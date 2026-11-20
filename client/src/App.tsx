import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUpRight,
  BookOpen,
  Code2,
  Lightbulb,
  Menu,
  Moon,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useChat } from "./context/ChatContext";
import { Sidebar } from "./components/Sidebar";
import { ChatInput } from "./components/ChatInput";
import { ChatMessage } from "./components/ChatMessage";
import type { Tone } from "./types";
const suggestions = [
  {
    icon: Lightbulb,
    title: "Explore an idea",
    text: "Help me brainstorm creative ideas for my next project.",
    label: "Find a fresh perspective",
  },
  {
    icon: Code2,
    title: "Build something",
    text: "Explain a useful programming concept with a practical example.",
    label: "Turn a question into clarity",
  },
  {
    icon: BookOpen,
    title: "Learn something new",
    text: "Help me break down a complex topic into simple steps.",
    label: "Make the complex feel simple",
  },
];
export default function App() {
  const {
    active,
    tone,
    setTone,
    error,
    setError,
    loading,
    streaming,
    sidebarOpen,
    setSidebarOpen,
    setDraft,
    refresh,
  } = useChat();
  const [dark, setDark] = useState(
    () => localStorage.getItem("theme") === "dark",
  );
  const [nearBottom, setNearBottom] = useState(true);
  const scroll = useRef<HTMLDivElement>(null),
    bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);
  useEffect(() => {
    setNearBottom(true);
    bottom.current?.scrollIntoView();
  }, [active?._id]);
  const lastContent = active?.messages.at(-1)?.content;
  useEffect(() => {
    if (nearBottom) bottom.current?.scrollIntoView({ behavior: "instant" });
  }, [lastContent, active?.messages.length, nearBottom]);
  const empty = !active?.messages.length;
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main-panel">
        <header className="chat-header">
          <div className="header-title">
            {!sidebarOpen && (
              <button
                className="icon-button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Expand sidebar"
              >
                <Menu size={20} />
              </button>
            )}
            <div>
              <h1>{active?.title || "AI Chat Assistant"}</h1>
              <span>
                <span className="status-dot" />
                {streaming
                  ? "Creating your response"
                  : "A little curiosity goes a long way"}
              </span>
            </div>
          </div>
          <div className="header-controls">
            <div className="tone-control">
              <label htmlFor="tone">Response tone</label>
              <select
                id="tone"
                value={tone}
                disabled={streaming || loading}
                onChange={(e) => void setTone(e.target.value as Tone)}
              >
                <option value="professional">Professional</option>
                <option value="casual">Casual</option>
                <option value="concise">Concise</option>
              </select>
            </div>
            <span className="control-divider" />
            <button
              className="icon-button theme-button"
              onClick={() => setDark(!dark)}
              aria-label={
                dark ? "Switch to light theme" : "Switch to dark theme"
              }
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button
              onClick={() => {
                setError("");
                void refresh().catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div
          className="message-scroll"
          ref={scroll}
          onScroll={() => {
            const el = scroll.current;
            if (el)
              setNearBottom(
                el.scrollHeight - el.scrollTop - el.clientHeight < 100,
              );
          }}
        >
          {loading && (
            <div className="loading-state" role="status">
              <span className="loading-ring" />
              Loading your conversation…
            </div>
          )}
          {!loading && empty ? (
            <section className="welcome">
              <div className="welcome-badge">
                <Sparkles size={14} /> A LITTLE HELP. ENDLESS POSSIBILITIES.
              </div>
              <div className="welcome-symbol">
                <Sparkles size={35} strokeWidth={1.4} />
              </div>
              <h2>
                Good questions.
                <br />
                <span>Great conversations.</span>
              </h2>
              <p>
                How can I help you today?
                <br />A place to explore ideas, untangle problems, and move
                forward.
              </p>
              <div className="suggestions">
                {suggestions.map(({ icon: Icon, title, text, label }) => (
                  <button
                    key={title}
                    onClick={() => {
                      setDraft(text);
                      document.getElementById("message")?.focus();
                    }}
                  >
                    <Icon size={20} />
                    <strong>{title}</strong>
                    <span>{label}</span>
                    <ArrowUpRight size={15} className="suggestion-arrow" />
                  </button>
                ))}
              </div>
              <span className="welcome-footnote">
                Your next idea starts with a conversation.
              </span>
            </section>
          ) : (
            <div className="messages" aria-live="off" aria-label="Messages">
              {active?.messages.map((message, index) => (
                <ChatMessage
                  key={message._id || index}
                  message={message}
                  streaming={streaming && message._id === "streaming"}
                />
              ))}
              <div ref={bottom} />
            </div>
          )}
        </div>
        {!nearBottom && !empty && (
          <button
            className="scroll-bottom secondary-button"
            onClick={() => {
              setNearBottom(true);
              bottom.current?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <ArrowDown size={15} /> Latest response
          </button>
        )}
        <div className="composer-region">
          <ChatInput />
        </div>
        <span className="sr-only" role="status">
          {streaming
            ? "Assistant is generating a response. Use Stop generating to cancel."
            : ""}
        </span>
      </main>
    </div>
  );
}
