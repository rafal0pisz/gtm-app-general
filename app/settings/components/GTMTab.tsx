"use client";

import { useState, useEffect, useRef } from "react";

interface GtmStatus {
  connected: boolean;
  email?: string;
  connected_at?: string;
}

const R = "4px";

export function GTMTab() {
  const [status, setStatus] = useState<GtmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  useEffect(() => {
    fetchStatus();
    return () => stopPolling();
  }, []);

  const fetchStatus = async (): Promise<GtmStatus | null> => {
    try {
      const res = await fetch("/api/gtm/auth/status");
      if (res.ok) {
        const data = await res.json() as GtmStatus;
        setStatus(data);
        return data;
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
    return null;
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setPolling(false);
    pollCountRef.current = 0;
  };

  const startPolling = () => {
    setPolling(true);
    pollCountRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollCountRef.current += 1;
      const data = await fetchStatus();
      if (data?.connected) { stopPolling(); return; }
      if (pollCountRef.current >= 20) stopPolling();
    }, 3000);
  };

  const handleConnect = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gtm/auth/start");
      const data = await res.json() as { url?: string; error?: string };
      if (!res.ok || !data.url) { setError(data.error ?? "Failed to generate authorization URL."); return; }
      window.open(data.url, "_blank", "noopener,noreferrer");
      startPolling();
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gtm/auth/disconnect", { method: "DELETE" });
      if (!res.ok) { const data = await res.json() as { error?: string }; setError(data.error ?? "Failed to disconnect account."); return; }
      setConfirmDisconnect(false);
      setStatus({ connected: false });
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3" style={{ color: "var(--text-muted)" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <span className="text-sm">Checking GTM status...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "var(--error)", borderRadius: R }}>
          {error}
        </div>
      )}

      {polling && (
        <div className="px-4 py-3 text-sm flex items-center gap-3" style={{ background: "var(--accent-subtle)", border: "1px solid rgba(114,13,214,0.2)", color: "var(--text-secondary)", borderRadius: R }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite", flexShrink: 0 }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          Waiting for authorization in the new window...
        </div>
      )}

      {status?.connected ? (
        <div className="p-5 flex flex-col gap-4" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: R }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 flex items-center justify-center" style={{ background: "rgba(22,163,74,0.1)", borderRadius: R }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Google Tag Manager</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
                  <span className="text-xs font-medium" style={{ color: "var(--success)" }}>Connected · OAuth 2.0</span>
                </div>
              </div>
            </div>

            {!confirmDisconnect ? (
              <button onClick={() => setConfirmDisconnect(true)} disabled={actionLoading} className="flex items-center gap-2 text-xs px-3 py-1.5" style={{ color: "var(--error)", background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", borderRadius: R, opacity: actionLoading ? 0.5 : 1 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                Disconnect
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Confirm?</span>
                <button onClick={handleDisconnect} disabled={actionLoading} className="text-xs px-3 py-1.5 font-semibold" style={{ background: "var(--error)", color: "#fff", borderRadius: R, opacity: actionLoading ? 0.5 : 1 }}>
                  {actionLoading ? "Disconnecting..." : "Yes, disconnect"}
                </button>
                <button onClick={() => setConfirmDisconnect(false)} disabled={actionLoading} className="text-xs px-3 py-1.5" style={{ background: "var(--surface-elevated)", color: "var(--text-secondary)", borderRadius: R }}>
                  Cancel
                </button>
              </div>
            )}
          </div>

          <div style={{ background: "var(--background)", border: "1px solid var(--border)", borderRadius: R }}>
            {status.email && <InfoRow label="Google Account" value={status.email} mono />}
            {status.connected_at && (
              <div style={{ borderTop: status.email ? "1px solid var(--border)" : undefined }}>
                <InfoRow label="Connected at" value={new Date(status.connected_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} />
              </div>
            )}
          </div>

          <p className="text-xs" style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>
            Access includes reading GTM containers and editing tags. Authorization is securely stored in Google Secret Manager.
          </p>
        </div>
      ) : (
        <div className="p-10 flex flex-col items-center gap-4 text-center" style={{ background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: R }}>
          <div className="w-12 h-12 flex items-center justify-center" style={{ background: "var(--surface-elevated)", borderRadius: R }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-muted)" }}>
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Not connected to GTM</p>
            <p className="text-xs mt-1 max-w-xs" style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>
              Connect your Google account to manage tags, triggers, and variables in GTM.
            </p>
          </div>
          <button
            onClick={handleConnect}
            disabled={actionLoading || polling}
            className="flex items-center gap-2 text-sm px-6 py-3 font-bold transition-all duration-200"
            style={{ background: "var(--accent)", color: "#ffffff", borderRadius: R, opacity: (actionLoading || polling) ? 0.6 : 1 }}
            onMouseEnter={(e) => { if (!actionLoading && !polling) e.currentTarget.style.background = "var(--accent-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--accent)"; }}
          >
            {actionLoading ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
            )}
            {polling ? "Waiting for authorization..." : "Connect to GTM"}
          </button>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 gap-4">
      <span className="text-xs flex-shrink-0" style={{ color: "var(--text-muted)" }}>{label}</span>
      <span className="text-xs truncate text-right" style={{ color: "var(--text-secondary)", fontFamily: mono ? "var(--font-mono)" : undefined }}>
        {value}
      </span>
    </div>
  );
}
