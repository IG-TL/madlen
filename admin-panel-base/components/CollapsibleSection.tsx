"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// 19.08.2026 — Игорь: "на странице настроек нужно сворачивать блоки, а то
// длинная страница получается". Тот же визуальный приём, что уже есть в
// EndingSubscriptions.tsx (17.08.2026) — заголовок кликабелен, шеврон
// показывает состояние, содержимое рендерится только когда развёрнуто (не
// просто скрыто через CSS — незачем держать в DOM то, что не видно).
// Вынесено в отдельный переиспользуемый компонент, а не скопировано в каждую
// секцию /settings по отдельности, чтобы 5 копий одной и той же логики не
// разошлись между собой при следующей правке.
export default function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" />
        )}
        <h2 className="text-base font-medium text-slate-900">{title}</h2>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </section>
  );
}
