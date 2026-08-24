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

// The Tag Manager API's default quota ("Queries per minute per user") is low
// enough that a handful of containers with several tags each can trip it —
// every call is against the same quota, regardless of which container it's
// for. Rather than trying to stay under an unknown limit by tuning
// concurrency alone, retry with backoff whenever Google reports the quota
// was hit, so a run slows down instead of failing outright.
export async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = /quota exceeded|rate limit exceeded|too many requests/i.test(message);
      if (!isQuota || attempt >= maxAttempts) throw err;
      const delayMs = backoffDelay(attempt);
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
  maxAttempts = 6
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || attempt >= maxAttempts) return res;

    let isQuota = res.status === 429;
    if (!isQuota) {
      try {
        isQuota = /quota exceeded/i.test(await res.clone().text());
      } catch {
        // ignore — treat as non-quota below
      }
    }
    if (!isQuota) return res;

    const delayMs = backoffDelay(attempt);
    console.warn(`[gtm] ${label} hit quota (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
    await sleep(delayMs);
  }
}
