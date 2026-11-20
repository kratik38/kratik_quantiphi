import {
  MessageSquare,
  Plus,
  PanelLeftClose,
  Trash2,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useChat } from "../context/ChatContext";
export function Sidebar() {
  const {
    conversations,
    active,
    sidebarOpen,
    setSidebarOpen,
    newChat,
    select,
    remove,
    streaming,
  } = useChat();
  const [deleting, setDeleting] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!deleting) return;
    const previous = document.activeElement as HTMLElement | null;
    const buttons = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLButtonElement>("button") || [],
      );
    buttons()
      .find((button) => button.autofocus)
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDeleting(null);
      }
      if (event.key !== "Tab") return;
      const elements = buttons(),
        first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [deleting]);
  return (
    <>
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
        aria-label="Conversation history"
      >
        <div className="sidebar-brand">
          <span className="logo">
            <Sparkles size={19} />
          </span>
          <span>
            AI Chat
            <span className="brand-subtitle">Your thinking companion</span>
          </span>
          <button
            className="icon-button sidebar-collapse"
            onClick={() => setSidebarOpen(false)}
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <button className="new-chat" onClick={newChat}>
          <Plus size={18} /> New conversation
        </button>
        <div className="history-heading">
          YOUR CONVERSATIONS <span>{conversations.length}</span>
        </div>
        <nav className="history-list">
          {conversations.length === 0 && (
            <div className="history-empty">
              <MessageSquare size={25} />
              <p>A little space for big ideas.</p>
              <span>Your conversations will appear here.</span>
            </div>
          )}
          {conversations.map((item) => (
            <div
              key={item._id}
              className={`history-item ${active?._id === item._id ? "active" : ""}`}
            >
              <button
                className="history-select"
                onClick={() => void select(item._id)}
              >
                <MessageSquare size={16} />
                <span>
                  {item.title}
                  <small>
                    {new Date(item.updatedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </small>
                </span>
              </button>
              <button
                className="icon-button delete-chat"
                aria-label={`Delete ${item.title}`}
                title="Delete conversation"
                disabled={streaming && active?._id === item._id}
                onClick={() => setDeleting(item._id)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" />
          <div>
            A space to think freely<small>Powered by OpenAI</small>
          </div>
          <Sparkles size={16} />
        </div>
      </aside>
      {deleting && (
        <div className="dialog-backdrop" onClick={() => setDeleting(null)}>
          <section
            ref={dialog}
            className="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="icon-button dialog-close"
              aria-label="Close confirmation"
              onClick={() => setDeleting(null)}
            >
              <X size={18} />
            </button>
            <span className="delete-symbol">
              <Trash2 size={23} />
            </span>
            <h2 id="delete-title">Delete this conversation?</h2>
            <p>This will permanently remove its messages from your history.</p>
            <div className="dialog-actions">
              <button
                autoFocus
                className="secondary-button"
                onClick={() => setDeleting(null)}
              >
                Keep conversation
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  void remove(deleting);
                  setDeleting(null);
                }}
              >
                Delete
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
