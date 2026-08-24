"use client";

import { useState } from "react";
import { GTMAccountsTab } from "./GTMAccountsTab";
import { GTMContainersTab } from "./GTMContainersTab";

type SubTab = "accounts" | "containers";

const R = "4px";

export function AccessTab() {
  const [active, setActive] = useState<SubTab>("accounts");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-1 p-1" style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: R, width: "fit-content" }}>
        {(["accounts", "containers"] as SubTab[]).map((tab) => {
          const isActive = active === tab;
          const label = tab === "accounts" ? "GTM Accounts" : "Containers";
          return (
            <button
              key={tab}
              onClick={() => setActive(tab)}
              className="px-4 py-1.5 text-sm font-medium transition-all duration-150"
              style={{
                background: isActive ? "var(--accent)" : "transparent",
                color: isActive ? "#ffffff" : "var(--text-secondary)",
                borderRadius: "3px",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {active === "accounts" && (
        <div className="flex flex-col gap-2">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>GTM Accounts</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>
              Step 1 — select which GTM accounts the app may query. Configure this before the Containers tab.
            </p>
          </div>
          <GTMAccountsTab />
        </div>
      )}

      {active === "containers" && (
        <div className="flex flex-col gap-2">
          <div>
            <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Containers</h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)", lineHeight: "1.6" }}>
              Step 2 — select which containers the AI assistant may manage. Only containers from whitelisted accounts appear here.
            </p>
          </div>
          <GTMContainersTab />
        </div>
      )}
    </div>
  );
}
