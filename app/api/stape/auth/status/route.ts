import { getStapeStatus } from "@/lib/secret-manager";
import { TENANT_ID } from "@/lib/tenant";

export async function GET() {
  const status = await getStapeStatus(TENANT_ID);
  return Response.json(status);
}
