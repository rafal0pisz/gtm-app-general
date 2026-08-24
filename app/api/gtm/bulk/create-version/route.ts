import { getValidAccessToken } from "@/lib/gtm-session";
import { bulkCreateVersionsFromWorkspaces, type CreateVersionTarget } from "@/lib/gtm-bulk-ops";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

interface CreateVersionBody {
  targets?: CreateVersionTarget[];
  versionName?: string;
  versionNotes?: string;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateVersionBody;
    const targets = body.targets;
    const versionName = body.versionName?.trim();

    if (!Array.isArray(targets) || targets.length === 0) {
      return Response.json({ error: "targets must be a non-empty array." }, { status: 400 });
    }
    if (targets.length > 20) {
      return Response.json(
        { error: "Max 20 containers per request — split the selection into smaller batches." },
        { status: 400 }
      );
    }
    if (!versionName) {
      return Response.json({ error: "versionName is required." }, { status: 400 });
    }

    const session = await getValidAccessToken();
    if (!session) {
      return Response.json({ error: "GTM is not connected. Connect your Google account first." }, { status: 404 });
    }

    const results = await bulkCreateVersionsFromWorkspaces(
      session.accessToken,
      targets,
      versionName,
      body.versionNotes?.trim() || undefined
    );
    return Response.json({ results });
  } catch (err) {
    console.error("[gtm/bulk/create-version] unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return Response.json({ error: "Internal server error." }, { status: 500 });
  }
}
