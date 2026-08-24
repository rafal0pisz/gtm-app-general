"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { Logo } from "@/components/Logo";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";

const SUGGESTED_PROMPTS = [
  "List my GTM containers",
  "Show tags in my container",
  "Check if GTM tags are properly configured",
  "What triggers are set up in my workspace?",
];

export default function ChatPage() {
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  const [input, setInput] = useState("");
  const isLoading = status === "streaming" || status === "submitted";
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isLoading) return;
    setInput("");
    sendMessage({ text });
  };

  return (
    <div className="flex flex-col h-screen" style={{ background: "var(--background)" }}>
      <header
        className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0"
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
            style={{
              color: "var(--accent)",
              border: "1px solid var(--accent)",
              padding: "6px 14px",
              borderRadius: "4px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--accent)";
              e.currentTarget.style.color = "#ffffff";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--accent)";
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </Link>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-8 px-4">
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-2" style={{ color: "var(--text-primary)" }}>
                Hi, I&apos;m Michael G.
              </h1>
              <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
                Ask about GTM configuration, tags, and triggers
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => sendMessage({ text: prompt })}
                  className="text-left px-4 py-3 text-sm transition-all duration-200"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                    borderRadius: "4px",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--accent)";
                    e.currentTarget.style.color = "var(--text-primary)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-6">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}

            {isLoading && (
              <div className="flex gap-3">
                <div
                  className="w-8 h-8 flex-shrink-0 flex items-center justify-center text-xs font-bold"
                  style={{ background: "var(--surface-elevated)", color: "var(--text-muted)", borderRadius: "4px" }}
                >
                  MG
                </div>
                <div
                  className="px-4 py-3 flex items-center gap-1.5"
                  style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "4px" }}
                >
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        background: "var(--text-muted)",
                        animation: `bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div
                className="px-4 py-3 text-sm"
                style={{
                  background: "rgba(220,38,38,0.06)",
                  border: "1px solid rgba(220,38,38,0.2)",
                  color: "var(--error)",
                  borderRadius: "4px",
                }}
              >
                Error: {error.message}
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </main>

      <ChatInput
        input={input}
        isLoading={isLoading}
        onInputChange={setInput}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

