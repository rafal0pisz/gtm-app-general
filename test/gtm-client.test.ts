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

test("rate limiter spaces out concurrent callers once the burst is spent", async () => {
  // burst = 1, so every call after the first has to wait its turn.
  const limiter = new AdaptiveRateLimiter(50, 4_000, 50, 0, 1);
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
    assert.ok(gap >= 40, `dispatch ${i} came ${gap}ms after the previous one, expected >= ~50ms`);
  }
});

test("a short burst goes out immediately, then settles to the paced rate", async () => {
  const BURST = 8;
  const limiter = new AdaptiveRateLimiter(100, 4_000, 100, 0, BURST);

  const startedAt = Date.now();
  for (let i = 0; i < BURST; i++) await limiter.waitForSlot();
  const burstMs = Date.now() - startedAt;
  assert.ok(burstMs < 60, `burst of ${BURST} took ${burstMs}ms — should be effectively instant`);

  // The allowance is spent; the next few must be paced.
  const pacedAt = Date.now();
  for (let i = 0; i < 3; i++) await limiter.waitForSlot();
  const pacedMs = Date.now() - pacedAt;
  assert.ok(pacedMs >= 250, `3 further calls took ${pacedMs}ms — expected ~100ms apart once paced`);
});

test("a quota error spends the saved-up burst instead of firing it back into the wall", async () => {
  const limiter = new AdaptiveRateLimiter(50, 4_000, 50, 40, 10);
  limiter.reportQuotaError();

  const startedAt = Date.now();
  await limiter.waitForSlot();
  await limiter.waitForSlot();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 40, `resumed after ${elapsed}ms — the cooldown should be respected`);
});

test("rate limiter slows down after a quota error and speeds back up on success", async () => {
  const limiter = new AdaptiveRateLimiter(50, 1_000, 100, 0);
  assert.equal(limiter.currentIntervalMs, 100);

  limiter.reportQuotaError();
  assert.equal(limiter.currentIntervalMs, 200, "should back off after a quota error");

  limiter.reportQuotaError();
  assert.equal(limiter.currentIntervalMs, 400);

  // One or two lucky calls must not immediately undo the backoff.
  limiter.reportSuccess();
  limiter.reportSuccess();
  assert.equal(limiter.currentIntervalMs, 400, "an isolated success should not undo a backoff");

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

test("an adopted pace only ever slows a limiter down, never speeds it up", async () => {
  const limiter = new AdaptiveRateLimiter(50, 1_000, 100, 0);

  limiter.adoptPace(400);
  assert.equal(limiter.currentIntervalMs, 400, "a slower pace learned elsewhere should be adopted");

  // A stale hint from an instance that never hit the quota must not undo
  // backoff this instance just learned the hard way.
  limiter.adoptPace(100);
  assert.equal(limiter.currentIntervalMs, 400, "a faster hint must not undo real backoff");

  limiter.adoptPace(99_999);
  assert.equal(limiter.currentIntervalMs, 1_000, "must still respect the ceiling");

  limiter.adoptPace(0);
  limiter.adoptPace(Number.NaN);
  assert.equal(limiter.currentIntervalMs, 1_000, "nonsense hints are ignored");
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
