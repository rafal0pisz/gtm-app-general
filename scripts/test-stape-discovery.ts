/**
 * Probes all OAuth discovery endpoints that @modelcontextprotocol/sdk auth() tries
 * for serverUrl = "https://gtm-mcp.stape.ai/mcp".
 *
 * Run: npx tsx scripts/test-stape-discovery.ts
 */

const TIMEOUT_MS = 8000;
const MCP_PROTOCOL_VERSION = "2025-03-26";

interface ProbeResult {
  url: string;
  label: string;
  status?: number;
  body?: string;
  elapsedMs: number;
  error?: string;
  timedOut?: boolean;
}

async function probe(url: string, label: string, withHeaders: boolean): Promise<ProbeResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = withHeaders
    ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, Accept: "application/json" }
    : { Accept: "application/json" };

  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);
    const elapsedMs = Date.now() - start;
    let body: string;
    try {
      body = await res.text();
    } catch {
      body = "(could not read body)";
    }
    return { url, label, status: res.status, body: body.slice(0, 2000), elapsedMs };
  } catch (err) {
    clearTimeout(timer);
    const elapsedMs = Date.now() - start;
    const timedOut = (err as Error).name === "AbortError";
    return {
      url,
      label,
      elapsedMs,
      timedOut,
      error: timedOut ? `TIMED OUT after ${TIMEOUT_MS}ms` : String(err),
    };
  }
}

function print(r: ProbeResult) {
  const tag = r.timedOut ? "⏱  TIMEOUT" : r.error ? "✗  ERROR  " : `HTTP ${r.status} ${r.status && r.status < 300 ? "✓" : ""}`;
  console.log(`\n${"─".repeat(72)}`);
  console.log(`${tag}  [${r.elapsedMs}ms]  ${r.label}`);
  console.log(`URL: ${r.url}`);
  if (r.error && !r.timedOut) console.log(`Error: ${r.error}`);
  if (r.body !== undefined) {
    try {
      // pretty-print JSON if possible
      console.log("Body:", JSON.stringify(JSON.parse(r.body), null, 2));
    } catch {
      console.log("Body:", r.body || "(empty)");
    }
  }
}

async function main() {
  console.log("=".repeat(72));
  console.log("Stape MCP OAuth discovery probe");
  console.log(`Server URL:  https://gtm-mcp.stape.ai/mcp`);
  console.log(`Timeout:     ${TIMEOUT_MS}ms per request`);
  console.log(`Time:        ${new Date().toISOString()}`);
  console.log("=".repeat(72));

  // ── PHASE 1: oauth-protected-resource ─────────────────────────────────────
  // discoverMetadataWithFallback("https://gtm-mcp.stape.ai/mcp", "oauth-protected-resource")
  //   path-aware:  /.well-known/oauth-protected-resource/mcp
  //   fallback:    /.well-known/oauth-protected-resource
  console.log("\n◆ PHASE 1 — discoverOAuthProtectedResourceMetadata");

  const pr1 = await probe(
    "https://gtm-mcp.stape.ai/.well-known/oauth-protected-resource/mcp",
    "oauth-protected-resource/mcp  (path-aware, WITH headers)",
    true
  );
  print(pr1);

  if (pr1.timedOut || pr1.error || (pr1.status && pr1.status >= 400)) {
    const pr1b = await probe(
      "https://gtm-mcp.stape.ai/.well-known/oauth-protected-resource",
      "oauth-protected-resource       (root fallback, WITH headers)",
      true
    );
    print(pr1b);

    if (pr1b.timedOut || pr1b.error || (pr1b.status && pr1b.status >= 400)) {
      const pr1c = await probe(
        "https://gtm-mcp.stape.ai/.well-known/oauth-protected-resource",
        "oauth-protected-resource       (root fallback, NO headers — CORS retry)",
        false
      );
      print(pr1c);
    }
  }

  // ── PHASE 2: auth server metadata ─────────────────────────────────────────
  // buildDiscoveryUrls("https://gtm-mcp.stape.ai/")
  //   (origin "/" because pathname was "/" when no protected-resource found)
  //     → /.well-known/oauth-authorization-server
  //     → /.well-known/openid-configuration
  console.log("\n◆ PHASE 2 — discoverAuthorizationServerMetadata  (auth server = https://gtm-mcp.stape.ai/)");

  const as1 = await probe(
    "https://gtm-mcp.stape.ai/.well-known/oauth-authorization-server",
    "oauth-authorization-server  (WITH headers)",
    true
  );
  print(as1);

  if (as1.timedOut || as1.error) {
    const as1b = await probe(
      "https://gtm-mcp.stape.ai/.well-known/oauth-authorization-server",
      "oauth-authorization-server  (NO headers — CORS retry)",
      false
    );
    print(as1b);
  }

  const as2 = await probe(
    "https://gtm-mcp.stape.ai/.well-known/openid-configuration",
    "openid-configuration        (WITH headers)",
    true
  );
  print(as2);

  if (as2.timedOut || as2.error) {
    const as2b = await probe(
      "https://gtm-mcp.stape.ai/.well-known/openid-configuration",
      "openid-configuration        (NO headers — CORS retry)",
      false
    );
    print(as2b);
  }

  // ── PHASE 3: Dynamic Client Registration (DCR) ────────────────────────────
  // This happens in registerClient() inside auth() when clientInformation() returns undefined.
  console.log("\n◆ PHASE 3 — POST /register (Dynamic Client Registration)");

  const REDIRECT_URI = "http://localhost:3000/api/stape/auth/callback";
  const dcrBody = JSON.stringify({
    redirect_uris: [REDIRECT_URI],
    client_name: "Sanofi GTM Assistant",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

  {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("https://gtm-mcp.stape.ai/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          Accept: "application/json",
        },
        body: dcrBody,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const elapsedMs = Date.now() - start;
      const body = await res.text();
      const tag = res.ok ? `HTTP ${res.status} ✓` : `HTTP ${res.status}`;
      console.log(`\n${"─".repeat(72)}`);
      console.log(`${tag}  [${elapsedMs}ms]  POST /register`);
      console.log(`URL: https://gtm-mcp.stape.ai/register`);
      try { console.log("Body:", JSON.stringify(JSON.parse(body), null, 2)); }
      catch { console.log("Body:", body || "(empty)"); }
    } catch (err) {
      clearTimeout(timer);
      const elapsedMs = Date.now() - start;
      const timedOut = (err as Error).name === "AbortError";
      console.log(`\n${"─".repeat(72)}`);
      console.log(`${timedOut ? "⏱  TIMEOUT" : "✗  ERROR"}  [${elapsedMs}ms]  POST /register`);
      if (!timedOut) console.log("Error:", err);
    }
  }

  // ── BONUS: MCP endpoint itself ─────────────────────────────────────────────
  console.log("\n◆ BONUS — MCP endpoint & root");

  const mcp = await probe(
    "https://gtm-mcp.stape.ai/mcp",
    "MCP endpoint (GET, WITH headers)",
    true
  );
  print(mcp);

  const root = await probe(
    "https://gtm-mcp.stape.ai/",
    "Root (GET, no headers)",
    false
  );
  print(root);

  console.log(`\n${"=".repeat(72)}`);
  console.log("Done.");
}

main().catch(console.error);
