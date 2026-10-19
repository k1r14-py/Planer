import { useEffect, useRef, useState } from "react";
import type { LinkRule } from "../api";
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
  const { openSettings } = useLinks();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
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
        title={matched.length === 1 ? matched[0].label || host(matched[0].url) : `Ссылок: ${matched.length}`}
        aria-label="Ссылки к задаче"
        aria-expanded={open}
      >
        <Icon name="link" size={14} />
        {matched.length > 1 && <span className="link-count">{matched.length}</span>}
      </button>
      {open && (
        <div className="link-popover" role="dialog">
          {matched.map((r) => (
            <a key={r.id} className="link-item" href={r.url} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
              <span className="link-title">
                <Icon name="link" size={13} /> {r.label || host(r.url)}
              </span>
              <span className="link-url">{r.url}</span>
              <span className="link-why">по словам: {r.keywords.join(" + ")}</span>
            </a>
          ))}
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
