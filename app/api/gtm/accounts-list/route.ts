import { getGtmToken, getGtmAccountWhitelist } from "@/lib/secret-manager";
import { exchangeGtmToken, fetchGtmAccountList } from "@/lib/gtm-containers";
import { TENANT_ID } from "@/lib/tenant";

export interface GtmAccount {
  accountId: string;
  name: string;
  isWhitelisted: boolean;
}

export async function GET() {
  const token = await getGtmToken(TENANT_ID);
  if (!token) {
    return Response.json(
      { error: "GTM not connected. Connect your account in Settings → Authorization." },
      { status: 404 }
    );
  }

  let accessToken: string;
  try {
    accessToken = await exchangeGtmToken(token.refresh_token);
  } catch (err) {
    console.error("[gtm/accounts-list] token refresh failed:", err);
    return Response.json({ error: "Token refresh failed." }, { status: 500 });
  }

  const [accounts, whitelist] = await Promise.all([
    fetchGtmAccountList(accessToken),
    getGtmAccountWhitelist(TENANT_ID),
  ]);

  const wlSet = new Set(whitelist);
  const result: GtmAccount[] = accounts.map((a) => ({
    accountId: a.accountId,
    name: a.name,
    isWhitelisted: wlSet.has(a.accountId),
  }));

  return Response.json({ accounts: result });
}
