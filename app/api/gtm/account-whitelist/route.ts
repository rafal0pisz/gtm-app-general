import { getGtmAccountWhitelist, saveGtmAccountWhitelist } from "@/lib/secret-manager";
import { TENANT_ID } from "@/lib/tenant";

export async function GET() {
  const whitelist = await getGtmAccountWhitelist(TENANT_ID);
  return Response.json({ whitelist });
}

export async function POST(req: Request) {
  const body = await req.json() as unknown;
  if (!Array.isArray(body) || !body.every((x) => typeof x === "string")) {
    return Response.json(
      { error: "Body must be an array of accountId strings." },
      { status: 400 }
    );
  }
  await saveGtmAccountWhitelist(TENANT_ID, body as string[]);
  return Response.json({ ok: true, count: body.length });
}
