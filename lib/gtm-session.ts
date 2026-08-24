import { cookies } from "next/headers";
import crypto from "crypto";

// Google OAuth session stored client-side in an encrypted, httpOnly cookie —
// no database, no Secret Manager, no service account. Each browser session
// connects its own Google account; Google's own permission checks on the
// GTM API are the real access boundary, not anything this app enforces.

const COOKIE_NAME = "gtm_session";
const ALGO = "aes-256-gcm";

interface GtmSession {
  access_token: string;
  refresh_token: string;
  expires_at: number; // ms epoch
  email?: string;
}

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured.");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(data: GtmSession): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function decrypt(payload: string): GtmSession | null {
  try {
    const buf = Buffer.from(payload, "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString("utf-8")) as GtmSession;
  } catch {
    return null;
  }
}

const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

async function readSession(): Promise<GtmSession | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  return decrypt(raw);
}

async function writeSession(session: GtmSession): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, encrypt(session), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export async function startSession(tokens: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  email?: string;
}): Promise<void> {
  await writeSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    email: tokens.email,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getSessionStatus(): Promise<{ connected: boolean; email?: string }> {
  const session = await readSession();
  return session ? { connected: true, email: session.email } : { connected: false };
}

// Refreshes the access token if it's expired (or about to), persisting the
// refreshed token back into the cookie. Only callable from a context that
// can set cookies — Route Handlers and Server Actions, not Server Components.
export async function getValidAccessToken(): Promise<{ accessToken: string; email?: string } | null> {
  const session = await readSession();
  if (!session) return null;

  if (session.expires_at > Date.now() + 60_000) {
    return { accessToken: session.access_token, email: session.email };
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GTM_CLIENT_ID!,
      client_secret: process.env.GTM_CLIENT_SECRET!,
      refresh_token: session.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;

  const updated: GtmSession = {
    ...session,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await writeSession(updated);
  return { accessToken: updated.access_token, email: updated.email };
}
