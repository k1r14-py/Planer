import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DashboardDay } from "../../api";
import { formatMinutes, percent } from "../../utils";

// ---------- общее ----------

/** Ширина контейнера — графики рисуются в пикселях, без растягивания viewBox. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface TipRow {
  value: string;
  label: string;
  key?: "series-1" | "series-2" | "ghost" | "none";
}

export interface Tip {
  x: number;
  y: number;
  title: string;
  rows: TipRow[];
}

/** Подсказка: значение главное, подпись вторична, ряд помечен короткой линией цвета серии. */
export function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(180);
  useEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  }, [tip]);
  if (!tip) return null;
  const left = Math.max(0, Math.min(tip.x + 14, width - w));
  return (
    <div ref={ref} className="viz-tooltip" style={{ left, top: tip.y }} role="status">
      <div className="viz-tooltip-title">{tip.title}</div>
      {tip.rows.map((r) => (
        <div key={r.label} className="viz-tooltip-row">
          {r.key && r.key !== "none" && <i className={`line-key ${r.key}`} />}
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 4, step: 1 };
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  const step = steps.find((s) => v / s <= 4) ?? Math.ceil(v / 4);
  return { max: Math.ceil(v / step) * step, step };
}

/** Столбик со скруглённым верхом (4px) и прямым основанием. */
function columnPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

const dayLabel = (day: string) => {
  const d = new Date(`${day}T12:00:00`);
  return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export const longDay = (day: string) =>
  new Date(`${day}T12:00:00`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" });

// ---------- «Сделано по дням» ----------

const PLOT_H = 190;
const AXIS_H = 26;
const LEFT = 28;
const GAP = 2; // зазор цвета фона между сегментами

export function DailyChart({ data, onPick }: { data: DashboardDay[]; onPick: (day: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const n = data.length;
  const plotW = Math.max(0, width - LEFT);
  const band = n ? plotW / n : 0;
  const barW = Math.max(3, Math.min(24, band * 0.62));
  const { max, step } = niceMax(Math.max(...data.map((d) => Math.max(d.planned, d.planned_done + d.unplanned_done)), 0));
  const y = (v: number) => (v / max) * PLOT_H;
  const labelEvery = n <= 14 ? 1 : n <= 31 ? 7 : 14;

  const show = (i: number) => {
    const d = data[i];
    setActive(i);
    setTip({
      x: LEFT + band * i + band / 2,
      y: 8,
      title: longDay(d.day),
      rows: [
        { value: String(d.planned), label: "в плане", key: "ghost" },
        { value: String(d.planned_done), label: "сделано из плана", key: "series-1" },
        { value: String(d.unplanned_done), label: "сделано вне плана", key: "series-2" },
        ...(d.focus_sec ? [{ value: formatMinutes(d.focus_sec / 60), label: "по таймеру", key: "none" as const }] : []),
      ],
    });
  };
  const hide = () => {
    setTip(null);
    setActive(null);
  };

  return (
    <div className="viz" ref={ref} onMouseLeave={hide}>
      {width > 0 && (
        <svg width={width} height={PLOT_H + AXIS_H + 8} role="img" aria-label="Выполнение по дням">
          <g transform="translate(0,8)">
            {Array.from({ length: max / step + 1 }, (_, k) => k * step).map((v) => (
              <g key={v}>
                <line className="viz-grid" x1={LEFT} x2={width} y1={PLOT_H - y(v) + 0.5} y2={PLOT_H - y(v) + 0.5} />
                <text className="viz-tick" x={LEFT - 8} y={PLOT_H - y(v) + 4} textAnchor="end">
                  {v}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = LEFT + band * i + band / 2;
              const x = cx - barW / 2;
              const hDone = y(d.planned_done);
              const hExtra = y(d.unplanned_done);
              const extraGap = hDone > 0 && hExtra > 0 ? GAP : 0;
              return (
                <g key={d.day} className={active === i ? "viz-col active" : "viz-col"}>
                  <path className="viz-ghost" d={columnPath(x, PLOT_H - y(d.planned), barW, y(d.planned))} />
                  {hExtra > 0 ? (
                    <>
                      {/* нижний сегмент — квадратный, скругляется только верхний */}
                      <rect className="viz-s1" x={x} y={PLOT_H - hDone} width={barW} height={hDone} />
                      <path
                        className="viz-s2"
                        d={columnPath(x, PLOT_H - hDone - extraGap - hExtra, barW, hExtra)}
                      />
                    </>
                  ) : (
                    <path className="viz-s1" d={columnPath(x, PLOT_H - hDone, barW, hDone)} />
                  )}
                  {(i % labelEvery === 0 || n <= 14) && (
                    <text className="viz-tick" x={cx} y={PLOT_H + 18} textAnchor="middle">
                      {dayLabel(d.day)}
                    </text>
                  )}
                  <rect
                    className="viz-hit"
                    x={LEFT + band * i}
                    y={0}
                    width={band}
                    height={PLOT_H + AXIS_H}
                    tabIndex={0}
                    aria-label={`${longDay(d.day)}: в плане ${d.planned}, сделано из плана ${d.planned_done}, вне плана ${d.unplanned_done}`}
                    onMouseEnter={() => show(i)}
                    onFocus={() => show(i)}
                    onBlur={hide}
                    onClick={() => onPick(d.day)}
                    onKeyDown={(e) => e.key === "Enter" && onPick(d.day)}
                  />
                </g>
              );
            })}
            <line className="viz-axis" x1={LEFT} x2={width} y1={PLOT_H + 0.5} y2={PLOT_H + 0.5} />
          </g>
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

export function DailyTable({ data, onPick }: { data: DashboardDay[]; onPick: (day: string) => void }) {
  return (
    <div className="viz-table-wrap">
      <table className="viz-table">
        <thead>
          <tr>
            <th>День</th>
            <th>В плане</th>
            <th>Сделано из плана</th>
            <th>Вне плана</th>
            <th>Выполнение</th>
            <th>Таймер</th>
          </tr>
        </thead>
        <tbody>
          {[...data].reverse().map((d) => (
            <tr key={d.day}>
              <td>
                <button className="link" onClick={() => onPick(d.day)}>
                  {longDay(d.day)}
                </button>
              </td>
              <td>{d.planned}</td>
              <td>{d.planned_done}</td>
              <td>{d.unplanned_done}</td>
              <td>{d.planned ? `${percent(d.planned_done, d.planned)}%` : "—"}</td>
              <td>{d.focus_sec ? formatMinutes(d.focus_sec / 60) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- тепловая карта активности ----------

const CELL_GAP = 4;
const WEEKDAY_SHORT = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export function Heatmap({ data, onPick }: { data: DashboardDay[]; onPick: (day: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  if (!data.length) return null;

  const first = new Date(`${data[0].day}T12:00:00`);
  const offset = (first.getDay() + 6) % 7; // понедельник — первая строка
  const max = Math.max(...data.map((d) => d.done), 0);
  // 5 ступеней одного синего тона; 0 — отдельный «пустой» цвет
  const level = (v: number) => (v === 0 ? 0 : max <= 5 ? Math.min(5, v) : Math.min(5, Math.ceil((v / max) * 5)));
  const weeks = Math.ceil((offset + data.length) / 7);
  const left = 26;
  const top = 18;
  // клетка подстраивается под ширину карточки: от 12 до 22px
  const CELL = width ? Math.max(12, Math.min(22, Math.floor((width - left) / weeks) - CELL_GAP)) : 15;

  // подпись месяца — над неделей, где он начинается; налезающие подписи пропускаем
  const monthLabels: { x: number; text: string }[] = [];
  let lastMonth = -1;
  data.forEach((d, i) => {
    const dt = new Date(`${d.day}T12:00:00`);
    if (dt.getMonth() === lastMonth) return;
    lastMonth = dt.getMonth();
    const x = left + Math.floor((offset + i) / 7) * (CELL + CELL_GAP);
    const prev = monthLabels[monthLabels.length - 1];
    if (prev && x - prev.x < 34) prev.text = "";
    monthLabels.push({ x, text: dt.toLocaleDateString("ru-RU", { month: "short" }) });
  });

  return (
    <div className="viz heatmap" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg
        width={left + weeks * (CELL + CELL_GAP)}
        height={top + 7 * (CELL + CELL_GAP)}
        role="img"
        aria-label="Сделанные задачи по дням"
      >
        {monthLabels.filter((m) => m.text).map((m) => (
          <text key={m.x} className="viz-tick" x={m.x} y={11}>
            {m.text}
          </text>
        ))}
        {[0, 2, 4].map((r) => (
          <text key={r} className="viz-tick" x={0} y={top + r * (CELL + CELL_GAP) + CELL / 2 + 4}>
            {WEEKDAY_SHORT[r]}
          </text>
        ))}
        {data.map((d, i) => {
          const col = Math.floor((offset + i) / 7);
          const row = (offset + i) % 7;
          const x = left + col * (CELL + CELL_GAP);
          const yy = top + row * (CELL + CELL_GAP);
          const showTip = () =>
            setTip({
              x: x + CELL,
              y: yy + CELL + 4,
              title: longDay(d.day),
              rows: [
                { value: String(d.done), label: "сделано задач", key: "none" },
                ...(d.planned ? [{ value: `${percent(d.planned_done, d.planned)}%`, label: "плана выполнено", key: "none" as const }] : []),
              ],
            });
          return (
            <rect
              key={d.day}
              className={`heat-cell lvl-${level(d.done)}`}
              x={x}
              y={yy}
              width={CELL}
              height={CELL}
              rx={4}
              tabIndex={0}
              aria-label={`${longDay(d.day)}: сделано ${d.done}`}
              onMouseEnter={showTip}
              onFocus={showTip}
              onBlur={() => setTip(null)}
              onClick={() => onPick(d.day)}
              onKeyDown={(e) => e.key === "Enter" && onPick(d.day)}
            />
          );
        })}
      </svg>
      <div className="heat-legend">
        меньше
        {[0, 1, 2, 3, 4, 5].map((l) => (
          <i key={l} className={`heat-cell lvl-${l}`} />
        ))}
        больше
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

// ---------- полосы «сделано из всего» (проекты, теги) ----------

export interface BarItem {
  key: string;
  label: React.ReactNode;
  done: number;
  total: number;
  note?: string;
}

export function DoneBars({ items, empty }: { items: BarItem[]; empty: string }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  const max = Math.max(...items.map((i) => i.total), 1);
  return (
    <ul className="done-bars">
      {items.map((it) => (
        <li key={it.key}>
          <span className="db-label">{it.label}</span>
          <span className="db-track" style={{ width: `${(it.total / max) * 100}%` }}>
            <span className="db-fill" style={{ width: it.total ? `${(it.done / it.total) * 100}%` : 0 }} />
          </span>
          <span className="db-value">
            <strong>{it.done}</strong> / {it.total}
            {it.note && <span className="muted"> · {it.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---------- выполнение плана по дням недели ----------

const WEEKDAY_LONG = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

export function WeekdayChart({
  data,
}: {
  data: { weekday: number; planned: number; planned_done: number; done: number }[];
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const H = 120;
  return (
    <div className="viz" ref={ref} onMouseLeave={() => setTip(null)}>
      <div className="weekday-chart" style={{ height: H + 44 }}>
        {data.map((w) => {
          const rate = w.planned ? w.planned_done / w.planned : null;
          const showTip = (e: React.SyntheticEvent<HTMLElement>) => {
            const el = e.currentTarget;
            setTip({
              x: el.offsetLeft + el.offsetWidth / 2,
              y: 0,
              title: WEEKDAY_LONG[w.weekday],
              rows: [
                { value: rate == null ? "—" : `${Math.round(rate * 100)}%`, label: "плана выполнено", key: "series-1" },
                { value: `${w.planned_done} из ${w.planned}`, label: "плановых задач", key: "none" },
                { value: String(w.done), label: "всего сделано", key: "none" },
              ],
            });
          };
          return (
            <div
              key={w.weekday}
              className="wd-col"
              tabIndex={0}
              onMouseEnter={showTip}
              onFocus={showTip}
              onBlur={() => setTip(null)}
              aria-label={`${WEEKDAY_LONG[w.weekday]}: ${rate == null ? "плана не было" : `выполнено ${Math.round(rate * 100)}%`}`}
            >
              <span className="wd-value">{rate == null ? "—" : `${Math.round(rate * 100)}%`}</span>
              <span className="wd-bar-area" style={{ height: H }}>
                <span className="wd-bar" style={{ height: rate ? `${rate * 100}%` : 0 }} />
              </span>
              <span className="wd-label">{WEEKDAY_SHORT[w.weekday]}</span>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}
