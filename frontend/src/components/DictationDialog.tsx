import { useEffect, useRef, useState } from "react";
import type { Day, VoiceStatus } from "../api";
import { api } from "../api";
import { useAI } from "../ai";
import { DraftList, flatten, unflatten, type DraftRow } from "./DraftList";
import { Icon } from "./Icon";
import { Recorder, type RecPhase } from "./Recorder";

type Mode = "ai" | "rules";

const MODE_KEY = "planer-parse-mode";

const HELP_RULES: [string, string][] = [
  ["Новая задача", "точка или «потом»: «Купить хлеб. Потом позвонить маме»"],
  ["Подзадача", "«подзадача собрать данные» — вложится в предыдущую задачу"],
  ["Оценка", "«на 30 минут», «на час», «полтора часа»"],
  ["Срок", "«до пятницы», «к 25 октября», «до конца недели»"],
  ["Проект", "«…, проект Работа» или «по проекту Работа»"],
  ["Тег", "«тег срочно»"],
];

const HELP_AI: [string, string][] = [
  ["Говорите свободно", "«надо бы к пятнице доделать отчёт, там сначала собрать данные, и маме вечером позвонить»"],
  ["ИИ сам поймёт", "где отдельные задачи, а где шаги одной задачи; сроки, длительность и проекты"],
  ["Проверьте список", "перед добавлением можно поправить любую задачу"],
];

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "rules" ? "rules" : "ai";
  } catch {
    return "ai";
  }
}

export function DictationDialog({
  day,
  voice,
  startRecording,
  onClose,
  onAdded,
}: {
  day: string;
  voice: VoiceStatus | null;
  startRecording: boolean;
  onClose: () => void;
  onAdded: (d: Day) => void;
}) {
  const ai = useAI();
  const [phase, setPhase] = useState<RecPhase>("idle");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [edited, setEdited] = useState(false); // список правили руками — правка текста их сбросит
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preferred, setPreferred] = useState<Mode>(loadMode);
  const [parsing, setParsing] = useState(false);
  const [parsedText, setParsedText] = useState(""); // какой текст разобран ИИ последним
  const [parsedBy, setParsedBy] = useState<Mode | null>(null);
  const request = useRef(0);

  const mode: Mode = ai.ready ? preferred : "rules";

  const setMode = (m: Mode) => {
    setPreferred(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  async function parseWith(m: Mode, value: string) {
    const id = ++request.current;
    if (!value.trim()) {
      setRows([]);
      setParsedBy(null);
      return;
    }
    setError(null);
    if (m === "ai") {
      setParsing(true);
      setNotice(null);
      try {
        const r = await api.aiParse(value, day);
        if (id !== request.current) return;
        setRows(flatten(r.items));
        setParsedBy("ai");
        setParsedText(value);
        setEdited(false);
        return;
      } catch (e) {
        if (id !== request.current) return;
        setNotice(`ИИ не ответил: ${(e as Error).message} Разобрал по правилам.`);
      } finally {
        if (id === request.current) setParsing(false);
      }
    }
    try {
      const r = await api.parse(value, day);
      if (id !== request.current) return;
      setRows(flatten(r.items));
      setParsedBy("rules");
      setEdited(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ручная правка текста: правила — на лету; ИИ — по кнопке (не дёргаем модель на каждую букву)
  useEffect(() => {
    if (mode !== "rules") return;
    const h = setTimeout(() => parseWith("rules", text), 250);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && phase !== "recording" && !parsing && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, parsing, onClose]);

  const onRecorded = (t: string) => {
    const next = text.trim() ? `${text.trim()}\n${t}` : t;
    setText(next);
    if (mode === "ai") parseWith("ai", next);
  };

  async function add() {
    try {
      onAdded(await api.addBulk(day, unflatten(rows)));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const total = unflatten(rows).reduce((n, i) => n + 1 + i.children.length, 0);
  const aiStale = mode === "ai" && text.trim() && text !== parsedText;
  const busy = phase !== "idle" || parsing;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label="Надиктовать задачи">
        <header className="dialog-head">
          <h2>Надиктовать задачи</h2>
          <button className="icon-btn" onClick={onClose} disabled={phase === "recording"} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        {ai.ready ? (
          <div className="mode-row">
            <span className="muted small">Разбор:</span>
            <div className="segmented small" role="tablist">
              <button className={mode === "ai" ? "active" : ""} onClick={() => setMode("ai")} disabled={busy}>
                <Icon name="sparkles" /> ИИ — свободная речь
              </button>
              <button className={mode === "rules" ? "active" : ""} onClick={() => setMode("rules")} disabled={busy}>
                По правилам
              </button>
            </div>
          </div>
        ) : (
          <button className="ai-hint" onClick={ai.openSettings}>
            <Icon name="sparkles" /> Подключите ИИ, чтобы говорить свободно, без правил — локально или через DeepSeek,
            Qwen, ChatGPT
          </button>
        )}

        <Recorder
          voice={voice}
          autoStart={startRecording}
          onText={onRecorded}
          onPhase={setPhase}
          idleTitle={mode === "ai" ? "Расскажите, что нужно сделать" : "Говорите задачи по порядку"}
          idleHint={
            mode === "ai"
              ? "Своими словами — ИИ разложит на задачи, сроки и подзадачи"
              : "«Написать отчёт на час. Подзадача собрать данные. Потом позвонить маме»"
          }
        />

        {notice && <div className="notice">{notice}</div>}

        {parsing && (
          <div className="parsing">
            <Icon name="loader" /> ИИ разбирает текст…
          </div>
        )}

        {rows.length === 0 && phase !== "transcribing" && !parsing && (
          <div className="dictation-help">
            <div className="field-label">{mode === "ai" ? "Как это работает" : "Как говорить"}</div>
            <dl>
              {(mode === "ai" ? HELP_AI : HELP_RULES).map(([what, how]) => (
                <div key={what}>
                  <dt>{what}</dt>
                  <dd>{how}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {rows.length > 0 && (
          <div className={`preview ${parsing ? "refetching" : ""}`}>
            <div className="field-label">
              Будет добавлено · {total}
              {parsedBy === "ai" && (
                <span className="badge accent">
                  <Icon name="sparkles" size={11} /> разобрано ИИ
                </span>
              )}
            </div>
            <div className="preview-hint muted small">
              Нажмите на название, чтобы исправить · <Icon name="indent" size={12} /> — сделать подзадачей
              предыдущей · × — убрать
            </div>
            <DraftList
              rows={rows}
              onChange={(next) => {
                setRows(next);
                setEdited(true);
              }}
            />
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <details className="dictation-text" open={!startRecording || !voice?.available || undefined}>
          <summary className="field-label">
            {voice?.available ? "Распознанный текст" : "Текст"}
            {edited ? " (повторный разбор сбросит правки в списке)" : ""}
          </summary>
          <textarea
            id="dictation-text"
            className="textarea"
            rows={3}
            value={text}
            placeholder={
              mode === "ai"
                ? "Напишите своими словами, что нужно сделать…"
                : "Каждая задача с новой строки или через точку.\nПодзадача … — добавит подзадачу к предыдущей."
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (mode === "ai" && e.key === "Enter" && (e.metaKey || e.ctrlKey)) parseWith("ai", text);
            }}
          />
          {aiStale && (
            <button className="btn sm" onClick={() => parseWith("ai", text)} disabled={parsing}>
              <Icon name="sparkles" /> Разобрать с ИИ <span className="muted">⌘/Ctrl + Enter</span>
            </button>
          )}
        </details>

        <footer className="dialog-foot">
          <button className="btn ghost" onClick={onClose} disabled={phase === "recording"}>
            Отмена
          </button>
          <button className="btn primary" onClick={add} disabled={!total || busy}>
            Добавить {total ? total : ""}
          </button>
        </footer>
      </div>
    </div>
  );
}
