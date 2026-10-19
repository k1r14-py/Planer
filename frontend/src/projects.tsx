import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Project } from "./api";
import { api } from "./api";

export const PROJECT_COLORS = ["#6d5efc", "#16a36a", "#e5484d", "#d68a00", "#0091ff", "#d6409f", "#12a594", "#8e8c99"];

interface ProjectsState {
  projects: Project[];
  byId: Map<number, Project>;
  reload: () => void;
}

const Ctx = createContext<ProjectsState>({ projects: [], byId: new Map(), reload: () => {} });

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const reload = useCallback(() => {
    api.projects().then(setProjects, () => {});
  }, []);
  useEffect(reload, [reload]);
  const value = useMemo(
    () => ({ projects, byId: new Map(projects.map((p) => [p.id, p])), reload }),
    [projects, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useProjects = () => useContext(Ctx);

export function ProjectChip({ project, onClick }: { project: Project; onClick?: () => void }) {
  return (
    <span
      className={`project-chip ${onClick ? "clickable" : ""}`}
      style={{ "--pc": project.color } as React.CSSProperties}
      onClick={onClick}
    >
      <i />
      {project.name}
    </span>
  );
}
