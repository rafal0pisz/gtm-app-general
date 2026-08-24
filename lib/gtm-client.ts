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
//
// The exact ceiling isn't knowable from here (it varies per project and
// isn't reported in the error), so rather than hardcode a guess, the pace
// adapts: back off hard the moment Google reports the quota was hit, then
// creep back toward full speed while calls keep succeeding. That way a
// project with a generous quota isn't permanently throttled to the slowest
// safe speed, and a project with a tight one still settles under it instead
// of failing.
const MIN_INTERVAL_MS = Number(process.env.GTM_MIN_INTERVAL_MS) || 200;
const MAX_INTERVAL_MS = Number(process.env.GTM_MAX_INTERVAL_MS) || 4_000;
const START_INTERVAL_MS = Number(process.env.GTM_START_INTERVAL_MS) || 400;
// The quota is measured per minute, so a hit means that minute's allowance
// is already spent — a brief full stop lets it start refilling instead of
// trickling more doomed requests at it.
const QUOTA_COOLDOWN_MS = Number(process.env.GTM_QUOTA_COOLDOWN_MS) || 5_000;
// How many consecutive successes before easing the pace back up. High
// enough that one lucky call doesn't undo a backoff.
const SPEEDUP_AFTER_OK = 15;

export class AdaptiveRateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastDispatch = 0;
  private intervalMs: number;
  private pauseUntil = 0;
  private okStreak = 0;
  private minIntervalMs: number;
  private maxIntervalMs: number;
  private cooldownMs: number;

  constructor(
    minIntervalMs = MIN_INTERVAL_MS,
    maxIntervalMs = MAX_INTERVAL_MS,
    startIntervalMs = START_INTERVAL_MS,
    cooldownMs = QUOTA_COOLDOWN_MS
  ) {
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.intervalMs = startIntervalMs;
    this.cooldownMs = cooldownMs;
  }

  // Reserves the next available dispatch slot and resolves once it arrives.
  // Only the *waiting* is serialized here — the caller's own call still runs
  // (and can take as long as it likes) after this resolves, so slow calls
  // don't back up the queue for everyone else.
  async waitForSlot(): Promise<void> {
    const mySlot = this.queue.then(async () => {
      const readyAt = Math.max(this.lastDispatch + this.intervalMs, this.pauseUntil);
      const wait = readyAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastDispatch = Date.now();
    });
    // Swallow rejections on the chain itself so one caller's failure can't
    // poison every subsequent waiter — each caller still awaits its own slot.
    this.queue = mySlot.catch(() => {});
    await mySlot;
  }

  reportQuotaError(): void {
    this.okStreak = 0;
    this.intervalMs = Math.min(this.maxIntervalMs, Math.round(this.intervalMs * 2));
    this.pauseUntil = Date.now() + this.cooldownMs;
  }

  reportSuccess(): void {
    if (this.intervalMs <= this.minIntervalMs) return;
    if (++this.okStreak < SPEEDUP_AFTER_OK) return;
    this.okStreak = 0;
    this.intervalMs = Math.max(this.minIntervalMs, Math.round(this.intervalMs * 0.75));
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  // Adopts a pace learned elsewhere, but only ever slows down. Each request
  // may land on a fresh serverless instance whose limiter starts at full
  // speed with no memory of the quota pressure the previous one hit, so the
  // caller hands the last known pace back in. Refusing to speed up here
  // means a stale hint can't undo backoff a warm instance just learned.
  adoptPace(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.intervalMs = Math.min(this.maxIntervalMs, Math.max(this.intervalMs, intervalMs));
  }
}

const gtmRateLimiter = new AdaptiveRateLimiter();

// Lets a request carry the pace forward to the next one (see adoptPace).
export function currentPaceMs(): number {
  return gtmRateLimiter.currentIntervalMs;
}

export function adoptPace(intervalMs: number): void {
  gtmRateLimiter.adoptPace(intervalMs);
}

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
  // Measured from the first dispatch, not from entry: waiting for a slot in
  // a large concurrent batch is queueing, not backoff, and charging it to
  // the retry budget would leave calls at the back of the queue no room to
  // retry at all.
  let start = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      await gtmRateLimiter.waitForSlot();
      if (start === 0) start = Date.now();
      const result = await fn();
      gtmRateLimiter.reportSuccess();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = /quota exceeded|rate limit exceeded|too many requests/i.test(message);
      if (!isQuota) throw err;
      gtmRateLimiter.reportQuotaError();
      const elapsed = Date.now() - start;
      if (attempt >= maxAttempts || elapsed >= budgetMs) throw err;
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
  // See withRetry(): timed from first dispatch, so queueing behind other
  // concurrent calls doesn't eat the retry budget.
  let start = 0;
  for (let attempt = 1; ; attempt++) {
    await gtmRateLimiter.waitForSlot();
    if (start === 0) start = Date.now();
    const res = await fetch(url, init);
    if (res.ok) {
      gtmRateLimiter.reportSuccess();
      return res;
    }

    let isQuota = res.status === 429;
    if (!isQuota) {
      try {
        isQuota = /quota exceeded/i.test(await res.clone().text());
      } catch {
        // ignore — treat as non-quota below
      }
    }
    if (!isQuota) return res;

    gtmRateLimiter.reportQuotaError();
    const elapsed = Date.now() - start;
    if (attempt >= maxAttempts || elapsed >= budgetMs) return res;

    const delayMs = Math.min(backoffDelay(attempt), budgetMs - elapsed);
    console.warn(`[gtm] ${label} hit quota (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
    await sleep(delayMs);
  }
}
