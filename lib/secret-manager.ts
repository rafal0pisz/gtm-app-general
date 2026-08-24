import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const PROJECT_ID = process.env.GCP_PROJECT_ID || "web-analytics-ai-platform";

declare global {
  // eslint-disable-next-line no-var
  var __smClient: SecretManagerServiceClient | undefined;
}

function client(): SecretManagerServiceClient {
  if (!global.__smClient) {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    global.__smClient = credentialsJson
      ? new SecretManagerServiceClient({ credentials: JSON.parse(Buffer.from(credentialsJson, "base64").toString("utf-8")) as object })
      : new SecretManagerServiceClient();
  }
  return global.__smClient;
}

function secretParent(): string {
  return `projects/${PROJECT_ID}`;
}

function secretResourceName(id: string): string {
  return `${secretParent()}/secrets/${id}`;
}

async function ensureSecretExists(id: string): Promise<void> {
  const name = secretResourceName(id);
  try {
    await client().getSecret({ name });
  } catch {
    await client().createSecret({
      parent: secretParent(),
      secretId: id,
      secret: { replication: { automatic: {} } },
    });
  }
}

// ── GTM OAuth token ───────────────────────────────────────────────────────────

export interface GtmTokenData {
  refresh_token: string;
  access_token?: string;
  email?: string;
  connected_at: string;
}

function gtmSecretId(tenantId: string): string {
  return `gtm-token-${tenantId}`;
}

export async function saveGtmToken(tenantId: string, data: GtmTokenData): Promise<void> {
  const id = gtmSecretId(tenantId);
  await ensureSecretExists(id);
  await client().addSecretVersion({
    parent: secretResourceName(id),
    payload: { data: Buffer.from(JSON.stringify(data)) },
  });
}

export async function getGtmToken(tenantId: string): Promise<GtmTokenData | null> {
  try {
    const [version] = await client().accessSecretVersion({
      name: `${secretResourceName(gtmSecretId(tenantId))}/versions/latest`,
    });
    const raw = version.payload?.data;
    if (!raw) return null;
    const str = Buffer.isBuffer(raw)
      ? raw.toString("utf-8")
      : Buffer.from(raw as Uint8Array).toString("utf-8");
    return JSON.parse(str) as GtmTokenData;
  } catch {
    return null;
  }
}

export async function deleteGtmToken(tenantId: string): Promise<void> {
  await client().deleteSecret({ name: secretResourceName(gtmSecretId(tenantId)) });
}

export async function getGtmStatus(
  tenantId: string
): Promise<{ connected: true; email?: string; connected_at: string } | { connected: false }> {
  const token = await getGtmToken(tenantId);
  if (!token) return { connected: false };
  return { connected: true, email: token.email, connected_at: token.connected_at };
}

// ── GTM account whitelist ─────────────────────────────────────────────────────
// Stores a list of GTM accountIds the app is allowed to query.
// Empty list = no restriction (query all accounts).

function gtmAccountWhitelistId(tenantId: string): string {
  return `gtm-account-whitelist-${tenantId}`;
}

export async function saveGtmAccountWhitelist(tenantId: string, accountIds: string[]): Promise<void> {
  const id = gtmAccountWhitelistId(tenantId);
  await ensureSecretExists(id);
  await client().addSecretVersion({
    parent: secretResourceName(id),
    payload: { data: Buffer.from(JSON.stringify(accountIds)) },
  });
}

export async function getGtmAccountWhitelist(tenantId: string): Promise<string[]> {
  try {
    const [version] = await client().accessSecretVersion({
      name: `${secretResourceName(gtmAccountWhitelistId(tenantId))}/versions/latest`,
    });
    const raw = version.payload?.data;
    if (!raw) return [];
    const str = Buffer.isBuffer(raw)
      ? raw.toString("utf-8")
      : Buffer.from(raw as Uint8Array).toString("utf-8");
    return JSON.parse(str) as string[];
  } catch {
    return [];
  }
}

// ── GTM container whitelist ───────────────────────────────────────────────────

function gtmWhitelistId(tenantId: string): string {
  return `gtm-whitelist-${tenantId}`;
}

export async function saveGtmWhitelist(tenantId: string, whitelist: string[]): Promise<void> {
  const id = gtmWhitelistId(tenantId);
  await ensureSecretExists(id);
  await client().addSecretVersion({
    parent: secretResourceName(id),
    payload: { data: Buffer.from(JSON.stringify(whitelist)) },
  });
}

export async function getGtmWhitelist(tenantId: string): Promise<string[]> {
  try {
    const [version] = await client().accessSecretVersion({
      name: `${secretResourceName(gtmWhitelistId(tenantId))}/versions/latest`,
    });
    const raw = version.payload?.data;
    if (!raw) return [];
    const str = Buffer.isBuffer(raw)
      ? raw.toString("utf-8")
      : Buffer.from(raw as Uint8Array).toString("utf-8");
    return JSON.parse(str) as string[];
  } catch {
    return [];
  }
}

