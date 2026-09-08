"use client";

import { useEffect, useState } from "react";
import { Loader2, Send, UserCheck, UserX, ShieldAlert, FilePlus2 } from "lucide-react";
import { getDialog, sendMessageToClient, setHumanTakeover, resolveDialogEscalation } from "@/lib/dataClient";
import { hasSupabase, supabase } from "@/lib/supabaseClient";
import { AgentDialog } from "@/lib/types";
import { useCurrentUserName } from "@/lib/useCurrentUser";
import CreateSubscriptionModal from "./CreateSubscriptionModal";

const ROLE_STYLE: Record<string, string> = {
  client: "bg-white border border-slate-200 self-start",
  agent: "bg-slate-900 text-white self-end",
  olga: "bg-amber-100 border border-amber-200 self-end",
  staff: "bg-amber-100 border border-amber-200 self-end",
};

const ROLE_LABEL: Record<string, string> = {
  client: "Клиент",
  agent: "Агент",
  olga: "Ольга",
  staff: "Менеджер",
};

// 17.08.2026 — "Взять диалог на себя" (запрос Игоря): пока включено, бот
// не отвечает клиенту сам (см. agent-bot/orchestrator.py, human_takeover),
// менеджер пишет отсюда напрямую. Явный тумблер, не автовозврат по
// таймауту — решение Игоря, см. CLAUDE.md.
export default function DialogThread({ dialogId }: { dialogId: string }) {
  const currentUser = useCurrentUserName();
  const [dialog, setDialog] = useState<AgentDialog | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [togglingTakeover, setTogglingTakeover] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [resolvingEscalation, setResolvingEscalation] = useState(false);
  // 26.08.2026 — Игорь: "Ольга должна иметь возможность нажать на кнопку...
  // и создать [заявку на подписку]" — доступно на ЛЮБОМ диалоге (решение
  // Игоря), не только эскалированных, см. CreateSubscriptionModal.tsx.
  const [createSubOpen, setCreateSubOpen] = useState(false);

  function reload() {
    return getDialog(dialogId).then(setDialog);
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogId]);

  // 17.08.2026 — Игорь: "диалог онлайн, чтобы видно сразу сообщение от
  // клиента, без перезагрузки". Раньше тред обновлялся только по ручному
  // действию (reload() после отправки/тумблера) — новое сообщение клиента
  // появлялось только если самому перезагрузить страницу.
  //
  // Supabase Realtime (postgres_changes) на dialogs/dialog_messages —
  // те же две таблицы, что и так читаются напрямую anon-клиентом (см.
  // dataClient.ts::getDialog, RLS отключён). При любом изменении просто
  // перезапрашиваем весь диалог через reload() — не пытаемся мёржить/
  // дописывать сообщения по одному в state: диалогов мало, сообщений в
  // каждом мало, а полный reload исключает риск дублей/неправильного
  // порядка при гонке нескольких событий подряд.
  useEffect(() => {
    if (!hasSupabase()) return;
    const channel = supabase!
      .channel(`dialog-thread-${dialogId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "dialog_messages", filter: `dialog_id=eq.${dialogId}` },
        () => reload(),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "dialogs", filter: `dialog_id=eq.${dialogId}` },
        () => reload(),
      )
      .subscribe();
    return () => {
      supabase!.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogId]);

  async function handleToggleTakeover() {
    if (!dialog) return;
    setTogglingTakeover(true);
    setActionMessage(null);
    const nextTakeover = !dialog.human_takeover;
    const result = await setHumanTakeover(dialog.client_id, nextTakeover, currentUser);
    setActionMessage(result.message);
    setTogglingTakeover(false);
    await reload();
  }

  // 21.08.2026 — Игорь: заметный баннер эскалации прямо в чате диалога
  // (не только на отдельной карточке /escalations/[id]) с возможностью сразу
  // же её завершить, не уходя со страницы диалога. См. resolveDialogEscalation
  // в dataClient.ts — чистит escalated_to/escalation_reason на самом диалоге
  // и закрывает связанные строки escalations по dialog_id.
  async function handleResolveEscalation() {
    if (!dialog) return;
    setResolvingEscalation(true);
    setActionMessage(null);
    await resolveDialogEscalation(dialog.dialog_id, currentUser);
    setResolvingEscalation(false);
    await reload();
  }

  async function handleSend() {
    if (!dialog?.client_chat_id || !draft.trim()) return;
    setSending(true);
    setActionMessage(null);
    const result = await sendMessageToClient(dialog.client_id, dialog.client_chat_id, draft.trim());
    setSending(false);
    if (result.ok) setDraft("");
    setActionMessage(result.message);
    await reload();
  }

  if (!dialog) {
    return <p className="text-sm text-slate-500">Загрузка…</p>;
  }

  const takeover = dialog.human_takeover ?? false;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-medium text-slate-900">{dialog.client_display_name}</div>
            <div className="text-xs text-slate-500">
              {dialog.channel} · начало {new Date(dialog.started_at).toLocaleString("ru-RU")}
              {dialog.ended_at && ` · конец ${new Date(dialog.ended_at).toLocaleString("ru-RU")}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* 26.08.2026 — на любом диалоге (решение Игоря), не только
                эскалированном: "бывает, эскалация произошла, а агент просто
                не создал заявку, хотя вся инфа в диалоге есть". */}
            <button
              onClick={() => setCreateSubOpen(true)}
              className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden="true" />
              Создать заявку на подписку
            </button>
            <button
              onClick={handleToggleTakeover}
              disabled={togglingTakeover}
              className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${
                takeover
                  ? "border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {togglingTakeover ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : takeover ? (
                <UserX className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {takeover ? "Вернуть боту" : "Взять диалог на себя"}
            </button>
          </div>
        </div>

        {takeover && (
          <div className="mt-2 rounded border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
            Диалог у менеджера{dialog.human_takeover_by ? ` (${dialog.human_takeover_by})` : ""} — бот не отвечает
            клиенту, пока не нажать «Вернуть боту».
          </div>
        )}

      </div>

      {/* 21.08.2026 — заметный баннер сверху чата (не мелкая строка внутри
          шапки, как было раньше), пока у диалога есть активная эскалация. */}
      {dialog.escalated_to && (
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
            <div className="text-sm text-red-800">
              <span className="font-medium">Эскалировано, кому: {dialog.escalated_to}</span>
              {dialog.escalation_reason && <div className="mt-0.5 text-red-700">{dialog.escalation_reason}</div>}
            </div>
          </div>
          <button
            onClick={handleResolveEscalation}
            disabled={resolvingEscalation}
            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-red-300 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            {resolvingEscalation && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            Завершить эскалацию
          </button>
        </div>
      )}

      {/* Вопрос 19.07.2026: "длинные диалоги будут скроллиться?" — раньше
          список сообщений просто рос вместе со страницей. Теперь у него
          своя высота с прокруткой, а шапка диалога и статус эскалации
          сверху остаются на виду. */}
      <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/50 p-3">
        {dialog.messages.map((m, i) => (
          <div key={i} className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${ROLE_STYLE[m.role]}`}>
            <div className="mb-0.5 text-xs opacity-70">{ROLE_LABEL[m.role]}</div>
            {m.text}
            <div className="mt-1 text-[10px] opacity-60">
              {new Date(m.at).toLocaleTimeString("ru-RU")}
            </div>
          </div>
        ))}
      </div>

      {/* 17.08.2026 — ответ от менеджера напрямую в Telegram клиенту. Не
          зависит от того, взят ли диалог на себя (можно один раз что-то
          подсказать и оставить бота работать дальше) — но раз пишем сами,
          пока бот тоже отвечает, есть риск дублирования/рассинхрона, так
          что предупреждаем, а не запрещаем (решение Игоря — тумблер
          отдельный, а не привязанный к самому факту отправки). */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <label className="block text-xs font-medium text-slate-500">Ответить клиенту от менеджера</label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Текст уйдёт клиенту в Telegram прямо сейчас…"
          disabled={sending}
          className="mt-1.5 w-full rounded border border-slate-300 bg-white p-2.5 text-sm disabled:opacity-60"
        />
        {!takeover && draft.trim() && (
          <p className="mt-1 text-xs text-amber-700">
            Диалог не взят на себя — бот тоже может ответить клиенту одновременно с вами.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            onClick={handleSend}
            disabled={!dialog.client_chat_id || !draft.trim() || sending}
            title={!dialog.client_chat_id ? "Нет сохранённого chat_id для этого диалога (старая запись)" : undefined}
            className="inline-flex items-center gap-1.5 rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Отправить
          </button>
          {actionMessage && <span className="text-xs text-slate-500">{actionMessage}</span>}
        </div>
      </div>

      <CreateSubscriptionModal
        open={createSubOpen}
        dialogId={dialogId}
        onClose={() => setCreateSubOpen(false)}
        onCreated={() => {
          setActionMessage("Заявка на подписку создана из диалога.");
          reload();
        }}
      />
    </div>
  );
}
