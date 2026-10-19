import { useEffect, useRef, useState } from "react";
import type { AskReply, ChatTurn } from "../api";
import { api } from "../api";
import { useAI } from "../ai";
import { Icon } from "./Icon";

interface Message extends ChatTurn {
  tasks?: AskReply["tasks"];
  error?: boolean;
}

const STORE_KEY = "planer-chat";

const SUGGESTIONS = [
  "Что я сделал на прошлой неделе?",
  "Сколько времени ушло на задачи по проектам за месяц?",
  "Что у меня просрочено или висит дольше всего?",
  "Что я делал вчера?",
];

const STATUS_RU: Record<string, string> = {
  todo: "открыта",
  done: "сделана",
  skipped: "пропущена",
  moved: "перенесена",
};

function loadMessages(): Message[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) || "[]");
  } catch {
    return [];
  }
}

function shortDate(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
}

/** Вопросы к планеру: ИИ находит нужные задачи и отвечает по ним. */
export function ChatDialog({
  today,
  onClose,
  onOpenDay,
}: {
  today: string;
  onClose: () => void;
  onOpenDay: (day: string) => void;
}) {
  const ai = useAI();
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-40)));
    } catch {
      /* ignore */
    }
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const history: ChatTurn[] = messages.filter((m) => !m.error).map(({ role, text }) => ({ role, text }));
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput("");
    setBusy(true);
    try {
      const r = await api.aiAsk(q, today, history);
      setMessages((m) => [...m, { role: "assistant", text: r.answer, tasks: r.tasks }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide chat-dialog" role="dialog" aria-label="Спросить планер">
        <header className="dialog-head">
          <h2>
            <Icon name="chat" /> Спросить планер
          </h2>
          {messages.length > 0 && (
            <button className="btn ghost sm" onClick={() => setMessages([])} disabled={busy}>
              Новый разговор
            </button>
          )}
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        {!ai.ready ? (
          <div className="notice">
            Для вопросов нужен ИИ-помощник.{" "}
            <button className="link-like" onClick={ai.openSettings}>
              Подключить
            </button>
          </div>
        ) : (
          <>
            <div className="chat-list" ref={listRef}>
              {messages.length === 0 && (
                <div className="chat-empty">
                  <p className="muted">
                    Спросите что угодно о своих задачах: что сделано, сколько времени ушло, что висит. ИИ найдёт нужные
                    задачи в планере и ответит по ним.
                  </p>
                  <div className="chat-suggestions">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} className="suggestion" onClick={() => ask(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`chat-msg ${m.role} ${m.error ? "error-msg" : ""}`}>
                  <div className="chat-bubble">{m.text}</div>
                  {m.tasks && m.tasks.length > 0 && (
                    <div className="chat-tasks">
                      {m.tasks.map((t) => (
                        <button
                          key={t.id}
                          className="chat-task"
                          onClick={() => {
                            onOpenDay(t.day);
                            onClose();
                          }}
                          title="Открыть день"
                        >
                          <span className={`dot ${t.status}`} />
                          {t.title}
                          <span className="muted small">
                            {shortDate(t.day)} · {STATUS_RU[t.status]}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {busy && (
                <div className="chat-msg assistant">
                  <div className="chat-bubble muted">
                    <Icon name="loader" /> Ищу в планере…
                  </div>
                </div>
              )}
            </div>
            <div className="chat-input">
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                placeholder="Например: что я делал по НОК на прошлой неделе?"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(input);
                  }
                }}
              />
              <button
                className="btn primary"
                onClick={() => ask(input)}
                disabled={busy || !input.trim()}
                aria-label="Спросить"
              >
                <Icon name="send" />
              </button>
            </div>
            <p className="privacy-note small">
              <Icon name="lock" /> В ИИ уходят только задачи, найденные по вопросу.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
