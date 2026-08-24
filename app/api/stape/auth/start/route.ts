import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StapeOAuthProvider, RedirectToAuthorizationError } from "@/lib/stape-oauth-provider";
import { createTimedFetch } from "@/lib/timed-fetch";
import { TENANT_ID } from "@/lib/tenant";

export const maxDuration = 30;

const STAPE_MCP_URL = "https://gtm-mcp.stape.ai/mcp";

export async function GET() {
  const provider = new StapeOAuthProvider(TENANT_ID);
  const fetchFn = createTimedFetch();

  const t0 = Date.now();
  console.log(`[stape/auth/start] ${new Date(t0).toISOString()} — calling auth()`);

  try {
    const result = await auth(provider, { serverUrl: STAPE_MCP_URL, fetchFn });

    const elapsed = Date.now() - t0;
    console.log(`[stape/auth/start] auth() resolved in ${elapsed}ms → result="${result}"`);

    if (result === "AUTHORIZED") {
      return Response.json({ alreadyAuthorized: true });
    }

    return Response.json({ error: "Unexpected auth result" }, { status: 500 });
  } catch (err) {
    const elapsed = Date.now() - t0;

    if (err instanceof RedirectToAuthorizationError) {
      console.log(`[stape/auth/start] RedirectToAuthorizationError in ${elapsed}ms → ${err.url}`);
      return Response.json({ url: err.url.toString() });
    }

    console.error(`[stape/auth/start] auth() threw after ${elapsed}ms:`, err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to initiate Stape authorization" },
      { status: 500 }
    );
  }
}
