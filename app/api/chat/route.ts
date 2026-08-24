import { anthropic } from "@ai-sdk/anthropic";
import { streamText, convertToModelMessages, dynamicTool, jsonSchema, type ToolSet } from "ai";
import { buildSystemPrompt } from "@/lib/system-prompt";
import { wrapToolsWithRules } from "@/lib/gtm-rules-engine";
import { buildGtmTools } from "@/lib/gtm-tools";
import { getGtmToken } from "@/lib/secret-manager";
import {
  fetchWhitelistedGtmContainers,
  buildContainerMap,
  exchangeGtmToken,
} from "@/lib/gtm-containers";
import { TENANT_ID } from "@/lib/tenant";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    const [gtmTokenData, gtmContainers] = await Promise.all([
      getGtmToken(TENANT_ID),
      fetchWhitelistedGtmContainers(TENANT_ID),
    ]);

    const gtmContainerMap = buildContainerMap(gtmContainers);

    let tools: ToolSet | undefined;

    if (gtmTokenData) {
      try {
        const accessToken = await exchangeGtmToken(gtmTokenData.refresh_token);
        const gtmTools = await buildGtmTools(accessToken, gtmContainers);
        tools = await wrapToolsWithRules(gtmTools, gtmContainerMap);
      } catch (err) {
        console.error(
          "[chat] buildGtmTools failed:",
          err instanceof Error ? err.stack ?? err.message : err
        );
      }
    }

    const gtmConnected = !!tools;

    // Local container listing tool (whitelist-aware).
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

    const result = streamText({
      model: anthropic("claude-opus-4-8"),
      system: buildSystemPrompt({ gtmConnected, gtmContainers }),
      messages: await convertToModelMessages(messages),
      maxOutputTokens: 16000,
      tools: tools ?? {},
      onFinish: ({ finishReason }) => {
        if (finishReason === "error") {
          console.error("[chat] streamText finished with finishReason=error");
        }
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (err) {
    console.error("[chat] unhandled error in POST handler:", err instanceof Error ? err.stack ?? err.message : err);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
