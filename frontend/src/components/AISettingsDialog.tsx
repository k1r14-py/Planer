import { useEffect, useState } from "react";
import type { AIProviderPreset, OllamaStatus } from "../api";
import { api } from "../api";
import { useAI } from "../ai";
import { Icon } from "./Icon";

const BUSY = ["starting", "downloading", "installing", "pulling"];

export function AISettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, reload } = useAI();
  const [providers, setProviders] = useState<AIProviderPreset[]>([]);
  const [provider, setProvider] = useState(settings?.provider || "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(settings?.model || "");
  const [baseUrl, setBaseUrl] = useState(settings?.base_url || "");
  const [models, setModels] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.aiProviders().then(setProviders, () => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const preset = providers.find((p) => p.id === provider);
  const isSaved = settings?.provider === provider;

  const choose = (p: AIProviderPreset) => {
    setProvider(p.id);
    setResult(null);
    setModels([]);
    setApiKey("");
    setAdvanced(p.id === "custom");
    // у сохранённого провайдера оставляем его модель и адрес
    if (settings?.provider === p.id) {
      setModel(settings.model);
      setBaseUrl(settings.base_url);
    } else {
      setModel(p.model);
      setBaseUrl(p.base_url);
    }
  };

  const draft = () => ({ provider, base_url: baseUrl, model, api_key: apiKey });

  const loadModels = async () => {
    setResult(null);
    try {
      const list = await api.aiModels(draft());
      setModels(list);
      if (!list.length) setResult({ ok: false, text: "Сервис не вернул список моделей — впишите название вручную." });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    }
  };

  const saveAndTest = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.aiTest(draft());
      await api.aiSave(draft());
      reload();
      setApiKey("");
      setResult({ ok: true, text: `Готово: ${preset?.name ?? provider}, модель ${model} отвечает.` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    await api.aiReset();
    reload();
    setProvider("");
    setResult({ ok: true, text: "ИИ отключён — используется разбор по правилам." });
  };

  const needsKey = preset?.needs_key && !(isSaved && settings?.has_key);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="ИИ-помощник">
        <header className="dialog-head">
          <h2>
            <Icon name="sparkles" /> ИИ-помощник
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" />
          </button>
        </header>

        <p className="muted dialog-intro">
          ИИ разбирает свободную речь в задачи со сроками и подзадачами, разбивает большие задачи на шаги и помогает
          подвести итоги дня. Выберите, где будет работать модель.
          {settings?.configured && (
            <>
              {" "}
              Сейчас: <strong>{providers.find((p) => p.id === settings.provider)?.name ?? settings.provider}</strong>,{" "}
              {settings.model}.
            </>
          )}
        </p>

        <div className="provider-grid">
          {providers.map((p) => (
            <button
              key={p.id}
              className={`provider-card ${provider === p.id ? "selected" : ""}`}
              onClick={() => choose(p)}
              aria-pressed={provider === p.id}
            >
              <span className="provider-name">
                {p.name}
                {p.id === "ollama" && <span className="badge accent">бесплатно · приватно</span>}
                {settings?.configured && settings.provider === p.id && <Icon name="check" />}
              </span>
              <span className="provider-hint">{p.hint}</span>
            </button>
          ))}
        </div>

        {provider === "ollama" && <OllamaPanel onReady={reload} />}

        {preset && provider !== "ollama" && (
          <div className="provider-form">
            {preset.needs_key && (
              <label className="form-field">
                <span>API-ключ</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  placeholder={isSaved && settings?.has_key ? `сохранён (${settings.key_hint}) — оставьте пустым` : "вставьте ключ"}
                  onChange={(e) => setApiKey(e.target.value.trim())}
                />
                {preset.key_url && (
                  <a href={preset.key_url} target="_blank" rel="noreferrer" className="small">
                    Где взять ключ →
                  </a>
                )}
              </label>
            )}

            <label className="form-field">
              <span>Модель</span>
              <div className="field-row">
                <input list="ai-models" value={model} onChange={(e) => setModel(e.target.value)} placeholder="название модели" />
                <button className="btn sm" onClick={loadModels} disabled={!!needsKey && !apiKey} title="Загрузить список моделей сервиса">
                  Список
                </button>
              </div>
              <datalist id="ai-models">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {models.length > 0 && <span className="muted small">Доступно моделей: {models.length} — выберите в поле выше</span>}
            </label>

            {(advanced || provider === "custom") && (
              <label className="form-field">
                <span>Адрес API</span>
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
              </label>
            )}
            {provider !== "custom" && (
              <button className="btn ghost sm" onClick={() => setAdvanced(!advanced)}>
                {advanced ? "Скрыть адрес API" : "Изменить адрес API"}
              </button>
            )}

            <p className="privacy-note small">
              <Icon name="lock" /> Текст задач будет отправляться в {preset.name}. Ключ хранится только на этом компьютере.
            </p>
          </div>
        )}

        {result && <div className={result.ok ? "success-box" : "error"}>{result.text}</div>}

        <footer className="dialog-foot">
          {settings?.configured && (
            <button className="btn ghost danger-text" onClick={disable}>
              Отключить ИИ
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Закрыть
          </button>
          {preset && provider !== "ollama" && (
            <button className="btn primary" onClick={saveAndTest} disabled={busy || !model || !!(needsKey && !apiKey) || !baseUrl}>
              {busy ? <Icon name="loader" /> : null} Сохранить и проверить
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/** Локальная модель: статус, рекомендация по железу, установка в одну кнопку. */
function OllamaPanel({ onReady }: { onReady: () => void }) {
  const { settings } = useAI();
  const [st, setSt] = useState<OllamaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const s = await api.ollamaStatus();
        if (!alive) return;
        setSt((prev) => {
          if (prev && BUSY.includes(prev.job.state) && s.job.state === "done") onReady();
          return s;
        });
        timer = window.setTimeout(poll, BUSY.includes(s.job.state) ? 1000 : 4000);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [onReady]);

  if (!st) return <p className="muted">Проверяю компьютер…</p>;

  const job = st.job;
  const rec = st.recommended;
  const busy = BUSY.includes(job.state);
  const model = rec.model ?? "qwen2.5:3b";
  const ready = st.running && st.models.some((m) => m === model || m.startsWith(model));

  const setup = async (m?: string) => {
    setError(null);
    try {
      setSt({ ...st, job: await api.ollamaSetup(m) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="provider-form">
      <div className="machine-facts">
        <span>
          Память: <strong>{st.ram_gb ? `${Math.round(st.ram_gb)} ГБ` : "неизвестно"}</strong>
        </span>
        <span>
          Свободно на диске: <strong>{Math.round(st.free_disk_gb)} ГБ</strong>
        </span>
        <span>
          Ollama:{" "}
          <strong>{st.running ? "работает" : st.installed ? "установлена, не запущена" : "не установлена"}</strong>
        </span>
      </div>

      {!st.supported ? (
        <div className="notice">
          Автоустановка доступна на macOS и Windows. На Linux установите Ollama командой{" "}
          <code>curl -fsSL https://ollama.com/install.sh | sh</code> и выполните <code>ollama pull {model}</code>.
        </div>
      ) : busy ? (
        <div className="setup-progress">
          <div className="setup-line">
            <Icon name="loader" /> {job.message}
          </div>
          {job.progress != null && (
            <div className="level wide" aria-label="Прогресс">
              <div className="level-fill accent" style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
          )}
          <span className="muted small">Можно закрыть окно — установка продолжится.</span>
        </div>
      ) : job.state === "done" || (ready && job.state !== "error") ? (
        settings?.provider === "ollama" ? (
          <div className="success-box">
            <Icon name="check" /> Модель {settings.model} работает на этом компьютере. ИИ готов.
          </div>
        ) : (
          <div className="field-row">
            <span>Модель {model} уже установлена.</span>
            <button
              className="btn primary"
              onClick={() => api.aiSave({ provider: "ollama", model }).then(onReady, (e) => setError(e.message))}
            >
              Использовать эту модель
            </button>
          </div>
        )
      ) : (
        <>
          <p className="setup-plan">
            {rec.ok ? (
              <>
                Подходящая модель для этого компьютера: <strong>{model}</strong> ({rec.size}).{" "}
                {st.installed ? "" : "Скачаем и установим Ollama (около 200 МБ) и модель. "}
                Это займёт несколько минут, права администратора не нужны.
              </>
            ) : (
              rec.note
            )}
          </p>
          {rec.ok && rec.note && <p className="muted small">{rec.note}</p>}
          {job.state === "error" && <div className="error">{job.message}</div>}
          <div className="field-row">
            {rec.ok ? (
              <button className="btn primary" onClick={() => setup(model)}>
                <Icon name="sparkles" /> Установить и настроить
              </button>
            ) : (
              <button className="btn" onClick={() => setup("qwen2.5:3b")}>
                Всё равно поставить компактную модель (1,9 ГБ)
              </button>
            )}
          </div>
          {st.models.length > 0 && (
            <p className="muted small">Уже скачанные модели: {st.models.join(", ")}</p>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
      <p className="privacy-note small">
        <Icon name="lock" /> Задачи не покидают компьютер — модель работает локально.
      </p>
    </div>
  );
}
