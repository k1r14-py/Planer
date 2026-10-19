import { useEffect, useState } from "react";
import type { Day, ReviewProposal, VoiceStatus } from "../api";
import { api } from "../api";
import { Icon } from "./Icon";
import { Recorder, type RecPhase } from "./Recorder";

type Group = "done" | "skipped" | "carry";

const GROUPS: [Group, string][] = [
  ["done", "Отметить сделанными"],
  ["skipped", "Пропустить"],
  ["carry", "Перенести на завтра"],
];

/** Итоги дня голосом: рассказ → предложение ИИ → пользователь отмечает, что применить. */
export function ReviewDialog({
  data,
  voice,
  onClose,
  onApplied,
}: {
  data: Day;
  voice: VoiceStatus | null;
  onClose: () => void;
  onApplied: (d: Day) => void;
}) {
  const [phase, setPhase] = useState<RecPhase>("idle");
  const [text, setText] = useState("");
  const [proposal, setProposal] = useState<ReviewProposal | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set()); // снятые галочки: "done:12", "new:0"
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = (id: number) => data.tasks.find((t) => t.id === id)?.title ?? `#${id}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && phase === "idle" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, busy, onClose]);

  const propose = async (value = text) => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.aiReview(data.day, value);
      setProposal(p);
      setNote(p.note);
      setOff(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    try {
      const chosen: ReviewProposal = {
        done: proposal.done.filter((id) => !off.has(`done:${id}`)),
        skipped: proposal.skipped.filter((id) => !off.has(`skipped:${id}`)),
        carry: proposal.carry.filter((id) => !off.has(`carry:${id}`)),
        new_tasks: proposal.new_tasks.filter((_, i) => !off.has(`new:${i}`)),
        note: off.has("note") ? "" : note,
      };
      onApplied(await api.aiReviewApply(data.day, chosen));
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const empty =
    proposal &&
    !proposal.done.length &&
    !proposal.skipped.length &&
    !proposal.carry.length &&
    !proposal.new_tasks.length &&
    !proposal.note;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && phase === "idle" && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-label="Итоги дня">
        <header className="dialog-head">
          <h2>
            <Icon name="review" /> Итоги дня
          </h2>
          <button className="icon-btn" onClick={onClose} disabled={phase === "recording"} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        {!proposal ? (
          <>
            <Recorder
              voice={voice}
              autoStart={false}
              onPhase={setPhase}
              onText={(t) => {
                const next = text.trim() ? `${text.trim()}\n${t}` : t;
                setText(next);
                propose(next);
              }}
              idleTitle="Расскажите, как прошёл день"
              idleHint="«Отчёт сдал, на созвон не попал — перенесу на завтра, в зал не пошёл, зато починил прод»"
            />
            <textarea
              className="textarea"
              rows={3}
              value={text}
              placeholder="…или напишите текстом"
              onChange={(e) => setText(e.target.value)}
            />
            {busy && (
              <div className="parsing">
                <Icon name="loader" /> ИИ сопоставляет рассказ с задачами дня…
              </div>
            )}
          </>
        ) : (
          <div className="review">
            {empty && <div className="notice">ИИ не нашёл, что изменить. Попробуйте рассказать подробнее.</div>}
            {GROUPS.map(([g, label]) =>
              proposal[g].length ? (
                <section key={g}>
                  <div className="field-label">{label}</div>
                  {proposal[g].map((id) => (
                    <label key={id} className="review-row">
                      <input type="checkbox" checked={!off.has(`${g}:${id}`)} onChange={() => toggle(`${g}:${id}`)} />
                      {title(id)}
                    </label>
                  ))}
                </section>
              ) : null,
            )}
            {proposal.new_tasks.length > 0 && (
              <section>
                <div className="field-label">Добавить как сделанное вне плана</div>
                {proposal.new_tasks.map((t, i) => (
                  <label key={i} className="review-row">
                    <input type="checkbox" checked={!off.has(`new:${i}`)} onChange={() => toggle(`new:${i}`)} />
                    {t.title}
                  </label>
                ))}
              </section>
            )}
            {proposal.note && (
              <section>
                <label className="review-row field-label">
                  <input type="checkbox" checked={!off.has("note")} onChange={() => toggle("note")} />
                  Дописать в «Итоги дня»
                </label>
                <textarea className="textarea" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
              </section>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <footer className="dialog-foot">
          {proposal && (
            <button className="btn ghost" onClick={() => setProposal(null)} disabled={busy}>
              ← Изменить рассказ
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose} disabled={phase === "recording" || busy}>
            Отмена
          </button>
          {proposal ? (
            <button className="btn primary" onClick={apply} disabled={busy || !!empty}>
              Применить
            </button>
          ) : (
            <button className="btn primary" onClick={() => propose()} disabled={!text.trim() || busy || phase !== "idle"}>
              <Icon name="sparkles" /> Предложить
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
