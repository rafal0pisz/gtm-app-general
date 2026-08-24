"use client";

import { useRef, useEffect } from "react";

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function ChatInput({ input, isLoading, onInputChange, onSubmit }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim() && !isLoading) onSubmit(e as unknown as React.FormEvent);
    }
  };

  const canSend = !!input.trim() && !isLoading;

  return (
    <div
      className="border-t px-4 py-4 flex-shrink-0"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      <form onSubmit={onSubmit} className="flex gap-3 items-end max-w-3xl mx-auto">
        <div
          className="flex-1 flex items-end transition-all duration-200"
          style={{
            border: `1px solid ${input ? "var(--accent)" : "var(--border)"}`,
            background: "var(--background)",
            borderRadius: "4px",
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about GTM..."
            rows={1}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              resize: "none",
              padding: "12px 14px",
              color: "var(--text-primary)",
              fontSize: "14px",
              lineHeight: "1.5",
              minHeight: "46px",
              fontFamily: "var(--font-poppins)",
            }}
          />
        </div>

        <button
          type="submit"
          disabled={!canSend}
          className="w-10 h-10 flex items-center justify-center flex-shrink-0 transition-all duration-200"
          style={{
            background: canSend ? "var(--accent)" : "var(--surface-elevated)",
            cursor: canSend ? "pointer" : "not-allowed",
            borderRadius: "4px",
          }}
          onMouseEnter={(e) => { if (canSend) e.currentTarget.style.background = "var(--accent-hover)"; }}
          onMouseLeave={(e) => { if (canSend) e.currentTarget.style.background = "var(--accent)"; }}
        >
          {isLoading ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text-muted)", animation: "spin 1s linear infinite" }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={canSend ? "#ffffff" : "var(--text-muted)"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          )}
        </button>
      </form>

      <p className="text-center text-xs mt-2 max-w-3xl mx-auto" style={{ color: "var(--text-muted)" }}>
        Enter — send &nbsp;·&nbsp; Shift+Enter — new line
      </p>
    </div>
  );
}
