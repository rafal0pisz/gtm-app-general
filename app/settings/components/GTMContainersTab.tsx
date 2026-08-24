"use client";

import { useState, useMemo, useCallback } from "react";
import type { GtmContainer } from "@/app/api/gtm/accounts/route";

const CONTEXT_LABEL: Record<string, string> = {
  web: "Web", serverSide: "Server", androidSdk5: "Android", iosSdk5: "iOS", ampHtml: "AMP",
};

const CONTEXT_COLOR: Record<string, { bg: string; color: string }> = {
  web: { bg: "rgba(22,163,74,0.1)", color: "#16a34a" },
  serverSide: { bg: "rgba(114,13,214,0.1)", color: "#720dd6" },
  androidSdk5: { bg: "rgba(217,119,6,0.1)", color: "#d97706" },
  iosSdk5: { bg: "rgba(59,130,246,0.1)", color: "#3b82f6" },
  ampHtml: { bg: "rgba(239,68,68,0.1)", color: "#ef4444" },
};

const R = "4px";

export function GTMContainersTab() {
  const [containers, setContainers] = useState<GtmContainer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noGTM, setNoGTM] = useState(false);
  const [accountFilter, setAccountFilter] = useState("all");
  const [search, setSearch] = useState("");

  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savedWhitelist, setSavedWhitelist] = useState<string[]>([]);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const isDirty = useMemo(() => {
    const savedSet = new Set(savedWhitelist);
    if (selected.size !== savedSet.size) return true;
    for (const id of selected) if (!savedSet.has(id)) return true;
    return false;
  }, [selected, savedWhitelist]);

  const fetchAll = useCallback(async () => {
    setError(null); setNoGTM(false); setLoading(true); setSavedOk(false);
    try {
      const [containersRes, whitelistRes] = await Promise.all([
        fetch("/api/gtm/accounts?force=true"),
        fetch("/api/gtm/whitelist"),
      ]);
      const wlData = whitelistRes.ok ? (await whitelistRes.json() as { whitelist: string[] }) : { whitelist: [] };
      const wl = wlData.whitelist;
      setSavedWhitelist(wl);

      if (containersRes.status === 404) { setNoGTM(true); return; }
      if (!containersRes.ok) { const data = await containersRes.json() as { error?: string }; setError(data.error ?? "Unknown error"); return; }
      const data = await containersRes.json() as { containers: GtmContainer[] };
      setContainers(data.containers);
      setSelected(wl.length === 0 ? new Set() : new Set(wl));
      setLoaded(true);
    } catch {
      setError("Failed to load the container list.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleToggle = (publicId: string) => {
    setSaveError(null); setSavedOk(false);
    setSelected((prev) => { const next = new Set(prev); if (next.has(publicId)) next.delete(publicId); else next.add(publicId); return next; });
  };

  const handleSelectAll = () => {
    setSaveError(null); setSavedOk(false);
    setSelected(new Set(containers.map((c) => c.publicId)));
  };

  const handleSave = async () => {
    setSaveLoading(true); setSaveError(null); setSavedOk(false);
    try {
      const allSelected = containers.every((c) => selected.has(c.publicId));
      const toSave = allSelected ? [] : Array.from(selected);
      const res = await fetch("/api/gtm/whitelist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toSave) });
      if (!res.ok) { const data = await res.json() as { error?: string }; setSaveError(data.error ?? "Failed to save."); return; }
      setSavedWhitelist(toSave); setSavedOk(true);
      setTimeout(() => setSavedOk(false), 3000);
    } catch {
      setSaveError("Connection error. Please try again.");
    } finally {
      setSaveLoading(false);
    }
  };

  const accounts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of containers) seen.set(c.accountId, c.accountName);
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1], "en"));
  }, [containers]);

  const filtered = useMemo(() =>
    containers.filter((c) => {
      const matchAccount = accountFilter === "all" || c.accountId === accountFilter;
      const matchSearch = !search || c.containerName.toLowerCase().includes(search.toLowerCase()) || c.publicId.toLowerCase().includes(search.toLowerCase());
      return matchAccount && matchSearch;
    }),
    [containers, accountFilter, search]
  );

  const selectedInFiltered = filtered.filter((c) => selected.has(c.publicId)).length;

  if (noGTM) {
    return (
      <EmptyState
        icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>}
        title="Not connected to GTM"
        description='Connect your Google Tag Manager account in the "Authorization" tab.'
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text-muted)" }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input type="text" placeholder="Search container..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full pl-8 pr-3 py-2 text-sm outline-none" style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-primary)", borderRadius: R }} />
        </div>

        <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)} className="py-2 pl-3 pr-8 text-sm outline-none appearance-none cursor-pointer" style={{ background: "var(--surface)", border: "1px solid var(--border)", color: accountFilter === "all" ? "var(--text-secondary)" : "var(--text-primary)", borderRadius: R }}>
          <option value="all">All GTM accounts</option>
          {accounts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>

        <button onClick={fetchAll} disabled={loading} className="flex items-center gap-2 text-sm px-3 py-2" style={{ background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-secondary)", opacity: loading ? 0.5 : 1, borderRadius: R }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: loading ? "spin 1s linear infinite" : undefined }}>
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          Refresh
        </button>
      </div>

      {error && <div className="px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "var(--error)", borderRadius: R }}>{error}</div>}

      {loading && !error && (
        <div className="flex items-center justify-center py-16 gap-3" style={{ color: "var(--text-muted)" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
          <span className="text-sm">Loading containers...</span>
        </div>
      )}

      {!loading && !error && containers.length > 0 && (
        <>
          <div style={{ border: "1px solid var(--border)", borderRadius: R, overflow: "hidden" }}>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
                  <th className="w-10 px-3 py-3">
                    <input type="checkbox" checked={filtered.length > 0 && filtered.every((c) => selected.has(c.publicId))} onChange={handleSelectAll} className="cursor-pointer" style={{ accentColor: "var(--accent)" }} />
                  </th>
                  <Th>Container</Th><Th>ID</Th><Th>Domain</Th><Th>Country</Th><Th>GTM Account</Th><Th>Type</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={7} className="py-10 text-center text-sm" style={{ color: "var(--text-muted)" }}>No results</td></tr>
                ) : (
                  filtered.map((c, i) => {
                    const isSelected = selected.has(c.publicId);
                    return (
                      <tr key={c.containerId} onClick={() => handleToggle(c.publicId)} className="cursor-pointer" style={{ background: isSelected ? (i % 2 === 0 ? "rgba(114,13,214,0.03)" : "rgba(114,13,214,0.05)") : (i % 2 === 0 ? "var(--background)" : "var(--surface)"), borderBottom: "1px solid var(--border)" }}>
                        <td className="px-3 py-3 w-10" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={isSelected} onChange={() => handleToggle(c.publicId)} className="cursor-pointer" style={{ accentColor: "var(--accent)" }} />
                        </td>
                        <Td>
                          <div className="flex items-center gap-2">
                            <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{c.containerName}</span>
                            {isSelected && <span className="px-1.5 py-0.5 text-xs font-medium flex-shrink-0" style={{ background: "var(--accent-subtle)", color: "var(--accent)", borderRadius: "3px", border: "1px solid rgba(114,13,214,0.2)" }}>Active</span>}
                          </div>
                        </Td>
                        <Td><span className="px-2 py-0.5 text-xs" style={{ background: "var(--surface-elevated)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", borderRadius: "3px" }}>{c.publicId}</span></Td>
                        <Td><span style={{ color: "var(--text-secondary)" }}>{c.parsed?.domain ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</span></Td>
                        <Td>
                          {c.parsed ? (
                            <span className="px-2 py-0.5 text-xs font-medium" style={{ background: c.parsed.countryCode === "Global" ? "rgba(59,130,246,0.1)" : "rgba(22,163,74,0.1)", color: c.parsed.countryCode === "Global" ? "#3b82f6" : "#16a34a", borderRadius: "3px" }}>
                              {c.parsed.countryCode}
                            </span>
                          ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                        </Td>
                        <Td><span style={{ color: "var(--text-secondary)" }}>{c.accountName}</span></Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {c.usageContext.map((ctx) => {
                              const { bg, color } = CONTEXT_COLOR[ctx] ?? { bg: "var(--surface-elevated)", color: "var(--text-muted)" };
                              return <span key={ctx} className="px-2 py-0.5 text-xs font-medium" style={{ background: bg, color, borderRadius: "3px" }}>{CONTEXT_LABEL[ctx] ?? ctx}</span>;
                            })}
                          </div>
                        </Td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {selectedInFiltered} of {filtered.length} containers selected
            </p>
            <div className="flex items-center gap-3">
              {saveError && <span className="text-xs" style={{ color: "var(--error)" }}>{saveError}</span>}
              {savedOk && <span className="text-xs flex items-center gap-1" style={{ color: "var(--success)" }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>Saved</span>}
              <button onClick={handleSave} disabled={!isDirty || saveLoading} className="flex items-center gap-2 text-sm px-4 py-2 font-semibold" style={{ background: isDirty ? "var(--accent)" : "var(--surface-elevated)", color: isDirty ? "#ffffff" : "var(--text-muted)", borderRadius: R, opacity: saveLoading ? 0.6 : 1, cursor: isDirty ? "pointer" : "default" }} onMouseEnter={(e) => { if (isDirty && !saveLoading) e.currentTarget.style.background = "var(--accent-hover)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = isDirty ? "var(--accent)" : "var(--surface-elevated)"; }}>
                {saveLoading && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>}
                {saveLoading ? "Saving..." : "Save selection"}
              </button>
            </div>
          </div>

          <p className="text-xs" style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>
            Select the containers available to the agent. No selection = agent has no access to GTM.
          </p>
        </>
      )}

      {!loaded && !loading && !error && (
        <EmptyState icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>} title="Containers not loaded" description="Click Refresh to load your GTM containers." />
      )}

      {loaded && !loading && !error && containers.length === 0 && (
        <EmptyState icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></svg>} title="No GTM containers" description="The GTM account has no access to any containers." />
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-3 text-left text-xs font-medium" style={{ color: "var(--text-muted)" }}>{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3">{children}</td>;
}

function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="p-10 flex flex-col items-center gap-3 text-center" style={{ background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: "4px" }}>
      <div className="w-12 h-12 flex items-center justify-center" style={{ background: "var(--surface-elevated)", color: "var(--text-muted)", borderRadius: "4px" }}>{icon}</div>
      <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{title}</p>
      <p className="text-xs max-w-xs" style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>{description}</p>
    </div>
  );
}
