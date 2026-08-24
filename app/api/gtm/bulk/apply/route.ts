import { getGtmToken } from "@/lib/secret-manager";
import { exchangeGtmToken } from "@/lib/gtm-containers";
import { TENANT_ID } from "@/lib/tenant";
import { bulkApply, type BulkTarget, type BulkTagSpec } from "@/lib/gtm-bulk-ops";

export const maxDuration = 300;

interface ApplyBody {
  targets?: BulkTarget[];
  publishTag?: BulkTagSpec;
  pauseTagNames?: string[];
  versionName?: string;
  versionNotes?: string;
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
    if (!body.publishTag && !(body.pauseTagNames && body.pauseTagNames.length > 0)) {
      return Response.json(
        { error: "Provide at least a publishTag or a non-empty pauseTagNames list." },
        { status: 400 }
      );
    }

    const tokenData = await getGtmToken(TENANT_ID);
    if (!tokenData) {
      return Response.json({ error: "GTM is not connected. Connect it in Settings → Authorization." }, { status: 404 });
    }
    const accessToken = await exchangeGtmToken(tokenData.refresh_token);

    const results = await bulkApply(accessToken, targets, {
      publishTag: body.publishTag,
      pauseTagNames: body.pauseTagNames,
      versionName: body.versionName || `Bulk update ${new Date().toISOString()}`,
      versionNotes: body.versionNotes,
    });

    return Response.json({ results });
  } catch (err) {
    console.error("[gtm/bulk/apply] unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return Response.json({ error: "Internal server error." }, { status: 500 });
  }
}
