import { getValidAccessToken } from "@/lib/gtm-session";
import { fetchGtmAccountList } from "@/lib/gtm-containers";

export const dynamic = "force-dynamic";

// Just the account list — fast (one or two paginated calls), regardless of
// how many accounts there are. Fetching containers per account is a
// separate, chunked step (see /api/gtm/accounts/containers) so that step
// can't blow past a function time limit no matter how many accounts exist.
export async function GET() {
  try {
    const session = await getValidAccessToken();
    if (!session) {
      return Response.json(
        { error: "Brak połączenia z GTM. Połącz konto Google." },
        { status: 404 }
      );
    }

    const accounts = await fetchGtmAccountList(session.accessToken);
    return Response.json({ accounts });
  } catch (err) {
    console.error("[gtm/accounts] unhandled error:", err);
    return Response.json({ error: "Wewnętrzny błąd serwera." }, { status: 500 });
  }
}
