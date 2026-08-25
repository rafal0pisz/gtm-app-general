"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Logo } from "@/components/Logo";
import { BulkOpsPanel } from "@/components/BulkOpsPanel";

// Corner radii live in globals.css so the palette and the shape stay in one
// place; inline styles can read the variables directly.
const R = "var(--radius)";

interface GtmStatus {
  connected: boolean;
  email?: string;
}

function HomeContent() {
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<GtmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCountRef = useRef(0);

  const callbackStatus = searchParams.get("status");
  const callbackReason = searchParams.get("reason");

  const fetchStatus = useCallback(async (): Promise<GtmStatus | null> => {
    try {
      const res = await fetch("/api/gtm/auth/status", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as GtmStatus;
        setStatus(data);
        return data;
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
    return null;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPolling(false);
    pollCountRef.current = 0;
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- standard fetch-on-mount
    void fetchStatus();
    return () => stopPolling();
  }, [fetchStatus, stopPolling]);

  const startPolling = () => {
    setPolling(true);
    pollCountRef.current = 0;
    pollRef.current = setInterval(async () => {
      pollCountRef.current += 1;
      const data = await fetchStatus();
      if (data?.connected) {
        stopPolling();
        return;
      }
      if (pollCountRef.current >= 20) stopPolling();
    }, 3000);
  };

  const handleConnect = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gtm/auth/start", { cache: "no-store" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(data.error ?? "Nie udało się wygenerować URL autoryzacji.");
        return;
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
      startPolling();
    } catch {
      setError("Błąd połączenia. Spróbuj ponownie.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDisconnect = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/gtm/auth/disconnect", { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Nie udało się rozłączyć konta.");
        return;
      }
      setConfirmDisconnect(false);
      setStatus({ connected: false });
    } catch {
      setError("Błąd połączenia. Spróbuj ponownie.");
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--background)" }}>
      <header
        className="sticky top-0 z-20 border-b"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="max-w-6xl mx-auto w-full px-4 py-3 flex items-center justify-between gap-4">
          <Logo />
          {status?.connected && (
            <div className="flex items-center gap-4">
              {status.email && (
                <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  {status.email}
                </span>
              )}
              {!confirmDisconnect ? (
                <button
                  onClick={() => setConfirmDisconnect(true)}
                  className="text-xs px-3 py-1.5"
                  style={{ color: "var(--error)", background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", borderRadius: R }}
                >
                  Rozłącz
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Na pewno?</span>
                  <button onClick={handleDisconnect} disabled={actionLoading} className="text-xs px-3 py-1.5 font-semibold" style={{ background: "var(--error)", color: "#fff", borderRadius: R, opacity: actionLoading ? 0.5 : 1 }}>
                    Tak
                  </button>
                  <button onClick={() => setConfirmDisconnect(false)} disabled={actionLoading} className="text-xs px-3 py-1.5" style={{ background: "var(--surface)", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", borderRadius: R }}>
                    Anuluj
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
        {callbackStatus === "error" && (
          <div className="mb-6 px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "var(--error)", borderRadius: R }}>
            Błąd autoryzacji Google{callbackReason ? `: ${callbackReason}` : "."}
          </div>
        )}
        {callbackStatus === "success" && (
          <div className="mb-6 px-4 py-3 text-sm" style={{ background: "rgba(22,163,74,0.06)", border: "1px solid rgba(22,163,74,0.2)", color: "var(--success)", borderRadius: R }}>
            Konto Google połączone.
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 gap-3" style={{ color: "var(--text-muted)" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span className="text-sm">Sprawdzam połączenie...</span>
          </div>
        ) : !status?.connected ? (
          <div className="flex flex-col items-center gap-4 text-center py-24">
            <div
              className="w-14 h-14 flex items-center justify-center"
              style={{ background: "var(--accent-subtle)", color: "var(--accent)", borderRadius: "var(--radius-lg)" }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div>
              <p className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Połącz konto Google</p>
              <p className="text-sm mt-1 max-w-sm" style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>
                Potrzebne, żeby appka mogła czytać i edytować Twoje kontenery Google Tag Manager.
              </p>
            </div>
            {error && (
              <div className="px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)", color: "var(--error)", borderRadius: R }}>
                {error}
              </div>
            )}
            <button
              onClick={handleConnect}
              disabled={actionLoading || polling}
              className="text-sm font-bold px-6 py-3"
              style={{ background: "var(--accent)", color: "#fff", borderRadius: R, opacity: actionLoading || polling ? 0.6 : 1 }}
            >
              {polling ? "Czekam na autoryzację..." : "Połącz z Google"}
            </button>
          </div>
        ) : (
          <>
            <div className="mb-8">
              <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
                Publikacja masowa
              </h1>
              <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
                Wgraj ten sam tag i pauzuj tagi po nazwie na wielu kontenerach Google Tag Manager naraz.
              </p>
            </div>
            <BulkOpsPanel accountKey={status.email ?? "default"} />
          </>
        )}
      </main>

      <footer className="border-t" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <p className="max-w-6xl mx-auto w-full px-4 py-4 text-[11px] text-center" style={{ color: "var(--text-muted)" }}>
          Powered by <span className="font-medium" style={{ color: "var(--text-secondary)" }}>Bettersteps</span>
        </p>
      </footer>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}
