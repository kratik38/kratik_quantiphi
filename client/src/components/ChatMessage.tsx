import { Check, Copy, Sparkles, UserRound } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useChat } from "../context/ChatContext";
import type { Message } from "../types";
export function ChatMessage({
  message,
  streaming,
}: {
  message: Message;
  streaming: boolean;
}) {
  const [copied, setCopied] = useState(false),
    [copyError, setCopyError] = useState(false);
  const { setDraft } = useChat();
  const assistant = message.role === "assistant";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setCopyError(false);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <article className={`message-row ${assistant ? "assistant" : "user"}`}>
      <div className="message-avatar">
        {assistant ? <Sparkles size={17} /> : <UserRound size={16} />}
      </div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{assistant ? "AI Assistant" : "You"}</strong>
          <span>
            {new Date(message.timestamp).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {assistant && message.tone && (
            <span className="message-tone">{message.tone}</span>
          )}
        </div>
        <div className="message-bubble">
          {assistant ? (
            <div className={`markdown ${streaming ? "is-streaming" : ""}`}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ children, ...props }) => (
                    <a {...props} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
              {streaming && <span className="stream-caret" />}
            </div>
          ) : (
            <p className="user-content">{message.content}</p>
          )}
          {assistant && !message.content && streaming && (
            <span className="thinking">
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        {!assistant &&
          (message.status === "failed" || message.status === "cancelled") && (
            <button
              className="copy-button"
              onClick={() => {
                setDraft(message.content);
                document.getElementById("message")?.focus();
              }}
            >
              Response {message.status}. Click to retry your prompt.
            </button>
          )}
        {assistant && message.content && !streaming && (
          <button
            className="copy-button"
            onClick={() => void copy()}
            aria-label="Copy response"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
            {copyError
              ? "Copy unavailable"
              : copied
                ? "Copied"
                : "Copy response"}
          </button>
        )}
        {!assistant &&
          (message.status === "failed" || message.status === "cancelled") && (
            <span className="message-failure">
              Response {message.status}. Your prompt is saved.
            </span>
          )}
      </div>
    </article>
  );
}
