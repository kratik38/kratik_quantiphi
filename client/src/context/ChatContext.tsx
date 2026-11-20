import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../services/api";
import { streamProgressively } from "../services/progressiveStream";
import type {
  Conversation,
  Summary,
  Tone,
  Message,
  RegenerationPreview,
} from "../types";
interface ChatState {
  conversations: Summary[];
  active: Conversation | null;
  tone: Tone;
  draft: string;
  error: string;
  loading: boolean;
  streaming: boolean;
  sidebarOpen: boolean;
  setDraft: (value: string) => void;
  setError: (value: string) => void;
  setSidebarOpen: (value: boolean) => void;
  refresh: () => Promise<void>;
  select: (id: string, messageId?: string) => Promise<void>;
  highlightedMessage: { id: string; navigation: number } | null;
  regeneration: RegenerationPreview | null;
  regenerate: (messageId: string) => Promise<void>;
  newChat: () => void;
  remove: (id: string) => Promise<void>;
  setTone: (tone: Tone) => Promise<void>;
  send: (text?: string) => Promise<void>;
  stop: () => void;
}
const Context = createContext<ChatState | null>(null);
export function ChatProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Summary[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [tone, changeTone] = useState<Tone>("professional");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [regeneration, setRegeneration] = useState<RegenerationPreview | null>(
    null,
  );
  const [highlightedMessage, setHighlightedMessage] = useState<{
    id: string;
    navigation: number;
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.innerWidth >= 768,
  );
  const generation = useRef(0),
    busy = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const retry = useRef<{
    id: string;
    text: string;
    conversationId: string;
    tone: Tone;
  } | null>(null);
  const refresh = async () => {
    const result = await api<{ conversations: Summary[] }>("/conversations");
    setConversations(result.conversations);
  };
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    return () => controller.current?.abort();
  }, []);
  const stop = () => controller.current?.abort();
  const resetRequest = () => {
    ++generation.current;
    controller.current?.abort();
    controller.current = null;
    busy.current = false;
    setStreaming(false);
    setRegeneration(null);
    setHighlightedMessage(null);
    setLoading(false);
  };
  const select = async (id: string, messageId?: string) => {
    resetRequest();
    const version = generation.current;
    setError("");
    setDraft("");
    setLoading(true);
    if (window.innerWidth < 768) setSidebarOpen(false);
    try {
      const { conversation } = await api<{ conversation: Conversation }>(
        `/conversations/${id}`,
      );
      if (generation.current !== version) return;
      setActive(conversation);
      if (messageId)
        setHighlightedMessage({ id: messageId, navigation: version });
      changeTone(conversation.tone);
      localStorage.setItem("activeConversation", id);
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    const id = localStorage.getItem("activeConversation");
    if (id) void select(id);
  }, []);
  const newChat = () => {
    resetRequest();
    setActive(null);
    setDraft("");
    setError("");
    changeTone("professional");
    localStorage.removeItem("activeConversation");
    if (window.innerWidth < 768) setSidebarOpen(false);
  };
  const remove = async (id: string) => {
    try {
      await api(`/conversations/${id}`, { method: "DELETE" });
      if (active?._id === id) newChat();
      setConversations((list) => list.filter((item) => item._id !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setTone = async (next: Tone) => {
    if (busy.current || loading) return;
    const previous = tone,
      id = active?._id,
      version = generation.current;
    changeTone(next);
    setError("");
    if (!id) return;
    busy.current = true;
    setLoading(true);
    try {
      const { conversation } = await api<{ conversation: Conversation }>(
        `/conversations/${id}`,
        { method: "PATCH", body: JSON.stringify({ tone: next }) },
      );
      if (version === generation.current) {
        setActive(conversation);
        void refresh().catch((e) => setError((e as Error).message));
      }
    } catch (e) {
      if (version === generation.current) {
        changeTone(previous);
        setError((e as Error).message);
      }
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setLoading(false);
      }
    }
  };
  const send = async (provided?: string) => {
    const text = (provided ?? draft).trim();
    if (!text || busy.current || loading) return;
    busy.current = true;
    setStreaming(true);
    setError("");
    setDraft("");
    const version = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    let conversation = active;
    let finalConversation: Conversation | undefined;
    try {
      if (!conversation) {
        const timestamp = new Date().toISOString();
        setActive({
          _id: "new",
          title: text.slice(0, 55),
          tone,
          createdAt: timestamp,
          updatedAt: timestamp,
          messages: [
            { _id: "optimistic", role: "user", content: text, timestamp, tone },
            {
              _id: "streaming",
              role: "assistant",
              content: "",
              timestamp,
              tone,
            },
          ],
        });
        ({ conversation } = await api<{ conversation: Conversation }>(
          "/conversations",
          {
            method: "POST",
            body: JSON.stringify({ tone }),
            signal: abort.signal,
          },
        ));
        if (version !== generation.current) return;
        setActive(conversation);
        localStorage.setItem("activeConversation", conversation._id);
      }
      const conversationId = conversation._id;
      const lastMessage = conversation.messages.at(-1);
      const savedRetryId =
        lastMessage?.role === "user" &&
        lastMessage.content === text &&
        lastMessage.tone === tone &&
        (lastMessage.status === "failed" || lastMessage.status === "cancelled")
          ? lastMessage.requestId
          : undefined;
      const requestId =
        retry.current?.text === text &&
        retry.current.conversationId === conversationId &&
        retry.current.tone === tone
          ? retry.current.id
          : savedRetryId || crypto.randomUUID();
      retry.current = { id: requestId, text, conversationId, tone };
      const optimistic: Message = {
        _id: "optimistic",
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        tone,
        requestId,
      };
      setActive({
        ...conversation,
        messages: [
          ...conversation.messages.filter((m) => m.requestId !== requestId),
          optimistic,
          {
            _id: "streaming",
            role: "assistant",
            content: "",
            timestamp: new Date().toISOString(),
            tone,
          },
        ],
      });
      finalConversation = await streamProgressively(
        { conversationId, message: text, tone, requestId },
        abort.signal,
        (content) => {
          if (version !== generation.current) return;
          setActive((current) =>
            current
              ? {
                  ...current,
                  messages: current.messages.map((m) =>
                    m._id === "streaming" ? { ...m, content } : m,
                  ),
                }
              : current,
          );
        },
        ({ event, data }) => {
          if (version !== generation.current) return;
          if (event === "start" && data.userMessage)
            setActive((current) =>
              current
                ? {
                    ...current,
                    messages: current.messages.map((m) =>
                      m._id === "optimistic"
                        ? (data.userMessage as unknown as Message)
                        : m,
                    ),
                  }
                : current,
            );
        },
      );
      if (version !== generation.current) return;
      if (!finalConversation)
        ({ conversation: finalConversation } = await api<{
          conversation: Conversation;
        }>(`/conversations/${conversationId}`));
      if (version !== generation.current) return;
      setActive(finalConversation);
      retry.current = null;
      void refresh().catch((e) => setError((e as Error).message));
    } catch (e) {
      if (version !== generation.current) return;
      const cancelled = abort.signal.aborted;
      setError(
        cancelled
          ? "Response stopped. You can send your message again to retry."
          : (e as Error).message,
      );
      setDraft(text);
      if (!conversation) setActive(null);
      if (conversation) {
        try {
          const result = await api<{ conversation: Conversation }>(
            `/conversations/${conversation._id}`,
          );
          if (version === generation.current) setActive(result.conversation);
        } catch {
          setActive((current) =>
            current
              ? {
                  ...current,
                  messages: current.messages.filter(
                    (m) => m._id !== "streaming",
                  ),
                }
              : current,
          );
        }
        void refresh().catch(() => {});
      }
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setStreaming(false);
        controller.current = null;
      }
    }
  };
  const regenerate = async (messageId: string) => {
    if (!active || busy.current || loading) return;
    const latest = [...active.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.status === "completed");
    if (latest?._id !== messageId) return;
    busy.current = true;
    setStreaming(true);
    setError("");
    setHighlightedMessage(null);
    const version = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    const conversationId = active._id;
    setRegeneration({
      messageId,
      content: "",
      tone,
      timestamp: new Date().toISOString(),
    });
    try {
      let conversation = await streamProgressively(
        { conversationId, messageId, tone },
        abort.signal,
        (content) => {
          if (version === generation.current)
            setRegeneration((current) =>
              current ? { ...current, content } : current,
            );
        },
        () => {},
        "/chat/regenerate",
      );
      if (version !== generation.current) return;
      if (!conversation)
        ({ conversation } = await api<{ conversation: Conversation }>(
          `/conversations/${conversationId}`,
        ));
      if (version !== generation.current) return;
      setActive(conversation);
      void refresh().catch((e) => setError((e as Error).message));
    } catch (e) {
      if (version !== generation.current) return;
      setError(
        abort.signal.aborted
          ? "Regeneration stopped. Your original response is preserved."
          : `Regeneration failed. ${(e as Error).message}`,
      );
      // A lost final event may follow a successful database commit; reconcile canonical state.
      try {
        const result = await api<{ conversation: Conversation }>(
          `/conversations/${conversationId}`,
        );
        if (version === generation.current) setActive(result.conversation);
      } catch {
        /* Keep the original messages if reloading is unavailable. */
      }
    } finally {
      if (version === generation.current) {
        busy.current = false;
        setStreaming(false);
        setRegeneration(null);
        controller.current = null;
      }
    }
  };
  return (
    <Context.Provider
      value={{
        conversations,
        active,
        tone,
        draft,
        error,
        loading,
        streaming,
        regeneration,
        regenerate,
        highlightedMessage,
        sidebarOpen,
        setDraft,
        setError,
        setSidebarOpen,
        refresh,
        select,
        newChat,
        remove,
        setTone,
        send,
        stop,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useChat() {
  const context = useContext(Context);
  if (!context) throw new Error("ChatProvider is required");
  return context;
}
