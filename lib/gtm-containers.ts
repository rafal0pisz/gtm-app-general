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

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchContainersForAccount(
  account: { accountId: string; name: string },
  accessToken: string
): Promise<GtmContainerInfo[]> {
  const all: GtmContainerInfo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GTM_BASE}/accounts/${account.accountId}/containers`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[gtm-containers] account ${account.accountId} (${account.name}): HTTP ${res.status}`,
        body.slice(0, 200)
      );
      break;
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

export async function fetchGtmAccountList(
  accessToken: string
): Promise<Array<{ accountId: string; name: string }>> {
  const all: Array<{ accountId: string; name: string }> = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${GTM_BASE}/accounts`);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[gtm-containers] accounts API returned HTTP ${res.status}`, body);
      break;
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

export async function fetchAllGtmContainers(accessToken: string): Promise<GtmContainerInfo[]> {
  const accounts = await fetchGtmAccountList(accessToken);
  if (accounts.length === 0) return [];

  const allContainers: GtmContainerInfo[] = [];

  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_DELAY_MS);

    const batch = accounts.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((account) => fetchContainersForAccount(account, accessToken))
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        allContainers.push(...r.value);
      } else {
        console.warn("[gtm-containers] batch item threw:", r.reason);
      }
    }
  }

  return allContainers;
}
