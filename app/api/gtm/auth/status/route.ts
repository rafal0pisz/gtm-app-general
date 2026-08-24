import { getGtmStatus } from "@/lib/secret-manager";
import { TENANT_ID } from "@/lib/tenant";

export async function GET() {
  const status = await getGtmStatus(TENANT_ID);
  return Response.json(status);
}
