import { anthropic } from "@ai-sdk/anthropic";
import { streamText, convertToModelMessages, dynamicTool, jsonSchema, type ToolSet } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { wrapToolsWithRules } from "@/lib/gtm-rules-engine";
import { getGtmToken } from "@/lib/secret-manager";
import {
  fetchWhitelistedGtmContainers,
  buildContainerMap,
} from "@/lib/gtm-containers";
import { StapeOAuthProvider, RedirectToAuthorizationError } from "@/lib/stape-oauth-provider";
import { createTimedFetch } from "@/lib/timed-fetch";
import { TENANT_ID } from "@/lib/tenant";
import { findPageElement } from "@/lib/page-reader";

export const maxDuration = 60;

const STAPE_MCP_URL = "https://gtm-mcp.stape.ai/mcp";

// Explicit timeout for each tool/call RPC — the SDK default is 60 s which is
// too long for interactive chat. 20 s is enough for any single GTM operation.
const TOOL_CALL_TIMEOUT_MS = 20_000;

// Timeout for MCP transport HTTP calls (connect + listTools).
const MCP_CONNECT_TIMEOUT_MS = 10_000;

type McpTextContent = { type: "text"; text: string };

// Abbreviate args for log output to avoid flooding logs with full payloads.
function logArgs(args: Record<string, unknown>, maxLength = 300): string {
  try {
    const s = JSON.stringify(args);
    return s.length > maxLength ? s.slice(0, maxLength) + "…" : s;
  } catch {
    return String(args);
  }
}

// Races a promise against a deadline. Throws a descriptive error on timeout.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.error(`[buildStapeTools] ${label} timed out after ${ms}ms`);
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer!));
}

async function buildStapeTools(
  tenantId: string,
  containerWhitelist: Set<string>
): Promise<{ tools: ToolSet; client: Client }> {
  const timedFetch = createTimedFetch(MCP_CONNECT_TIMEOUT_MS);
  const provider = new StapeOAuthProvider(tenantId);
  const client = new Client({ name: "sanofi-gtm", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(STAPE_MCP_URL), {
    authProvider: provider,
    // FetchLike = (url: string | URL, init?) => Promise<Response>; compatible with our wrapper.
    fetch: timedFetch as unknown as (url: string | URL, init?: RequestInit) => Promise<Response>,
  });

  console.log("[buildStapeTools] connecting to Stape MCP...");
  await withTimeout(client.connect(transport), MCP_CONNECT_TIMEOUT_MS, "client.connect()");

  console.log("[buildStapeTools] listing tools...");
  const { tools: mcpTools } = await withTimeout(
    client.listTools(),
    MCP_CONNECT_TIMEOUT_MS,
    "client.listTools()"
  );
  console.log(`[buildStapeTools] connected — ${mcpTools.length} tools available`);

  const tools: ToolSet = {};

  for (const mcpTool of mcpTools) {
    const toolName = mcpTool.name;
    tools[toolName] = dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema<Record<string, unknown>>(
        mcpTool.inputSchema as Record<string, unknown>
      ),
      execute: async (args) => {
        const rawArgs = args as Record<string, unknown>;

        // Enforce whitelist: block operations on containers not in the whitelist.
        const publicId =
          (rawArgs.publicId as string | undefined) ??
          (rawArgs.containerId as string | undefined);
        if (publicId && containerWhitelist.size > 0 && !containerWhitelist.has(publicId)) {
          throw new Error(
            `Container ${publicId} is not on the whitelist. Allowed containers: ${[...containerWhitelist].join(", ")}`
          );
        }

        console.log(`[mcp:${toolName}] →`, logArgs(rawArgs));
        const t0 = Date.now();

        let result;
        try {
          result = await client.callTool(
            { name: toolName, arguments: rawArgs },
            undefined,
            { timeout: TOOL_CALL_TIMEOUT_MS }
          );
        } catch (err) {
          console.error(
            `[mcp:${toolName}] ✗ threw [${Date.now() - t0}ms]:`,
            err instanceof Error ? err.stack ?? err.message : err
          );
          throw err;
        }

        const textParts = (result.content as McpTextContent[])
          .filter((c) => c.type === "text")
          .map((c) => c.text);

        if (result.isError) {
          const errMsg = textParts.join("\n") || "MCP tool error";
          console.error(`[mcp:${toolName}] ✗ isError=true [${Date.now() - t0}ms]:`, errMsg);
          throw new Error(errMsg);
        }

        console.log(`[mcp:${toolName}] ✓ [${Date.now() - t0}ms]`);
        return textParts.join("\n") || JSON.stringify(result.content);
      },
    });
  }

  return { tools, client };
}

export async function POST(req: Request) {
  let mcpClient: Client | undefined;

  try {
    const { messages } = await req.json();

    const [gtmTokenData, gtmContainers] = await Promise.all([
      getGtmToken(TENANT_ID),
      fetchWhitelistedGtmContainers(TENANT_ID),
    ]);

    const gtmContainerMap = buildContainerMap(gtmContainers);
    // Include both publicId (GTM-XXXXXXX) and numeric containerId so the whitelist
    // check in buildStapeTools passes regardless of which form the caller uses.
    const containerWhitelist = new Set(
      gtmContainers.flatMap((c) => [c.publicId, c.containerId])
    );

    let tools: ToolSet | undefined;

    try {
      const stape = await buildStapeTools(TENANT_ID, containerWhitelist);
      mcpClient = stape.client;
      tools = await wrapToolsWithRules(stape.tools, gtmContainerMap);
    } catch (err) {
      if (err instanceof RedirectToAuthorizationError) {
        console.error("[chat] buildStapeTools → RedirectToAuthorizationError: transport demanded re-auth despite token being present in Secret Manager. URL:", err.url?.toString());
      } else {
        console.error("[chat] buildStapeTools failed:", err instanceof Error ? err.stack ?? err.message : err);
      }
    }

    // GTM connection status: true when Stape MCP connected successfully
    const gtmConnected = !!tools;

    // Add local container listing tool (whitelist-aware, Stape doesn't handle this)
    if (tools) {
      tools["gtm_list_accounts_and_containers"] = dynamicTool({
        description:
          "List all GTM accounts and containers available to the agent. Returns only whitelisted containers — not all containers on the user's Google account. Use this first to discover what you have access to before performing operations.",
        inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
        execute: async () => {
          const containers = Array.from(gtmContainerMap.entries()).map(([publicId, info]) => ({
            publicId,
            containerName: info.containerName,
            accountName: info.accountName,
            accountId: info.accountId,
            containerId: info.containerId,
          }));
          if (containers.length === 0) {
            return "No containers are currently available. The whitelist may be empty or GTM is not connected.";
          }
          return JSON.stringify(containers);
        },
      });
    }

    // find_page_element is always available regardless of GTM/Stape connection
    const pageReaderTool = dynamicTool({
      description:
        "Render a public web page using headless Chromium and find an interactive element (button, link, form field) matching a natural-language description. Use this to discover stable CSS selectors for GTM click triggers. Only works on publicly accessible pages — pages behind login will not load.",
      inputSchema: jsonSchema<{ url: string; description: string }>({
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL of the page to inspect (must be publicly accessible)" },
          description: { type: "string", description: "Natural-language description of the element to find, e.g. 'Add to cart button' or 'Newsletter subscribe link'" },
        },
        required: ["url", "description"],
      }),
      execute: async (input) => {
        const { url, description } = input as { url: string; description: string };
        console.log(`[find_page_element] url=${url} description=${description}`);
        const t0 = Date.now();
        try {
          const result = await findPageElement(url, description);
          console.log(`[find_page_element] match=${result.match} [${Date.now() - t0}ms]`);
          return JSON.stringify(result);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[find_page_element] error [${Date.now() - t0}ms]:`, msg);
          return JSON.stringify({ error: msg });
        }
      },
    });

    const allTools: ToolSet = { ...(tools ?? {}), find_page_element: pageReaderTool };

    const result = streamText({
      model: anthropic("claude-opus-4-8"),
      system: buildSystemPrompt({ gtmConnected, gtmContainers }),
      messages: await convertToModelMessages(messages),
      maxOutputTokens: 16000,
      tools: allTools,
      onFinish: async ({ finishReason }) => {
        if (finishReason === "error") {
          console.error("[chat] streamText finished with finishReason=error");
        }
        await mcpClient?.close().catch((err) =>
          console.error("[chat] MCP client close error:", err instanceof Error ? err.message : err)
        );
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    console.error("[chat] unhandled error in POST handler:", err instanceof Error ? err.stack ?? err.message : err);
    await mcpClient?.close().catch(() => {});
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
