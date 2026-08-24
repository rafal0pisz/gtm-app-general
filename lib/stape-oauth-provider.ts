import { randomUUID } from "crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  getStapeToken,
  saveStapeToken,
  getStapeClientInfo,
  saveStapeClientInfo,
  getStapeCodeVerifier,
  saveStapeCodeVerifier,
  deleteStapeCodeVerifier,
  getStapeDiscoveryState,
  saveStapeDiscoveryState,
  type StapeTokenData,
  type StapeClientInfo,
} from "@/lib/secret-manager";

// ── Special error thrown by redirectToAuthorization ───────────────────────────
// Caught by the /api/stape/auth/start route to return the URL as JSON.

export class RedirectToAuthorizationError extends Error {
  constructor(public readonly url: URL) {
    super("stape_redirect_required");
    this.name = "RedirectToAuthorizationError";
  }
}

// ── App base URL helper ───────────────────────────────────────────────────────

function getAppBaseUrl(): string {
  return (
    process.env.STAPE_REDIRECT_URI?.replace("/api/stape/auth/callback", "") ??
    process.env.GTM_REDIRECT_URI?.replace("/api/gtm/auth/callback", "") ??
    "http://localhost:3000"
  );
}

// ── Logging helper ────────────────────────────────────────────────────────────

function elapsed(t0: number): string {
  return `${Date.now() - t0}ms`;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export class StapeOAuthProvider implements OAuthClientProvider {
  private readonly _tenantId: string;
  private readonly _sessionId: string;

  constructor(tenantId: string, sessionId?: string) {
    this._tenantId = tenantId;
    this._sessionId = sessionId ?? randomUUID();
  }

  get redirectUrl(): string {
    return `${getAppBaseUrl()}/api/stape/auth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Sanofi GTM Assistant",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this._sessionId;
  }

  // ── Discovery state caching ─────────────────────────────────────────────────
  // Stored in Secret Manager so it survives across serverless instances.
  // TTL 24 hours (set by saveStapeDiscoveryState).

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const t0 = Date.now();
    const cached = await getStapeDiscoveryState(this._tenantId);
    if (cached) {
      console.log(
        `[StapeOAuthProvider.discoveryState] found [${elapsed(t0)}] authServer=${cached.authorizationServerUrl}`
      );
      return cached as unknown as OAuthDiscoveryState;
    }
    console.log(`[StapeOAuthProvider.discoveryState] no cached state [${elapsed(t0)}]`);
    return undefined;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const t0 = Date.now();
    await saveStapeDiscoveryState(this._tenantId, state as unknown as import("@/lib/secret-manager").StapeDiscoveryState);
    console.log(
      `[StapeOAuthProvider.saveDiscoveryState] saved [${elapsed(t0)}] authServer=${state.authorizationServerUrl}`
    );
  }

  // ── Client information ──────────────────────────────────────────────────────

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const t0 = Date.now();
    console.log(`[StapeOAuthProvider.clientInformation] start`);
    if (process.env.STAPE_CLIENT_ID) {
      console.log(`[StapeOAuthProvider.clientInformation] resolved from env [${elapsed(t0)}]`);
      return {
        client_id: process.env.STAPE_CLIENT_ID,
        ...(process.env.STAPE_CLIENT_SECRET
          ? { client_secret: process.env.STAPE_CLIENT_SECRET }
          : {}),
      };
    }
    const stored = await getStapeClientInfo(this._tenantId);
    console.log(
      `[StapeOAuthProvider.clientInformation] Secret Manager read [${elapsed(t0)}] → ${stored ? `client_id=${(stored as StapeClientInfo).client_id}` : "null"}`
    );
    return (stored as OAuthClientInformationMixed | null) ?? undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const t0 = Date.now();
    console.log(`[StapeOAuthProvider.saveClientInformation] start client_id=${info.client_id}`);
    await saveStapeClientInfo(this._tenantId, info as StapeClientInfo);
    console.log(`[StapeOAuthProvider.saveClientInformation] done [${elapsed(t0)}]`);
  }

  // ── Tokens ──────────────────────────────────────────────────────────────────

  async tokens(): Promise<OAuthTokens | undefined> {
    const t0 = Date.now();
    console.log(`[StapeOAuthProvider.tokens] start`);
    const stored = await getStapeToken(this._tenantId);
    console.log(
      `[StapeOAuthProvider.tokens] Secret Manager read [${elapsed(t0)}] → ${stored ? "found" : "null"}`
    );
    return (stored as OAuthTokens | null) ?? undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const t0 = Date.now();
    console.log(`[StapeOAuthProvider.saveTokens] start`);
    await saveStapeToken(this._tenantId, tokens as StapeTokenData);
    console.log(`[StapeOAuthProvider.saveTokens] done [${elapsed(t0)}]`);
  }

  // ── Authorization redirect ──────────────────────────────────────────────────

  redirectToAuthorization(authorizationUrl: URL): void {
    console.log(`[StapeOAuthProvider.redirectToAuthorization] → ${authorizationUrl}`);
    throw new RedirectToAuthorizationError(authorizationUrl);
  }

  // ── PKCE ───────────────────────────────────────────────────────────────────
  // Stored in Secret Manager (TTL 10 min) so verifier survives across
  // serverless instances between the /start and /callback requests.

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const t0 = Date.now();
    console.log(`[StapeOAuthProvider.saveCodeVerifier] start session=${this._sessionId}`);
    await saveStapeCodeVerifier(this._sessionId, codeVerifier);
    console.log(`[StapeOAuthProvider.saveCodeVerifier] done [${elapsed(t0)}]`);
  }

  async codeVerifier(): Promise<string> {
    const t0 = Date.now();
    console.log(`[StapeOAuthProvider.codeVerifier] start session=${this._sessionId}`);
    const verifier = await getStapeCodeVerifier(this._sessionId);
    if (!verifier) {
      throw new Error(
        `No PKCE code verifier found for session ${this._sessionId} — expired or flow not started`
      );
    }
    console.log(`[StapeOAuthProvider.codeVerifier] found [${elapsed(t0)}]`);
    // Best-effort cleanup after use
    deleteStapeCodeVerifier(this._sessionId).catch(() => {});
    return verifier;
  }
}
