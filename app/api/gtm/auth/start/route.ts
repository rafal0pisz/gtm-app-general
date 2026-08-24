import { createOAuthState } from "@/lib/oauth-state";

export async function GET() {
  const clientId = process.env.GTM_CLIENT_ID;
  const redirectUri = process.env.GTM_REDIRECT_URI ?? "http://localhost:3000/api/gtm/auth/callback";

  if (!clientId) {
    return Response.json({ error: "GTM_CLIENT_ID not configured" }, { status: 500 });
  }

  const state = createOAuthState();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/tagmanager.readonly",
      "https://www.googleapis.com/auth/tagmanager.edit.containers",
      "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
      "https://www.googleapis.com/auth/tagmanager.publish",
      "https://www.googleapis.com/auth/tagmanager.manage.accounts",
      "https://www.googleapis.com/auth/tagmanager.manage.users",
      "https://www.googleapis.com/auth/userinfo.email",
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return Response.json({ url });
}
