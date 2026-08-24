import { getSessionStatus } from "@/lib/gtm-session";

export async function GET() {
  const status = await getSessionStatus();
  return Response.json(status);
}
