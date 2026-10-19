import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceStatus } from "../api";
import { api } from "../api";
import { formatClock } from "../utils";
import { Icon } from "./Icon";

export type RecPhase = "idle" | "recording" | "transcribing";

const MIC_KEY = "planer-mic";
const SILENT_LEVEL = 0.02; // ниже — считаем, что звука нет

function pickMime(): string | undefined {
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
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

/** Запись с микрофона → локальный Whisper → текст. Выбор микрофона, уровень звука, понятные ошибки. */
export function Recorder({
  voice,
  autoStart,
  onText,
  onPhase,
  idleTitle,
  idleHint,
}: {
  voice: VoiceStatus | null;
  autoStart: boolean;
  onText: (text: string) => void;
  onPhase?: (phase: RecPhase) => void;
  idleTitle: string;
  idleHint: string;
}) {
  const [phase, setPhaseState] = useState<RecPhase>("idle");
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
  // модель распознавания скачивается в фоне при первом запуске — показываем, пока не готова
  const [model, setModel] = useState(voice?.state);
  const [modelError, setModelError] = useState(voice?.error ?? null);
  useEffect(() => {
    if (!canRecord) return;
    let alive = true;
    let timer = 0;
    const poll = () =>
      api.voiceStatus().then((v) => {
        if (!alive) return;
        setModel(v.state);
        setModelError(v.error ?? null);
        if (v.state === "loading") timer = window.setTimeout(poll, 3000);
      }, () => {});
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [canRecord]);

  const setPhase = (p: RecPhase) => {
    setPhaseState(p);
    onPhase?.(p);
  };

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

  // автозапуск — как только сервер подтвердил, что голос доступен
  // (диалог могли открыть клавишей V раньше, чем пришёл статус)
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStart && canRecord && !autoStarted.current) {
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
          if (r.text) onText(r.text);
          else if (r.peak < 0.01)
            setNotice(
              `В записи тишина (${r.duration.toFixed(1)} с). Выберите другой микрофон в списке выше или проверьте ` +
                "Системные настройки → Конфиденциальность и безопасность → Микрофон: доступ для браузера должен быть включён.",
            );
          else setNotice(`Речь не распознана (${r.duration.toFixed(1)} с). Попробуйте говорить чуть громче или ближе к микрофону.`);
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

  const hasLabels = mics.some((m) => m.label);

  return (
    <>
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
          <button className="rec-btn recording" onClick={() => recorder.current?.stop()} aria-label="Остановить запись">
            <span className="pulse" />
            <Icon name="square" size={18} />
          </button>
        ) : (
          <button
            className="rec-btn"
            onClick={start}
            disabled={!canRecord || phase === "transcribing"}
            title={canRecord ? "Начать запись" : "Распознавание речи не установлено"}
            aria-label="Начать запись"
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
                  Микрофон не передаёт звук — выберите другой в списке выше или проверьте доступ браузера к микрофону в
                  настройках системы
                </span>
              ) : (
                <span className="muted">Нажмите ■, чтобы закончить</span>
              )}
            </>
          )}
          {phase === "transcribing" && (
            <>
              <strong>Распознаю речь…</strong>
              <span className="muted">
                {model === "loading"
                  ? "Первый раз — дожидаюсь загрузки модели распознавания, это может занять несколько минут"
                  : `Локально, модель ${voice?.model}`}
              </span>
            </>
          )}
          {phase === "idle" && canRecord && (
            <>
              <strong>{idleTitle}</strong>
              <span className="muted">{idleHint}</span>
              {model === "loading" && (
                <span className="muted small model-note">
                  <Icon name="loader" size={12} /> Готовлю распознавание речи — один раз скачивается модель (~500 МБ). Записать
                  можно уже сейчас.
                </span>
              )}
              {model === "error" && modelError && (
                <span className="warn-text">Модель распознавания не загрузилась: {modelError}</span>
              )}
            </>
          )}
          {phase === "idle" && !canRecord && (
            <>
              <strong>Голос недоступен</strong>
              <span className="muted">Распознавание речи не установлено. Пока можно вписать текст ниже.</span>
            </>
          )}
        </div>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}
    </>
  );
}
