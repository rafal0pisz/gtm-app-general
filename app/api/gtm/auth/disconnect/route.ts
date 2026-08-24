import { clearSession } from "@/lib/gtm-session";

export async function DELETE() {
  try {
    await clearSession();
    return Response.json({ success: true });
  } catch (err) {
    console.error("GTM disconnect error:", err);
    return Response.json({ error: "Nie udało się rozłączyć konta GTM." }, { status: 500 });
  }
}
