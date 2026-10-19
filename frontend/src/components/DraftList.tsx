import type { DraftItem } from "../api";
import { formatMinutes, shortDate } from "../utils";
import { Icon } from "./Icon";

/** Плоская строка черновика: depth 0 — задача, 1 — подзадача предыдущей задачи. */
export interface DraftRow extends Omit<DraftItem, "children"> {
  key: number;
  depth: 0 | 1;
}

let nextKey = 1;

export function flatten(items: DraftItem[]): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const { children, ...item } of items) {
    rows.push({ ...item, key: nextKey++, depth: 0 });
    for (const { children: _, ...sub } of children) rows.push({ ...sub, key: nextKey++, depth: 1 });
  }
  return rows;
}

export function unflatten(rows: DraftRow[]): DraftItem[] {
  const items: DraftItem[] = [];
  for (const { key: _, depth, ...row } of rows) {
    if (!row.title.trim()) continue;
    const item: DraftItem = { ...row, title: row.title.trim(), children: [] };
    if (depth === 1 && items.length) items[items.length - 1].children.push(item);
    else items.push(item);
  }
  return items;
}

export function DraftList({ rows, onChange }: { rows: DraftRow[]; onChange: (rows: DraftRow[]) => void }) {
  const update = (key: number, patch: Partial<DraftRow>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <ul className="draft-list">
      {rows.map((r, i) => (
        <li key={r.key} className={`draft-row depth-${r.depth}`}>
          {r.depth === 1 && <Icon name="corner" />}
          <span className="check small" />
          <div className="draft-main">
            <input
              className="draft-title"
              value={r.title}
              onChange={(e) => update(r.key, { title: e.target.value })}
              aria-label="Название задачи"
            />
            <span className="draft-chips">
              {r.estimate_min != null && (
                <Chip onRemove={() => update(r.key, { estimate_min: null })}>
                  <Icon name="hourglass" /> {formatMinutes(r.estimate_min)}
                </Chip>
              )}
              {r.deadline && (
                <Chip onRemove={() => update(r.key, { deadline: null })} tone="deadline">
                  <Icon name="flag" /> до {shortDate(r.deadline)}
                </Chip>
              )}
              {r.project && (
                <Chip onRemove={() => update(r.key, { project: null })} tone="project">
                  <Icon name="folder" /> {r.project}
                </Chip>
              )}
              {r.tags.map((t) => (
                <Chip key={t} onRemove={() => update(r.key, { tags: r.tags.filter((x) => x !== t) })} tone="tag">
                  #{t}
                </Chip>
              ))}
            </span>
          </div>
          <span className="draft-actions">
            {r.depth === 0 ? (
              <button
                className="icon-btn sm"
                disabled={i === 0}
                title="Сделать подзадачей предыдущей задачи"
                onClick={() => update(r.key, { depth: 1 })}
              >
                <Icon name="indent" />
              </button>
            ) : (
              <button className="icon-btn sm" title="Сделать отдельной задачей" onClick={() => update(r.key, { depth: 0 })}>
                <Icon name="outdent" />
              </button>
            )}
            <button
              className="icon-btn sm"
              title="Убрать из списка"
              onClick={() => {
                // вместе с задачей убираем и её подзадачи
                let end = i + 1;
                if (r.depth === 0) while (end < rows.length && rows[end].depth === 1) end++;
                onChange([...rows.slice(0, i), ...rows.slice(end)]);
              }}
            >
              <Icon name="x" />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Chip({
  children,
  onRemove,
  tone = "",
}: {
  children: React.ReactNode;
  onRemove: () => void;
  tone?: string;
}) {
  return (
    <span className={`draft-chip ${tone}`}>
      {children}
      <button onClick={onRemove} aria-label="Убрать">
        ×
      </button>
    </span>
  );
}
