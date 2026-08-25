import type { GtmContainer } from "@/app/api/gtm/accounts/containers/route";

// Scanning every account is inherently one API call per account, so a full
// sweep over hundreds of accounts costs minutes however well it's paced.
// The list barely changes between runs though, so the scan result is kept in
// the browser and reused: after the first sweep the picker fills instantly,
// and looking up specific container IDs needs no API calls at all.
//
// localStorage rather than a cookie because a few hundred containers is well
// past the ~4KB a cookie can carry, and it never needs to reach the server.

const CACHE_PREFIX = "gtm-container-cache:v1:";

export interface CachedScan {
  savedAt: number;
  containers: GtmContainer[];
  // The API pace the scan settled on, so the next one starts at a rate
  // already known to be safe rather than probing for it again.
  pacingMs?: number;
}

// Scoped per connected Google account — switching accounts must not show the
// previous one's containers.
function keyFor(accountKey: string): string {
  return `${CACHE_PREFIX}${accountKey || "default"}`;
}

export function loadCachedScan(accountKey: string): CachedScan | null {
  try {
    const raw = localStorage.getItem(keyFor(accountKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedScan;
    if (!Array.isArray(parsed.containers) || parsed.containers.length === 0) return null;
    return parsed;
  } catch {
    // Unavailable (private mode, blocked site data) or corrupt — treat the
    // cache as simply absent; the caller falls back to scanning.
    return null;
  }
}

export function saveCachedScan(accountKey: string, containers: GtmContainer[], pacingMs?: number): void {
  if (containers.length === 0) return;
  try {
    const payload: CachedScan = { savedAt: Date.now(), containers, pacingMs };
    localStorage.setItem(keyFor(accountKey), JSON.stringify(payload));
  } catch {
    // Over quota or blocked — the cache is an optimisation, never required.
  }
}

export function clearCachedScan(accountKey: string): void {
  try {
    localStorage.removeItem(keyFor(accountKey));
  } catch {
    // ignore
  }
}

export function describeCacheAge(savedAt: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - savedAt) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}
