"use client";

import { useEffect, useState } from "react";
import { HeartPulse, MessageCircleWarning, Frown, Settings2, Plus, X } from "lucide-react";
import { getRedZoneTerms, addRedZoneTerm, deactivateRedZoneTerm } from "@/lib/dataClient";
import { RedZoneTermEntry, RedZoneCategory, RedZoneLanguage } from "@/lib/types";
import { humanizeTermPattern } from "@/lib/humanize";
import Modal from "./Modal";
import ConfirmDialog from "./ConfirmDialog";
import AuditLogPanel from "./AuditLogPanel";
import { useCurrentUserName } from "@/lib/useCurrentUser";

// ТЗ агента, уровень 9, п.3: "Ручное управление зелёной/красной зоной
// общения — без правки кода". Зелёная зона (FAQ, сценарии, на которые бот
// отвечает сам) — отдельный экран, см. GreenZoneManager.tsx.
//
// Редизайн 19.07.2026: раньше здесь были сырые regex-паттерны прямо в
// строках ("аллерг\w*" и т.п.) — по отзыву это выглядело как техническая
// таблица из базы данных, не подходит для нетехнического владельца бизнеса.
// Теперь по умолчанию показывается человекочитаемое слово, а технический
// паттерн скрыт за переключателем внизу карточки (нужен только Игорю).
//
// Редизайн 20.07.2026: та же жалоба, что и в зелёной зоне — форма
// добавления была инлайн-блоком под карточками категорий, уезжала вниз
// экрана по мере роста списка. Кнопка "Добавить слово" теперь вверху,
// форма — в модалке (Modal.tsx).

const CATEGORY_LABEL: Record<RedZoneCategory, string> = {
  allergy_medical: "Аллергии и здоровье",
  indirect_pattern: "Косвенные упоминания",
  complaint_negative: "Жалобы и недовольство",
};

const CATEGORY_HINT: Record<RedZoneCategory, string> = {
  allergy_medical: "Любое из этих слов — сообщение сразу уходит Ольге, без исключений",
  indirect_pattern: "Фразы, за которыми часто скрывается вопрос о здоровье, даже без прямого слова",
  complaint_negative: "Жалобы, возвраты, явное недовольство — тоже сразу к Ольге",
};

const CATEGORY_ICON: Record<RedZoneCategory, typeof HeartPulse> = {
  allergy_medical: HeartPulse,
  indirect_pattern: MessageCircleWarning,
  complaint_negative: Frown,
};

const CATEGORY_STYLE: Record<RedZoneCategory, { bg: string; text: string; ring: string; chip: string }> = {
  allergy_medical: { bg: "bg-red-50", text: "text-red-700", ring: "ring-red-100", chip: "bg-red-100 text-red-700" },
  indirect_pattern: { bg: "bg-amber-50", text: "text-amber-700", ring: "ring-amber-100", chip: "bg-amber-100 text-amber-700" },
  complaint_negative: { bg: "bg-orange-50", text: "text-orange-700", ring: "ring-orange-100", chip: "bg-orange-100 text-orange-700" },
};

const LANGUAGE_LABEL: Record<RedZoneLanguage, string> = { ru: "Русский", fr: "Французский", en: "Английский" };

// 21.08.2026 — Игорь: красная и зелёная зона объединены в одну компактную
// страницу (см. app/red-zone/page.tsx), каждая карточка категории по
// умолчанию показывает усечённый список (первые несколько слов), полный
// список — по клику "Показать все N". Локальный expand/collapse на уровне
// карточки, не глобальный стейт.
const VISIBLE_TERMS_LIMIT = 6;

export default function RedZoneTermsManager() {
  const CURRENT_USER = useCurrentUserName();
  const [terms, setTerms] = useState<RedZoneTermEntry[] | null>(null);
  const [category, setCategory] = useState<RedZoneCategory>("allergy_medical");
  const [language, setLanguage] = useState<RedZoneLanguage>("ru");
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");
  const [showTechnical, setShowTechnical] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingDeactivate, setPendingDeactivate] = useState<RedZoneTermEntry | null>(null);
  const [expandedCats, setExpandedCats] = useState<Set<RedZoneCategory>>(new Set());

  function toggleExpanded(cat: RedZoneCategory) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  async function refresh() {
    setTerms(await getRedZoneTerms());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleAdd() {
    if (!pattern.trim()) return;
    await addRedZoneTerm(category, language, pattern, CURRENT_USER, note || undefined);
    setPattern("");
    setNote("");
    setModalOpen(false);
    await refresh();
  }

  // Запрос 19.07.2026: "в красной зоне я спокойно удалил пункт из аллергии.
  // Так не должно быть. Всегда нужна модалка с апрувом да/нет" — клик по X
  // теперь только открывает подтверждение, реальное удаление — в
  // confirmDeactivate().
  async function confirmDeactivate() {
    if (!pendingDeactivate) return;
    await deactivateRedZoneTerm(pendingDeactivate.term_id, CURRENT_USER);
    setPendingDeactivate(null);
    await refresh();
  }

  if (!terms) {
    return <p className="text-sm text-slate-500">Загрузка…</p>;
  }

  const byCategory = (cat: RedZoneCategory) => terms.filter((t) => t.category === cat);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-600">
          Если клиент упоминает что-то из списка ниже — бот сразу передаёт
          сообщение Ольге и не пытается ответить сам. Это работает как
          подстраховка: лучше лишний раз переспросить, чем пропустить
          что-то важное про здоровье.
        </p>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Добавить слово
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {(Object.keys(CATEGORY_LABEL) as RedZoneCategory[]).map((cat) => {
          const Icon = CATEGORY_ICON[cat];
          const style = CATEGORY_STYLE[cat];
          const items = byCategory(cat);
          const expanded = expandedCats.has(cat);
          const visibleItems = expanded ? items : items.slice(0, VISIBLE_TERMS_LIMIT);
          const hiddenCount = items.length - visibleItems.length;
          return (
            <div key={cat} className={`rounded-xl border border-slate-200 bg-white p-4 ring-1 ${style.ring}`}>
              <div className="mb-1 flex items-center gap-2">
                <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${style.bg}`}>
                  <Icon className={`h-4 w-4 ${style.text}`} aria-hidden="true" />
                </span>
                <h2 className="text-sm font-medium text-slate-900">{CATEGORY_LABEL[cat]}</h2>
              </div>
              <p className="mb-3 text-xs text-slate-500">{CATEGORY_HINT[cat]}</p>

              <div className="flex flex-wrap gap-1.5">
                {items.length === 0 && <span className="text-xs text-slate-400">Пока пусто</span>}
                {visibleItems.map((t) => (
                  <span
                    key={t.term_id}
                    className={`group inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${style.chip}`}
                  >
                    {humanizeTermPattern(t.pattern)}
                    <button
                      onClick={() => setPendingDeactivate(t)}
                      aria-label={`Убрать «${humanizeTermPattern(t.pattern)}»`}
                      className="ml-0.5 rounded-full opacity-60 hover:opacity-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              {(hiddenCount > 0 || expanded) && items.length > VISIBLE_TERMS_LIMIT && (
                <button
                  onClick={() => toggleExpanded(cat)}
                  className="mt-2 text-xs font-medium text-slate-400 hover:text-slate-700"
                >
                  {expanded ? "Свернуть" : `Показать все (${items.length})`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => setShowTechnical((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600"
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
        {showTechnical ? "Скрыть технический вид" : "Показать технический вид (для разработчика)"}
      </button>

      {showTechnical && (
        <div className="space-y-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
            Термины отсюда реально попадают в живой классификатор бота
            (`red_zone_classifier.py`) — он подтягивает активные термины из
            этой таблицы поверх базового стоп-листа (не позже минуты после
            сохранения). Деактивация здесь останавливает только термины,
            добавленные через этот экран — исходный базовый список
            (`red_zone_terms.yaml`) им не заменяется и продолжает работать
            всегда, как дополнительная страховка.
          </div>
          {(Object.keys(CATEGORY_LABEL) as RedZoneCategory[]).map((cat) => (
            <div key={cat} className="rounded-lg border border-slate-200 bg-white p-3">
              <h3 className="mb-2 text-xs font-medium text-slate-600">{CATEGORY_LABEL[cat]}</h3>
              <div className="space-y-1.5">
                {byCategory(cat).map((t) => (
                  <div key={t.term_id} className="flex items-center justify-between text-xs">
                    <div>
                      <span className="mr-2 rounded bg-slate-100 px-1.5 py-0.5 uppercase text-slate-500">
                        {t.language}
                      </span>
                      <code className="text-slate-700">{t.pattern}</code>
                      {t.note && <span className="ml-2 text-slate-400">— {t.note}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <AuditLogPanel entityType="red_zone_term" title="История изменений красной зоны" />

      <Modal open={modalOpen} title="Добавить слово в список" onClose={() => setModalOpen(false)}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="flex-1">
              <label className="block text-xs text-slate-500">Категория</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as RedZoneCategory)}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs text-slate-500">Язык</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as RedZoneLanguage)}
                className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
              >
                {Object.entries(LANGUAGE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-500">Слово</label>
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="напр. лактоза"
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500">Заметка (необязательно)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
          </div>
          <p className="text-xs text-slate-400">
            Слово поймает все его формы автоматически (например «лактоза» найдёт и «лактозы», и «лактозой»).
          </p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleAdd}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              Добавить
            </button>
            <button
              onClick={() => setModalOpen(false)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              Отмена
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDeactivate !== null}
        title="Убрать слово из красной зоны?"
        description={
          pendingDeactivate
            ? `«${humanizeTermPattern(pendingDeactivate.pattern)}» перестанет отправлять сообщения Ольге на разбор.`
            : undefined
        }
        confirmLabel="Да, убрать"
        onConfirm={confirmDeactivate}
        onCancel={() => setPendingDeactivate(null)}
      />
    </div>
  );
}
