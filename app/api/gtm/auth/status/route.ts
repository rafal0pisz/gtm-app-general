import { getSessionStatus } from "@/lib/gtm-session";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getSessionStatus();
  return Response.json(status);
}
