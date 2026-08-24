import type { tagmanager_v2 } from "googleapis";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import type { GtmContainerInfo } from "@/lib/gtm-containers";
import { tagmanagerClient, resolveWorkspaceId } from "@/lib/gtm-client";

// Direct Google Tag Manager API v2 tool set — replaces the old Stape MCP
// integration. Deliberately exposes only read + create/update operations for
// tags, triggers and variables. There is no delete/publish/account-management
// tool here at all, so the "hard restrictions" in the system prompt are also
// enforced structurally, not just by asking the model nicely.

function findAccountIdForContainer(
  containers: GtmContainerInfo[],
  containerId: string
): string | undefined {
  return containers.find(
    (c) => c.containerId === containerId || c.publicId === containerId
  )?.accountId;
}

type Args = Record<string, unknown>;

async function resolveScope(
  tm: tagmanager_v2.Tagmanager,
  containers: GtmContainerInfo[],
  args: Args
): Promise<{ parent: string; containerId: string }> {
  const containerId = args.containerId as string | undefined;
  if (!containerId) {
    throw new Error("containerId is required.");
  }
  const accountId =
    (args.accountId as string | undefined) ??
    findAccountIdForContainer(containers, containerId);
  if (!accountId) {
    throw new Error(
      `Could not resolve accountId for container ${containerId}. It may not be on the whitelist.`
    );
  }
  const workspaceId = await resolveWorkspaceId(tm, accountId, containerId);
  return {
    containerId,
    parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
  };
}

// Loose JSON schema shared by tag/trigger/variable create+update tools — the
// GTM API accepts many optional fields (scheduling, consent, priority, ...)
// beyond the common ones spelled out here, so additionalProperties stays
// open and the model can pass through anything else it knows is valid.
const PARAMETER_SCHEMA = {
  type: "array",
  description:
    "GTM Parameter array, e.g. [{\"type\":\"template\",\"key\":\"measurementId\",\"value\":\"G-XXXX\"}]",
  items: { type: "object", additionalProperties: true },
};

function entitySchema(kind: "tag" | "trigger" | "variable", mode: "create" | "update") {
  const properties: Record<string, unknown> = {
    containerId: {
      type: "string",
      description: "Numeric GTM container ID, or its GTM-XXXXXXX public ID.",
    },
    name: { type: "string" },
    type: { type: "string", description: `GTM ${kind} type, e.g. "gaawe" for GA4 event.` },
    parameter: PARAMETER_SCHEMA,
    notes: { type: "string" },
  };
  const required = ["containerId"];

  if (kind === "tag") {
    properties.firingTriggerId = { type: "array", items: { type: "string" } };
    properties.blockingTriggerId = { type: "array", items: { type: "string" } };
  }
  if (kind === "trigger") {
    properties.filter = { type: "array", items: { type: "object", additionalProperties: true } };
    properties.customEventFilter = { type: "array", items: { type: "object", additionalProperties: true } };
  }

  if (mode === "update") {
    properties[`${kind}Id`] = { type: "string", description: `Existing ${kind} ID (from a list_${kind}s call).` };
    required.push(`${kind}Id`);
  } else {
    required.push("name", "type");
  }

  return jsonSchema<Args>({
    type: "object",
    properties,
    required,
    additionalProperties: true,
  } as unknown as JSONSchema7);
}

function stripScopeFields(args: Args, idField?: string): Args {
  const { containerId, accountId, workspaceId, ...rest } = args;
  void containerId;
  void accountId;
  void workspaceId;
  if (idField) delete rest[idField];
  return rest;
}

export async function buildGtmTools(
  accessToken: string,
  containers: GtmContainerInfo[]
): Promise<ToolSet> {
  const tm = tagmanagerClient(accessToken);
  const tools: ToolSet = {};

  const collections: Array<{
    kind: "tag" | "trigger" | "variable";
    api: {
      list: (parent: string) => Promise<unknown[]>;
      create: (parent: string, body: Args) => Promise<unknown>;
      update: (path: string, body: Args) => Promise<unknown>;
    };
  }> = [
    {
      kind: "tag",
      api: {
        list: async (parent) => (await tm.accounts.containers.workspaces.tags.list({ parent })).data.tag ?? [],
        create: async (parent, body) =>
          (await tm.accounts.containers.workspaces.tags.create({ parent, requestBody: body })).data,
        update: async (path, body) =>
          (await tm.accounts.containers.workspaces.tags.update({ path, requestBody: body })).data,
      },
    },
    {
      kind: "trigger",
      api: {
        list: async (parent) =>
          (await tm.accounts.containers.workspaces.triggers.list({ parent })).data.trigger ?? [],
        create: async (parent, body) =>
          (await tm.accounts.containers.workspaces.triggers.create({ parent, requestBody: body })).data,
        update: async (path, body) =>
          (await tm.accounts.containers.workspaces.triggers.update({ path, requestBody: body })).data,
      },
    },
    {
      kind: "variable",
      api: {
        list: async (parent) =>
          (await tm.accounts.containers.workspaces.variables.list({ parent })).data.variable ?? [],
        create: async (parent, body) =>
          (await tm.accounts.containers.workspaces.variables.create({ parent, requestBody: body })).data,
        update: async (path, body) =>
          (await tm.accounts.containers.workspaces.variables.update({ path, requestBody: body })).data,
      },
    },
  ];

  for (const { kind, api } of collections) {
    const plural = `${kind}s`;

    tools[`gtm_list_${plural}`] = dynamicTool({
      description: `List all ${plural} in a GTM container's default workspace.`,
      inputSchema: jsonSchema<Args>({
        type: "object",
        properties: {
          containerId: { type: "string", description: "Numeric GTM container ID, or its GTM-XXXXXXX public ID." },
        },
        required: ["containerId"],
      }),
      execute: async (rawArgs) => {
        const args = rawArgs as Args;
        const { parent } = await resolveScope(tm, containers, args);
        const items = await api.list(parent);
        return JSON.stringify(items);
      },
    });

    tools[`gtm_create_${kind}`] = dynamicTool({
      description: `Create a new ${kind} in a GTM container's default workspace.`,
      inputSchema: entitySchema(kind, "create"),
      execute: async (rawArgs) => {
        const args = rawArgs as Args;
        const { parent } = await resolveScope(tm, containers, args);
        const body = stripScopeFields(args);
        const result = await api.create(parent, body);
        return JSON.stringify(result);
      },
    });

    tools[`gtm_update_${kind}`] = dynamicTool({
      description: `Update an existing ${kind} by ID (call gtm_list_${plural} first to find the ID).`,
      inputSchema: entitySchema(kind, "update"),
      execute: async (rawArgs) => {
        const args = rawArgs as Args;
        const { parent } = await resolveScope(tm, containers, args);
        const idField = `${kind}Id`;
        const entityId = args[idField] as string | undefined;
        if (!entityId) throw new Error(`${idField} is required to update a ${kind}.`);
        const body = stripScopeFields(args, idField);
        const result = await api.update(`${parent}/${plural}/${entityId}`, body);
        return JSON.stringify(result);
      },
    });
  }

  return tools;
}
