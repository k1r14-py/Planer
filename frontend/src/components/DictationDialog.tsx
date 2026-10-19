import { useEffect, useRef, useState } from "react";
import type { Day, DraftItem, VoiceStatus } from "../api";
import { api } from "../api";
import { formatClock, formatMinutes } from "../utils";
import { Icon } from "./Icon";

type Phase = "idle" | "recording" | "transcribing";

function pickMime(): string | undefined {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

function countItems(items: DraftItem[]): number {
  return items.reduce((n, i) => n + 1 + countItems(i.children), 0);
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
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);

  const canRecord = !!voice?.available;

  // перепарсинг текста при ручном редактировании
  useEffect(() => {
    if (!text.trim()) {
      setItems([]);
      return;
    }
    const h = setTimeout(() => {
      api.parse(text).then((r) => setItems(r.items)).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(h);
  }, [text]);

  useEffect(() => {
    if (phase !== "recording") return;
    const h = setInterval(() => setElapsed((Date.now() - started.current) / 1000), 250);
    return () => clearInterval(h);
  }, [phase]);

  useEffect(() => {
    if (startRecording && canRecord) start();
    return () => {
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && phase !== "recording" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMime();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType });
        setPhase("transcribing");
        try {
          const r = await api.transcribe(blob);
          setText((prev) => (prev.trim() ? `${prev.trim()}\n${r.text}` : r.text));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setPhase("idle");
        }
      };
      recorder.current = rec;
      started.current = Date.now();
      setElapsed(0);
      rec.start();
      setPhase("recording");
    } catch (e) {
      setError(`Нет доступа к микрофону: ${(e as Error).message}`);
    }
  }

  function stop() {
    recorder.current?.stop();
  }

  async function add() {
    try {
      onAdded(await api.addBulk(day, items));
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const total = countItems(items);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && phase === "idle" && onClose()}>
      <div className="dialog" role="dialog" aria-label="Надиктовать задачи">
        <header className="dialog-head">
          <h2>Надиктовать задачи</h2>
          <button className="icon-btn" onClick={onClose} disabled={phase === "recording"} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        <div className="recorder">
          {phase === "recording" ? (
            <button className="rec-btn recording" onClick={stop}>
              <span className="pulse" />
              <Icon name="square" size={18} />
            </button>
          ) : (
            <button
              className="rec-btn"
              onClick={start}
              disabled={!canRecord || phase === "transcribing"}
              title={canRecord ? "Начать запись" : "Whisper не установлен на сервере"}
            >
              {phase === "transcribing" ? <Icon name="loader" size={20} /> : <Icon name="mic" size={20} />}
            </button>
          )}
          <div className="rec-info">
            {phase === "recording" && (
              <>
                <strong>Идёт запись · {formatClock(elapsed)}</strong>
                <span className="muted">Нажмите ■, чтобы закончить</span>
              </>
            )}
            {phase === "transcribing" && (
              <>
                <strong>Распознаю…</strong>
                <span className="muted">Локально, модель {voice?.model}</span>
              </>
            )}
            {phase === "idle" && canRecord && (
              <>
                <strong>Говорите задачи по порядку</strong>
                <span className="muted">
                  «Написать отчёт на час. Подзадача собрать данные. Потом позвонить маме»
                </span>
              </>
            )}
            {phase === "idle" && !canRecord && (
              <>
                <strong>Голос недоступен</strong>
                <span className="muted">
                  Установите <code>pip install -r backend/requirements-voice.txt</code> и перезапустите сервер.
                  Пока можно вписать список текстом ниже.
                </span>
              </>
            )}
          </div>
        </div>

        <label className="field-label" htmlFor="dictation-text">
          Текст (можно править — превью обновится)
        </label>
        <textarea
          id="dictation-text"
          className="textarea"
          rows={4}
          value={text}
          placeholder={"Каждая задача с новой строки или через точку.\nПодзадача … — добавит подзадачу к предыдущей."}
          onChange={(e) => setText(e.target.value)}
        />

        {error && <div className="error">{error}</div>}

        {items.length > 0 && (
          <div className="preview">
            <div className="field-label">Будет добавлено</div>
            <PreviewList items={items} />
          </div>
        )}

        <footer className="dialog-foot">
          <button className="btn ghost" onClick={onClose} disabled={phase === "recording"}>
            Отмена
          </button>
          <button className="btn primary" onClick={add} disabled={!total || phase !== "idle"}>
            Добавить {total ? total : ""}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PreviewList({ items }: { items: DraftItem[] }) {
  return (
    <ul className="preview-list">
      {items.map((i, idx) => (
        <li key={idx}>
          <span className="preview-row">
            <span className="check small" />
            {i.title}
            {i.estimate_min != null && <span className="chip">{formatMinutes(i.estimate_min)}</span>}
          </span>
          {i.children.length > 0 && <PreviewList items={i.children} />}
        </li>
      ))}
    </ul>
  );
}
