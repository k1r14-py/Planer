import { useEffect, useRef, useState } from "react";
import type { UpdateInfo, UpdateStatus } from "../api";
import { api } from "../api";
import { Icon } from "./Icon";

const LAST_CHECK_KEY = "planer-update-checked";
const DAY_MS = 24 * 3600 * 1000;
const RESTART_TIMEOUT_MS = 4 * 60 * 1000;

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "result"; info: UpdateInfo }
  | { kind: "updating"; message: string }
  | { kind: "error"; message: string };

function storedCheck(): number {
  try {
    return Number(localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
}

function rememberCheck() {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ждём, пока сервер перезапустится уже с новой версией. */
async function waitForVersion(version: string, onTick: (s: UpdateStatus | null) => void): Promise<void> {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(1000);
    let s: UpdateStatus;
    try {
      s = await api.updateStatus();
    } catch {
      // сервер в перезапуске — запросы падают, это нормально
      onTick(null);
      continue;
    }
    if (s.state === "error") throw new Error(s.message);
    if (s.current === version) return;
    onTick(s);
  }
  throw new Error("Сервер не вернулся после обновления — загляните в лог ~/Library/Logs/Planer.log");
}

export function UpdateButton() {
  const [version, setVersion] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [badge, setBadge] = useState<UpdateInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.health().then((h) => setVersion(h.version), () => {});
    // тихая проверка раз в сутки
    if (Date.now() - storedCheck() > DAY_MS) {
      api.updateCheck().then(
        (info) => {
          rememberCheck();
          if (info.available) setBadge(info);
        },
        () => {},
      );
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && phase.kind !== "updating") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, phase.kind]);

  async function check() {
    setPhase({ kind: "checking" });
    try {
      const info = await api.updateCheck();
      rememberCheck();
      setBadge(info.available ? info : null);
      setPhase({ kind: "result", info });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  async function apply(info: UpdateInfo) {
    setPhase({ kind: "updating", message: `Скачиваю версию ${info.latest}…` });
    try {
      await api.updateApply();
      await waitForVersion(info.latest, (s) =>
        setPhase({ kind: "updating", message: s?.message || "Перезапускаю…" }),
      );
      setPhase({ kind: "updating", message: "Готово, перезагружаю страницу…" });
      window.location.reload();
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && phase.kind === "idle") {
      if (badge) setPhase({ kind: "result", info: badge });
      else check();
    }
  };

  return (
    <div className="update-wrap" ref={ref}>
      <button className="version-btn" onClick={toggle} title="Обновления">
        v{version || "…"}
        {badge && <span className="update-dot" aria-label="Есть обновление" />}
      </button>
      {open && (
        <div className="update-panel">
          <div className="update-head">
            <strong>Planer {version && `v${version}`}</strong>
            {phase.kind !== "updating" && phase.kind !== "checking" && (
              <button className="btn ghost sm" onClick={check}>
                Проверить обновления
              </button>
            )}
          </div>

          {phase.kind === "checking" && (
            <p className="update-line">
              <Icon name="loader" /> Проверяю GitHub…
            </p>
          )}

          {phase.kind === "error" && <div className="error">{phase.message}</div>}

          {phase.kind === "result" && !phase.info.available && (
            <p className="update-line ok">
              <Icon name="check" /> Установлена последняя версия
            </p>
          )}

          {phase.kind === "result" && phase.info.available && (
            <>
              <p className="update-line">
                Доступна версия <strong>{phase.info.latest}</strong>
                {phase.info.published_at && (
                  <span className="muted small">
                    {" "}
                    · {new Date(phase.info.published_at).toLocaleDateString("ru-RU")}
                  </span>
                )}
              </p>
              {phase.info.notes && <pre className="update-notes">{phase.info.notes}</pre>}
              {phase.info.can_apply ? (
                <button className="btn primary" onClick={() => apply(phase.info)}>
                  Обновить до {phase.info.latest}
                </button>
              ) : (
                <p className="muted small">
                  {phase.info.reason}
                  {phase.info.url && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={phase.info.url} target="_blank" rel="noreferrer">
                        страница релиза
                      </a>
                    </>
                  )}
                </p>
              )}
              <p className="muted small">Задачи сохранятся: перед обновлением делается копия базы.</p>
            </>
          )}

          {phase.kind === "updating" && (
            <p className="update-line">
              <Icon name="loader" /> {phase.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
