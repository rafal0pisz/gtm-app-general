import { getGtmToken, getGtmWhitelist } from "@/lib/secret-manager";
import { TENANT_ID } from "@/lib/tenant";
import { fetchAllGtmContainers } from "@/lib/gtm-containers";

export interface GtmContainer {
  accountId: string;
  accountName: string;
  containerId: string;
  containerName: string;
  publicId: string;
  usageContext: string[];
  isWhitelisted: boolean;
  parsed: { domain: string; countryCode: string } | null;
}

export async function GET(req: Request) {
  try {
    return await handleGET(req);
  } catch (err) {
    console.error("[gtm/accounts] unhandled error:", err);
    return Response.json({ error: "Wewnętrzny błąd serwera." }, { status: 500 });
  }
}

async function handleGET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "true";

  const token = await getGtmToken(TENANT_ID);
  if (!token) {
    return Response.json(
      { error: "Brak połączenia z GTM. Połącz konto w zakładce Autoryzacja." },
      { status: 404 }
    );
  }

  const [containers, whitelist] = await Promise.all([
    fetchAllGtmContainers(TENANT_ID, force),
    getGtmWhitelist(TENANT_ID),
  ]);

  const whitelistSet = new Set(whitelist);
  const noRestriction = whitelist.length === 0;

  const result = {
    containers: containers
      .map((c): GtmContainer => ({
        ...c,
        isWhitelisted: noRestriction ? true : whitelistSet.has(c.publicId),
      }))
      .sort((a, b) => a.containerName.localeCompare(b.containerName, "pl")),
  };

  return Response.json(result);
}
