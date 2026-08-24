import { getValidAccessToken } from "@/lib/gtm-session";
import { fetchContainersForAccounts, type FailedAccount, type GtmAccountInfo } from "@/lib/gtm-containers";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export interface GtmContainer {
  accountId: string;
  accountName: string;
  containerId: string;
  containerName: string;
  publicId: string;
  usageContext: string[];
  parsed: { domain: string; countryCode: string } | null;
}

interface ContainersBody {
  accounts?: Array<{ accountId: string; name: string }>;
}

// Fetches containers for ONE caller-supplied chunk of accounts. The client
// drives this repeatedly over successive chunks of however many accounts it
// has access to — each call only touches a handful of accounts, so it
// finishes in a couple of seconds regardless of the total account count,
// instead of one request trying to scan everything and risking a function
// timeout (or just feeling like it hung).
export async function POST(req: Request) {
  try {
    const session = await getValidAccessToken();
    if (!session) {
      return Response.json(
        { error: "Brak połączenia z GTM. Połącz konto Google." },
        { status: 404 }
      );
    }

    const body = (await req.json()) as ContainersBody;
    const accounts = body.accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return Response.json({ error: "accounts must be a non-empty array." }, { status: 400 });
    }
    if (accounts.length > 25) {
      return Response.json(
        { error: "Max 25 accounts per request — split into smaller chunks." },
        { status: 400 }
      );
    }

    const { containers, failedAccounts, pendingAccounts } = await fetchContainersForAccounts(
      session.accessToken,
      accounts
    );
    const result: GtmContainer[] = containers.map((c) => ({
      accountId: c.accountId,
      accountName: c.accountName,
      containerId: c.containerId,
      containerName: c.containerName,
      publicId: c.publicId,
      usageContext: c.usageContext,
      parsed: c.parsed,
    }));

    const response: {
      containers: GtmContainer[];
      failedAccounts?: FailedAccount[];
      pendingAccounts?: GtmAccountInfo[];
    } = { containers: result };
    if (failedAccounts.length > 0) response.failedAccounts = failedAccounts;
    if (pendingAccounts.length > 0) response.pendingAccounts = pendingAccounts;

    return Response.json(response);
  } catch (err) {
    console.error("[gtm/accounts/containers] unhandled error:", err);
    return Response.json({ error: "Wewnętrzny błąd serwera." }, { status: 500 });
  }
}
