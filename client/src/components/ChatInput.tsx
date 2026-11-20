import { ArrowUp, Square, CornerDownLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { useChat } from "../context/ChatContext";
export function ChatInput() {
  const { draft, setDraft, streaming, loading, send, stop, tone } = useChat();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;
    }
  }, [draft]);
  return (
    <div className="composer-wrap">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor="message">
          Your message
        </label>
        <textarea
          ref={input}
          id="message"
          placeholder="Ask anything, or share an idea…"
          value={draft}
          maxLength={12000}
          rows={1}
          disabled={streaming || loading}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bottom">
          <span className="composer-tone">
            <span className="status-dot" />
            {tone.charAt(0).toUpperCase() + tone.slice(1)} tone
          </span>
          <div className="send-group">
            <span className="enter-hint">
              <CornerDownLeft size={12} /> to send
            </span>
            {streaming ? (
              <button
                type="button"
                className="send-button stop-button"
                onClick={stop}
                aria-label="Stop generating"
              >
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button
                className="send-button"
                disabled={!draft.trim() || loading}
                type="submit"
                aria-label="Send message"
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </div>
      </form>
      <p className="composer-note">
        AI can make mistakes. Always check important information.
        <span>Shift + Enter for a new line</span>
      </p>
    </div>
  );
}
