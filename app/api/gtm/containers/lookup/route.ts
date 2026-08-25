import { getValidAccessToken } from "@/lib/gtm-session";
import { lookupContainersByTagId } from "@/lib/gtm-lookup";
import { adoptPace, currentPaceMs } from "@/lib/gtm-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface LookupBody {
  tagIds?: string[];
  pacingMs?: number;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as LookupBody;
    const tagIds = body.tagIds;

    if (!Array.isArray(tagIds) || tagIds.length === 0) {
      return Response.json({ error: "tagIds must be a non-empty array." }, { status: 400 });
    }
    if (tagIds.length > 100) {
      return Response.json(
        { error: "Max 100 container IDs per request — split them into smaller batches." },
        { status: 400 }
      );
    }

    const session = await getValidAccessToken();
    if (!session) {
      return Response.json({ error: "GTM is not connected. Connect your Google account first." }, { status: 404 });
    }

    if (typeof body.pacingMs === "number") adoptPace(body.pacingMs);

    const outcome = await lookupContainersByTagId(session.accessToken, tagIds);
    return Response.json({ ...outcome, pacingMs: currentPaceMs() });
  } catch (err) {
    console.error("[gtm/containers/lookup] unhandled error:", err instanceof Error ? err.stack ?? err.message : err);
    return Response.json({ error: "Internal server error." }, { status: 500 });
  }
}
