import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIMessage } from "ai";

interface ChatMessageProps {
  message: UIMessage;
}

function getTextContent(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { type: "text"; text: string }).text)
    .join("");
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";
  const text = getTextContent(message);

  if (!text) return null;

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className="w-8 h-8 rounded flex-shrink-0 flex items-center justify-center text-xs font-bold"
        style={{
          background: isUser ? "var(--accent)" : "var(--surface-elevated)",
          color: isUser ? "#ffffff" : "var(--text-muted)",
        }}
      >
        {isUser ? "Ty" : "MG"}
      </div>

      <div
        className={`max-w-[75%] px-4 py-3 text-sm leading-relaxed ${
          isUser ? "rounded-tl-xl rounded-bl-xl rounded-br-xl" : "rounded-tr-xl rounded-bl-xl rounded-br-xl"
        }`}
        style={{
          background: isUser ? "var(--accent)" : "var(--surface)",
          color: isUser ? "#ffffff" : "var(--text-primary)",
          border: isUser ? "none" : "1px solid var(--border)",
          fontWeight: isUser ? 500 : 400,
        }}
      >
        {isUser ? (
          <p style={{ whiteSpace: "pre-wrap" }}>{text}</p>
        ) : (
          <div className="prose prose-sm max-w-none" style={{ color: "var(--text-primary)" }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ className, children, ...props }) {
                  const isBlock = className?.startsWith("language-");
                  if (isBlock) {
                    return (
                      <pre
                        style={{
                          background: "var(--surface-elevated)",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                          padding: "12px",
                          overflowX: "auto",
                          fontSize: "12px",
                        }}
                      >
                        <code className={className} {...props}>
                          {children}
                        </code>
                      </pre>
                    );
                  }
                  return (
                    <code
                      style={{
                        background: "var(--surface-elevated)",
                        padding: "2px 6px",
                        borderRadius: "3px",
                        fontSize: "12px",
                        color: "var(--accent)",
                      }}
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                table({ children }) {
                  return (
                    <div style={{ overflowX: "auto", marginBlock: "8px" }}>
                      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px" }}>
                        {children}
                      </table>
                    </div>
                  );
                },
                th({ children }) {
                  return (
                    <th style={{ border: "1px solid var(--border)", padding: "6px 10px", background: "var(--surface-elevated)", textAlign: "left", fontWeight: 600, color: "var(--text-secondary)" }}>
                      {children}
                    </th>
                  );
                },
                td({ children }) {
                  return (
                    <td style={{ border: "1px solid var(--border)", padding: "6px 10px", color: "var(--text-primary)" }}>
                      {children}
                    </td>
                  );
                },
                p({ children }) {
                  return <p style={{ marginBottom: "0.5em", color: "var(--text-primary)" }}>{children}</p>;
                },
                strong({ children }) {
                  return <strong style={{ color: "var(--text-primary)", fontWeight: 600 }}>{children}</strong>;
                },
              }}
            >
              {text}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
