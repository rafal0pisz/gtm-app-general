import type { tagmanager_v2 } from "googleapis";
import { tagmanagerClient, resolveWorkspaceId, workspacePath, withRetry } from "@/lib/gtm-client";

export interface BulkTarget {
  accountId: string;
  containerId: string;
  containerName: string;
}

export interface SourceContainer {
  accountId: string;
  containerId: string;
}

export interface BulkTagSpec {
  // Arbitrary GTM Tag fields (name, type, parameter, notes, priority,
  // consentSettings, ...) — pasted in as-is by the user, sent through to the
  // GTM API mostly unmodified. `name` is required: it's how an existing tag
  // with the same name is found for update instead of creating a duplicate.
  name: string;
  [key: string]: unknown;
  // Not a GTM API field — resolved per-container to a firingTriggerId,
  // since trigger IDs aren't portable across containers.
  firingTriggerName?: string;
}

export interface BulkApplyOptions {
  publishTags?: BulkTagSpec[];
  pauseTagNames?: string[];
  versionName: string;
  versionNotes?: string;
  // When a tag's type is a custom-template reference ("cvt_<templateId>"),
  // that template must already exist in the *target* container — the ID is
  // local to whichever container defines it. If given, the referenced
  // template is copied from this container into each target container
  // (matched/reused if already present there) before the tag is created.
  sourceContainer?: SourceContainer;
}

export interface BulkApplyResult {
  accountId: string;
  containerId: string;
  containerName: string;
  status: "ok" | "error";
  changes: string[];
  versionId?: string;
  versionName?: string;
  error?: string;
}

export interface BulkPublishTarget {
  accountId: string;
  containerId: string;
  containerName: string;
  versionId: string;
}

export interface BulkPublishResult {
  accountId: string;
  containerId: string;
  containerName: string;
  versionId: string;
  status: "ok" | "error";
  error?: string;
}

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 2_000;
// Small stagger between individual write calls within one container — the
// Tag Manager API quota is per-user across all containers combined, so a
// burst of 10+ tag creates/updates back to back is as risky as concurrency
// across containers.
const CALL_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runInBatches<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_DELAY_MS);
    const batch = items.slice(i, i + BATCH_SIZE);
    const settled = await Promise.all(batch.map((item) => worker(item)));
    results.push(...settled);
  }
  return results;
}

// Trigger name → ID, fetched at most once per container regardless of how
// many tags need a trigger resolved.
class TriggerResolver {
  private map: Map<string, string> | null = null;

  constructor(private tm: tagmanager_v2.Tagmanager, private parent: string) {}

  async resolve(name: string): Promise<string> {
    if (!this.map) {
      const res = await withRetry(
        () => this.tm.accounts.containers.workspaces.triggers.list({ parent: this.parent }),
        "triggers.list"
      );
      this.map = new Map(
        (res.data.trigger ?? [])
          .filter((t) => t.name && t.triggerId)
          .map((t) => [t.name!.trim().toLowerCase(), t.triggerId!])
      );
    }
    const id = this.map.get(name.trim().toLowerCase());
    if (!id) {
      const available = Array.from(this.map.keys()).join(", ") || "(none)";
      throw new Error(`Trigger "${name}" not found in this container. Available triggers: ${available}`);
    }
    return id;
  }
}

// Two custom templates are "the same" if they came from the same Community
// Gallery entry, or — for a hand-built (non-gallery) template — if they
// have the exact same display name. Good enough to avoid re-importing (and
// duplicating) a template that's already present in the target container.
function sameTemplate(
  a: tagmanager_v2.Schema$CustomTemplate,
  b: tagmanager_v2.Schema$CustomTemplate
): boolean {
  if (a.galleryReference && b.galleryReference) {
    return (
      a.galleryReference.host === b.galleryReference.host &&
      a.galleryReference.owner === b.galleryReference.owner &&
      a.galleryReference.repository === b.galleryReference.repository
    );
  }
  return !!a.name && a.name === b.name;
}

// Resolves a tag `type` like "cvt_62480338_7" (a Custom Template Gallery
// reference) to whatever type string is valid *in the target container* —
// the numeric ID is local to whichever container owns that template
// instance, so the same literal type string from a pasted tag JSON is only
// ever correct in the one container it was copied from. Imports the
// template into the target container (or reuses a matching one already
// there) exactly once per container, regardless of how many tags reference
// it.
class CustomTemplateResolver {
  private sourceTemplates: tagmanager_v2.Schema$CustomTemplate[] | null = null;
  private targetTemplates: tagmanager_v2.Schema$CustomTemplate[] | null = null;
  private cache = new Map<string, string>();

  constructor(
    private tm: tagmanager_v2.Tagmanager,
    private sourceParent: string,
    private targetParent: string
  ) {}

  async resolve(sourceType: string): Promise<string> {
    const match = /^cvt_(.+)$/.exec(sourceType);
    if (!match) return sourceType;

    const cached = this.cache.get(sourceType);
    if (cached) return cached;

    if (!this.sourceTemplates) {
      const res = await withRetry(
        () => this.tm.accounts.containers.workspaces.templates.list({ parent: this.sourceParent }),
        "templates.list(source)"
      );
      this.sourceTemplates = res.data.template ?? [];
    }
    // The exact encoding of a custom-template tag's `type` isn't documented,
    // so try several plausible candidates against what a workspace's
    // templates.list() actually returns, instead of assuming one is right.
    const suffix = match[1];
    const beforeUnderscore = suffix.split("_")[0];
    const sourceTemplate = this.sourceTemplates.find(
      (t) =>
        t.templateId === suffix ||
        t.templateId === beforeUnderscore ||
        t.galleryReference?.galleryTemplateId === suffix ||
        t.galleryReference?.galleryTemplateId === beforeUnderscore
    );
    if (!sourceTemplate) {
      const available = this.sourceTemplates
        .map(
          (t) =>
            `"${t.name}" (templateId=${t.templateId}, galleryTemplateId=${t.galleryReference?.galleryTemplateId ?? "—"})`
        )
        .join("; ");
      throw new Error(
        `Custom template for type "${sourceType}" was not found in the source container's workspace. ` +
          `Templates present there: ${available || "(none)"}`
      );
    }

    if (!this.targetTemplates) {
      const res = await withRetry(
        () => this.tm.accounts.containers.workspaces.templates.list({ parent: this.targetParent }),
        "templates.list(target)"
      );
      this.targetTemplates = res.data.template ?? [];
    }

    let targetTemplate = this.targetTemplates.find((t) => sameTemplate(t, sourceTemplate));
    if (!targetTemplate) {
      const body = stripIdentityFields({ ...sourceTemplate }) as tagmanager_v2.Schema$CustomTemplate;
      const created = await withRetry(
        () => this.tm.accounts.containers.workspaces.templates.create({ parent: this.targetParent, requestBody: body }),
        "templates.create"
      );
      targetTemplate = created.data;
      this.targetTemplates.push(targetTemplate);
    }
    if (!targetTemplate.templateId) {
      throw new Error(`Failed to import custom template "${sourceTemplate.name ?? suffix}" into this container.`);
    }

    const targetType = `cvt_${targetTemplate.templateId}`;
    this.cache.set(sourceType, targetType);
    return targetType;
  }
}

// Fields that identify WHERE a tag lives (account/container/workspace/tag
// ID, its computed path, fingerprint, live URL). If the pasted JSON came
// from an existing tag (exported, or copied from another container), these
// point at that *source* container — spreading them onto a different
// container's create/update request makes the GTM API reject it with
// "Mismatched key with path or parent". They must always come from whatever
// container is currently being written to, never from user input.
const IDENTITY_FIELDS = [
  "accountId",
  "containerId",
  "workspaceId",
  "tagId",
  "fingerprint",
  "path",
  "tagManagerUrl",
] as const;

function stripIdentityFields(obj: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...obj };
  for (const field of IDENTITY_FIELDS) delete clone[field];
  return clone;
}

async function upsertPublishTag(
  tm: tagmanager_v2.Tagmanager,
  parent: string,
  spec: BulkTagSpec,
  knownByName: Map<string, tagmanager_v2.Schema$Tag>,
  triggers: TriggerResolver,
  templates: CustomTemplateResolver | null,
  changes: string[]
): Promise<tagmanager_v2.Schema$Tag> {
  const { firingTriggerName, ...rest } = spec;
  const tagFields = stripIdentityFields(rest);
  const firingTriggerId = firingTriggerName ? [await triggers.resolve(firingTriggerName)] : undefined;

  if (typeof tagFields.type === "string" && tagFields.type.startsWith("cvt_")) {
    if (!templates) {
      throw new Error(
        `Tag type "${tagFields.type}" is a custom-template reference, which needs a source container specified to copy that template from.`
      );
    }
    tagFields.type = await templates.resolve(tagFields.type);
  }

  const key = spec.name.trim().toLowerCase();
  const existing = knownByName.get(key);

  if (existing?.tagId) {
    // `existing` already comes from tags.list(), which returns full Tag
    // resources — no need for an extra tags.get() before merging.
    const merged: tagmanager_v2.Schema$Tag = {
      ...existing,
      ...tagFields,
      ...(firingTriggerId ? { firingTriggerId } : {}),
    };
    const updated = (
      await withRetry(
        () =>
          tm.accounts.containers.workspaces.tags.update({
            path: `${parent}/tags/${existing.tagId}`,
            requestBody: merged,
          }),
        "tags.update"
      )
    ).data;
    changes.push(`Tag "${spec.name}" updated (tagId ${existing.tagId})`);
    return updated;
  } else {
    const created = (
      await withRetry(
        () =>
          tm.accounts.containers.workspaces.tags.create({
            parent,
            requestBody: { ...tagFields, ...(firingTriggerId ? { firingTriggerId } : {}) },
          }),
        "tags.create"
      )
    ).data;
    changes.push(`Tag "${spec.name}" created (tagId ${created.tagId})`);
    return created;
  }
}

async function pauseTagsByName(
  tm: tagmanager_v2.Tagmanager,
  parent: string,
  names: string[],
  existingTags: tagmanager_v2.Schema$Tag[],
  changes: string[]
): Promise<void> {
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const match = existingTags.find((t) => t.name?.trim().toLowerCase() === name.toLowerCase());
    if (!match?.tagId) {
      changes.push(`Tag "${name}" not found — skipped`);
      continue;
    }
    if (match.paused) {
      changes.push(`Tag "${name}" already paused — skipped`);
      continue;
    }
    await sleep(CALL_DELAY_MS);
    await withRetry(
      () =>
        tm.accounts.containers.workspaces.tags.update({
          path: `${parent}/tags/${match.tagId}`,
          requestBody: { ...match, paused: true },
        }),
      "tags.update"
    );
    changes.push(`Tag "${name}" paused (tagId ${match.tagId})`);
  }
}

async function applyToContainer(
  tm: tagmanager_v2.Tagmanager,
  target: BulkTarget,
  options: BulkApplyOptions,
  sourceParent: string | null
): Promise<BulkApplyResult> {
  const changes: string[] = [];
  try {
    const workspaceId = await resolveWorkspaceId(tm, target.accountId, target.containerId);
    const parent = workspacePath(target.accountId, target.containerId, workspaceId);
    const triggers = new TriggerResolver(tm, parent);
    const templates = sourceParent ? new CustomTemplateResolver(tm, sourceParent, parent) : null;

    const needsTagList = (options.publishTags?.length ?? 0) > 0 || (options.pauseTagNames?.length ?? 0) > 0;
    const existingTags = needsTagList
      ? (await withRetry(() => tm.accounts.containers.workspaces.tags.list({ parent }), "tags.list")).data.tag ?? []
      : [];

    if (options.publishTags?.length) {
      const knownByName = new Map(
        existingTags.filter((t) => t.name).map((t) => [t.name!.trim().toLowerCase(), t])
      );
      for (const tagSpec of options.publishTags) {
        await sleep(CALL_DELAY_MS);
        const result = await upsertPublishTag(tm, parent, tagSpec, knownByName, triggers, templates, changes);
        knownByName.set(tagSpec.name.trim().toLowerCase(), result);
      }
    }
    if (options.pauseTagNames?.length) {
      await pauseTagsByName(tm, parent, options.pauseTagNames, existingTags, changes);
    }

    if (changes.length === 0) {
      return {
        accountId: target.accountId,
        containerId: target.containerId,
        containerName: target.containerName,
        status: "error",
        changes,
        error: "Nothing to do — no matching tags and no publish tag configured.",
      };
    }

    const versionRes = await withRetry(
      () =>
        tm.accounts.containers.workspaces.create_version({
          path: parent,
          requestBody: { name: options.versionName, notes: options.versionNotes },
        }),
      "workspaces.create_version"
    );
    const version = versionRes.data.containerVersion;

    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      status: "ok",
      changes,
      versionId: version?.containerVersionId ?? undefined,
      versionName: version?.name ?? options.versionName,
    };
  } catch (err) {
    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      status: "error",
      changes,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function bulkApply(
  accessToken: string,
  targets: BulkTarget[],
  options: BulkApplyOptions
): Promise<BulkApplyResult[]> {
  const tm = tagmanagerClient(accessToken);

  let sourceParent: string | null = null;
  if (options.sourceContainer) {
    const { accountId, containerId } = options.sourceContainer;
    const workspaceId = await resolveWorkspaceId(tm, accountId, containerId);
    sourceParent = workspacePath(accountId, containerId, workspaceId);
  }

  return runInBatches(targets, (target) => applyToContainer(tm, target, options, sourceParent));
}

async function publishOne(
  tm: tagmanager_v2.Tagmanager,
  target: BulkPublishTarget
): Promise<BulkPublishResult> {
  try {
    await withRetry(
      () =>
        tm.accounts.containers.versions.publish({
          path: `accounts/${target.accountId}/containers/${target.containerId}/versions/${target.versionId}`,
        }),
      "versions.publish"
    );
    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      versionId: target.versionId,
      status: "ok",
    };
  } catch (err) {
    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      versionId: target.versionId,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function bulkPublish(
  accessToken: string,
  targets: BulkPublishTarget[]
): Promise<BulkPublishResult[]> {
  const tm = tagmanagerClient(accessToken);
  return runInBatches(targets, (target) => publishOne(tm, target));
}

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  description?: string;
}

export interface ContainerWorkspacesResult {
  accountId: string;
  containerId: string;
  containerName: string;
  workspaces: WorkspaceSummary[];
  error?: string;
}

async function fetchWorkspacesForContainer(
  tm: tagmanager_v2.Tagmanager,
  target: BulkTarget
): Promise<ContainerWorkspacesResult> {
  try {
    const parent = `accounts/${target.accountId}/containers/${target.containerId}`;
    const res = await withRetry(
      () => tm.accounts.containers.workspaces.list({ parent }),
      "workspaces.list",
      { budgetMs: 15_000 }
    );
    const workspaces: WorkspaceSummary[] = (res.data.workspace ?? [])
      .filter((w) => w.workspaceId)
      .map((w) => ({
        workspaceId: w.workspaceId!,
        name: w.name || `Workspace ${w.workspaceId}`,
        description: w.description ?? undefined,
      }));

    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      workspaces,
    };
  } catch (err) {
    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      workspaces: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function bulkListWorkspaces(
  accessToken: string,
  targets: BulkTarget[]
): Promise<ContainerWorkspacesResult[]> {
  const tm = tagmanagerClient(accessToken);
  return runInBatches(targets, (target) => fetchWorkspacesForContainer(tm, target));
}

export interface CreateVersionTarget {
  accountId: string;
  containerId: string;
  containerName: string;
  workspaceId: string;
}

export interface CreateVersionResult {
  accountId: string;
  containerId: string;
  containerName: string;
  status: "ok" | "error";
  versionId?: string;
  versionName?: string;
  error?: string;
}

// Snapshots whatever is currently in the given workspace into a new
// container version — no tag edits, just "turn this draft into a
// version," e.g. for a workspace someone else already finished editing.
async function createVersionFromWorkspace(
  tm: tagmanager_v2.Tagmanager,
  target: CreateVersionTarget,
  versionName: string,
  versionNotes: string | undefined
): Promise<CreateVersionResult> {
  try {
    const parent = workspacePath(target.accountId, target.containerId, target.workspaceId);
    const versionRes = await withRetry(
      () =>
        tm.accounts.containers.workspaces.create_version({
          path: parent,
          requestBody: { name: versionName, notes: versionNotes },
        }),
      "workspaces.create_version"
    );
    const version = versionRes.data.containerVersion;
    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      status: "ok",
      versionId: version?.containerVersionId ?? undefined,
      versionName: version?.name ?? versionName,
    };
  } catch (err) {
    return {
      accountId: target.accountId,
      containerId: target.containerId,
      containerName: target.containerName,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function bulkCreateVersionsFromWorkspaces(
  accessToken: string,
  targets: CreateVersionTarget[],
  versionName: string,
  versionNotes: string | undefined
): Promise<CreateVersionResult[]> {
  const tm = tagmanagerClient(accessToken);
  return runInBatches(targets, (target) => createVersionFromWorkspace(tm, target, versionName, versionNotes));
}
