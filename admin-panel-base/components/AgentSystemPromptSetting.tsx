"use client";

import { useEffect, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { getAgentSystemPrompt, setAgentSystemPrompt, syncAgentBot } from "@/lib/dataClient";
import { AGENT_SYSTEM_PROMPT_SETTING_KEY } from "@/lib/types";
import AuditLogPanel from "./AuditLogPanel";
import { useCurrentUserName } from "@/lib/useCurrentUser";

// Запрос 20.07.2026: "нужно, чтобы в админке был прописан промт
// (редактируемый), который определяет правила и границы общения агента с
// клиентами. Чтобы Франсуа мог менять сам". Свободный текст, не форма —
// это системный промпт для настоящего Claude, Франсуа правит его напрямую,
// без разработчика.
//
// 21.07.2026: теперь реально подключено — сохранение здесь отправляет
// промпт на живой agent-bot (см. lib/dataClient.ts, syncAgentBot() и
// app/api/agent-sync/route.ts). Раньше это была витрина "на будущее",
// теперь правки Франсуа реально долетают до бота (с оговоркой: бот держит
// это в памяти, при перезапуске бесплатного Render теряется — тогда
// достаточно нажать "Сохранить" ещё раз).
//
// Дефолт (mockData.ts) — только механический каркас уже согласованных
// правил (красная зона/зелёная зона/эскалация). Тон и стиль общения
// сознательно не придуманы мной — в тексте промпта прямой плейсхолдер
// "Франсуа — допишите ниже".

export default function AgentSystemPromptSetting() {
  const CURRENT_USER = useCurrentUserName();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    getAgentSystemPrompt().then(setText);
  }, []);

  async function handleSave() {
    if (text === null) return;
    await setAgentSystemPrompt(text, CURRENT_USER);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);

    setSyncing(true);
    setSyncResult(null);
    const result = await syncAgentBot();
    setSyncing(false);
    setSyncResult(result);
  }

  if (text === null) {
    return <p className="text-sm text-slate-500">Загрузка…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-medium text-slate-700">Промпт агента</h2>
        <p className="mt-1 text-xs text-slate-500">
          Правила и границы общения бота с клиентами — на этом тексте будет
          строиться каждый ответ агента. Можно менять прямо здесь, без
          разработчика.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={16}
          className="mt-3 w-full rounded border border-slate-300 bg-white p-3 font-mono text-xs leading-relaxed"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={handleSave}
            className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Сохранить
          </button>
          {saved && <span className="text-xs text-emerald-600">Сохранено</span>}
          {syncing && (
            <span className="flex items-center gap-1 text-xs text-slate-500">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Отправляю боту…
            </span>
          )}
        </div>

        {syncResult && (
          <div
            className={`mt-3 flex items-start gap-1.5 rounded border p-2 text-xs ${
              syncResult.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{syncResult.message}</span>
          </div>
        )}

        <div className="mt-3 flex items-start gap-1.5 rounded border border-sky-200 bg-sky-50 p-2 text-xs text-sky-800">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            При сохранении промпт реально отправляется живому боту. Если бот
            "спал" (бесплатный тариф Render) — первая отправка может занять
            до минуты, при ошибке просто нажмите "Сохранить" ещё раз.
          </span>
        </div>
      </div>

      <AuditLogPanel
        entityType="app_setting"
        entityId={AGENT_SYSTEM_PROMPT_SETTING_KEY}
        title="История изменений промпта"
      />
    </div>
  );
}
