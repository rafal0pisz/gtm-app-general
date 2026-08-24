"use client";

import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Logo } from "./Logo";

export function Header() {
  return (
    <header
      className="flex items-center justify-between px-6 py-4 border-b"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <Link href="/">
        <Logo />
      </Link>

      <div className="flex items-center gap-6">
        <Link
          href="/settings"
          className="text-sm font-medium transition-colors duration-200"
          style={{ color: "var(--text-secondary)" }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text-primary)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-secondary)")}
        >
          Settings
        </Link>
        <UserButton />
      </div>
    </header>
  );
}
