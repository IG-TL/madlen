"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getEscalations, EscalationSort } from "@/lib/dataClient";
import { Escalation, EscalationStatus } from "@/lib/types";

// Запрос 19.07.2026: статусы новая/в работе/завершена, "в работе"
// автоматически при открытии карточки, дефолтная сортировка
// "в работе -> новая -> завершена", плюс сортировка по типу эскалации,
// пагинация 20 строк по всему объёму (не по текущей странице).

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

const CATEGORY_LABEL: Record<Escalation["category"], string> = {
  allergy_medical: "Аллергии и здоровье",
  indirect_pattern: "Косвенное упоминание",
  complaint_negative: "Жалоба",
  // 21.07.2026: агент сам не уверен в ответе (протокол ESCALATE) — не из
  // красного стоп-листа, см. types.ts.
  agent_uncertain: "Агент не уверен",
};

const PAGE_SIZE = 20;

export default function EscalationList() {
  const router = useRouter();
  const [rows, setRows] = useState<Escalation[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sortBy, setSortBy] = useState<EscalationSort>("status");
  const [page, setPage] = useState(1);

  useEffect(() => {
    getEscalations(sortBy, page, PAGE_SIZE).then(({ rows, total }) => {
      setRows(rows);
      setTotal(total);
    });
  }, [sortBy, page]);

  // Смена сортировки — возвращаемся на первую страницу, иначе можно
  // оказаться на несуществующей странице после пересортировки.
  function handleSortChange(value: EscalationSort) {
    setSortBy(value);
    setPage(1);
  }

  if (!rows) {
    return <p className="text-sm text-slate-500">Загрузка…</p>;
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Сортировка:</span>
          <select
            value={sortBy}
            onChange={(e) => handleSortChange(e.target.value as EscalationSort)}
            className="rounded border border-slate-300 bg-white px-2 py-1"
          >
            <option value="status">по статусу (в работе → новые → завершённые)</option>
            <option value="category">по типу эскалации</option>
            <option value="date">по дате</option>
          </select>
        </div>
        <span className="text-xs text-slate-400">Всего: {total}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Клиент</th>
              <th className="px-4 py-3">Тип</th>
              <th className="px-4 py-3">Сообщение</th>
              <th className="px-4 py-3">Когда</th>
              <th className="px-4 py-3">Статус</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Эскалаций нет.
                </td>
              </tr>
            )}
            {rows.map((e) => (
              // Запрос 19.07.2026: "пусть в эскалации вся строка будет
              // кликабельна, не только имя". role="link" + tabIndex/onKeyDown
              // — чтобы строка была доступна и с клавиатуры, не только мышью.
              //
              // 21.08.2026 — Игорь: раз баннер эскалации (с кнопкой "Завершить
              // эскалацию") теперь живёт прямо в чате (DialogThread.tsx, см.
              // задачу д), строка ведёт сразу в чат с клиентом, а не на
              // отдельную карточку /escalations/[id] — отвечать и закрывать
              // эскалацию можно в одном месте, без лишнего перехода.
              // /escalations/[id] (EscalationDetail.tsx) физически не удалён —
              // просто на него больше не ведёт ни одна активная ссылка в UI.
              <tr
                key={e.escalation_id}
                onClick={() => router.push(`/dialogs/${e.dialog_id}`)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") router.push(`/dialogs/${e.dialog_id}`);
                }}
                role="link"
                tabIndex={0}
                className="cursor-pointer hover:bg-slate-50"
              >
                <td className="px-4 py-3 font-medium text-slate-900">{e.client_display_name}</td>
                <td className="px-4 py-3 text-slate-600">{CATEGORY_LABEL[e.category]}</td>
                <td className="max-w-xs truncate px-4 py-3 text-slate-600">{e.message_text}</td>
                <td className="px-4 py-3 whitespace-nowrap text-slate-500">
                  {new Date(e.created_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[e.status]}`}>
                    {STATUS_LABEL[e.status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-slate-600 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            Назад
          </button>
          <span className="text-slate-500">
            Страница {page} из {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-slate-600 disabled:opacity-40"
          >
            Вперёд
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
