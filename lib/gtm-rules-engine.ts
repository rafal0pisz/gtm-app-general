import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import {
  fetchTaxonomyGtm,
  fetchTaxonomyEvents,
  fetchReferenceConfig,
  type TaxonomyGtm,
  type TaxonomyEvents,
  type ReferenceConfig,
} from "@/lib/reference-data";
import type { GtmContainerMap } from "@/lib/gtm-containers";

// ── Naming helpers ────────────────────────────────────────────────────────────

function applyNamingPattern(name: string, pattern: string | undefined): string {
  if (!pattern) return name;
  // Pattern uses placeholders like {PLATFORM} {TYPE} {DESCRIPTION}.
  // We can't fully auto-fill every placeholder from just the name, but we
  // can normalise the casing to match the most common conventions:
  // - If pattern is all-caps: UPPER_SNAKE_CASE
  // - If pattern uses dots: lowercase.dot.notation
  // - If pattern uses dashes: kebab-case
  // For now, pass the name through — enforcement is done via error messages.
  return name;
}

function normaliseName(name: string, example: string | undefined): string {
  if (!example) return name;
  // Detect separator convention from example
  if (example.includes("_")) return name.replace(/-/g, "_");
  if (example.includes("-") && !example.includes("_")) return name.replace(/_/g, "-");
  return name;
}

// ── Event name fuzzy match ────────────────────────────────────────────────────

function findClosestEvent(
  eventName: string,
  events: Record<string, unknown>
): string | null {
  const lower = eventName.toLowerCase().replace(/[-\s]/g, "_");
  for (const key of Object.keys(events)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

// ── MCP tool args types ───────────────────────────────────────────────────────

type Args = Record<string, unknown>;

// Cast a ToolSet entry to a callable execute fn (bypasses AI SDK v7 2-arg signature)
function exec(t: unknown): (args: Args) => Promise<unknown> {
  return (t as { execute: (args: Args) => Promise<unknown> }).execute;
}

// Abbreviate an args object for log output — avoids flooding logs with full payloads.
function logArgs(args: Args, maxLength = 300): string {
  try {
    const s = JSON.stringify(args);
    return s.length > maxLength ? s.slice(0, maxLength) + "…" : s;
  } catch {
    return String(args);
  }
}

// ── Rules engine factory ──────────────────────────────────────────────────────

const PUBLIC_ID_RE = /^GTM-[A-Z0-9]+$/i;

function resolveContainerId(args: Args, containerMap: GtmContainerMap): Args {
  const raw = args.containerId as string | undefined;
  if (!raw || !PUBLIC_ID_RE.test(raw)) return args;
  const upper = raw.toUpperCase();
  const info = containerMap.get(upper) ?? containerMap.get(raw);
  if (!info) return args;
  const changes: Args = { containerId: info.containerId };
  const logParts = [`containerId ${raw} → ${info.containerId}`];
  if (args.accountId && args.accountId !== info.accountId) {
    changes.accountId = info.accountId;
    logParts.push(`accountId ${args.accountId as string} → ${info.accountId}`);
  }
  console.log(`[rules] translated ${logParts.join(", ")}`);
  return { ...args, ...changes };
}

export async function wrapToolsWithRules(rawTools: ToolSet, containerMap: GtmContainerMap): Promise<ToolSet> {
  const [taxonomyGtm, taxonomyEvents, referenceConfig] = await Promise.all([
    fetchTaxonomyGtm().catch(() => ({} as TaxonomyGtm)),
    fetchTaxonomyEvents().catch(() => ({} as TaxonomyEvents)),
    fetchReferenceConfig().catch(() => ({} as ReferenceConfig)),
  ]);

  const wrapped: ToolSet = {};

  for (const [toolName, tool] of Object.entries(rawTools)) {
    const isMutatingTags = toolName.includes("create_tag") || toolName.includes("update_tag");
    const isMutatingTriggers =
      toolName.includes("create_trigger") || toolName.includes("update_trigger");
    const isMutatingVariables =
      toolName.includes("create_variable") || toolName.includes("update_variable");
    const isMutating = isMutatingTags || isMutatingTriggers || isMutatingVariables;

    if (!isMutating) {
      wrapped[toolName] = dynamicTool({
        description: (tool as { description?: string }).description ?? "",
        inputSchema:
          (tool as { inputSchema?: ReturnType<typeof jsonSchema> }).inputSchema ??
          jsonSchema<Args>({ type: "object", properties: {} }),
        execute: async (rawInput) => {
          const translated = resolveContainerId(rawInput as Args, containerMap);
          console.log(`[rules:${toolName}] →`, logArgs(translated));
          const t0 = Date.now();
          try {
            const result = await exec(tool)(translated);
            console.log(`[rules:${toolName}] ✓ [${Date.now() - t0}ms]`);
            return result;
          } catch (err) {
            console.error(`[rules:${toolName}] ✗ [${Date.now() - t0}ms]:`, err instanceof Error ? err.stack ?? err.message : err);
            throw err;
          }
        },
      });
      continue;
    }

    wrapped[toolName] = dynamicTool({
      description: (tool as { description?: string }).description ?? "",
      inputSchema:
        (tool as { inputSchema?: ReturnType<typeof jsonSchema> }).inputSchema ??
        jsonSchema<Args>({ type: "object", properties: {} }),
      execute: async (rawInput) => {
        const mutated: Args = resolveContainerId({ ...(rawInput as Args) }, containerMap);

        // ── 1. NAMING ──────────────────────────────────────────────────────
        const naming = taxonomyGtm.naming_taxonomy;
        if (naming && typeof mutated.name === "string") {
          const currentName = mutated.name as string;
          if (isMutatingTags && naming.tag) {
            mutated.name = applyNamingPattern(
              normaliseName(currentName, naming.tag.example),
              naming.tag.pattern
            );
          } else if (isMutatingTriggers && naming.trigger) {
            mutated.name = normaliseName(currentName, naming.trigger.example);
          } else if (isMutatingVariables && naming.variable) {
            mutated.name = normaliseName(currentName, naming.variable.example);
          }
        }

        // ── 2. TAG TYPE VALIDATION ──────────────────────────────────────────
        if (isMutatingTags) {
          const tagType = mutated.type as string | undefined;
          if (tagType && taxonomyGtm.platforms) {
            const allAllowedTypes = Array.from(
              new Set(
                Object.values(taxonomyGtm.platforms).flatMap(
                  (p) => p.tag_types ?? []
                )
              )
            );
            if (allAllowedTypes.length > 0 && !allAllowedTypes.includes(tagType)) {
              throw new Error(
                `Tag type "${tagType}" is not allowed. Permitted types: ${allAllowedTypes.join(", ")}.`
              );
            }
          }
        }

        // ── 3. BLOCKING TRIGGER CHECK ───────────────────────────────────────
        if (isMutatingTags && taxonomyGtm.platforms) {
          const tagType = mutated.type as string | undefined;
          for (const platform of Object.values(taxonomyGtm.platforms)) {
            for (const rule of platform.consent_rules ?? []) {
              if (rule.tag_type && tagType && rule.tag_type === tagType) {
                const required = rule.required_blocking_trigger;
                if (!required) continue;
                const blockingTriggers = (mutated.blockingTriggerId as string[] | undefined) ?? [];
                const firingTriggers = (mutated.firingTriggerId as string[] | undefined) ?? [];
                const allTriggers = [...blockingTriggers, ...firingTriggers];
                const hasBlocking = allTriggers.some((t) =>
                  typeof t === "string" && t.includes(required)
                );
                if (!hasBlocking) {
                  throw new Error(
                    `Tag type "${tagType}" requires a blocking trigger named "${required}" (consent rule). ` +
                      `Add this trigger to the blockingTriggerId array before creating the tag.`
                  );
                }
              }
            }
          }
        }

        // ── 4. DEPENDENCY: auto-create config tags if missing ───────────────
        if (isMutatingTags && taxonomyGtm.platforms) {
          const tagType = mutated.type as string | undefined;
          for (const platform of Object.values(taxonomyGtm.platforms)) {
            for (const rule of platform.implementation_rules ?? []) {
              if (
                rule.rule === "require_existing_config_or_autocreate" &&
                rule.config_tag_type &&
                tagType &&
                rule.condition &&
                tagType.includes(rule.condition.replace("tag_type == ", "").replace(/"/g, "").trim())
              ) {
                // Check if config tag exists: call list_tags if available
                const listTagsTool = rawTools["list_tags"] ?? rawTools["gtm_list_tags"];
                if (listTagsTool) {
                  try {
                    const existing = await exec(listTagsTool)({
                      containerId: mutated.containerId,
                      workspaceId: mutated.workspaceId,
                    });
                    const existingStr =
                      typeof existing === "string" ? existing : JSON.stringify(existing);
                    const configType = rule.config_tag_type;
                    if (!existingStr.includes(configType)) {
                      // Auto-create config tag from reference-config or defaults
                      const createTagTool =
                        rawTools["create_tag"] ?? rawTools["gtm_create_tag"];
                      if (createTagTool) {
                        const configFromRef = (referenceConfig as ReferenceConfig & { config_tags?: Args[] }).config_tags?.find(
                          (ct) => (ct.type as string) === configType
                        );
                        const configArgs: Args = configFromRef
                          ? {
                              ...configFromRef,
                              containerId: mutated.containerId,
                              workspaceId: mutated.workspaceId,
                            }
                          : {
                              name: `Config - ${configType}`,
                              type: configType,
                              parameter: [],
                              firingTriggerId: [],
                              containerId: mutated.containerId,
                              workspaceId: mutated.workspaceId,
                            };
                        await exec(createTagTool)(configArgs);
                      }
                    }
                  } catch {
                    // Non-fatal: dependency check failed, proceed with original call
                  }
                }
              }
            }
          }
        }

        // ── 5. REQUIRED RESOURCES FROM REFERENCE-CONFIG ────────────────────
        if (isMutatingTags && referenceConfig.triggers) {
          const listTriggersTool =
            rawTools["list_triggers"] ?? rawTools["gtm_list_triggers"];
          const createTriggerTool =
            rawTools["create_trigger"] ?? rawTools["gtm_create_trigger"];
          if (listTriggersTool && createTriggerTool) {
            try {
              const existingTriggersRaw = await exec(listTriggersTool)({
                containerId: mutated.containerId,
                workspaceId: mutated.workspaceId,
              });
              const existingStr =
                typeof existingTriggersRaw === "string"
                  ? existingTriggersRaw
                  : JSON.stringify(existingTriggersRaw);
              for (const refTrigger of referenceConfig.triggers) {
                if (!existingStr.includes(refTrigger.name)) {
                  const { name, type, filter, ...rest } = refTrigger;
                  await exec(createTriggerTool)({
                    name,
                    type,
                    ...(filter ? { filter } : {}),
                    ...rest,
                    containerId: mutated.containerId,
                    workspaceId: mutated.workspaceId,
                  });
                }
              }
            } catch {
              // Non-fatal: proceed even if resource pre-check fails
            }
          }
        }

        if (isMutatingTags && referenceConfig.variables) {
          const listVarsTool =
            rawTools["list_variables"] ?? rawTools["gtm_list_variables"];
          const createVarTool =
            rawTools["create_variable"] ?? rawTools["gtm_create_variable"];
          if (listVarsTool && createVarTool) {
            try {
              const existingVarsRaw = await exec(listVarsTool)({
                containerId: mutated.containerId,
                workspaceId: mutated.workspaceId,
              });
              const existingStr =
                typeof existingVarsRaw === "string"
                  ? existingVarsRaw
                  : JSON.stringify(existingVarsRaw);
              for (const refVar of referenceConfig.variables) {
                if (!existingStr.includes(refVar.name)) {
                  await exec(createVarTool)({
                    ...refVar,
                    containerId: mutated.containerId,
                    workspaceId: mutated.workspaceId,
                  });
                }
              }
            } catch {
              // Non-fatal
            }
          }
        }

        // ── 6. EVENT / PARAMETER NAME VALIDATION (GA4, Meta) ───────────────
        if (isMutatingTags) {
          const tagType = (mutated.type as string | undefined) ?? "";
          const isGA4Event = tagType === "gaawe" || tagType.includes("ga4");
          const isMeta =
            tagType.includes("meta") ||
            tagType.includes("facebook") ||
            tagType.includes("fbq");

          const eventName = extractEventName(mutated);

          if (eventName && taxonomyEvents.platforms) {
            const platformKey = isGA4Event ? "ga4" : isMeta ? "meta" : null;
            if (platformKey) {
              const platformData = taxonomyEvents.platforms[platformKey];
              if (platformData?.events) {
                const events = platformData.events;
                if (!events[eventName]) {
                  const corrected = findClosestEvent(eventName, events);
                  if (corrected) {
                    // Auto-correct the event name
                    setEventName(mutated, corrected);
                  } else {
                    const available = Object.keys(events).join(", ");
                    throw new Error(
                      `Event name "${eventName}" is not in the ${platformKey.toUpperCase()} taxonomy. ` +
                        `Available events: ${available}.`
                    );
                  }
                }
                // Validate parameter names if we can find them
                const paramNames = extractParamNames(mutated);
                const allowedParams = Object.keys(
                  events[eventName]?.parameters ?? {}
                );
                if (allowedParams.length > 0) {
                  for (const param of paramNames) {
                    if (!allowedParams.includes(param)) {
                      const corrected = findClosestEvent(param, events[eventName]?.parameters ?? {});
                      if (corrected) {
                        replaceParamName(mutated, param, corrected);
                      }
                      // Unknown params are not fatal — just allow them through
                    }
                  }
                }
              }
            }
          }
        }

        // ── Execute the original tool with possibly-mutated args ────────────
        console.log(`[rules:${toolName}] →`, logArgs(mutated));
        const t0 = Date.now();
        try {
          const result = await exec(tool)(mutated);
          console.log(`[rules:${toolName}] ✓ [${Date.now() - t0}ms]`);
          return result;
        } catch (err) {
          console.error(`[rules:${toolName}] ✗ [${Date.now() - t0}ms]:`, err instanceof Error ? err.stack ?? err.message : err);
          throw err;
        }
      },
    });
  }

  return wrapped;
}

// ── Helpers to extract/set event names from GTM tag parameter arrays ──────────

function extractEventName(args: Args): string | null {
  const params = args.parameter as Array<{ key: string; value?: string }> | undefined;
  if (!Array.isArray(params)) return null;
  const ep = params.find((p) => p.key === "eventName" || p.key === "event_name");
  return ep?.value ?? null;
}

function setEventName(args: Args, name: string): void {
  const params = args.parameter as Array<{ key: string; value?: string }> | undefined;
  if (!Array.isArray(params)) return;
  const ep = params.find((p) => p.key === "eventName" || p.key === "event_name");
  if (ep) ep.value = name;
}

function extractParamNames(args: Args): string[] {
  const params = args.parameter as Array<{ key: string; value?: string }> | undefined;
  if (!Array.isArray(params)) return [];
  return params
    .filter((p) => p.key === "eventParameters" || p.key === "userProperties")
    .flatMap((p) => {
      try {
        const list = JSON.parse(p.value ?? "[]") as Array<{ name?: string }>;
        return list.map((item) => item.name ?? "").filter(Boolean);
      } catch {
        return [];
      }
    });
}

function replaceParamName(args: Args, oldName: string, newName: string): void {
  const params = args.parameter as Array<{ key: string; value?: string }> | undefined;
  if (!Array.isArray(params)) return;
  for (const p of params) {
    if (p.key === "eventParameters" || p.key === "userProperties") {
      try {
        const list = JSON.parse(p.value ?? "[]") as Array<{ name?: string }>;
        for (const item of list) {
          if (item.name === oldName) item.name = newName;
        }
        p.value = JSON.stringify(list);
      } catch {
        // ignore
      }
    }
  }
}
