import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

export interface PageElementInfo {
  tag: string;
  text: string;
  id?: string;
  className?: string;
  name?: string;
  ariaLabel?: string;
  type?: string;
  selector: string;
  isVisible: boolean;
}

export type FindPageElementResult =
  | { match: "single"; selector: string; elementInfo: PageElementInfo }
  | { match: "ambiguous" | "none"; candidates: PageElementInfo[] };

const TOTAL_TIMEOUT_MS = 20_000;
const PAGE_LOAD_TIMEOUT_MS = 15_000;

// Run inside page.evaluate — must be a plain serialisable type.
type RawElement = {
  tag: string;
  text: string;
  id?: string;
  className?: string;
  name?: string;
  ariaLabel?: string;
  type?: string;
  dataTestId?: string;
  isVisible: boolean;
};

export async function findPageElement(
  url: string,
  description: string
): Promise<FindPageElementResult> {
  const browser = await chromium.launch({
    headless: true,
    // Required when running as root in Docker / Cloud Run
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    return await Promise.race([
      doFind(browser, url, description),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`find_page_element timed out after ${TOTAL_TIMEOUT_MS}ms for ${url}`)
            ),
          TOTAL_TIMEOUT_MS
        )
      ),
    ]);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function doFind(
  browser: import("playwright").Browser,
  url: string,
  description: string
): Promise<FindPageElementResult> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // Try networkidle first; fall back to domcontentloaded + short settle pause.
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: PAGE_LOAD_TIMEOUT_MS });
  } catch {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForTimeout(2_000);
    } catch (err) {
      throw new Error(`Page failed to load (${url}): ${(err as Error).message}`);
    }
  }

  const elements: RawElement[] = await page.evaluate(() => {
    const SELECTORS = [
      "button",
      "a[href]",
      "[role='button']",
      "[role='link']",
      "input[type='submit']",
      "input[type='button']",
      "input[type='reset']",
      "[onclick]:not(script)",
    ];

    function isVisible(el: Element): boolean {
      const s = window.getComputedStyle(el as HTMLElement);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      if ((el as HTMLInputElement).disabled) return false;
      return true;
    }

    function getText(el: Element): string {
      if (el.tagName === "INPUT" || el.tagName === "BUTTON") {
        const inp = el as HTMLInputElement;
        if (inp.value) return inp.value.trim().slice(0, 200);
      }
      return ((el as HTMLElement).innerText ?? el.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
    }

    const seen = new Set<Element>();
    const results: Array<{
      tag: string; text: string; id?: string; className?: string;
      name?: string; ariaLabel?: string; type?: string; dataTestId?: string;
      isVisible: boolean;
    }> = [];

    for (const sel of SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        results.push({
          tag: el.tagName.toLowerCase(),
          text: getText(el),
          id: el.id || undefined,
          className:
            typeof el.className === "string"
              ? el.className.trim().slice(0, 200) || undefined
              : undefined,
          name: (el as HTMLInputElement).name || undefined,
          ariaLabel: el.getAttribute("aria-label") || undefined,
          type: (el as HTMLInputElement).type || undefined,
          dataTestId: el.getAttribute("data-testid") || undefined,
          isVisible: isVisible(el),
        });
      }
    }
    return results;
  });

  // ── Scoring ──────────────────────────────────────────────────────────────────
  const desc = description.toLowerCase().trim();
  const descWords = desc.split(/\W+/).filter(Boolean);

  function score(el: RawElement): number {
    const text = el.text.toLowerCase();
    const aria = (el.ariaLabel ?? "").toLowerCase();
    const id   = (el.id ?? "").toLowerCase();
    const cls  = (el.className ?? "").toLowerCase();
    const nm   = (el.name ?? "").toLowerCase();
    let s = 0;

    if (text === desc || aria === desc)                          s += 100;
    else if (text.startsWith(desc) || aria.startsWith(desc))    s += 80;
    else if (text.includes(desc) || aria.includes(desc))        s += 60;
    else {
      const hits = descWords.filter(
        (w) => text.includes(w) || aria.includes(w) || id.includes(w) || cls.includes(w) || nm.includes(w)
      ).length;
      if (hits > 0) s += Math.min(hits * 15, 45);
    }

    if (el.isVisible) s += 5;
    return s;
  }

  // Prefer stable, human-readable CSS selectors that work well in GTM triggers.
  function buildSelector(el: RawElement): string {
    if (el.id && !/^\d/.test(el.id)) return `#${el.id}`;
    if (el.dataTestId) return `[data-testid="${el.dataTestId}"]`;
    if (el.ariaLabel) return `${el.tag}[aria-label="${el.ariaLabel}"]`;
    if (el.name) return `${el.tag}[name="${el.name}"]`;
    return el.tag;
  }

  const scored = elements
    .map((el) => ({ el, s: score(el) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s);

  const toInfo = (el: RawElement): PageElementInfo => ({
    tag: el.tag,
    text: el.text,
    id: el.id,
    className: el.className,
    name: el.name,
    ariaLabel: el.ariaLabel,
    type: el.type,
    selector: buildSelector(el),
    isVisible: el.isVisible,
  });

  let result: FindPageElementResult;

  if (scored.length === 0) {
    result = { match: "none", candidates: [] };
  } else {
    const topScore = scored[0].s;
    // "Single clear winner" = top score ≥ 45 AND no other element within 15% of it
    const top = scored.filter(({ s }) => s >= topScore * 0.85);

    if (top.length === 1 && topScore >= 45) {
      const info = toInfo(top[0].el);
      result = { match: "single", selector: info.selector, elementInfo: info };
    } else {
      result = {
        match: top.length > 1 ? "ambiguous" : "none",
        candidates: scored.slice(0, 10).map(({ el }) => toInfo(el)),
      };
    }
  }

  const debugAlways = process.env.DEBUG_PAGE_READER === "true";
  if (debugAlways || result.match === "none") {
    await dumpDebugInfo(page, url, description, result.match);
  }

  return result;
}

async function dumpDebugInfo(
  page: import("playwright").Page,
  url: string,
  description: string,
  matchResult: string
): Promise<void> {
  try {
    const title = await page.title();
    const finalUrl = page.url();
    const content = (await page.content()).slice(0, 2000);

    console.error(`[PAGE_READER_DEBUG] requested_url=${url}`);
    console.error(`[PAGE_READER_DEBUG] final_url=${finalUrl}`);
    console.error(`[PAGE_READER_DEBUG] title=${title}`);
    console.error(`[PAGE_READER_DEBUG] description=${description}`);
    console.error(`[PAGE_READER_DEBUG] match=${matchResult}`);
    console.error(`[PAGE_READER_DEBUG] html_snippet=\n${content}`);

    const ts = Date.now();
    const screenshotPath = path.join("/tmp", `page-reader-debug-${ts}.png`);
    const htmlPath = path.join("/tmp", `page-reader-debug-${ts}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    fs.writeFileSync(htmlPath, content, "utf8");

    console.error(`[PAGE_READER_DEBUG] screenshot=${screenshotPath}`);
    console.error(`[PAGE_READER_DEBUG] html_file=${htmlPath}`);
  } catch (err) {
    console.error(`[PAGE_READER_DEBUG] failed to collect debug info: ${(err as Error).message}`);
  }
}
