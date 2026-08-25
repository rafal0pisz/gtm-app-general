"use client";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { GtmContainer } from "@/app/api/gtm/accounts/containers/route";
import { scanAccountsForContainers } from "@/lib/container-scan";
import { clearCachedScan, describeCacheAge, loadCachedScan, saveCachedScan } from "@/lib/container-cache";

// See globals.css — radii are defined there alongside the palette.
const R = "var(--radius)";
const R_LG = "var(--radius-lg)";
// Kept small: each container can take a while now that write calls retry
// with backoff on GTM API quota errors, so a big chunk risks the Vercel
// function timing out before it finishes.
const CHUNK_SIZE = 4;
// Listing workspaces is read-only and one call per container, so it can go
// much wider than the write paths. Capped at what the route accepts.
const WORKSPACE_CHUNK_SIZE = 20;
// How many accounts' containers to ask for per /api/gtm/accounts/containers
// call. The server stops at its own deadline and hands back whatever it
// didn't reach, so this is an upper bound on one round-trip's work, not a
// promise that all of it gets done in that call.
const ACCOUNT_CHUNK_SIZE = 25;
// How many times an account that errored is retried before it's reported as
// failed. Quota errors are transient, so a couple of extra passes clears
// nearly all of them without the user doing anything.
const MAX_ACCOUNT_ATTEMPTS = 3;

interface ApplyResult {
  accountId: string;
  containerId: string;
  containerName: string;
  status: "ok" | "error";
  changes: string[];
  versionId?: string;
  versionName?: string;
  error?: string;
}

interface PublishResult {
  accountId: string;
  containerId: string;
  containerName: string;
  versionId: string;
  status: "ok" | "error";
  error?: string;
}

interface BulkTargetRow {
  accountId: string;
  containerId: string;
  containerName: string;
}

interface ContainerWorkspacesRow {
  accountId: string;
  containerId: string;
  containerName: string;
  workspaces: { workspaceId: string; name: string; description?: string }[];
  error?: string;
}

interface CreateVersionResult {
  accountId: string;
  containerId: string;
  containerName: string;
  status: "ok" | "error";
  versionId?: string;
  versionName?: string;
  error?: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Accepts: a single tag object, a bare array of tag objects, or a GTM
// "Export Container" style wrapper ({ tag: [...] } or
// { containerVersion: { tag: [...] } }) — pulls out the array of tag objects
// either way.
function extractTagObjects(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.tag)) return obj.tag as Record<string, unknown>[];
    const cv = obj.containerVersion;
    if (cv && typeof cv === "object" && Array.isArray((cv as Record<string, unknown>).tag)) {
      return (cv as Record<string, unknown>).tag as Record<string, unknown>[];
    }
    if (typeof obj.name === "string") return [obj];
  }
  return [];
}

export function BulkOpsPanel({ accountKey = "default" }: { accountKey?: string }) {
  // ── Container picker ────────────────────────────────────────────────────
  const [containers, setContainers] = useState<GtmContainer[]>([]);
  // When the list came from the cache rather than a live scan: the timestamp
  // it was saved at, so the UI can say how stale it might be.
  const [fromCache, setFromCache] = useState<number | null>(null);
  const cachedPacingRef = useRef(0);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [containersError, setContainersError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failedAccounts, setFailedAccounts] = useState<{ accountId: string; name: string; error: string }[]>([]);
  const [notFoundIds, setNotFoundIds] = useState<string[]>([]);
  const [targetIdsRaw, setTargetIdsRaw] = useState("");
  const [accountScanProgress, setAccountScanProgress] = useState<{ done: number; total: number } | null>(null);
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── Publish-tag form ────────────────────────────────────────────────────
  const [publishEnabled, setPublishEnabled] = useState(true);
  const [tagJsonText, setTagJsonText] = useState("");
  const [firingTriggerName, setFiringTriggerName] = useState("All Pages");
  const [sourceContainerId, setSourceContainerId] = useState("");

  // ── Pause-tags form ─────────────────────────────────────────────────────
  const [pauseEnabled, setPauseEnabled] = useState(false);
  const [pauseNamesRaw, setPauseNamesRaw] = useState("");

  // ── Version info ────────────────────────────────────────────────────────
  const [versionName, setVersionName] = useState("");
  const [versionNotes, setVersionNotes] = useState("");

  // ── Apply run state ─────────────────────────────────────────────────────
  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number } | null>(null);
  const [applyResults, setApplyResults] = useState<ApplyResult[]>([]);
  const [applyError, setApplyError] = useState<string | null>(null);

  // ── Publish run state ───────────────────────────────────────────────────
  const [selectedForPublish, setSelectedForPublish] = useState<Set<string>>(new Set());
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishProgress, setPublishProgress] = useState<{ done: number; total: number } | null>(null);
  const [publishResults, setPublishResults] = useState<PublishResult[]>([]);
  const [publishError, setPublishError] = useState<string | null>(null);

  // ── Publish from an existing workspace (independent of Apply/Publish above) ─
  const [workspacesResults, setWorkspacesResults] = useState<ContainerWorkspacesRow[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspacesProgress, setWorkspacesProgress] = useState<{ done: number; total: number } | null>(null);
  const [chosenWorkspace, setChosenWorkspace] = useState<Map<string, string>>(new Map());
  const [workspaceVersionName, setWorkspaceVersionName] = useState("");
  const [workspaceVersionNotes, setWorkspaceVersionNotes] = useState("");
  const [creatingVersions, setCreatingVersions] = useState(false);
  const [createVersionProgress, setCreateVersionProgress] = useState<{ done: number; total: number } | null>(null);
  const [createVersionResults, setCreateVersionResults] = useState<CreateVersionResult[]>([]);
  const [confirmingVersionPublish, setConfirmingVersionPublish] = useState(false);
  const [versionPublishing, setVersionPublishing] = useState(false);
  const [versionPublishProgress, setVersionPublishProgress] = useState<{ done: number; total: number } | null>(null);
  const [versionPublishResults, setVersionPublishResults] = useState<PublishResult[]>([]);

  const fetchContainers = useCallback(async () => {
    setContainersError(null);
    setFailedAccounts([]);
    setNotFoundIds([]);
    setContainers([]);
    setLoadingContainers(true);
    setAccountScanProgress(null);
    setFromCache(null);

    try {
      const targetIds = new Set(
        targetIdsRaw.split(/[\n,]/).map((s) => s.trim().toUpperCase()).filter(Boolean)
      );
      const isTargeted = targetIds.size > 0;

      const accountsRes = await fetch("/api/gtm/accounts", { cache: "no-store" });
      if (!accountsRes.ok) {
        const data = (await accountsRes.json()) as { error?: string };
        setContainersError(data.error ?? "Unknown error");
        return;
      }
      const { accounts: allAccounts } = (await accountsRes.json()) as {
        accounts: { accountId: string; name: string }[];
      };

      setAccountScanProgress({ done: 0, total: allAccounts.length });

      let pacingMs = cachedPacingRef.current;
      const scan = await scanAccountsForContainers<GtmContainer>({
        accounts: allAccounts,
        chunkSize: ACCOUNT_CHUNK_SIZE,
        maxAttempts: MAX_ACCOUNT_ATTEMPTS,
        targetPublicIds: isTargeted ? targetIds : undefined,
        publicIdOf: (c) => c.publicId,
        fetchChunk: async (batch) => {
          const res = await fetch("/api/gtm/accounts/containers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Each chunk may be served by a different instance, so the pace
            // the last one settled on is handed forward — otherwise every
            // chunk relearns the quota limit from scratch by hitting it.
            body: JSON.stringify({ accounts: batch, pacingMs }),
          });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error ?? `HTTP ${res.status}`);
          }
          const data = (await res.json()) as { pacingMs?: number };
          if (typeof data.pacingMs === "number") pacingMs = data.pacingMs;
          return data as Awaited<ReturnType<typeof res.json>>;
        },
        // Update as it goes so the list and progress are visibly moving
        // rather than a frozen spinner.
        onProgress: ({ containers: found, done, total }) => {
          setContainers(found);
          setAccountScanProgress({ done, total });
        },
      });

      setContainers(scan.containers);
      setFailedAccounts(scan.failedAccounts);
      setNotFoundIds(scan.notFoundIds);
      if (isTargeted) setSelected(new Set(scan.containers.map((c) => c.publicId)));
      setLoaded(true);

      cachedPacingRef.current = pacingMs;
      // Only a full sweep is worth caching. A targeted scan stops as soon as
      // it finds the requested IDs, so storing its result would leave a
      // partial list masquerading as the complete one.
      //
      // A sweep with some accounts still failing is cached anyway: an account
      // the user genuinely can't read would otherwise block caching forever,
      // and a nearly-complete list available instantly beats no list at all.
      if (!isTargeted) {
        saveCachedScan(accountKey, scan.containers, pacingMs);
      }
    } catch {
      setContainersError("Failed to load the container list.");
    } finally {
      setLoadingContainers(false);
    }
  }, [targetIdsRaw, accountKey]);

  // Fill the picker from the last full scan the moment the panel opens, so
  // the common case costs no API calls at all.
  useEffect(() => {
    const cached = loadCachedScan(accountKey);
    if (!cached) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrating from browser storage on mount
    setContainers(cached.containers);
    setFromCache(cached.savedAt);
    setLoaded(true);
    cachedPacingRef.current = cached.pacingMs ?? 0;
  }, [accountKey]);

  // With a cached list in hand, resolving pasted container IDs is a local
  // lookup — no scan needed.
  const selectFromPastedIds = useCallback(() => {
    const ids = new Set(
      targetIdsRaw.split(/[\n,]/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    );
    if (ids.size === 0) return;
    const found = containers.filter((c) => ids.has(c.publicId.toUpperCase()));
    for (const c of found) ids.delete(c.publicId.toUpperCase());
    setSelected(new Set(found.map((c) => c.publicId)));
    setNotFoundIds([...ids]);
  }, [targetIdsRaw, containers]);

  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of containers) seen.set(c.accountId, c.accountName);
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1], "en"));
  }, [containers]);

  const filtered = useMemo(
    () =>
      containers.filter((c) => {
        const matchAccount = accountFilter === "all" || c.accountId === accountFilter;
        const matchSearch =
          !search ||
          c.containerName.toLowerCase().includes(search.toLowerCase()) ||
          c.publicId.toLowerCase().includes(search.toLowerCase());
        return matchAccount && matchSearch;
      }),
    [containers, accountFilter, search]
  );

  const toggle = (publicId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(publicId)) next.delete(publicId);
      else next.add(publicId);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const allSelected = filtered.length > 0 && filtered.every((c) => prev.has(c.publicId));
      if (allSelected) {
        const next = new Set(prev);
        for (const c of filtered) next.delete(c.publicId);
        return next;
      }
      const next = new Set(prev);
      for (const c of filtered) next.add(c.publicId);
      return next;
    });
  };

  const canApply =
    selected.size > 0 &&
    !applying &&
    ((publishEnabled && tagJsonText.trim()) || (pauseEnabled && pauseNamesRaw.trim()));

  const handleApply = async () => {
    setApplyError(null);
    setApplyResults([]);
    setSelectedForPublish(new Set());
    setPublishResults([]);

    const targets = containers
      .filter((c) => selected.has(c.publicId))
      .map((c) => ({ accountId: c.accountId, containerId: c.containerId, containerName: c.containerName }));

    const pauseTagNames = pauseEnabled
      ? pauseNamesRaw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      : [];

    let publishTags: Record<string, unknown>[] | undefined;
    if (publishEnabled) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(tagJsonText);
      } catch {
        setApplyError("Tag JSON jest niepoprawny — nie da się go sparsować.");
        return;
      }
      const tagObjects = extractTagObjects(parsed);
      if (tagObjects.length === 0) {
        setApplyError(
          'Nie znaleziono żadnego tagu w JSON-ie. Wklej pojedynczy obiekt tagu, tablicę tagów, albo eksport kontenera z polem "tag".'
        );
        return;
      }
      const withoutName = tagObjects.findIndex((t) => typeof t.name !== "string");
      if (withoutName !== -1) {
        setApplyError(`Tag pod indeksem ${withoutName} nie ma pola "name" (string).`);
        return;
      }
      const defaultTrigger = firingTriggerName.trim() || undefined;
      publishTags = tagObjects.map((t) => ({
        ...t,
        firingTriggerName: typeof t.firingTriggerName === "string" ? t.firingTriggerName : defaultTrigger,
      }));
    }

    let sourceContainer: { accountId: string; containerId: string } | undefined;
    const needsCustomTemplate = publishTags?.some(
      (t) => typeof t.type === "string" && t.type.startsWith("cvt_")
    );
    if (needsCustomTemplate) {
      const trimmedSourceId = sourceContainerId.trim().toUpperCase();
      if (!trimmedSourceId) {
        setApplyError(
          'One or more tags use a custom-template type ("cvt_...") — fill in "Source container for custom templates" below.'
        );
        return;
      }
      const found = containers.find((c) => c.publicId.toUpperCase() === trimmedSourceId);
      if (!found) {
        setApplyError(
          `Source container ${trimmedSourceId} isn't in the loaded list above — add it to the "Container public IDs" box in step 1 and reload.`
        );
        return;
      }
      sourceContainer = { accountId: found.accountId, containerId: found.containerId };
    }

    setApplying(true);

    const finalVersionName = versionName.trim() || `Bulk update ${new Date().toISOString()}`;

    const batches = chunk(targets, CHUNK_SIZE);
    setApplyProgress({ done: 0, total: targets.length });

    for (const batch of batches) {
      try {
        const res = await fetch("/api/gtm/bulk/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targets: batch,
            publishTags,
            pauseTagNames,
            versionName: finalVersionName,
            versionNotes: versionNotes.trim() || undefined,
            sourceContainer,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setApplyResults((prev) => [
            ...prev,
            ...batch.map((t) => ({
              accountId: t.accountId,
              containerId: t.containerId,
              containerName: t.containerName,
              status: "error" as const,
              changes: [],
              error: data.error ?? `HTTP ${res.status}`,
            })),
          ]);
        } else {
          const data = (await res.json()) as { results: ApplyResult[] };
          setApplyResults((prev) => [...prev, ...data.results]);
        }
      } catch {
        setApplyResults((prev) => [
          ...prev,
          ...batch.map((t) => ({
            accountId: t.accountId,
            containerId: t.containerId,
            containerName: t.containerName,
            status: "error" as const,
            changes: [],
            error: "Network error.",
          })),
        ]);
      }
      setApplyProgress((prev) => (prev ? { done: prev.done + batch.length, total: prev.total } : prev));
    }

    setApplying(false);
  };

  const readyToPublish = applyResults.filter((r) => r.status === "ok" && r.versionId);

  const togglePublishSelection = (containerId: string) => {
    setSelectedForPublish((prev) => {
      const next = new Set(prev);
      if (next.has(containerId)) next.delete(containerId);
      else next.add(containerId);
      return next;
    });
  };

  const selectAllReady = () => {
    setSelectedForPublish((prev) => {
      const allSelected = readyToPublish.length > 0 && readyToPublish.every((r) => prev.has(r.containerId));
      return allSelected ? new Set() : new Set(readyToPublish.map((r) => r.containerId));
    });
  };

  const handlePublish = async () => {
    setPublishError(null);
    setPublishResults([]);
    setPublishing(true);
    setConfirmingPublish(false);

    const targets = readyToPublish
      .filter((r) => selectedForPublish.has(r.containerId))
      .map((r) => ({
        accountId: r.accountId,
        containerId: r.containerId,
        containerName: r.containerName,
        versionId: r.versionId!,
      }));

    setPublishProgress({ done: 0, total: targets.length });

    for (const batch of chunk(targets, CHUNK_SIZE)) {
      try {
        const res = await fetch("/api/gtm/bulk/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets: batch }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setPublishResults((prev) => [
            ...prev,
            ...batch.map((t) => ({ ...t, status: "error" as const, error: data.error ?? `HTTP ${res.status}` })),
          ]);
        } else {
          const data = (await res.json()) as { results: PublishResult[] };
          setPublishResults((prev) => [...prev, ...data.results]);
        }
      } catch {
        setPublishResults((prev) => [
          ...prev,
          ...batch.map((t) => ({ ...t, status: "error" as const, error: "Network error." })),
        ]);
      }
      setPublishProgress((prev) => (prev ? { done: prev.done + batch.length, total: prev.total } : prev));
    }

    setPublishing(false);
  };

  const loadWorkspaces = async () => {
    setWorkspacesResults([]);
    setChosenWorkspace(new Map());
    setCreateVersionResults([]);
    setVersionPublishResults([]);
    setWorkspacesLoading(true);

    const targets = containers
      .filter((c) => selected.has(c.publicId))
      .map((c) => ({ accountId: c.accountId, containerId: c.containerId, containerName: c.containerName }));

    setWorkspacesProgress({ done: 0, total: targets.length });
    // Keyed by containerId so a retry replaces that container's row rather
    // than adding a second one for it.
    const rows = new Map<string, ContainerWorkspacesRow>();
    const defaults = new Map<string, string>();

    const runPass = async (pass: BulkTargetRow[]) => {
      for (const batch of chunk(pass, WORKSPACE_CHUNK_SIZE)) {
        try {
          const res = await fetch("/api/gtm/bulk/workspaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ targets: batch }),
          });
          if (res.ok) {
            const data = (await res.json()) as { results: ContainerWorkspacesRow[] };
            for (const r of data.results) {
              rows.set(r.containerId, r);
              const preferred = r.workspaces.find((w) => w.name === "Default Workspace") ?? r.workspaces[0];
              if (preferred) defaults.set(r.containerId, preferred.workspaceId);
            }
          } else {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            for (const t of batch) {
              rows.set(t.containerId, { ...t, workspaces: [], error: data.error ?? `HTTP ${res.status}` });
            }
          }
        } catch {
          for (const t of batch) rows.set(t.containerId, { ...t, workspaces: [], error: "Network error." });
        }
        setWorkspacesResults([...rows.values()]);
        setChosenWorkspace(new Map(defaults));
        setWorkspacesProgress((prev) => (prev ? { done: prev.done + batch.length, total: prev.total } : prev));
      }
    };

    await runPass(targets);
    // Same reasoning as the container scan: quota errors are transient, so
    // retry the containers that failed instead of leaving them unselectable.
    for (let attempt = 1; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
      const failed = [...rows.values()].filter((r) => r.error);
      if (failed.length === 0) break;
      setWorkspacesProgress({ done: 0, total: failed.length });
      await runPass(
        failed.map((r) => ({ accountId: r.accountId, containerId: r.containerId, containerName: r.containerName }))
      );
    }

    setWorkspacesLoading(false);
  };

  const handleCreateVersions = async () => {
    setCreateVersionResults([]);
    setVersionPublishResults([]);
    setCreatingVersions(true);

    const finalVersionName = workspaceVersionName.trim() || `Bulk publish ${new Date().toISOString()}`;

    const targets = workspacesResults
      .filter((r) => !r.error && chosenWorkspace.get(r.containerId))
      .map((r) => ({
        accountId: r.accountId,
        containerId: r.containerId,
        containerName: r.containerName,
        workspaceId: chosenWorkspace.get(r.containerId)!,
      }));

    setCreateVersionProgress({ done: 0, total: targets.length });

    for (const batch of chunk(targets, CHUNK_SIZE)) {
      try {
        const res = await fetch("/api/gtm/bulk/create-version", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targets: batch,
            versionName: finalVersionName,
            versionNotes: workspaceVersionNotes.trim() || undefined,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { results: CreateVersionResult[] };
          setCreateVersionResults((prev) => [...prev, ...data.results]);
        } else {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setCreateVersionResults((prev) => [
            ...prev,
            ...batch.map((t) => ({ ...t, status: "error" as const, error: data.error ?? `HTTP ${res.status}` })),
          ]);
        }
      } catch {
        setCreateVersionResults((prev) => [
          ...prev,
          ...batch.map((t) => ({ ...t, status: "error" as const, error: "Network error." })),
        ]);
      }
      setCreateVersionProgress((prev) => (prev ? { done: prev.done + batch.length, total: prev.total } : prev));
    }

    setCreatingVersions(false);
  };

  const readyToPublishFromWorkspaces = createVersionResults.filter((r) => r.status === "ok" && r.versionId);

  const handlePublishFromWorkspaces = async () => {
    setVersionPublishResults([]);
    setVersionPublishing(true);
    setConfirmingVersionPublish(false);

    const targets = readyToPublishFromWorkspaces.map((r) => ({
      accountId: r.accountId,
      containerId: r.containerId,
      containerName: r.containerName,
      versionId: r.versionId!,
    }));

    setVersionPublishProgress({ done: 0, total: targets.length });

    for (const batch of chunk(targets, CHUNK_SIZE)) {
      try {
        const res = await fetch("/api/gtm/bulk/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targets: batch }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setVersionPublishResults((prev) => [
            ...prev,
            ...batch.map((t) => ({ ...t, status: "error" as const, error: data.error ?? `HTTP ${res.status}` })),
          ]);
        } else {
          const data = (await res.json()) as { results: PublishResult[] };
          setVersionPublishResults((prev) => [...prev, ...data.results]);
        }
      } catch {
        setVersionPublishResults((prev) => [
          ...prev,
          ...batch.map((t) => ({ ...t, status: "error" as const, error: "Network error." })),
        ]);
      }
      setVersionPublishProgress((prev) => (prev ? { done: prev.done + batch.length, total: prev.total } : prev));
    }

    setVersionPublishing(false);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* ── Step 1: containers ─────────────────────────────────────────── */}
      <Section title="1. Select containers">
        {fromCache !== null && (
          <div
            className="mb-3 px-4 py-3 text-sm flex items-center justify-between gap-3 flex-wrap"
            style={{ background: "var(--accent-subtle)", border: "1px solid var(--accent)", color: "var(--text-secondary)", borderRadius: R }}
          >
            <span>
              {containers.length} container(s) loaded instantly from this browser — last full scan{" "}
              {describeCacheAge(fromCache)}. Rescan only if containers were added or removed in GTM.
            </span>
            <button
              onClick={() => {
                clearCachedScan(accountKey);
                setFromCache(null);
                setContainers([]);
                setLoaded(false);
                setSelected(new Set());
              }}
              className="text-xs px-3 py-1.5 shrink-0"
              style={{ background: "var(--surface)", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", borderRadius: R }}
            >
              Discard saved list
            </button>
          </div>
        )}

        <div className="mb-3">
          <Field label="Container public IDs (optional — GTM-XXXXXXX, one per line or comma-separated). Skips scanning every account you have access to; only looks for these.">
            <textarea
              value={targetIdsRaw}
              onChange={(e) => setTargetIdsRaw(e.target.value)}
              rows={3}
              placeholder={"GTM-ABCD123\nGTM-EFGH456"}
              style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
            />
          </Field>
          {targetIdsRaw.trim() !== "" && containers.length > 0 && (
            <button
              onClick={selectFromPastedIds}
              className="mt-2 text-sm font-semibold px-4 py-2"
              style={{ background: "var(--accent)", color: "#fff", borderRadius: R }}
            >
              Select these IDs from the loaded list (no scan)
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap mb-3">
          <input
            type="text"
            placeholder="Search container..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-48 px-3 py-2 text-sm outline-none"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: R }}
          />
          <select
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="py-2 pl-3 pr-8 text-sm outline-none appearance-none cursor-pointer"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: R }}
          >
            <option value="all">All GTM accounts</option>
            {accounts.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <button
            onClick={fetchContainers}
            disabled={loadingContainers}
            className="text-sm px-3 py-2"
            style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)", borderRadius: R, opacity: loadingContainers ? 0.5 : 1 }}
          >
            {loadingContainers
              ? `Scanning... ${accountScanProgress?.done ?? 0}/${accountScanProgress?.total ?? 0} accounts, ${containers.length} found`
              : loaded
              ? "Rescan all accounts"
              : "Scan all accounts"}
          </button>
        </div>

        {containersError && <ErrorBox>{containersError}</ErrorBox>}

        {notFoundIds.length > 0 && (
          <div className="mb-3 px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "var(--error)", borderRadius: R }}>
            Not found in the loaded container list: {notFoundIds.join(", ")}. If these were created
            recently, rescan all accounts to pick them up.
          </div>
        )}

        {failedAccounts.length > 0 && (
          <div className="mb-3 px-4 py-3 text-sm" style={{ background: "rgba(217,119,6,0.06)", border: "1px solid rgba(217,119,6,0.2)", color: "#d97706", borderRadius: R }}>
            {failedAccounts.length} account(s) failed to load and are missing from the list below — click Refresh to retry:
            <ul className="mt-1 text-xs" style={{ color: "#d97706" }}>
              {failedAccounts.map((a) => (
                <li key={a.accountId}>{a.name} ({a.accountId}): {a.error}</li>
              ))}
            </ul>
          </div>
        )}

        {(loaded || (loadingContainers && containers.length > 0)) && !containersError && (
          <>
            <div style={{ border: "1px solid var(--border)", borderRadius: R_LG, overflow: "hidden", maxHeight: 360, overflowY: "auto" }}>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ background: "var(--surface-elevated)", borderBottom: "1px solid var(--border)", position: "sticky", top: 0 }}>
                    <th className="w-10 px-3 py-3">
                      <input type="checkbox" checked={filtered.length > 0 && filtered.every((c) => selected.has(c.publicId))} onChange={selectAllFiltered} style={{ accentColor: "var(--accent)" }} />
                    </th>
                    <Th>Container</Th>
                    <Th>ID</Th>
                    <Th>GTM Account</Th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={4} className="py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>No results</td></tr>
                  ) : (
                    filtered.map((c) => {
                      const isSelected = selected.has(c.publicId);
                      return (
                        <tr key={c.containerId} onClick={() => toggle(c.publicId)} className="cursor-pointer" style={{ background: isSelected ? "var(--accent-subtle)" : "transparent", borderBottom: "1px solid var(--border)" }}>
                          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={isSelected} onChange={() => toggle(c.publicId)} style={{ accentColor: "var(--accent)" }} />
                          </td>
                          <Td>{c.containerName}</Td>
                          <Td><span className="px-2 py-0.5 text-xs" style={{ background: "var(--surface-elevated)", fontFamily: "var(--font-mono)", borderRadius: "3px" }}>{c.publicId}</span></Td>
                          <Td>{c.accountName}</Td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>{selected.size} container(s) selected</p>
          </>
        )}
      </Section>

      {/* ── Alternative: publish what's already in a workspace ──────────── */}
      <Section title="Or: publish an existing workspace (independent of the steps below)">
        <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>
          Lists the working areas (workspaces) that currently exist in the containers selected above. Pick which
          workspace to publish per container — its current contents are turned into a new version, which you then
          publish. Nothing in the workspace is edited.
        </p>
        <button
          onClick={loadWorkspaces}
          disabled={selected.size === 0 || workspacesLoading}
          className="text-sm font-semibold px-5 py-2.5"
          style={{ background: selected.size > 0 ? "var(--accent)" : "var(--control-disabled-bg)", color: selected.size > 0 ? "#fff" : "var(--control-disabled-fg)", borderRadius: R }}
        >
          {workspacesLoading
            ? `Loading workspaces... (${workspacesProgress?.done ?? 0}/${workspacesProgress?.total ?? 0})`
            : `Load workspaces for ${selected.size} container(s)`}
        </button>

        {workspacesResults.length > 0 && (
          <div className="mt-4" style={{ border: "1px solid var(--border)", borderRadius: R_LG, overflow: "hidden" }}>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: "var(--surface-elevated)", borderBottom: "1px solid var(--border)" }}>
                  <Th>Container</Th>
                  <Th>Workspace to publish</Th>
                </tr>
              </thead>
              <tbody>
                {workspacesResults.map((r) => (
                  <tr key={r.containerId} style={{ borderBottom: "1px solid var(--border)" }}>
                    <Td>{r.containerName}</Td>
                    <Td>
                      {r.error ? (
                        <span style={{ color: "var(--error)" }}>{r.error}</span>
                      ) : r.workspaces.length === 0 ? (
                        <span style={{ color: "var(--text-muted)" }}>No workspaces</span>
                      ) : (
                        <select
                          value={chosenWorkspace.get(r.containerId) ?? ""}
                          onChange={(e) => setChosenWorkspace((prev) => new Map(prev).set(r.containerId, e.target.value))}
                          className="py-1.5 pl-2 pr-6 text-sm outline-none"
                          style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: R }}
                        >
                          {r.workspaces.map((w) => (
                            <option key={w.workspaceId} value={w.workspaceId}>
                              {w.name}
                              {w.description ? ` — ${w.description}` : ""}
                            </option>
                          ))}
                        </select>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {workspacesResults.some((r) => !r.error && r.workspaces.length > 0) && (
          <div className="mt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Version name (optional)">
                <input
                  value={workspaceVersionName}
                  onChange={(e) => setWorkspaceVersionName(e.target.value)}
                  placeholder={`Bulk publish ${new Date().toISOString().slice(0, 10)}`}
                  style={inputStyle}
                />
              </Field>
              <Field label="Version notes (optional)">
                <input value={workspaceVersionNotes} onChange={(e) => setWorkspaceVersionNotes(e.target.value)} style={inputStyle} />
              </Field>
            </div>

            <div>
              <button
                onClick={handleCreateVersions}
                disabled={creatingVersions}
                className="text-sm font-semibold px-5 py-2.5"
                style={{ background: "var(--accent)", color: "#fff", borderRadius: R }}
              >
                {creatingVersions
                  ? `Creating versions... (${createVersionProgress?.done ?? 0}/${createVersionProgress?.total ?? 0})`
                  : "Create versions from chosen workspaces"}
              </button>
            </div>

            {createVersionResults.length > 0 && (
              <div style={{ border: "1px solid var(--border)", borderRadius: R_LG, overflow: "hidden" }}>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr style={{ background: "var(--surface-elevated)", borderBottom: "1px solid var(--border)" }}>
                      <Th>Container</Th>
                      <Th>Version</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {createVersionResults.map((r) => (
                      <tr key={r.containerId} style={{ borderBottom: "1px solid var(--border)" }}>
                        <Td>{r.containerName}</Td>
                        <Td>{r.versionId ? `${r.versionName ?? ""} (#${r.versionId})` : "—"}</Td>
                        <Td>
                          <span style={{ color: r.status === "ok" ? "var(--success)" : "var(--error)", fontWeight: 600 }}>
                            {r.status === "ok" ? "Created" : r.error ?? "Error"}
                          </span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {readyToPublishFromWorkspaces.length > 0 && !confirmingVersionPublish && (
              <div>
                <button
                  onClick={() => setConfirmingVersionPublish(true)}
                  disabled={versionPublishing}
                  className="text-sm font-semibold px-5 py-2.5"
                  style={{ background: "var(--error)", color: "#fff", borderRadius: R }}
                >
                  Publish {readyToPublishFromWorkspaces.length} version(s) live
                </button>
              </div>
            )}
            {readyToPublishFromWorkspaces.length > 0 && confirmingVersionPublish && (
              <div className="flex items-center gap-3">
                <span className="text-sm" style={{ color: "var(--text-primary)" }}>Publish these versions live now?</span>
                <button onClick={handlePublishFromWorkspaces} className="text-sm font-semibold px-4 py-2" style={{ background: "var(--error)", color: "#fff", borderRadius: R }}>
                  Yes, publish
                </button>
                <button onClick={() => setConfirmingVersionPublish(false)} className="text-sm px-4 py-2" style={{ background: "var(--surface)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", borderRadius: R }}>
                  Cancel
                </button>
              </div>
            )}
            {versionPublishing && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Publishing... ({versionPublishProgress?.done ?? 0}/{versionPublishProgress?.total ?? 0})
              </p>
            )}
            {versionPublishResults.length > 0 && (
              <div className="mt-4" style={{ border: "1px solid var(--border)", borderRadius: R_LG, overflow: "hidden" }}>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr style={{ background: "var(--surface-elevated)", borderBottom: "1px solid var(--border)" }}>
                      <Th>Container</Th>
                      <Th>Status</Th>
                      <Th>Error</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {versionPublishResults.map((r) => (
                      <tr key={r.containerId} style={{ borderBottom: "1px solid var(--border)" }}>
                        <Td>{r.containerName}</Td>
                        <Td>
                          <span style={{ color: r.status === "ok" ? "var(--success)" : "var(--error)", fontWeight: 600 }}>
                            {r.status === "ok" ? "Published" : "Error"}
                          </span>
                        </Td>
                        <Td>{r.error ?? "—"}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ── Step 2: what to do ─────────────────────────────────────────── */}
      <Section title="2. What to do in each selected container">
        <label className="flex items-center gap-2 mb-3 cursor-pointer">
          <input type="checkbox" checked={publishEnabled} onChange={(e) => setPublishEnabled(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Create or update tags</span>
        </label>
        {publishEnabled && (
          <div className="flex flex-col gap-3 mb-6 pl-6">
            <Field label='Tag JSON — a single tag object, an array of tags, or a GTM "Export Container" JSON (its "tag" array is used automatically)'>
              <textarea
                value={tagJsonText}
                onChange={(e) => setTagJsonText(e.target.value)}
                rows={14}
                placeholder={JSON.stringify(
                  [
                    {
                      name: "Custom Script - Consent Banner",
                      type: "html",
                      parameter: [
                        { type: "template", key: "html", value: "<script>...</script>" },
                        { type: "boolean", key: "supportDocumentWrite", value: "false" },
                      ],
                    },
                    {
                      name: "GA4 - Purchase Event",
                      type: "gaawe",
                      parameter: [{ type: "template", key: "eventName", value: "purchase" }],
                    },
                  ],
                  null,
                  2
                )}
                style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }}
              />
            </Field>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Each tag is matched to an existing one by <code>name</code> (case-insensitive) → updated; otherwise created new.
              Don&apos;t include <code>firingTriggerId</code> — trigger IDs aren&apos;t portable across containers. Add a per-tag
              <code> firingTriggerName</code> field to override the default below, e.g. only for tags that don&apos;t exist yet.
            </p>
            <Field label="Default firing trigger name (used for any tag above without its own firingTriggerName, only when that tag doesn't exist yet)">
              <input value={firingTriggerName} onChange={(e) => setFiringTriggerName(e.target.value)} placeholder="All Pages" style={inputStyle} />
            </Field>
            <Field label='Source container for custom templates (only needed if a tag type starts with "cvt_") — GTM-XXXXXXX. Must be a container already loaded in the list above.'>
              <input value={sourceContainerId} onChange={(e) => setSourceContainerId(e.target.value)} placeholder="GTM-5DP3WTLJ" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            </Field>
          </div>
        )}

        <label className="flex items-center gap-2 mb-3 cursor-pointer">
          <input type="checkbox" checked={pauseEnabled} onChange={(e) => setPauseEnabled(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Pause existing tags by name</span>
        </label>
        {pauseEnabled && (
          <div className="pl-6 mb-4">
            <Field label="Tag names to pause (one per line, or comma-separated). Case-insensitive exact match.">
              <textarea value={pauseNamesRaw} onChange={(e) => setPauseNamesRaw(e.target.value)} rows={4} placeholder={"Old GA Universal Analytics\nOld Facebook Pixel"} style={inputStyle} />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Version name (optional)">
            <input value={versionName} onChange={(e) => setVersionName(e.target.value)} placeholder={`Bulk update ${new Date().toISOString().slice(0, 10)}`} style={inputStyle} />
          </Field>
          <Field label="Version notes (optional)">
            <input value={versionNotes} onChange={(e) => setVersionNotes(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </Section>

      {/* ── Step 3: apply ───────────────────────────────────────────────── */}
      <Section title="3. Apply (creates a new container version — does not publish)">
        <button
          onClick={handleApply}
          disabled={!canApply}
          className="text-sm font-semibold px-5 py-2.5"
          style={{ background: canApply ? "var(--accent)" : "var(--control-disabled-bg)", color: canApply ? "#fff" : "var(--control-disabled-fg)", borderRadius: R, cursor: canApply ? "pointer" : "default" }}
        >
          {applying ? `Applying... (${applyProgress?.done ?? 0}/${applyProgress?.total ?? 0})` : `Apply to ${selected.size} container(s)`}
        </button>
        {applyError && <ErrorBox>{applyError}</ErrorBox>}

        {applyResults.length > 0 && (
          <div className="mt-4" style={{ border: "1px solid var(--border)", borderRadius: R_LG, overflow: "hidden" }}>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: "var(--surface-elevated)", borderBottom: "1px solid var(--border)" }}>
                  <th className="w-10 px-3 py-2">
                    <input type="checkbox" checked={readyToPublish.length > 0 && readyToPublish.every((r) => selectedForPublish.has(r.containerId))} onChange={selectAllReady} style={{ accentColor: "var(--accent)" }} />
                  </th>
                  <Th>Container</Th>
                  <Th>Status</Th>
                  <Th>Changes / Error</Th>
                  <Th>Version</Th>
                </tr>
              </thead>
              <tbody>
                {applyResults.map((r) => (
                  <tr key={r.containerId} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td className="px-3 py-2">
                      {r.status === "ok" && r.versionId && (
                        <input type="checkbox" checked={selectedForPublish.has(r.containerId)} onChange={() => togglePublishSelection(r.containerId)} style={{ accentColor: "var(--accent)" }} />
                      )}
                    </td>
                    <Td>{r.containerName}</Td>
                    <Td>
                      <span style={{ color: r.status === "ok" ? "var(--success)" : "var(--error)", fontWeight: 600 }}>
                        {r.status === "ok" ? "OK" : "Error"}
                      </span>
                    </Td>
                    <Td>
                      <ul className="text-xs" style={{ color: r.status === "error" ? "var(--error)" : "var(--text-secondary)" }}>
                        {r.error ? <li>{r.error}</li> : r.changes.map((c, i) => <li key={i}>{c}</li>)}
                      </ul>
                    </Td>
                    <Td>{r.versionName ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Step 4: publish ─────────────────────────────────────────────── */}
      {readyToPublish.length > 0 && (
        <Section title="4. Publish (this goes live immediately)">
          <p className="text-xs mb-3" style={{ color: "var(--text-muted)" }}>
            {selectedForPublish.size} of {readyToPublish.length} version(s) selected.
          </p>
          {!confirmingPublish ? (
            <button
              onClick={() => setConfirmingPublish(true)}
              disabled={selectedForPublish.size === 0 || publishing}
              className="text-sm font-semibold px-5 py-2.5"
              style={{ background: selectedForPublish.size > 0 ? "var(--error)" : "var(--control-disabled-bg)", color: selectedForPublish.size > 0 ? "#fff" : "var(--control-disabled-fg)", borderRadius: R }}
            >
              Publish selected versions
            </button>
          ) : (
            <div className="flex items-center gap-3">
              <span className="text-sm" style={{ color: "var(--text-primary)" }}>
                Publish {selectedForPublish.size} container(s) live now?
              </span>
              <button onClick={handlePublish} className="text-sm font-semibold px-4 py-2" style={{ background: "var(--error)", color: "#fff", borderRadius: R }}>
                Yes, publish
              </button>
              <button onClick={() => setConfirmingPublish(false)} className="text-sm px-4 py-2" style={{ background: "var(--surface)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", borderRadius: R }}>
                Cancel
              </button>
            </div>
          )}
          {publishing && (
            <p className="text-xs mt-2" style={{ color: "var(--text-muted)" }}>
              Publishing... ({publishProgress?.done ?? 0}/{publishProgress?.total ?? 0})
            </p>
          )}
          {publishError && <ErrorBox>{publishError}</ErrorBox>}

          {publishResults.length > 0 && (
            <div className="mt-4" style={{ border: "1px solid var(--border)", borderRadius: R_LG, overflow: "hidden" }}>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ background: "var(--surface-elevated)", borderBottom: "1px solid var(--border)" }}>
                    <Th>Container</Th>
                    <Th>Status</Th>
                    <Th>Error</Th>
                  </tr>
                </thead>
                <tbody>
                  {publishResults.map((r) => (
                    <tr key={r.containerId} style={{ borderBottom: "1px solid var(--border)" }}>
                      <Td>{r.containerName}</Td>
                      <Td>
                        <span style={{ color: r.status === "ok" ? "var(--success)" : "var(--error)", fontWeight: 600 }}>
                          {r.status === "ok" ? "Published" : "Error"}
                        </span>
                      </Td>
                      <Td>{r.error ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  color: "var(--text-primary)",
  borderRadius: R,
  padding: "8px 12px",
  fontSize: "0.875rem",
  outline: "none",
  width: "100%",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2
        className="text-[11px] font-medium uppercase tracking-wider mb-2 px-0.5"
        style={{ color: "var(--text-muted)" }}
      >
        {title}
      </h2>
      <div
        className="p-5"
        style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: R_LG }}
      >
        {children}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</span>
      {children}
    </label>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-medium" style={{ color: "var(--text-muted)" }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2" style={{ color: "var(--text-secondary)" }}>{children}</td>;
}

function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "var(--error)", borderRadius: R }}>
      {children}
    </div>
  );
}
