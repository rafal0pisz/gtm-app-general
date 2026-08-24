"use client";

import { useState, useMemo, useCallback } from "react";
import type { GtmContainer } from "@/app/api/gtm/accounts/route";

const R = "4px";
const CHUNK_SIZE = 8;

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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function BulkOpsPanel() {
  // ── Container picker ────────────────────────────────────────────────────
  const [containers, setContainers] = useState<GtmContainer[]>([]);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [containersError, setContainersError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ── Publish-tag form ────────────────────────────────────────────────────
  const [publishEnabled, setPublishEnabled] = useState(true);
  const [tagName, setTagName] = useState("");
  const [tagType, setTagType] = useState("html");
  const [scriptHtml, setScriptHtml] = useState("");
  const [firingTriggerName, setFiringTriggerName] = useState("All Pages");

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

  const fetchContainers = useCallback(async () => {
    setContainersError(null);
    setLoadingContainers(true);
    try {
      const res = await fetch("/api/gtm/accounts?force=true");
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setContainersError(data.error ?? "Unknown error");
        return;
      }
      const data = (await res.json()) as { containers: GtmContainer[] };
      setContainers(data.containers);
      setLoaded(true);
    } catch {
      setContainersError("Failed to load the container list.");
    } finally {
      setLoadingContainers(false);
    }
  }, []);

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
    ((publishEnabled && tagName.trim() && scriptHtml.trim()) ||
      (pauseEnabled && pauseNamesRaw.trim()));

  const handleApply = async () => {
    setApplyError(null);
    setApplyResults([]);
    setSelectedForPublish(new Set());
    setPublishResults([]);
    setApplying(true);

    const targets = containers
      .filter((c) => selected.has(c.publicId))
      .map((c) => ({ accountId: c.accountId, containerId: c.containerId, containerName: c.containerName }));

    const pauseTagNames = pauseEnabled
      ? pauseNamesRaw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
      : [];

    const publishTag = publishEnabled
      ? {
          name: tagName.trim(),
          type: tagType.trim() || "html",
          parameter:
            tagType.trim() === "html" || !tagType.trim()
              ? [
                  { type: "template", key: "html", value: scriptHtml },
                  { type: "boolean", key: "supportDocumentWrite", value: "false" },
                ]
              : undefined,
          firingTriggerName: firingTriggerName.trim() || undefined,
        }
      : undefined;

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
            publishTag,
            pauseTagNames,
            versionName: finalVersionName,
            versionNotes: versionNotes.trim() || undefined,
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

  return (
    <div className="flex flex-col gap-8">
      {/* ── Step 1: containers ─────────────────────────────────────────── */}
      <Section title="1. Select containers">
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
            {loadingContainers ? "Loading..." : loaded ? "Refresh" : "Load containers"}
          </button>
        </div>

        {containersError && <ErrorBox>{containersError}</ErrorBox>}

        {loaded && !containersError && (
          <>
            <div style={{ border: "1px solid var(--border)", borderRadius: R, overflow: "hidden", maxHeight: 360, overflowY: "auto" }}>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", position: "sticky", top: 0 }}>
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
                        <tr key={c.containerId} onClick={() => toggle(c.publicId)} className="cursor-pointer" style={{ background: isSelected ? "rgba(114,13,214,0.05)" : "transparent", borderBottom: "1px solid var(--border)" }}>
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

      {/* ── Step 2: what to do ─────────────────────────────────────────── */}
      <Section title="2. What to do in each selected container">
        <label className="flex items-center gap-2 mb-3 cursor-pointer">
          <input type="checkbox" checked={publishEnabled} onChange={(e) => setPublishEnabled(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Create or update a tag</span>
        </label>
        {publishEnabled && (
          <div className="flex flex-col gap-3 mb-6 pl-6">
            <Field label="Tag name (used to find an existing tag with the same name)">
              <input value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="e.g. Custom Script - Consent Banner" style={inputStyle} />
            </Field>
            <Field label="Tag type">
              <input value={tagType} onChange={(e) => setTagType(e.target.value)} placeholder="html" style={inputStyle} />
            </Field>
            {tagType.trim() === "html" || !tagType.trim() ? (
              <Field label="Script (Custom HTML)">
                <textarea value={scriptHtml} onChange={(e) => setScriptHtml(e.target.value)} rows={8} placeholder="<script>...</script>" style={{ ...inputStyle, fontFamily: "var(--font-mono)", resize: "vertical" }} />
              </Field>
            ) : (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Non-HTML tag types are created without parameters here — edit the tag manually in GTM afterwards if it needs them.
              </p>
            )}
            <Field label="Firing trigger name (only used when the tag doesn't exist yet)">
              <input value={firingTriggerName} onChange={(e) => setFiringTriggerName(e.target.value)} placeholder="All Pages" style={inputStyle} />
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
          style={{ background: canApply ? "var(--accent)" : "var(--surface-elevated)", color: canApply ? "#fff" : "var(--text-muted)", borderRadius: R, cursor: canApply ? "pointer" : "default" }}
        >
          {applying ? `Applying... (${applyProgress?.done ?? 0}/${applyProgress?.total ?? 0})` : `Apply to ${selected.size} container(s)`}
        </button>
        {applyError && <ErrorBox>{applyError}</ErrorBox>}

        {applyResults.length > 0 && (
          <div className="mt-4" style={{ border: "1px solid var(--border)", borderRadius: R, overflow: "hidden" }}>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
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
              style={{ background: selectedForPublish.size > 0 ? "var(--error)" : "var(--surface-elevated)", color: selectedForPublish.size > 0 ? "#fff" : "var(--text-muted)", borderRadius: R }}
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
              <button onClick={() => setConfirmingPublish(false)} className="text-sm px-4 py-2" style={{ background: "var(--surface-elevated)", color: "var(--text-secondary)", borderRadius: R }}>
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
            <div className="mt-4" style={{ border: "1px solid var(--border)", borderRadius: R, overflow: "hidden" }}>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
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
      <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text-primary)" }}>{title}</h2>
      <div className="p-5" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: R }}>
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
