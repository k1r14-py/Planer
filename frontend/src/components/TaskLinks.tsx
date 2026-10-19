import { useEffect, useRef, useState } from "react";
import type { LinkRule } from "../api";
import { api } from "../api";
import { useLinks } from "../links";
import { Icon } from "./Icon";

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Значок 🔗 у задачи и всплывающее окно со ссылками, подобранными по ключевым словам. */
export function TaskLinks({ matched }: { matched: LinkRule[] }) {
  const { openSettings, reload } = useLinks();
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) {
      setConfirmId(null);
      return;
    }
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!matched.length) return null;

  return (
    <span className="task-links" ref={ref}>
      <button
        className={`link-btn ${open ? "open" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        title={
          matched.length === 1
            ? matched[0].label || host(matched[0].url)
            : `Ссылок: ${matched.length}`
        }
        aria-label="Ссылки к задаче"
        aria-expanded={open}
      >
        <Icon name="link" size={14} />
        {matched.length > 1 && (
          <span className="link-count">{matched.length}</span>
        )}
      </button>
      {open && (
        <div className="link-popover" role="dialog">
          {matched.map((r) =>
            confirmId === r.id ? (
              <div key={r.id} className="link-confirm">
                <span>
                  Удалить ссылку «{r.label || host(r.url)}»? Она пропадёт у всех
                  задач со словами {r.keywords.join(" + ")}.
                </span>
                <span className="field-row">
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await api.deleteLink(r.id);
                      setConfirmId(null);
                      reload();
                    }}
                  >
                    Удалить
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={() => setConfirmId(null)}
                  >
                    Отмена
                  </button>
                </span>
              </div>
            ) : (
              <div key={r.id} className="link-row">
                <a
                  className="link-item"
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                >
                  <span className="link-title">
                    <Icon name="link" size={13} /> {r.label || host(r.url)}
                  </span>
                  <span className="link-url">{r.url}</span>
                  <span className="link-why">
                    по словам: {r.keywords.join(" + ")}
                  </span>
                </a>
                <button
                  className="icon-btn sm danger-hover"
                  onClick={() => setConfirmId(r.id)}
                  title="Удалить ссылку"
                  aria-label="Удалить ссылку"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ),
          )}
          <button
            className="link-settings"
            onClick={() => {
              setOpen(false);
              openSettings();
            }}
          >
            <Icon name="sliders" size={13} /> Настроить ссылки…
          </button>
        </div>
      )}
    </span>
  );
}
