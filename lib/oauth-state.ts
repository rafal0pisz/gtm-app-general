import { cookies } from "next/headers";
import { randomUUID } from "crypto";

// CSRF state for the Google OAuth flow, held in a short-lived cookie instead
// of server memory — an in-memory Map doesn't survive across serverless
// instances, so /start and /callback can easily land on different instances
// and never see each other's state.

const COOKIE_NAME = "gtm_oauth_state";
const MAX_AGE_S = 10 * 60; // 10 minutes

export async function createOAuthState(): Promise<string> {
  const state = randomUUID();
  const store = await cookies();
  store.set(COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_S,
  });
  return state;
}

export async function consumeOAuthState(state: string): Promise<boolean> {
  const store = await cookies();
  const saved = store.get(COOKIE_NAME)?.value;
  store.delete(COOKIE_NAME);
  return !!saved && saved === state;
}
