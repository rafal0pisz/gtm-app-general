import { getValidAccessToken } from "@/lib/gtm-session";
import { bulkApply, type BulkTarget, type BulkTagSpec, type SourceContainer } from "@/lib/gtm-bulk-ops";

export const maxDuration = 300;

interface ApplyBody {
  targets?: BulkTarget[];
  publishTags?: BulkTagSpec[];
  pauseTagNames?: string[];
  versionName?: string;
  versionNotes?: string;
  sourceContainer?: SourceContainer;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ApplyBody;
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
    if (!(body.publishTags && body.publishTags.length > 0) && !(body.pauseTagNames && body.pauseTagNames.length > 0)) {
      return Response.json(
        { error: "Provide at least one publishTags entry or a non-empty pauseTagNames list." },
        { status: 400 }
      );
    }

    const session = await getValidAccessToken();
    if (!session) {
      return Response.json({ error: "GTM is not connected. Connect your Google account first." }, { status: 404 });
    }

    const results = await bulkApply(session.accessToken, targets, {
      publishTags: body.publishTags,
      pauseTagNames: body.pauseTagNames,
      versionName: body.versionName || `Bulk update ${new Date().toISOString()}`,
      versionNotes: body.versionNotes,
      sourceContainer: body.sourceContainer,
    });

    return Response.json({ results });
  } catch (err) {
    console.error("[gtm/bulk/apply] unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return Response.json({ error: "Internal server error." }, { status: 500 });
  }
}
