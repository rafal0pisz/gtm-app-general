import { type NextRequest } from "next/server";
import { consumeOAuthState } from "@/lib/oauth-state";
import { startSession } from "@/lib/gtm-session";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const redirectBase =
    process.env.GTM_REDIRECT_URI?.replace("/api/gtm/auth/callback", "") ?? "http://localhost:3000";

  if (error) {
    return Response.redirect(`${redirectBase}/?status=error&reason=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return Response.redirect(`${redirectBase}/?status=error&reason=missing_params`);
  }

  const valid = await consumeOAuthState(state);
  if (!valid) {
    return Response.redirect(`${redirectBase}/?status=error&reason=invalid_state`);
  }

  const clientId = process.env.GTM_CLIENT_ID!;
  const clientSecret = process.env.GTM_CLIENT_SECRET!;
  const redirectUri = process.env.GTM_REDIRECT_URI ?? "http://localhost:3000/api/gtm/auth/callback";

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });

  if (!tokenRes.ok) {
    return Response.redirect(`${redirectBase}/?status=error&reason=token_exchange`);
  }

  const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number };

  if (!tokenData.refresh_token) {
    return Response.redirect(`${redirectBase}/?status=error&reason=no_refresh_token`);
  }

  let email: string | undefined;
  try {
    const infoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (infoRes.ok) {
      const info = await infoRes.json() as { email?: string };
      email = info.email;
    }
  } catch {
    // email optional
  }

  await startSession({
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in ?? 3600,
    email,
  });

  return Response.redirect(`${redirectBase}/?status=success`);
}
