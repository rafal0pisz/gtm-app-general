"use client";

import Link from "next/link";
import { Logo } from "@/components/Logo";
import { BulkOpsPanel } from "./components/BulkOpsPanel";

export default function BulkPage() {
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
        <span className="text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Bulk Publish</span>
      </header>

      <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
        <h1 className="text-2xl font-bold mb-2" style={{ color: "var(--text-primary)" }}>Bulk Publish</h1>
        <p className="text-sm mb-6" style={{ color: "var(--text-secondary)", lineHeight: "1.6" }}>
          Apply the same tag (and/or pause tags by name) across many GTM containers at once.
          Applying only creates a new container version — nothing goes live until you explicitly publish it.
        </p>
        <BulkOpsPanel />
      </div>
    </div>
  );
}
