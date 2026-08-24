import { getGtmWhitelist, saveGtmWhitelist } from "@/lib/secret-manager";
import { TENANT_ID } from "@/lib/tenant";

export async function GET() {
  const whitelist = await getGtmWhitelist(TENANT_ID);
  return Response.json({ whitelist });
}

export async function POST(req: Request) {
  const body = await req.json() as unknown;
  if (!Array.isArray(body) || !body.every((x) => typeof x === "string")) {
    return Response.json(
      { error: "Body musi być tablicą stringów (publicId kontenerów)." },
      { status: 400 }
    );
  }

  await saveGtmWhitelist(TENANT_ID, body as string[]);
  return Response.json({ ok: true, count: body.length });
}
