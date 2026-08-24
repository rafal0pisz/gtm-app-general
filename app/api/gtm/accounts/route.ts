import { getValidAccessToken } from "@/lib/gtm-session";
import { fetchAllGtmContainers } from "@/lib/gtm-containers";

export interface GtmContainer {
  accountId: string;
  accountName: string;
  containerId: string;
  containerName: string;
  publicId: string;
  usageContext: string[];
  parsed: { domain: string; countryCode: string } | null;
}

export async function GET() {
  try {
    const session = await getValidAccessToken();
    if (!session) {
      return Response.json(
        { error: "Brak połączenia z GTM. Połącz konto Google." },
        { status: 404 }
      );
    }

    const containers = await fetchAllGtmContainers(session.accessToken);
    const result: GtmContainer[] = containers
      .map((c) => ({
        accountId: c.accountId,
        accountName: c.accountName,
        containerId: c.containerId,
        containerName: c.containerName,
        publicId: c.publicId,
        usageContext: c.usageContext,
        parsed: c.parsed,
      }))
      .sort((a, b) => a.containerName.localeCompare(b.containerName, "pl"));

    return Response.json({ containers: result });
  } catch (err) {
    console.error("[gtm/accounts] unhandled error:", err);
    return Response.json({ error: "Wewnętrzny błąd serwera." }, { status: 500 });
  }
}
