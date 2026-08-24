import { deleteGtmToken } from "@/lib/secret-manager";
import { TENANT_ID } from "@/lib/tenant";

export async function DELETE() {
  try {
    await deleteGtmToken(TENANT_ID);
    return Response.json({ success: true });
  } catch (err) {
    console.error("GTM disconnect error:", err);
    return Response.json({ error: "Nie udało się rozłączyć konta GTM." }, { status: 500 });
  }
}
