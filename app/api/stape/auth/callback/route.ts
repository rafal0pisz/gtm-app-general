import { type NextRequest } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StapeOAuthProvider } from "@/lib/stape-oauth-provider";
import { createTimedFetch } from "@/lib/timed-fetch";
import { TENANT_ID } from "@/lib/tenant";

export const maxDuration = 30;

const STAPE_MCP_URL = "https://gtm-mcp.stape.ai/mcp";

function getRedirectBase(): string {
  return (
    process.env.STAPE_REDIRECT_URI?.replace("/api/stape/auth/callback", "") ??
    process.env.GTM_REDIRECT_URI?.replace("/api/gtm/auth/callback", "") ??
    "http://localhost:3000"
  );
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const base = getRedirectBase();

  if (error) {
    return Response.redirect(
      `${base}/settings?tab=autoryzacja&status=error&reason=${encodeURIComponent(error)}`
    );
  }

  if (!code || !state) {
    return Response.redirect(
      `${base}/settings?tab=autoryzacja&status=error&reason=missing_params`
    );
  }

  // state is the sessionId — links back to the stored PKCE code verifier
  const provider = new StapeOAuthProvider(TENANT_ID, state);
  const fetchFn = createTimedFetch();

  const t0 = Date.now();
  console.log(`[stape/auth/callback] ${new Date(t0).toISOString()} — calling auth() with code`);

  try {
    const result = await auth(provider, {
      serverUrl: STAPE_MCP_URL,
      authorizationCode: code,
      fetchFn,
    });

    const elapsed = Date.now() - t0;
    console.log(`[stape/auth/callback] auth() resolved in ${elapsed}ms → result="${result}"`);

    if (result === "AUTHORIZED") {
      return Response.redirect(`${base}/settings?tab=autoryzacja&status=stape_success`);
    }

    return Response.redirect(
      `${base}/settings?tab=autoryzacja&status=error&reason=auth_incomplete`
    );
  } catch (err) {
    const elapsed = Date.now() - t0;
    console.error(`[stape/auth/callback] auth() threw after ${elapsed}ms:`, err);
    const reason =
      err instanceof Error ? encodeURIComponent(err.message) : "token_exchange";
    return Response.redirect(
      `${base}/settings?tab=autoryzacja&status=error&reason=${reason}`
    );
  }
}
