import { test } from "node:test";
import assert from "node:assert/strict";
import { AdaptiveRateLimiter, fetchWithRetry, withRetry } from "@/lib/gtm-client";

function quotaResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: 429, message: "Quota exceeded for quota metric 'Queries'" } }),
    { status: 429 }
  );
}

function okResponse(body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

test("rate limiter spaces out concurrent callers", async () => {
  const limiter = new AdaptiveRateLimiter(50, 4_000, 50, 0);
  const dispatchTimes: number[] = [];

  await Promise.all(
    Array.from({ length: 5 }, async () => {
      await limiter.waitForSlot();
      dispatchTimes.push(Date.now());
    })
  );

  dispatchTimes.sort((a, b) => a - b);
  for (let i = 1; i < dispatchTimes.length; i++) {
    const gap = dispatchTimes[i] - dispatchTimes[i - 1];
    assert.ok(gap >= 45, `dispatch ${i} came ${gap}ms after the previous one, expected >= ~50ms`);
  }
});

test("rate limiter slows down after a quota error and speeds back up on success", async () => {
  const limiter = new AdaptiveRateLimiter(50, 1_000, 100, 0);
  assert.equal(limiter.currentIntervalMs, 100);

  limiter.reportQuotaError();
  assert.equal(limiter.currentIntervalMs, 200, "should back off after a quota error");

  limiter.reportQuotaError();
  assert.equal(limiter.currentIntervalMs, 400);

  // A handful of successes must not immediately undo the backoff.
  for (let i = 0; i < 5; i++) limiter.reportSuccess();
  assert.equal(limiter.currentIntervalMs, 400, "a few successes should not undo a backoff");

  for (let i = 0; i < 20; i++) limiter.reportSuccess();
  assert.ok(limiter.currentIntervalMs < 400, "a sustained success streak should ease the pace back up");
});

test("rate limiter never goes below its floor or above its ceiling", async () => {
  const limiter = new AdaptiveRateLimiter(50, 300, 100, 0);
  for (let i = 0; i < 10; i++) limiter.reportQuotaError();
  assert.equal(limiter.currentIntervalMs, 300, "must not exceed the ceiling");

  for (let i = 0; i < 500; i++) limiter.reportSuccess();
  assert.equal(limiter.currentIntervalMs, 50, "must not drop below the floor");
});

test("fetchWithRetry retries a 429 and returns the eventual success", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return calls < 3 ? quotaResponse() : okResponse({ account: [] });
  }) as typeof fetch;

  try {
    const res = await fetchWithRetry("https://example.test/x", {}, "test", { budgetMs: 30_000 });
    assert.equal(res.status, 200);
    assert.equal(calls, 3, "should have retried twice before succeeding");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry gives up within its budget instead of retrying forever", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => quotaResponse()) as typeof fetch;

  const startedAt = Date.now();
  try {
    const res = await fetchWithRetry("https://example.test/x", {}, "test", { budgetMs: 1_500 });
    assert.equal(res.status, 429, "should surface the quota response rather than hanging");
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 8_000, `gave up after ${elapsed}ms, expected to respect the ~1.5s budget`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchWithRetry does not retry a non-quota error", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("nope", { status: 403 });
  }) as typeof fetch;

  try {
    const res = await fetchWithRetry("https://example.test/x", {}, "test", {});
    assert.equal(res.status, 403);
    assert.equal(calls, 1, "a 403 is not transient — retrying only wastes quota");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("withRetry retries quota errors but rethrows other failures immediately", async () => {
  let quotaCalls = 0;
  const recovered = await withRetry(
    async () => {
      quotaCalls++;
      if (quotaCalls < 2) throw new Error("Quota exceeded for quota metric 'Queries'");
      return "done";
    },
    "test",
    { budgetMs: 30_000 }
  );
  assert.equal(recovered, "done");
  assert.equal(quotaCalls, 2);

  let otherCalls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        otherCalls++;
        throw new Error("Mismatched key with path or parent");
      },
      "test",
      {}
    ),
    /Mismatched key/
  );
  assert.equal(otherCalls, 1, "a non-quota error must not be retried");
});
