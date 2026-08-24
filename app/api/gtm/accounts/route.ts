import { getValidAccessToken } from "@/lib/gtm-session";
import { fetchAllGtmContainers, type FailedAccount } from "@/lib/gtm-containers";

export const dynamic = "force-dynamic";
// Scanning 100+ GTM accounts can take a while — without this the route was
// silently killed by Vercel's default function timeout partway through,
// which looked exactly like "it just never loads."
export const maxDuration = 300;

export interface GtmContainer {
  accountId: string;
  accountName: string;
  containerId: string;
  containerName: string;
  publicId: string;
  usageContext: string[];
  parsed: { domain: string; countryCode: string } | null;
}

export async function GET(req: Request) {
  try {
    const session = await getValidAccessToken();
    if (!session) {
      return Response.json(
        { error: "Brak połączenia z GTM. Połącz konto Google." },
        { status: 404 }
      );
    }

    const idsParam = new URL(req.url).searchParams.get("ids");
    const targetPublicIds = idsParam
      ? new Set(idsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))
      : undefined;

    const { containers, failedAccounts, notFoundIds } = await fetchAllGtmContainers(
      session.accessToken,
      targetPublicIds
    );
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

    const response: {
      containers: GtmContainer[];
      failedAccounts?: FailedAccount[];
      notFoundIds?: string[];
    } = { containers: result };
    if (failedAccounts.length > 0) response.failedAccounts = failedAccounts;
    if (notFoundIds && notFoundIds.length > 0) response.notFoundIds = notFoundIds;

    return Response.json(response);
  } catch (err) {
    console.error("[gtm/accounts] unhandled error:", err);
    return Response.json({ error: "Wewnętrzny błąd serwera." }, { status: 500 });
  }
}
