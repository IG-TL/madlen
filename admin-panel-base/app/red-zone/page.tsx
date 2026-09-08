"use client";

import { useState } from "react";
import RedZoneTermsManager from "@/components/RedZoneTermsManager";
import GreenZoneManager from "@/components/GreenZoneManager";

// 21.08.2026 — Игорь: красная и зелёная зона были двумя отдельными
// пунктами меню (/red-zone, /green-zone) — объединены в одну компактную
// страницу с двумя секциями-вкладками (минимально ломающий вариант: URL
// /red-zone остаётся основным, /green-zone теперь редиректит сюда же, см.
// app/green-zone/page.tsx). Логика самих менеджеров не переписана — только
// добавлен truncate/expand на карточках категорий внутри них
// (RedZoneTermsManager.tsx, GreenZoneManager.tsx).
type Tab = "red" | "green";

export default function ZonesPage() {
  const [tab, setTab] = useState<Tab>("red");

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Красная и зелёная зона</h1>
        <p className="mt-1 text-sm text-slate-600">
          Красная зона — стоп-лист терминов, при которых сообщение клиента
          всегда уходит Ольге, без исключений. Зелёная зона — справочник
          фактов, на основе которых бот может отвечать клиенту сам, своими
          словами.
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        <button
          onClick={() => setTab("red")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "red"
              ? "border-b-2 border-red-600 text-red-700"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          Красная зона
        </button>
        <button
          onClick={() => setTab("green")}
          className={`px-4 py-2 text-sm font-medium ${
            tab === "green"
              ? "border-b-2 border-emerald-600 text-emerald-700"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          Зелёная зона
        </button>
      </div>

      {tab === "red" ? <RedZoneTermsManager /> : <GreenZoneManager />}
    </div>
  );
}
