import { getValidAccessToken } from "@/lib/gtm-session";
import { bulkListVersions, type BulkTarget } from "@/lib/gtm-bulk-ops";

export const maxDuration = 300;

interface VersionsBody {
  targets?: BulkTarget[];
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as VersionsBody;
    const targets = body.targets;

    if (!Array.isArray(targets) || targets.length === 0) {
      return Response.json({ error: "targets must be a non-empty array." }, { status: 400 });
    }
    if (targets.length > 20) {
      return Response.json(
        { error: "Max 20 containers per request — split the selection into smaller batches." },
        { status: 400 }
      );
    }

    const session = await getValidAccessToken();
    if (!session) {
      return Response.json({ error: "GTM is not connected. Connect your Google account first." }, { status: 404 });
    }

    const results = await bulkListVersions(session.accessToken, targets);
    return Response.json({ results });
  } catch (err) {
    console.error("[gtm/bulk/versions] unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return Response.json({ error: "Internal server error." }, { status: 500 });
  }
}
