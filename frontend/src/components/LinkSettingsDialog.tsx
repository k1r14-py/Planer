import { useEffect, useState } from "react";
import type { LinkRule } from "../api";
import { api } from "../api";
import { matchLinks, useLinks } from "../links";
import { Icon } from "./Icon";

interface Draft {
  id: number | null;
  keywords: string;
  url: string;
  label: string;
}

const EMPTY: Draft = { id: null, keywords: "", url: "", label: "" };

const splitWords = (s: string) =>
  s
    .split(/[,;+]/)
    .map((w) => w.trim())
    .filter(Boolean);

/** Словарь «ключевые слова → ссылка». У каждого пользователя свой, хранится на его компьютере. */
export function LinkSettingsDialog({ onClose }: { onClose: () => void }) {
  const { rules, reload } = useLinks();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [formOpen, setFormOpen] = useState(rules.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const edit = (r: LinkRule) => {
    setDraft({ id: r.id, keywords: r.keywords.join(", "), url: r.url, label: r.label });
    setFormOpen(true);
    setError(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { keywords: splitWords(draft.keywords), url: draft.url.trim(), label: draft.label.trim() };
    try {
      if (draft.id) await api.updateLink(draft.id, body);
      else await api.createLink(body);
      reload();
      setDraft(EMPTY);
      setFormOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: LinkRule) => {
    if (!confirm(`Удалить ссылку «${r.label || r.url}»?`)) return;
    await api.deleteLink(r.id);
    reload();
  };

  const words = splitWords(draft.keywords);
  const probeHits = probe.trim() ? matchLinks(rules, probe) : [];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="Ссылки по ключевым словам">
        <header className="dialog-head">
          <h2>
            <Icon name="link" /> Ссылки по ключевым словам
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        <p className="muted dialog-intro">
          Задайте слова и ссылку — у задачи, где встречаются <strong>все</strong> эти слова, появится значок{" "}
          <Icon name="link" size={13} /> со ссылкой. Например, «нок + лонгрид» → задача в Jira, «нок + скринкаст» →
          другая. Учитываются название, проект и теги задачи; окончания не важны («лонгрид» найдёт «лонгрида»).
        </p>

        <label className="form-field probe">
          <span>Проверить</span>
          <input value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Впишите задачу, например: Сделал лонгрид по НОК" />
          {probe.trim() && (
            <span className={probeHits.length ? "probe-hit" : "muted small"}>
              {probeHits.length
                ? `Сработает: ${probeHits.map((r) => r.label || r.url).join(" · ")}`
                : "Ни одна ссылка не сработает"}
            </span>
          )}
        </label>

        {rules.length > 0 && (
          <ul className="rule-list">
            {rules.map((r) => (
              <li key={r.id} className={probeHits.some((h) => h.id === r.id) ? "hit" : ""}>
                <span className="rule-words">
                  {r.keywords.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="muted"> + </span>}
                      <span className="kw">{k}</span>
                    </span>
                  ))}
                </span>
                <span className="rule-target">
                  {r.label && <strong>{r.label}</strong>}
                  <a href={r.url} target="_blank" rel="noreferrer" className="small">
                    {r.url}
                  </a>
                </span>
                <span className="rule-actions">
                  <button className="icon-btn sm" onClick={() => edit(r)} title="Изменить">
                    <Icon name="edit" />
                  </button>
                  <button className="icon-btn sm" onClick={() => remove(r)} title="Удалить">
                    <Icon name="trash" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {formOpen ? (
          <div className="provider-form rule-form">
            <label className="form-field">
              <span>Ключевые слова — через запятую, должны встретиться все</span>
              <input
                autoFocus
                value={draft.keywords}
                onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
                placeholder="нок, лонгрид"
              />
              {words.length > 0 && (
                <span className="rule-words">
                  {words.map((k, i) => (
                    <span key={i}>
                      {i > 0 && <span className="muted"> + </span>}
                      <span className="kw">{k.toLowerCase()}</span>
                    </span>
                  ))}
                </span>
              )}
            </label>
            <label className="form-field">
              <span>Ссылка</span>
              <input
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://jira.company.ru/browse/NOK-123"
                inputMode="url"
              />
            </label>
            <label className="form-field">
              <span>Название (необязательно)</span>
              <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Лонгрид НОК в Jira" />
            </label>
            {error && <div className="error">{error}</div>}
            <div className="field-row">
              <button className="btn primary" onClick={save} disabled={saving || !words.length || !draft.url.trim()}>
                {draft.id ? "Сохранить" : "Добавить ссылку"}
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setDraft(EMPTY);
                  setFormOpen(false);
                  setError(null);
                }}
              >
                Отмена
              </button>
            </div>
          </div>
        ) : (
          <button className="btn" onClick={() => setFormOpen(true)}>
            <Icon name="plus" /> Добавить ссылку
          </button>
        )}

        <p className="privacy-note small">
          <Icon name="lock" /> Ссылки хранятся только на этом компьютере.
        </p>
      </div>
    </div>
  );
}
