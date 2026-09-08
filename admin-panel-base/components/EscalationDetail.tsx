"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, BookmarkPlus, Bot, Send, Loader2 } from "lucide-react";
import {
  getEscalation,
  openEscalation,
  completeEscalation,
  setEscalationResolution,
  addGreenZoneFact,
  getGreenZoneCategories,
  sendMessageToClient,
} from "@/lib/dataClient";
import { Escalation, EscalationStatus, GreenZoneCategoryRow } from "@/lib/types";
import Modal from "./Modal";
import { useCurrentUserName } from "@/lib/useCurrentUser";

// Открытие карточки автоматически переводит "новая" -> "в работе" (запрос
// 19.07.2026: "в работе становится, как только открыли"). Завершение —
// отдельное явное действие (кнопка), не автоматическое.

const STATUS_LABEL: Record<EscalationStatus, string> = {
  new: "Новая",
  in_progress: "В работе",
  completed: "Завершена",
};

const STATUS_STYLE: Record<EscalationStatus, string> = {
  new: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  completed: "bg-emerald-100 text-emerald-700",
};

// 21.07.2026: реализация ранее отложенной идеи (CLAUDE.md, 20.07.2026) —
// "кнопка сохранить как факт у карточки эскалации, чтобы реальный ответ
// Ольги одним кликом предлагался как новый факт зелёной зоны". Не
// автоматически — Ольга сама решает, стоит ли конкретный ответ становиться
// фактом (например, для allergy_medical это обычно НЕ стоит — это красная
// зона, а не справочник для агента), и сама формулирует финальный текст
// факта, а не то, что она написала клиенту дословно.
//
// 23.07.2026: раньше категории здесь были захардкожены отдельной копией
// того же словаря, что и в GreenZoneManager.tsx (два независимых места для
// одного и того же списка). Теперь категории — редактируемый справочник
// (green_zone_categories), читается тем же getGreenZoneCategories(), что и
// на экране /green-zone — правка категории в одном месте.

export default function EscalationDetail({ escalationId }: { escalationId: string }) {
  const CURRENT_USER = useCurrentUserName();
  const [escalation, setEscalation] = useState<Escalation | null | undefined>(undefined);
  const [resolutionDraft, setResolutionDraft] = useState("");
  const [resolutionSaved, setResolutionSaved] = useState(false);

  const [factModalOpen, setFactModalOpen] = useState(false);
  const [categories, setCategories] = useState<GreenZoneCategoryRow[]>([]);
  const [factCategory, setFactCategory] = useState<string>("");
  const [factText, setFactText] = useState("");
  const [factSaved, setFactSaved] = useState(false);

  // 21.07.2026: "как Ольге найти клиента, которому надо ответить по
  // эскалации? давай сделаем возможность отвечать из админки" — отправка
  // реального сообщения в Telegram прямо отсюда (не просто запись текста).
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    getGreenZoneCategories().then(setCategories);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const current = await getEscalation(escalationId);
      if (cancelled || !current) {
        setEscalation(current);
        return;
      }
      // Открытие = автопереход в "в работе", только если сейчас "новая".
      const updated = current.status === "new" ? await openEscalation(escalationId, CURRENT_USER) : current;
      if (!cancelled) {
        setEscalation(updated);
        setResolutionDraft(updated?.resolution_text ?? "");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [escalationId]);

  async function handleComplete() {
    const updated = await completeEscalation(escalationId, CURRENT_USER);
    setEscalation(updated);
  }

  async function handleSaveResolution() {
    const updated = await setEscalationResolution(escalationId, resolutionDraft, CURRENT_USER);
    setEscalation(updated);
    setResolutionSaved(true);
    setTimeout(() => setResolutionSaved(false), 1500);
  }

  async function handleSendToClient() {
    if (!escalation?.client_chat_id || !resolutionDraft.trim()) return;
    setSending(true);
    setSendResult(null);
    const result = await sendMessageToClient(escalation.client_id, escalation.client_chat_id, resolutionDraft.trim());
    setSending(false);
    setSendResult(result);
    if (result.ok) {
      // Раз реально отправили — заодно сохраняем как resolution_text, не
      // заставляем нажимать "Сохранить ответ" отдельно вторым кликом.
      await setEscalationResolution(escalationId, resolutionDraft, CURRENT_USER);
      // 24.07.2026 — запрос Игоря: "после отправки автоматически
      // проставляется финальный статус" — реальный ответ клиенту через
      // бота и есть закрытие эскалации, отдельно жать "Отметить
      // завершённой" не нужно. Кнопка ниже остаётся для случаев без
      // отправки отсюда (например, ответили клиенту по телефону).
      const completed = await completeEscalation(escalationId, CURRENT_USER);
      setEscalation(completed);
      setSendResult({ ok: true, message: "Отправлено клиенту в Telegram, эскалация отмечена завершённой" });
    }
  }

  function openFactModal() {
    setFactText(resolutionDraft.trim());
    const active = categories.filter((c) => c.is_active);
    // "Другое" — тот же смысловой дефолт, что и раньше (последняя в
    // старом фиксированном списке, "отдушина"), теперь ищем по названию,
    // а если категорию переименовали/убрали — просто первая активная.
    setFactCategory(active.find((c) => c.label === "Другое")?.label ?? active[0]?.label ?? "");
    setFactModalOpen(true);
  }

  async function handleSaveFact() {
    if (!factText.trim() || !factCategory) return;
    await addGreenZoneFact(factCategory, factText, CURRENT_USER);
    setFactModalOpen(false);
    setFactSaved(true);
    setTimeout(() => setFactSaved(false), 2500);
  }

  if (escalation === undefined) {
    return <p className="text-sm text-slate-500">Загрузка…</p>;
  }

  if (escalation === null) {
    return <p className="text-sm text-slate-500">Эскалация не найдена.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-medium text-slate-900">{escalation.client_display_name}</h1>
            <Link
              href={`/dialogs/${escalation.dialog_id}`}
              className="text-xs text-slate-400 hover:text-slate-600 hover:underline"
            >
              смотреть весь диалог →
            </Link>
          </div>
          <span className={`rounded-full px-3 py-1 text-sm font-medium ${STATUS_STYLE[escalation.status]}`}>
            {STATUS_LABEL[escalation.status]}
          </span>
        </div>

        <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-800">«{escalation.message_text}»</div>

        {escalation.agent_intended_action && (
          // 21.07.2026: что бы АГЕНТ сделал сам, будь у него разрешение/tool
          // use (протокол "ESCALATE: <мысль>", см. agent-bot/logic/
          // agent_prompt.py) — не то, что реально сделала Ольга (это ниже,
          // resolution_text). Материал для будущего решения, какие функции
          // открыть агенту, никак не влияет на саму эскалацию.
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden="true" />
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-sky-600">Бот хотел бы сделать</p>
              <p className="mt-0.5">{escalation.agent_intended_action}</p>
            </div>
          </div>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-slate-400">Создана</dt>
            <dd className="text-slate-700">{new Date(escalation.created_at).toLocaleString("ru-RU")}</dd>
          </div>
          {escalation.opened_at && (
            <div>
              <dt className="text-xs text-slate-400">Открыта</dt>
              <dd className="text-slate-700">
                {new Date(escalation.opened_at).toLocaleString("ru-RU")}
                {escalation.opened_by && ` · ${escalation.opened_by}`}
              </dd>
            </div>
          )}
          {escalation.completed_at && (
            <div>
              <dt className="text-xs text-slate-400">Завершена</dt>
              <dd className="text-slate-700">
                {new Date(escalation.completed_at).toLocaleString("ru-RU")}
                {escalation.completed_by && ` · ${escalation.completed_by}`}
              </dd>
            </div>
          )}
        </dl>

        {escalation.status !== "completed" && (
          <button
            onClick={handleComplete}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Отметить завершённой
          </button>
        )}

        <div className="mt-5 border-t border-slate-100 pt-4">
          <label className="block text-xs font-medium text-slate-500">
            Реальный ответ клиенту (необязательно — для истории и как основа для факта зелёной зоны)
          </label>
          <textarea
            value={resolutionDraft}
            onChange={(e) => setResolutionDraft(e.target.value)}
            rows={3}
            placeholder="Что реально ответили клиенту…"
            className="mt-1.5 w-full rounded border border-slate-300 bg-white p-2.5 text-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              onClick={handleSaveResolution}
              className="rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Сохранить ответ
            </button>
            {resolutionSaved && <span className="text-xs text-emerald-600">Сохранено</span>}

            <button
              onClick={handleSendToClient}
              disabled={!escalation.client_chat_id || !resolutionDraft.trim() || sending}
              title={!escalation.client_chat_id ? "Нет сохранённого chat_id для этой эскалации (старая запись)" : undefined}
              className="inline-flex items-center gap-1.5 rounded border border-sky-300 bg-sky-50 px-3 py-1 text-xs font-medium text-sky-800 hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              Отправить клиенту в Telegram
            </button>

            <button
              onClick={openFactModal}
              disabled={!resolutionDraft.trim()}
              className="ml-auto inline-flex items-center gap-1.5 rounded border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
              Сохранить как факт зелёной зоны
            </button>
          </div>
          {sendResult && (
            <p className={`mt-2 text-xs ${sendResult.ok ? "text-emerald-600" : "text-amber-700"}`}>
              {sendResult.message}
            </p>
          )}
          {!escalation.client_chat_id && (
            <p className="mt-2 text-xs text-slate-400">
              У этой эскалации нет сохранённого chat_id (создана до 21.07.2026) — отправить сообщение отсюда нельзя,
              только вручную в Telegram.
            </p>
          )}
          {factSaved && (
            <p className="mt-2 text-xs text-emerald-600">
              Факт добавлен в зелёную зону и отправлен боту — см. /green-zone.
            </p>
          )}
        </div>
      </div>

      <Modal open={factModalOpen} title="Добавить как факт зелёной зоны" onClose={() => setFactModalOpen(false)}>
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            Это не обязательно дословный ответ клиенту — сформулируйте как общий факт, на который агент сможет
            опираться в будущих разговорах с другими клиентами.
          </p>
          <div>
            <label className="block text-xs text-slate-500">Категория</label>
            <select
              value={factCategory}
              onChange={(e) => setFactCategory(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {categories.filter((c) => c.is_active).length === 0 && (
                <option value="">Сначала добавьте категорию на /green-zone</option>
              )}
              {categories
                .filter((c) => c.is_active)
                .map((c) => (
                  <option key={c.category_id} value={c.label}>
                    {c.label}
                  </option>
                ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500">Факт</label>
            <textarea
              value={factText}
              onChange={(e) => setFactText(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-slate-300 bg-white p-2 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setFactModalOpen(false)}
              className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              Отмена
            </button>
            <button
              onClick={handleSaveFact}
              disabled={!factText.trim() || !factCategory}
              className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              Сохранить факт
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
