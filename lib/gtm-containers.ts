import { fetchWithRetry } from "@/lib/gtm-client";

const GTM_BASE = "https://www.googleapis.com/tagmanager/v2";

export interface ParsedContainerName {
  domain: string;
  countryCode: string | "Global";
}

export interface GtmContainerInfo {
  publicId: string;
  accountId: string;
  containerId: string;
  containerName: string;
  accountName: string;
  usageContext: string[];
  parsed: ParsedContainerName | null;
}

export interface FailedAccount {
  accountId: string;
  name: string;
  error: string;
}

export interface GtmAccountInfo {
  accountId: string;
  name: string;
}

// Expected formats:
//   {DOMAIN} - {CC}          e.g. "example.com - PL"
//   {CC} - {DOMAIN}          e.g. "PL - example.com"
//   {DOMAIN} - Global        e.g. "example.com - Global"
//   Global - {DOMAIN}        e.g. "Global - example.com"
// Country code: 2-letter ISO code (uppercase) or the literal "Global".
const CC_RE = /^[A-Z]{2}$/;

export function parseContainerName(name: string): ParsedContainerName | null {
  const sep = " - ";
  const idx = name.indexOf(sep);
  if (idx === -1) return null;

  const left = name.slice(0, idx).trim();
  const right = name.slice(idx + sep.length).trim();
  if (!left || !right) return null;

  if (left === "Global") return { domain: right, countryCode: "Global" };
  if (right === "Global") return { domain: left, countryCode: "Global" };
  if (CC_RE.test(left)) return { domain: right, countryCode: left };
  if (CC_RE.test(right)) return { domain: left, countryCode: right };

  return null;
}

async function readErrorMessage(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`;
}

// Throws (rather than silently truncating) so a page fetch that fails after
// retries are exhausted is visible to the caller instead of quietly leaving
// this account's container list incomplete.
async function fetchContainersForAccount(
  account: GtmAccountInfo,
  accessToken: string,
  deadline: number
): Promise<GtmContainerInfo[]> {
  const all: GtmContainerInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GTM_BASE}/accounts/${account.accountId}/containers`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    // Never retry past the caller's deadline — overshooting it is what turns
    // a recoverable per-account error into a whole-request timeout.
    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "containers.list",
      { budgetMs: Math.max(0, Math.min(20_000, deadline - Date.now())) }
    );
    if (!res.ok) {
      throw new Error(await readErrorMessage(res));
    }
    const data = (await res.json()) as {
      container?: Array<{ containerId: string; publicId: string; name: string; usageContext?: string[] }>;
      nextPageToken?: string;
    };
    all.push(
      ...(data.container ?? []).map<GtmContainerInfo>((c) => ({
        publicId: c.publicId,
        accountId: account.accountId,
        containerId: c.containerId,
        containerName: c.name,
        accountName: account.name,
        usageContext: c.usageContext ?? [],
        parsed: parseContainerName(c.name),
      }))
    );
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all;
}

export async function fetchGtmAccountList(accessToken: string): Promise<GtmAccountInfo[]> {
  const all: GtmAccountInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GTM_BASE}/accounts`);
    // Without this, accounts associated with the newer unified "Google tag"
    // setup are silently excluded from the list — a real gap, not just a
    // pagination issue, and easy to mistake for one.
    url.searchParams.set("includeGoogleTags", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "accounts.list",
      { budgetMs: 20_000 }
    );
    if (!res.ok) {
      throw new Error(`Failed to list GTM accounts (${await readErrorMessage(res)})`);
    }
    const data = (await res.json()) as {
      account?: Array<{ accountId: string; name: string }>;
      nextPageToken?: string;
    };
    all.push(...(data.account ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return all.sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

export interface FetchContainersResult {
  containers: GtmContainerInfo[];
  failedAccounts: FailedAccount[];
  // Accounts this call ran out of time to reach at all. Not errors — the
  // caller should simply send them again in the next request.
  pendingAccounts: GtmAccountInfo[];
}

// How many accounts to have in flight at once. The rate limiter is what
// actually controls the request rate, so this only needs to be high enough
// to keep the limiter's queue fed while some accounts are paging through
// results.
const CONCURRENCY = 8;

// Leaves room to serialize and return the response before any hosting
// platform's function limit (the tightest common one is 60s) kicks in.
const DEFAULT_DEADLINE_MS = 40_000;

// Fetches containers for a caller-supplied slice of accounts, stopping at a
// deadline well inside the hosting platform's function time limit. Whatever
// it didn't get to comes back as `pendingAccounts` for the caller to send
// again, so a slow run degrades into more round-trips instead of a timeout
// that loses every account in the slice at once.
export async function fetchContainersForAccounts(
  accessToken: string,
  accounts: GtmAccountInfo[],
  deadlineMs: number = DEFAULT_DEADLINE_MS
): Promise<FetchContainersResult> {
  const containers: GtmContainerInfo[] = [];
  const failedAccounts: FailedAccount[] = [];
  const deadline = Date.now() + deadlineMs;

  let next = 0;
  const takeNext = (): GtmAccountInfo | null => {
    if (next >= accounts.length || Date.now() >= deadline) return null;
    return accounts[next++];
  };

  const worker = async (): Promise<void> => {
    for (let account = takeNext(); account; account = takeNext()) {
      try {
        containers.push(...(await fetchContainersForAccount(account, accessToken, deadline)));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(`[gtm-containers] account ${account.accountId} (${account.name}) failed:`, error);
        failedAccounts.push({ accountId: account.accountId, name: account.name, error });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, accounts.length) }, worker));

  return { containers, failedAccounts, pendingAccounts: accounts.slice(next) };
}
