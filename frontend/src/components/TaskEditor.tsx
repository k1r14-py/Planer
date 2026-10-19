import { useEffect, useState } from "react";
import type { Day, Task, TagCount } from "../api";
import { api } from "../api";
import { PROJECT_COLORS, useProjects } from "../projects";
import { Icon } from "./Icon";

const NEW_PROJECT = "__new__";

/** Свойства задачи под строкой: оценка, срок, проект, теги. Каждое поле сохраняется сразу. */
export function TaskEditor({
  task,
  run,
  onClose,
}: {
  task: Task;
  run: (p: Promise<Day | unknown>) => void;
  onClose: () => void;
}) {
  const { projects, reload } = useProjects();
  const [estimate, setEstimate] = useState(task.estimate_min?.toString() ?? "");
  const [tagsText, setTagsText] = useState(task.tags.join(", "));
  const [newProject, setNewProject] = useState<string | null>(null);
  const [knownTags, setKnownTags] = useState<TagCount[]>([]);

  useEffect(() => {
    api.tags().then(setKnownTags, () => {});
  }, []);
  useEffect(() => setTagsText(task.tags.join(", ")), [task.tags]);

  const saveEstimate = () => {
    const n = parseInt(estimate, 10);
    const value = estimate.trim() === "" ? null : Number.isFinite(n) ? n : task.estimate_min;
    if (value !== task.estimate_min) run(api.patchTask(task.id, { estimate_min: value }));
  };

  const saveTags = () => {
    const tags = tagsText
      .split(/[,\s]+/)
      .map((t) => t.replace(/^#/, "").trim().toLowerCase())
      .filter(Boolean);
    if (tags.join(",") !== task.tags.join(",")) run(api.patchTask(task.id, { tags }));
  };

  const addTag = (tag: string) => {
    if (task.tags.includes(tag)) return;
    run(api.patchTask(task.id, { tags: [...task.tags, tag] }));
  };

  const createProject = async () => {
    const name = newProject?.trim();
    if (!name) return setNewProject(null);
    const color = PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
    run(
      api.createProject(name, color).then((p) => {
        reload();
        return api.patchTask(task.id, { project_id: p.id });
      }),
    );
    setNewProject(null);
  };

  const suggestions = knownTags.filter((t) => !task.tags.includes(t.tag)).slice(0, 8);

  return (
    <div className="task-editor" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <label>
        <span>
          <Icon name="hourglass" /> Оценка, мин
        </span>
        <input
          inputMode="numeric"
          value={estimate}
          placeholder="—"
          onChange={(e) => setEstimate(e.target.value.replace(/\D/g, ""))}
          onBlur={saveEstimate}
          onKeyDown={(e) => e.key === "Enter" && saveEstimate()}
        />
      </label>

      <label>
        <span>
          <Icon name="flag" /> Срок
        </span>
        <div className="field-row">
          <input
            type="date"
            value={task.deadline ?? ""}
            onChange={(e) => run(api.patchTask(task.id, { deadline: e.target.value || null }))}
          />
          {task.deadline && (
            <button className="icon-btn sm" title="Убрать срок" onClick={() => run(api.patchTask(task.id, { deadline: null }))}>
              <Icon name="x" />
            </button>
          )}
        </div>
      </label>

      <label>
        <span>
          <Icon name="folder" /> Проект
        </span>
        {newProject === null ? (
          <select
            value={task.project_id ?? ""}
            onChange={(e) => {
              if (e.target.value === NEW_PROJECT) return setNewProject("");
              run(api.patchTask(task.id, { project_id: e.target.value ? Number(e.target.value) : null }));
            }}
          >
            <option value="">Без проекта</option>
            {projects
              .filter((p) => !p.archived || p.id === task.project_id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            <option value={NEW_PROJECT}>＋ Новый проект…</option>
          </select>
        ) : (
          <input
            autoFocus
            placeholder="Название проекта, Enter"
            value={newProject}
            onChange={(e) => setNewProject(e.target.value)}
            onBlur={createProject}
            onKeyDown={(e) => {
              if (e.key === "Enter") createProject();
              if (e.key === "Escape") {
                e.stopPropagation();
                setNewProject(null);
              }
            }}
          />
        )}
      </label>

      <label className="wide">
        <span>
          <Icon name="tag" /> Теги
        </span>
        <input
          value={tagsText}
          placeholder="через запятую: срочно, звонки"
          onChange={(e) => setTagsText(e.target.value)}
          onBlur={saveTags}
          onKeyDown={(e) => e.key === "Enter" && saveTags()}
        />
        {suggestions.length > 0 && (
          <div className="tag-suggest">
            {suggestions.map((t) => (
              <button key={t.tag} className="tag" onClick={() => addTag(t.tag)}>
                #{t.tag}
              </button>
            ))}
          </div>
        )}
      </label>

      <button className="btn ghost sm editor-close" onClick={onClose}>
        Готово
      </button>
    </div>
  );
}
