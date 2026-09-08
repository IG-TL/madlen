"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getDialogs } from "@/lib/dataClient";
import { AgentDialog } from "@/lib/types";

export default function DialogList() {
  const [dialogs, setDialogs] = useState<AgentDialog[] | null>(null);
  const [onlyEscalated, setOnlyEscalated] = useState(false);

  useEffect(() => {
    getDialogs(onlyEscalated ? "escalated" : undefined).then(setDialogs);
  }, [onlyEscalated]);

  if (!dialogs) {
    return <p className="text-sm text-slate-500">Загрузка…</p>;
  }

  return (
    <div className="space-y-3">
      <label className="flex w-fit items-center gap-2 text-sm text-slate-600">
        <input
          type="checkbox"
          checked={onlyEscalated}
          onChange={(e) => setOnlyEscalated(e.target.checked)}
          className="rounded border-slate-300"
        />
        Только эскалированные Ольге
      </label>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Клиент</th>
              <th className="px-4 py-3">Канал</th>
              <th className="px-4 py-3">Начало</th>
              <th className="px-4 py-3">Эскалация</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {dialogs.map((d) => (
              <tr key={d.dialog_id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link href={`/dialogs/${d.dialog_id}`} className="font-medium text-slate-900 hover:underline">
                    {d.client_display_name}
                  </Link>
                  {/* 17.08.2026 — видно из списка, не только открыв диалог,
                      что бот сейчас не отвечает этому клиенту. */}
                  {d.human_takeover && (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700">
                      у менеджера
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">{d.channel}</td>
                <td className="px-4 py-3 text-slate-600">
                  {new Date(d.started_at).toLocaleString("ru-RU")}
                </td>
                <td className="px-4 py-3">
                  {d.escalated_to ? (
                    <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">
                      → {d.escalated_to}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">нет</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
