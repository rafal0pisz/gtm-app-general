import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchContainersForAccounts, fetchGtmAccountList, parseContainerName } from "@/lib/gtm-containers";

interface StubOptions {
  // accountId -> how to respond
  failing?: Set<string>;
  slowMs?: number;
  pagesPerAccount?: number;
}

function stubFetch(opts: StubOptions = {}) {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(input.toString());
    calls.push(url.pathname + url.search);
    if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));

    const accountId = /\/accounts\/(\d+)\/containers/.exec(url.pathname)?.[1];
    if (accountId && opts.failing?.has(accountId)) {
      return new Response(JSON.stringify({ error: { code: 403, message: "forbidden" } }), { status: 403 });
    }

    const pages = opts.pagesPerAccount ?? 1;
    const page = Number(url.searchParams.get("pageToken") ?? "1");
    return new Response(
      JSON.stringify({
        container: [
          {
            containerId: `c${accountId}-${page}`,
            publicId: `GTM-${accountId}${page}`,
            name: `example.com - PL`,
            usageContext: ["web"],
          },
        ],
        ...(page < pages ? { nextPageToken: String(page + 1) } : {}),
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const accounts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ accountId: String(1000 + i), name: `Account ${i}` }));

test("parseContainerName handles the documented name formats", () => {
  assert.deepEqual(parseContainerName("sanofi.com - PL"), { domain: "sanofi.com", countryCode: "PL" });
  assert.deepEqual(parseContainerName("PL - sanofi.com"), { domain: "sanofi.com", countryCode: "PL" });
  assert.deepEqual(parseContainerName("sanofi.com - Global"), { domain: "sanofi.com", countryCode: "Global" });
  assert.equal(parseContainerName("no separator here"), null);
});

test("every account in the slice is scanned and its containers returned", async () => {
  const stub = stubFetch();
  try {
    const result = await fetchContainersForAccounts("token", accounts(12));
    assert.equal(result.containers.length, 12, "one container per account");
    assert.equal(result.failedAccounts.length, 0);
    assert.equal(result.pendingAccounts.length, 0, "nothing should be left pending well inside the deadline");
  } finally {
    stub.restore();
  }
});

test("pagination is followed so later pages are not silently dropped", async () => {
  const stub = stubFetch({ pagesPerAccount: 3 });
  try {
    const result = await fetchContainersForAccounts("token", accounts(2));
    assert.equal(result.containers.length, 6, "2 accounts x 3 pages");
  } finally {
    stub.restore();
  }
});

test("one failing account does not lose the others", async () => {
  const stub = stubFetch({ failing: new Set(["1003"]) });
  try {
    const result = await fetchContainersForAccounts("token", accounts(6));
    assert.equal(result.containers.length, 5, "the five healthy accounts still come back");
    assert.equal(result.failedAccounts.length, 1);
    assert.equal(result.failedAccounts[0].accountId, "1003");
    assert.match(result.failedAccounts[0].error, /403/);
  } finally {
    stub.restore();
  }
});

test("hitting the deadline returns partial results plus the rest as pending, not an error", async () => {
  // Each call takes 100ms; with the worker pool that's at most a few dozen
  // accounts inside a 600ms deadline, so most of these 300 cannot be reached
  // in time and must come back as pending rather than as failures.
  const TOTAL = 300;
  const stub = stubFetch({ slowMs: 100 });
  try {
    const startedAt = Date.now();
    const result = await fetchContainersForAccounts("token", accounts(TOTAL), 600);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 3_000, `took ${elapsed}ms — should stop near its 600ms deadline, not run to completion`);
    assert.ok(result.pendingAccounts.length > 0, "unreached accounts must be reported as pending");
    assert.ok(result.containers.length > 0, "whatever was reached must still be returned");

    const accounted =
      result.containers.length + result.failedAccounts.length + result.pendingAccounts.length;
    assert.equal(accounted, TOTAL, "every account must be accounted for exactly once");
  } finally {
    stub.restore();
  }
});

test("account listing follows pagination and asks for Google-tag accounts", async () => {
  const original = globalThis.fetch;
  const seen: URL[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(input.toString());
    seen.push(url);
    const page = Number(url.searchParams.get("pageToken") ?? "1");
    return new Response(
      JSON.stringify({
        account: [{ accountId: `a${page}`, name: `Account ${page}` }],
        ...(page < 3 ? { nextPageToken: String(page + 1) } : {}),
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    const list = await fetchGtmAccountList("token");
    assert.equal(list.length, 3, "all pages must be collected");
    assert.ok(
      seen.every((u) => u.searchParams.get("includeGoogleTags") === "true"),
      "accounts tied to the unified Google tag are omitted without this flag"
    );
  } finally {
    globalThis.fetch = original;
  }
});
