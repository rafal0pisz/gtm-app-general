import { google, tagmanager_v2 } from "googleapis";

export function tagmanagerClient(accessToken: string): tagmanager_v2.Tagmanager {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.tagmanager({ version: "v2", auth });
}

// accountId:containerId → workspaceId. Workspaces are essentially static once
// a container is set up, so a short-lived process-wide cache avoids a list
// call on every single operation.
const WORKSPACE_CACHE_TTL_MS = 300_000;
const workspaceCache = new Map<string, { workspaceId: string; expiresAt: number }>();

export async function resolveWorkspaceId(
  tm: tagmanager_v2.Tagmanager,
  accountId: string,
  containerId: string
): Promise<string> {
  const key = `${accountId}:${containerId}`;
  const cached = workspaceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.workspaceId;

  const parent = `accounts/${accountId}/containers/${containerId}`;
  const res = await withRetry(() => tm.accounts.containers.workspaces.list({ parent }), "workspaces.list");
  const workspaces = res.data.workspace ?? [];
  const chosen =
    workspaces.find((w) => w.name === "Default Workspace") ?? workspaces[0];
  if (!chosen?.workspaceId) {
    throw new Error(`No workspace found for container ${containerId}.`);
  }
  workspaceCache.set(key, {
    workspaceId: chosen.workspaceId,
    expiresAt: Date.now() + WORKSPACE_CACHE_TTL_MS,
  });
  return chosen.workspaceId;
}

export function workspacePath(accountId: string, containerId: string, workspaceId: string): string {
  return `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Jittered so a burst of calls that all hit quota at once don't all retry at
// the exact same moment and immediately collide again.
function backoffDelay(attempt: number): number {
  const base = Math.min(20_000, 2 ** attempt * 1000);
  return Math.round(base * (0.5 + Math.random()));
}

// The Tag Manager API's "Queries per minute per user" quota is shared across
// every call this process makes — reads and writes, any account or
// container. Firing several accounts' worth of calls concurrently (even just
// 10 at once) can burst well past that quota before any 429 comes back to
// react to, and retry-with-backoff alone doesn't fix that: every retrying
// call backs off independently, so the *combined* dispatch rate across all
// of them can stay above the limit indefinitely instead of settling under
// it. A single process-wide gate that paces the actual moment each HTTP
// call goes out — not how many are in flight — keeps the real request rate
// under the quota regardless of how much concurrency callers throw at it.
const RATE_LIMIT_INTERVAL_MS = Number(process.env.GTM_RATE_LIMIT_MS) || 500;

class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastDispatch = 0;

  constructor(private minIntervalMs: number) {}

  // Reserves the next available dispatch slot and resolves once it arrives.
  // Only the *waiting* is serialized here — the caller's own call still runs
  // (and can take as long as it likes) after this resolves, so slow calls
  // don't back up the queue for everyone else.
  async waitForSlot(): Promise<void> {
    const mySlot = this.queue.then(async () => {
      const wait = Math.max(0, this.lastDispatch + this.minIntervalMs - Date.now());
      if (wait > 0) await sleep(wait);
      this.lastDispatch = Date.now();
    });
    this.queue = mySlot;
    await mySlot;
  }
}

const gtmRateLimiter = new RateLimiter(RATE_LIMIT_INTERVAL_MS);

export interface RetryOptions {
  maxAttempts?: number;
  // Total wall-clock time (across all retries combined) this is allowed to
  // spend backing off before giving up, even if maxAttempts hasn't been
  // reached. Without this, a handful of concurrent calls each independently
  // retrying up to ~50s can collectively outlast the serverless function's
  // own time limit — which kills the request with a bare 504 and no useful
  // error at all, worse than just failing fast and letting the caller
  // (Refresh) retry the whole chunk in a fresh invocation.
  budgetMs?: number;
}

// The Tag Manager API's default quota ("Queries per minute per user") is low
// enough that a handful of containers with several tags each can trip it —
// every call is against the same quota, regardless of which container it's
// for. Rather than trying to stay under an unknown limit by tuning
// concurrency alone, retry with backoff whenever Google reports the quota
// was hit, so a run slows down instead of failing outright.
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts: RetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const budgetMs = opts.budgetMs ?? 45_000;
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      await gtmRateLimiter.waitForSlot();
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = /quota exceeded|rate limit exceeded|too many requests/i.test(message);
      const elapsed = Date.now() - start;
      if (!isQuota || attempt >= maxAttempts || elapsed >= budgetMs) throw err;
      const delayMs = Math.min(backoffDelay(attempt), budgetMs - elapsed);
      console.warn(`[gtm] ${label} hit quota (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}

// Same idea as withRetry(), but for the raw REST calls in gtm-containers.ts
// (which don't go through the googleapis client, so errors show up as a
// non-ok Response instead of a thrown exception).
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  label: string,
  opts: RetryOptions = {}
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 6;
  const budgetMs = opts.budgetMs ?? 45_000;
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    await gtmRateLimiter.waitForSlot();
    const res = await fetch(url, init);
    const elapsed = Date.now() - start;
    if (res.ok || attempt >= maxAttempts || elapsed >= budgetMs) return res;

    let isQuota = res.status === 429;
    if (!isQuota) {
      try {
        isQuota = /quota exceeded/i.test(await res.clone().text());
      } catch {
        // ignore — treat as non-quota below
      }
    }
    if (!isQuota) return res;

    const delayMs = Math.min(backoffDelay(attempt), budgetMs - elapsed);
    console.warn(`[gtm] ${label} hit quota (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
    await sleep(delayMs);
  }
}
