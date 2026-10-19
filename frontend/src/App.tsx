import { useCallback, useEffect, useState } from "react";
import type { Day, VoiceStatus } from "./api";
import { api } from "./api";
import { DayView } from "./components/DayView";
import { DictationDialog } from "./components/DictationDialog";
import { DashboardView } from "./components/dashboard/DashboardView";
import { Icon } from "./components/Icon";
import { AISettingsDialog } from "./components/AISettingsDialog";
import { PlanFactView } from "./components/PlanFactView";
import { TasksView } from "./components/TasksView";
import { UpdateButton } from "./components/UpdateButton";
import { AIStateProvider, useAI } from "./ai";
import { useProjects } from "./projects";
import { formatDayTitle, isoDay, relativeLabel, shiftDay } from "./utils";

type Tab = "day" | "planfact" | "tasks" | "dashboard";

// мост из оболочки приложения (desktop/preload.js); в браузере его нет
declare global {
  interface Window {
    planerDesktop?: {
      onDictate: (cb: () => void) => () => void;
      onHotkey: (cb: (label: string) => void) => () => void;
      getHotkey: () => Promise<string>;
    };
  }
}
type Theme = "light" | "dark";

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("planer-theme");
    if (t === "light" || t === "dark") return t;
  } catch {
    /* storage недоступен */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const today = isoDay(new Date());
  const [day, setDay] = useState(today);
  const [tab, setTab] = useState<Tab>("day");
  const [data, setData] = useState<Day | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [dictation, setDictation] = useState<null | { record: boolean }>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [hotkey, setHotkey] = useState<string | null>(null);

  // приложение: глобальная горячая клавиша открывает диктовку из любой программы
  useEffect(() => {
    const desk = window.planerDesktop;
    if (!desk) return;
    const offDictate = desk.onDictate(() => {
      setTab("day");
      setDictation({ record: true });
    });
    const offHotkey = desk.onHotkey(setHotkey);
    desk.getHotkey().then(setHotkey, () => {});
    return () => {
      offDictate();
      offHotkey();
    };
  }, []);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const { reload: reloadProjects } = useProjects();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("planer-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const load = useCallback(() => {
    api.day(day).then(setData, (e) => setError(e.message));
  }, [day]);

  useEffect(load, [load]);
  useEffect(() => {
    api.voiceStatus().then(setVoice, () => setVoice(null));
  }, []);

  // тикаем раз в секунду, только если идёт таймер
  const timerRunning = !!data?.tasks.some((t) => t.timer_started_at);
  useEffect(() => {
    if (!timerRunning) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [timerRunning]);

  // любое действие: ответ с днём — применяем, иначе перечитываем
  const run = useCallback(
    (p: Promise<unknown>) => {
      setError(null);
      p.then(
        (r) => {
          if (r && typeof r === "object" && "tasks" in r && (r as Day).day === day) setData(r as Day);
          else load();
          setNow(Date.now());
          reloadProjects(); // быстрая строка «@Проект» могла создать новый проект
        },
        (e) => setError(e.message),
      );
    },
    [day, load, reloadProjects],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea") || e.metaKey || e.ctrlKey || e.altKey || dictation) return;
      if (e.key === "v" || e.key === "м") setDictation({ record: true });
      else if (e.key === "n" || e.key === "т") {
        e.preventDefault();
        setTab("day");
        setTimeout(() => document.getElementById("quick-add")?.focus());
      } else if (e.key === "ArrowLeft") setDay((d) => shiftDay(d, -1));
      else if (e.key === "ArrowRight") setDay((d) => shiftDay(d, 1));
      else if (e.key === "t" || e.key === "е") setDay(today);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dictation, today]);

  const carryOver = () => {
    const to = shiftDay(day, 1);
    run(api.carryOver(day, to).then((r) => r.day));
  };

  const openDay = (d: string) => {
    setDay(d);
    setTab("day");
  };

  const rel = relativeLabel(day, today);

  return (
    <AIStateProvider openSettings={() => setAiOpen(true)}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">
            <Icon name="check" size={14} />
          </span>
          Planer
        </div>
        <nav className="tabs" role="tablist">
          {(
            [
              ["day", "День", "list"],
              ["planfact", "План / Факт", "columns"],
              ["tasks", "Задачи", "search"],
              ["dashboard", "Дашборд", "chart"],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`tab ${tab === id ? "active" : ""}`}
              onClick={() => setTab(id)}
            >
              <Icon name={icon} /> <span>{label}</span>
            </button>
          ))}
        </nav>
        <AIButton />
        <UpdateButton />
        <button
          className="icon-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Сменить тему"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
        </button>
      </header>

      <main className="content">
        {(tab === "day" || tab === "planfact") && (
          <div className="date-nav">
            <button className="icon-btn" onClick={() => setDay(shiftDay(day, -1))} aria-label="Предыдущий день">
              <Icon name="chevron-left" />
            </button>
            <div className="date-title">
              {rel && <span className="date-rel">{rel}</span>}
              <h1>{formatDayTitle(day)}</h1>
            </div>
            <button className="icon-btn" onClick={() => setDay(shiftDay(day, 1))} aria-label="Следующий день">
              <Icon name="chevron-right" />
            </button>
            <label className="icon-btn date-picker" title="Выбрать дату">
              <Icon name="calendar" />
              <input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
            </label>
            {day !== today && (
              <button className="btn ghost sm" onClick={() => setDay(today)}>
                Сегодня
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="error" onClick={() => setError(null)}>
            {error}
          </div>
        )}

        {tab === "tasks" ? (
          <TasksView today={today} onOpenDay={openDay} />
        ) : tab === "dashboard" ? (
          <DashboardView today={today} onOpenDay={openDay} />
        ) : !data || data.day !== day ? (
          <div className="muted">Загрузка…</div>
        ) : tab === "day" ? (
          <DayView
            data={data}
            now={now}
            run={run}
            onDictate={(record) => setDictation({ record })}
            onCarryOver={carryOver}
            onOpenDay={openDay}
          />
        ) : (
          <PlanFactView data={data} now={now} voice={voice} onChange={setData} />
        )}
      </main>

      <footer className="hints muted small">
        <kbd>N</kbd> новая задача · <kbd>V</kbd> диктовка
        {hotkey && (
          <>
            {" "}
            (из любой программы — <kbd>{hotkey}</kbd>)
          </>
        )}{" "}
        · <kbd>←</kbd>/<kbd>→</kbd> дни · <kbd>T</kbd> сегодня ·
        двойной клик — переименовать · перетаскивание — порядок
      </footer>

      {dictation && (
        <DictationDialog
          day={day}
          voice={voice}
          startRecording={dictation.record}
          onClose={() => setDictation(null)}
          onAdded={(d) => {
            setData(d);
            setTab("day");
            reloadProjects();
          }}
        />
      )}

      {aiOpen && <AISettingsDialog onClose={() => setAiOpen(false)} />}
    </div>
    </AIStateProvider>
  );
}

/** Кнопка ИИ в шапке: точка показывает, подключён ли помощник. */
function AIButton() {
  const ai = useAI();
  return (
    <button
      className={`ai-btn ${ai.ready ? "on" : ""}`}
      onClick={ai.openSettings}
      title={ai.ready ? `ИИ подключён: ${ai.settings?.model}` : "Подключить ИИ-помощника"}
    >
      <Icon name="sparkles" /> <span>ИИ</span>
    </button>
  );
}
