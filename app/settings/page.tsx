"use client";

import { useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { AuthTab } from "./components/AuthTab";
import { AccessTab } from "./components/AccessTab";

type Tab = "authorization" | "access";

const TABS: { id: Tab; label: string }[] = [
  { id: "authorization", label: "Authorization" },
  { id: "access", label: "Access" },
];

function SettingsContent() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("tab") as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(
    raw && TABS.some((t) => t.id === raw) ? raw : "authorization"
  );

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--background)" }}>
      <header
        className="flex items-center justify-between px-6 py-4 border-b"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        <div className="flex items-center gap-5">
          <Link href="/">
            <Logo size="sm" />
          </Link>
          <span style={{ color: "var(--border)" }}>|</span>
          <Link
            href="/"
            className="flex items-center gap-2 text-sm font-medium transition-all duration-200"
            style={{ color: "var(--accent)", border: "1px solid var(--accent)", padding: "6px 14px", borderRadius: "4px" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent)"; e.currentTarget.style.color = "#ffffff"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--accent)"; }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </Link>
        </div>

        <span className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Settings</span>
      </header>

      <div className="flex-1 max-w-5xl mx-auto w-full px-4 py-8">
        <h1 className="text-2xl font-bold mb-6" style={{ color: "var(--text-primary)" }}>Settings</h1>

        <div className="flex border-b mb-8" style={{ borderColor: "var(--border)" }}>
          {TABS.map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative px-5 py-3 text-sm transition-colors duration-200"
                style={{
                  color: active ? "var(--accent)" : "var(--text-secondary)",
                  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                  marginBottom: "-1px",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeTab === "authorization" && <AuthTab />}
        {activeTab === "access" && <AccessTab />}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsContent />
    </Suspense>
  );
}
