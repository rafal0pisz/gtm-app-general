import { deleteStapeToken } from "@/lib/secret-manager";
import { TENANT_ID } from "@/lib/tenant";

export async function DELETE() {
  try {
    await deleteStapeToken(TENANT_ID);
    return Response.json({ success: true });
  } catch (err) {
    console.error("[stape/auth/disconnect] error:", err);
    return Response.json({ error: "Failed to disconnect Stape account." }, { status: 500 });
  }
}
