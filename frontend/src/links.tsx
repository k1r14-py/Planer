import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { LinkRule } from "./api";
import { api } from "./api";

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
const WORD = /[\p{L}\p{N}]+/gu;
const SIMPLE = /^[\p{L}\p{N}]+$/u;

/**
 * Правила, у которых все ключевые слова встречаются в тексте задачи.
 * Слово совпадает по началу («лонгрид» → «лонгрида»), фраза или слово с дефисом — как подстрока.
 * Самые точные (больше слов) — первыми.
 */
export function matchLinks(rules: LinkRule[], text: string): LinkRule[] {
  if (!rules.length || !text) return [];
  const t = norm(text);
  const words = t.match(WORD) ?? [];
  const has = (kw: string) => {
    const k = norm(kw.trim());
    if (!k) return true;
    return SIMPLE.test(k) ? words.some((w) => w.startsWith(k)) : t.includes(k);
  };
  return rules
    .filter((r) => r.keywords.length && r.keywords.every(has))
    .sort((a, b) => b.keywords.length - a.keywords.length);
}

interface LinksState {
  rules: LinkRule[];
  reload: () => void;
  openSettings: () => void;
}

const Ctx = createContext<LinksState>({ rules: [], reload: () => {}, openSettings: () => {} });

export function LinksProvider({ children, openSettings }: { children: React.ReactNode; openSettings: () => void }) {
  const [rules, setRules] = useState<LinkRule[]>([]);
  const reload = useCallback(() => {
    api.links().then(setRules, () => {});
  }, []);
  useEffect(reload, [reload]);
  const value = useMemo(() => ({ rules, reload, openSettings }), [rules, reload, openSettings]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLinks = () => useContext(Ctx);
