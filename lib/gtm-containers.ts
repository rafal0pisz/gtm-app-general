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
//   {DOMAIN} - {CC}          e.g. "sanofi.com - PL"
//   {CC} - {DOMAIN}          e.g. "PL - sanofi.com"
//   {DOMAIN} - Global        e.g. "sanofi.com - Global"
//   Global - {DOMAIN}        e.g. "Global - sanofi.com"
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
  accessToken: string
): Promise<GtmContainerInfo[]> {
  const all: GtmContainerInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GTM_BASE}/accounts/${account.accountId}/containers`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    // Every account in the batch fires this concurrently, but the shared
    // rate limiter in fetchWithRetry paces the actual outbound requests, so
    // this budget just needs enough room to wait its turn in a large batch
    // plus a few retries — not to outlast the whole HTTP request.
    const res = await fetchWithRetry(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "containers.list",
      { budgetMs: 25_000 }
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
}

// Fetches containers for a caller-supplied slice of accounts only — the
// caller (an API route handling one request per small chunk of accounts)
// decides how big that slice is, which keeps any single HTTP round-trip
// short and safely inside any hosting platform's function time limit,
// however many accounts there are in total across repeated calls.
//
// All accounts in the slice are launched together rather than in staggered
// sub-batches: the shared rate limiter inside fetchWithRetry is what
// actually paces the outbound requests now, so an extra layer of manual
// batching here would only add latency without adding safety.
export async function fetchContainersForAccounts(
  accessToken: string,
  accounts: GtmAccountInfo[]
): Promise<FetchContainersResult> {
  const containers: GtmContainerInfo[] = [];
  const failedAccounts: FailedAccount[] = [];

  const results = await Promise.allSettled(
    accounts.map((account) => fetchContainersForAccount(account, accessToken))
  );

  results.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      containers.push(...r.value);
    } else {
      const account = accounts[idx];
      const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[gtm-containers] account ${account.accountId} (${account.name}) failed:`, error);
      failedAccounts.push({ accountId: account.accountId, name: account.name, error });
    }
  });

  return { containers, failedAccounts };
}
