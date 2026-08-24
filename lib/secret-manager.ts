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

// ── Stape OAuth tokens ────────────────────────────────────────────────────────

function stapeTokenId(tenantId: string): string {
  return `stape-token-${tenantId}`;
}

function stapeClientInfoId(tenantId: string): string {
  return `stape-client-info-${tenantId}`;
}

async function readSecret<T>(secretId: string): Promise<T | null> {
  try {
    const [version] = await client().accessSecretVersion({
      name: `${secretResourceName(secretId)}/versions/latest`,
    });
    const raw = version.payload?.data;
    if (!raw) return null;
    const str = Buffer.isBuffer(raw)
      ? raw.toString("utf-8")
      : Buffer.from(raw as Uint8Array).toString("utf-8");
    return JSON.parse(str) as T;
  } catch {
    return null;
  }
}

async function writeSecret(secretId: string, value: unknown): Promise<void> {
  await ensureSecretExists(secretId);
  await client().addSecretVersion({
    parent: secretResourceName(secretId),
    payload: { data: Buffer.from(JSON.stringify(value)) },
  });
}

export interface StapeTokenData {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  id_token?: string;
}

export interface StapeClientInfo {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  [key: string]: unknown;
}

export async function saveStapeToken(tenantId: string, tokens: StapeTokenData): Promise<void> {
  await writeSecret(stapeTokenId(tenantId), tokens);
}

export async function getStapeToken(tenantId: string): Promise<StapeTokenData | null> {
  return readSecret<StapeTokenData>(stapeTokenId(tenantId));
}

export async function deleteStapeToken(tenantId: string): Promise<void> {
  await client().deleteSecret({ name: secretResourceName(stapeTokenId(tenantId)) });
}

export async function getStapeStatus(
  tenantId: string
): Promise<{ connected: true } | { connected: false }> {
  const token = await getStapeToken(tenantId);
  return token ? { connected: true } : { connected: false };
}

export async function saveStapeClientInfo(tenantId: string, info: StapeClientInfo): Promise<void> {
  await writeSecret(stapeClientInfoId(tenantId), info);
}

export async function getStapeClientInfo(tenantId: string): Promise<StapeClientInfo | null> {
  return readSecret<StapeClientInfo>(stapeClientInfoId(tenantId));
}

// ── Stape PKCE code verifiers ─────────────────────────────────────────────────
// Keyed by sessionId (= OAuth state param). TTL 10 minutes — the OAuth
// round-trip takes seconds, so this is a safe margin.

const PKCE_TTL_MS = 10 * 60 * 1000;

function stapePkceId(sessionId: string): string {
  return `stape-pkce-${sessionId}`;
}

export async function saveStapeCodeVerifier(
  sessionId: string,
  codeVerifier: string
): Promise<void> {
  await writeSecret(stapePkceId(sessionId), {
    codeVerifier,
    expiresAt: Date.now() + PKCE_TTL_MS,
  });
}

export async function getStapeCodeVerifier(sessionId: string): Promise<string | null> {
  const data = await readSecret<{ codeVerifier: string; expiresAt: number }>(
    stapePkceId(sessionId)
  );
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    deleteStapeCodeVerifier(sessionId).catch(() => {});
    return null;
  }
  return data.codeVerifier;
}

export async function deleteStapeCodeVerifier(sessionId: string): Promise<void> {
  try {
    await client().deleteSecret({ name: secretResourceName(stapePkceId(sessionId)) });
  } catch {
    // Already deleted or never existed
  }
}

// ── Stape OAuth discovery state ───────────────────────────────────────────────
// Caches OAuth server metadata for gtm-mcp.stape.ai. TTL 24 hours — the
// server's authorization endpoints rarely change.

const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export interface StapeDiscoveryState {
  authorizationServerUrl: string;
  authorizationServerMetadata?: Record<string, unknown>;
  resourceMetadata?: Record<string, unknown>;
  resourceMetadataUrl?: string;
}

function stapeDiscoveryStateId(tenantId: string): string {
  return `stape-discovery-state-${tenantId}`;
}

export async function saveStapeDiscoveryState(
  tenantId: string,
  state: StapeDiscoveryState
): Promise<void> {
  await writeSecret(stapeDiscoveryStateId(tenantId), {
    state,
    expiresAt: Date.now() + DISCOVERY_TTL_MS,
  });
}

export async function getStapeDiscoveryState(
  tenantId: string
): Promise<StapeDiscoveryState | null> {
  const data = await readSecret<{ state: StapeDiscoveryState; expiresAt: number }>(
    stapeDiscoveryStateId(tenantId)
  );
  if (!data) return null;
  if (data.expiresAt < Date.now()) return null;
  return data.state;
}
