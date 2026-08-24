import { getGtmToken, getGtmWhitelist, getGtmAccountWhitelist } from "@/lib/secret-manager";

const GTM_BASE = "https://www.googleapis.com/tagmanager/v2";
const CACHE_TTL_MS = 300_000;

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

export type GtmContainerMap = Map<
  string,
  {
    accountId: string;
    containerId: string;
    containerName: string;
    accountName: string;
    parsed: ParsedContainerName | null;
  }
>;

interface CacheEntry {
  containers: GtmContainerInfo[];
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __gtmContainersCache: Map<string, CacheEntry> | undefined;
}

function getCache(): Map<string, CacheEntry> {
  if (!global.__gtmContainersCache) global.__gtmContainersCache = new Map();
  return global.__gtmContainersCache;
}

export async function exchangeGtmToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GTM_CLIENT_ID!,
      client_secret: process.env.GTM_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`GTM token refresh failed: ${data.error ?? "unknown"}`);
  }
  return data.access_token;
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
  const res = await fetch(
    `${GTM_BASE}/accounts/${account.accountId}/containers`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(
      `[gtm-containers] account ${account.accountId} (${account.name}): HTTP ${res.status}`,
      body.slice(0, 200)
    );
    return [];
  }
  const data = (await res.json()) as {
    container?: Array<{ containerId: string; publicId: string; name: string; usageContext?: string[] }>;
  };
  return (data.container ?? []).map<GtmContainerInfo>((c) => ({
    publicId: c.publicId,
    accountId: account.accountId,
    containerId: c.containerId,
    containerName: c.name,
    accountName: account.name,
    usageContext: c.usageContext ?? [],
    parsed: parseContainerName(c.name),
  }));
}

export async function fetchGtmAccountList(
  accessToken: string
): Promise<Array<{ accountId: string; name: string }>> {
  const res = await fetch(`${GTM_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[gtm-containers] accounts API returned HTTP ${res.status}`, body);
    return [];
  }
  const data = (await res.json()) as { account?: Array<{ accountId: string; name: string }> };
  return (data.account ?? []).sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

async function fetchAllContainers(
  accessToken: string,
  accountWhitelist: string[]
): Promise<GtmContainerInfo[]> {
  const allAccounts = await fetchGtmAccountList(accessToken);

  let accounts: Array<{ accountId: string; name: string }>;
  if (accountWhitelist.length > 0) {
    const wlSet = new Set(accountWhitelist);
    accounts = allAccounts.filter((a) => wlSet.has(a.accountId));
    console.log(
      `[gtm-containers] Account whitelist active: querying ${accounts.length} of ${allAccounts.length} accounts`
    );
  } else {
    accounts = allAccounts;
    console.log(`[gtm-containers] No account whitelist — querying all ${accounts.length} accounts`);
  }

  if (accounts.length === 0) return [];

  const totalBatches = Math.ceil(accounts.length / BATCH_SIZE);
  const estimatedSeconds = totalBatches > 1 ? (totalBatches - 1) * (BATCH_DELAY_MS / 1000) : 0;
  console.log(
    `[gtm-containers] fetching containers for ${accounts.length} accounts` +
    ` in batches of ${BATCH_SIZE} (~${totalBatches} batches, ~${estimatedSeconds}s estimated)`
  );

  const allContainers: GtmContainerInfo[] = [];

  for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_DELAY_MS);

    const batch = accounts.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`[gtm-containers] batch ${batchIndex}/${totalBatches}: ${batch.map((a) => a.name).join(", ")}`);

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

  console.log(`[gtm-containers] done — ${allContainers.length} containers total`);
  return allContainers;
}

async function loadContainers(tenantId: string, force: boolean): Promise<GtmContainerInfo[] | null> {
  const cache = getCache();
  if (!force) {
    const cached = cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.containers;
  } else {
    cache.delete(tenantId);
  }

  const tokenData = await getGtmToken(tenantId);
  if (!tokenData) return null;

  let accessToken: string;
  try {
    accessToken = await exchangeGtmToken(tokenData.refresh_token);
  } catch (err) {
    console.error("[gtm-containers] token refresh failed:", err);
    return null;
  }

  const accountWhitelist = await getGtmAccountWhitelist(tenantId);

  let containers: GtmContainerInfo[];
  try {
    containers = await fetchAllContainers(accessToken, accountWhitelist);
  } catch (err) {
    console.error("[gtm-containers] fetchAllContainers failed:", err);
    return null;
  }

  cache.set(tenantId, { containers, expiresAt: Date.now() + CACHE_TTL_MS });
  return containers;
}

export async function fetchAllGtmContainers(tenantId: string, force = false): Promise<GtmContainerInfo[]> {
  return (await loadContainers(tenantId, force)) ?? [];
}

export async function fetchWhitelistedGtmContainers(tenantId: string): Promise<GtmContainerInfo[]> {
  const [containers, whitelist] = await Promise.all([
    loadContainers(tenantId, false),
    getGtmWhitelist(tenantId),
  ]);
  if (!containers) return [];
  return whitelist.length === 0
    ? containers
    : containers.filter((c) => (whitelist as string[]).includes(c.publicId));
}

export function buildContainerMap(containers: GtmContainerInfo[]): GtmContainerMap {
  return new Map(
    containers.map((c) => [
      c.publicId,
      {
        accountId: c.accountId,
        containerId: c.containerId,
        containerName: c.containerName,
        accountName: c.accountName,
        parsed: c.parsed,
      },
    ])
  );
}
