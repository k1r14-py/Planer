import { useEffect, useRef, useState } from "react";
import type { ShellCheck, UpdateInfo, UpdateStatus } from "../api";
import { api } from "../api";
import { Icon } from "./Icon";

const LAST_CHECK_KEY = "planer-update-checked";
const DAY_MS = 24 * 3600 * 1000;
const RESTART_TIMEOUT_MS = 4 * 60 * 1000;

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "result"; info: UpdateInfo; shell: ShellCheck | null }
  | { kind: "updating"; message: string }
  | { kind: "manual"; message: string }
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

/** Проверка оболочки — только в приложении; в браузере и при ошибке сети просто null. */
async function checkShell(): Promise<ShellCheck | null> {
  try {
    return (await window.planerDesktop?.shellUpdate?.check()) ?? null;
  } catch {
    return null;
  }
}

const hasUpdate = (info: UpdateInfo, shell: ShellCheck | null) => info.available || !!shell?.available;

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
  const [badge, setBadge] = useState<{
    info: UpdateInfo;
    shell: ShellCheck | null;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.health().then(
      (h) => setVersion(h.version),
      () => {},
    );
    // тихая проверка раз в сутки
    if (Date.now() - storedCheck() > DAY_MS) {
      Promise.all([api.updateCheck(), checkShell()]).then(
        ([info, shell]) => {
          rememberCheck();
          if (hasUpdate(info, shell)) setBadge({ info, shell });
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
      const [info, shell] = await Promise.all([api.updateCheck(), checkShell()]);
      rememberCheck();
      setBadge(hasUpdate(info, shell) ? { info, shell } : null);
      setPhase({ kind: "result", info, shell });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  async function apply(info: UpdateInfo) {
    setPhase({ kind: "updating", message: `Скачиваю версию ${info.latest}…` });
    try {
      await api.updateApply();
      await waitForVersion(info.latest, (s) => setPhase({ kind: "updating", message: s?.message || "Перезапускаю…" }));
      setPhase({ kind: "updating", message: "Готово, перезагружаю страницу…" });
      window.location.reload();
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  /** Новая оболочка: скачать установщик и поставить приложение целиком (код в нём тоже свежий). */
  async function applyShell(shell: ShellCheck) {
    const bridge = window.planerDesktop?.shellUpdate;
    if (!bridge) return;
    setPhase({
      kind: "updating",
      message: `Скачиваю Planer ${shell.version}…`,
    });
    const off = bridge.onStatus((job) => {
      if (job.state === "error") {
        off();
        setPhase({ kind: "error", message: job.message });
      } else if (job.state === "manual") {
        off();
        setPhase({ kind: "manual", message: job.message });
      } else {
        const pct = job.progress != null ? ` (${Math.round(job.progress * 100)}%)` : "";
        setPhase({ kind: "updating", message: job.message + pct });
      }
    });
    try {
      await bridge.install();
    } catch (e) {
      off();
      setPhase({ kind: "error", message: (e as Error).message });
    }
  }

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && phase.kind === "idle") {
      if (badge) setPhase({ kind: "result", ...badge });
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

          {phase.kind === "manual" && <div className="notice">{phase.message}</div>}

          {phase.kind === "result" && phase.shell?.available && (
            <>
              <p className="update-line">
                Доступна версия <strong>{phase.shell.version}</strong>
                {phase.info.published_at && (
                  <span className="muted small">
                    {" "}
                    · {new Date(phase.info.published_at).toLocaleDateString("ru-RU")}
                  </span>
                )}
              </p>
              {phase.info.available && phase.info.notes && <pre className="update-notes">{phase.info.notes}</pre>}
              <p className="muted small">
                В этой версии обновилось само приложение — скачаю его целиком
                {phase.shell.size ? ` (${Math.round(phase.shell.size / 1048576)} МБ)` : ""}
                {phase.shell.automatic
                  ? " и перезапущу Planer."
                  : ". Откроется окно установки — перетащите Planer в «Программы» с заменой."}
              </p>
              <button className="btn primary" onClick={() => applyShell(phase.shell!)}>
                Обновить до {phase.shell.version}
              </button>
              <p className="muted small">Задачи и настройки сохранятся.</p>
            </>
          )}

          {phase.kind === "result" && !hasUpdate(phase.info, phase.shell) && (
            <p className="update-line ok">
              <Icon name="check" /> Установлена последняя версия
            </p>
          )}

          {phase.kind === "result" && phase.info.available && !phase.shell?.available && (
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

          {window.planerDesktop && !window.planerDesktop.shellUpdate && phase.kind !== "updating" && (
            <p className="muted small">
              Чтобы Planer обновлялся целиком (вместе с самим приложением), один раз установите новую версию{" "}
              <a href="https://github.com/k1r14-py/Planer/releases/latest" target="_blank" rel="noreferrer">
                с GitHub
              </a>
              . Задачи сохранятся.
            </p>
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
