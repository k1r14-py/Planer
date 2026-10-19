import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { AISettings } from "./api";
import { api } from "./api";

interface AIState {
  settings: AISettings | null;
  ready: boolean; // ИИ настроен
  reload: () => void;
  openSettings: () => void;
}

const Ctx = createContext<AIState>({ settings: null, ready: false, reload: () => {}, openSettings: () => {} });

export function AIStateProvider({ children, openSettings }: { children: React.ReactNode; openSettings: () => void }) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const reload = useCallback(() => {
    api.aiSettings().then(setSettings, () => setSettings(null));
  }, []);
  useEffect(reload, [reload]);
  return (
    <Ctx.Provider value={{ settings, ready: !!settings?.configured, reload, openSettings }}>{children}</Ctx.Provider>
  );
}

export const useAI = () => useContext(Ctx);
