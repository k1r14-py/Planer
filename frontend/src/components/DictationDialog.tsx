import { useCallback, useEffect, useRef, useState } from "react";
import type { Day, DraftItem, VoiceStatus } from "../api";
import { api } from "../api";
import { formatClock, formatMinutes } from "../utils";
import { Icon } from "./Icon";

type Phase = "idle" | "recording" | "transcribing";

const MIC_KEY = "planer-mic";
const SILENT_LEVEL = 0.02; // ниже — считаем, что звука нет

function pickMime(): string | undefined {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

function countItems(items: DraftItem[]): number {
  return items.reduce((n, i) => n + 1 + countItems(i.children), 0);
}

function loadMic(): string {
  try {
    return localStorage.getItem(MIC_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveMic(id: string) {
  try {
    localStorage.setItem(MIC_KEY, id);
  } catch {
    /* ignore */
  }
}

/** Список микрофонов. Названия браузер отдаёт только после разрешения доступа. */
function useMicrophones() {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    setMics(all.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications"));
  }, []);
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);
  return { mics, refresh };
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
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [silent, setSilent] = useState(false);
  const [micId, setMicId] = useState(loadMic);
  const { mics, refresh: refreshMics } = useMicrophones();

  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const audioCtx = useRef<AudioContext | null>(null);
  const raf = useRef(0);
  const maxLevel = useRef(0);

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
    const h = setInterval(() => {
      const sec = (Date.now() - started.current) / 1000;
      setElapsed(sec);
      setSilent(sec > 2.5 && maxLevel.current < SILENT_LEVEL);
    }, 250);
    return () => clearInterval(h);
  }, [phase]);

  const stopMeter = () => {
    cancelAnimationFrame(raf.current);
    audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    setLevel(0);
  };

  // автозапуск записи — как только сервер подтвердил, что голос доступен
  // (диалог могли открыть клавишей V раньше, чем пришёл статус)
  const autoStarted = useRef(false);
  useEffect(() => {
    if (startRecording && canRecord && !autoStarted.current) {
      autoStarted.current = true;
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRecord]);

  useEffect(
    () => () => {
      stopMeter();
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && phase !== "recording" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, onClose]);

  async function openStream(): Promise<MediaStream> {
    if (micId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } });
      } catch {
        // выбранный микрофон отключили — берём системный по умолчанию
        setMicId("");
        saveMic("");
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }

  function startMeter(stream: MediaStream) {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    audioCtx.current = ctx;
    maxLevel.current = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      maxLevel.current = Math.max(maxLevel.current, peak);
      setLevel(peak);
      raf.current = requestAnimationFrame(tick);
    };
    tick();
  }

  async function start() {
    setError(null);
    setNotice(null);
    setSilent(false);
    try {
      const stream = await openStream();
      refreshMics(); // после разрешения доступа появляются названия устройств
      startMeter(stream);
      const mimeType = pickMime();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = async () => {
        stopMeter();
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: rec.mimeType });
        setPhase("transcribing");
        try {
          const r = await api.transcribe(blob);
          if (r.text) {
            setText((prev) => (prev.trim() ? `${prev.trim()}\n${r.text}` : r.text));
          } else if (r.peak < 0.01) {
            setNotice(
              `В записи тишина (${r.duration.toFixed(1)} с). Выберите другой микрофон в списке выше или проверьте ` +
                "Системные настройки → Конфиденциальность и безопасность → Микрофон: доступ для браузера должен быть включён.",
            );
          } else {
            setNotice(`Речь не распознана (${r.duration.toFixed(1)} с). Попробуйте говорить чуть громче или ближе к микрофону.`);
          }
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
      stopMeter();
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
  const hasLabels = mics.some((m) => m.label);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && phase === "idle" && onClose()}>
      <div className="dialog" role="dialog" aria-label="Надиктовать задачи">
        <header className="dialog-head">
          <h2>Надиктовать задачи</h2>
          <button className="icon-btn" onClick={onClose} disabled={phase === "recording"} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        {canRecord && mics.length > 0 && (
          <label className="mic-select">
            <Icon name="mic" />
            <select
              value={micId}
              disabled={phase !== "idle"}
              onChange={(e) => {
                setMicId(e.target.value);
                saveMic(e.target.value);
              }}
            >
              <option value="">Системный микрофон по умолчанию</option>
              {mics
                .filter((m) => m.deviceId && m.deviceId !== "default")
                .map((m, i) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || `Микрофон ${i + 1}`}
                  </option>
                ))}
            </select>
            {!hasLabels && <span className="muted small">названия появятся после первой записи</span>}
          </label>
        )}

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
                <div className="level" aria-label="Уровень звука">
                  <div className="level-fill" style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%` }} />
                </div>
                {silent ? (
                  <span className="warn-text">
                    Микрофон не передаёт звук — выберите другой в списке выше или проверьте доступ браузера к
                    микрофону в настройках macOS
                  </span>
                ) : (
                  <span className="muted">Нажмите ■, чтобы закончить</span>
                )}
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

        {notice && <div className="notice">{notice}</div>}

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
