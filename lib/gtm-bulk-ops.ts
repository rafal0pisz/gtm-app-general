import type { tagmanager_v2 } from "googleapis";
import { tagmanagerClient, resolveWorkspaceId, workspacePath } from "@/lib/gtm-client";

export interface BulkTarget {
  accountId: string;
  containerId: string;
  containerName: string;
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
  publishTag?: BulkTagSpec;
  pauseTagNames?: string[];
  versionName: string;
  versionNotes?: string;
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

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 1_000;

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

async function findTriggerIdByName(
  tm: tagmanager_v2.Tagmanager,
  parent: string,
  name: string
): Promise<string> {
  const res = await tm.accounts.containers.workspaces.triggers.list({ parent });
  const triggers = res.data.trigger ?? [];
  const match = triggers.find(
    (t) => t.name?.trim().toLowerCase() === name.trim().toLowerCase()
  );
  if (!match?.triggerId) {
    const available = triggers.map((t) => t.name).filter(Boolean).join(", ") || "(none)";
    throw new Error(
      `Trigger "${name}" not found in this container. Available triggers: ${available}`
    );
  }
  return match.triggerId;
}

async function upsertPublishTag(
  tm: tagmanager_v2.Tagmanager,
  parent: string,
  spec: BulkTagSpec,
  existingTags: tagmanager_v2.Schema$Tag[],
  changes: string[]
): Promise<void> {
  const { firingTriggerName, ...tagFields } = spec;
  const firingTriggerId = firingTriggerName
    ? [await findTriggerIdByName(tm, parent, firingTriggerName)]
    : undefined;

  const existing = existingTags.find(
    (t) => t.name?.trim().toLowerCase() === spec.name.trim().toLowerCase()
  );

  if (existing?.tagId) {
    const full = (await tm.accounts.containers.workspaces.tags.get({
      path: `${parent}/tags/${existing.tagId}`,
    })).data;
    const merged: tagmanager_v2.Schema$Tag = {
      ...full,
      ...tagFields,
      ...(firingTriggerId ? { firingTriggerId } : {}),
    };
    await tm.accounts.containers.workspaces.tags.update({
      path: `${parent}/tags/${existing.tagId}`,
      requestBody: merged,
    });
    changes.push(`Tag "${spec.name}" updated (tagId ${existing.tagId})`);
  } else {
    const created = (await tm.accounts.containers.workspaces.tags.create({
      parent,
      requestBody: { ...tagFields, ...(firingTriggerId ? { firingTriggerId } : {}) },
    })).data;
    changes.push(`Tag "${spec.name}" created (tagId ${created.tagId})`);
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
    const match = existingTags.find(
      (t) => t.name?.trim().toLowerCase() === name.toLowerCase()
    );
    if (!match?.tagId) {
      changes.push(`Tag "${name}" not found — skipped`);
      continue;
    }
    if (match.paused) {
      changes.push(`Tag "${name}" already paused — skipped`);
      continue;
    }
    const full = (await tm.accounts.containers.workspaces.tags.get({
      path: `${parent}/tags/${match.tagId}`,
    })).data;
    await tm.accounts.containers.workspaces.tags.update({
      path: `${parent}/tags/${match.tagId}`,
      requestBody: { ...full, paused: true },
    });
    changes.push(`Tag "${name}" paused (tagId ${match.tagId})`);
  }
}

async function applyToContainer(
  tm: tagmanager_v2.Tagmanager,
  target: BulkTarget,
  options: BulkApplyOptions
): Promise<BulkApplyResult> {
  const changes: string[] = [];
  try {
    const workspaceId = await resolveWorkspaceId(tm, target.accountId, target.containerId);
    const parent = workspacePath(target.accountId, target.containerId, workspaceId);

    const needsTagList = !!options.publishTag || (options.pauseTagNames?.length ?? 0) > 0;
    const existingTags = needsTagList
      ? (await tm.accounts.containers.workspaces.tags.list({ parent })).data.tag ?? []
      : [];

    if (options.publishTag) {
      await upsertPublishTag(tm, parent, options.publishTag, existingTags, changes);
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

    const versionRes = await tm.accounts.containers.workspaces.create_version({
      path: parent,
      requestBody: { name: options.versionName, notes: options.versionNotes },
    });
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
  return runInBatches(targets, (target) => applyToContainer(tm, target, options));
}

async function publishOne(
  tm: tagmanager_v2.Tagmanager,
  target: BulkPublishTarget
): Promise<BulkPublishResult> {
  try {
    await tm.accounts.containers.versions.publish({
      path: `accounts/${target.accountId}/containers/${target.containerId}/versions/${target.versionId}`,
    });
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
