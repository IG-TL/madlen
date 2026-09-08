"use client";

import { useEffect, useState } from "react";
import { Tag, Plus, Pencil, X } from "lucide-react";
import {
  getGreenZoneFacts,
  addGreenZoneFact,
  updateGreenZoneFact,
  deactivateGreenZoneFact,
  getGreenZoneCategories,
  addGreenZoneCategory,
  deactivateGreenZoneCategory,
} from "@/lib/dataClient";
import { GreenZoneFact, GreenZoneCategoryRow } from "@/lib/types";
import Modal from "./Modal";
import ConfirmDialog from "./ConfirmDialog";
import AuditLogPanel from "./AuditLogPanel";
import { useCurrentUserName } from "@/lib/useCurrentUser";

// ТЗ агента, уровень 9, п.3: "Ручное управление зелёной/красной зоной
// общения — без правки кода". Красная зона — стоп-лист слов, зелёная —
// СПРАВОЧНИК ФАКТОВ, на основе которых агент может отвечать своими
// словами (не готовые фразы под точный вопрос).
//
// Переосмыслено 20.07.2026: первая версия была парами "вопрос → готовый
// ответ" — прямая калька с красной зоны. Проблема (Игорь): с живым
// разговорным агентом клиент спрашивает одно и то же сотней формулировок,
// Ольге пришлось бы предугадывать их все годами — не масштабируется.
// Теперь она подтверждает ОДИН факт один раз ("скидка: неделя → 5%"), а
// формулировку на любой вопрос клиента даёт сама модель (настоящий Claude,
// когда подключим) — список остаётся маленьким, растёт медленно.
//
// Редизайн 20.07.2026 (тот же вечер): раньше факт можно было только
// добавить или деактивировать — "редактировать зелёные нельзя, надо
// добавить". Плюс форма добавления была инлайн-блоком под карточками
// категорий, поэтому уезжала вниз экрана по мере роста списка. Теперь
// кнопка "Добавить факт" — вверху, форма (и добавление, и правка) — в
// модалке (Modal.tsx), не зависит от длины списка ниже.
//
// 23.07.2026: категории были жёстким TS-enum из 6 значений — запрос Игоря
// "нужно иметь возможность редактировать категории и создавать их".
// Уточнил отдельно: для красной зоны это рискованно (категория там
// определяет матчинг regex-паттернов классификатора), для зелёной —
// безопасно (agent-bot видит только текст факта, не категорию, см.
// syncAgentBot()). Игорь подтвердил: делаем динамическими только зелёную
// зону. Категории теперь читаются из справочника green_zone_categories —
// добавление + деактивация прямо на этом экране, без правки кода. Единый
// значок (Tag) вместо индивидуальной иконки на категорию — иконку под
// произвольное имя категории заранее не подобрать.

type FormState = { category: string; factText: string; note: string };
const EMPTY_FORM: FormState = { category: "", factText: "", note: "" };

// 21.08.2026 — Игорь: красная и зелёная зона объединены в одну компактную
// страницу (см. app/red-zone/page.tsx), каждая карточка категории по
// умолчанию показывает усечённый список фактов, полный — по клику
// "Показать все N". Локальный expand/collapse на уровне карточки.
const VISIBLE_FACTS_LIMIT = 3;

export default function GreenZoneManager() {
  const CURRENT_USER = useCurrentUserName();
  const [facts, setFacts] = useState<GreenZoneFact[] | null>(null);
  const [categories, setCategories] = useState<GreenZoneCategoryRow[] | null>(null);
  const [editingFact, setEditingFact] = useState<GreenZoneFact | null>(null); // null + modalOpen=true -> добавление; иначе правка
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pendingDeactivate, setPendingDeactivate] = useState<GreenZoneFact | null>(null);
  const [newCategoryLabel, setNewCategoryLabel] = useState("");
  const [pendingDeactivateCategory, setPendingDeactivateCategory] = useState<GreenZoneCategoryRow | null>(null);
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());

  function toggleExpanded(key: string) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function refreshFacts() {
    setFacts(await getGreenZoneFacts());
  }

  async function refreshCategories() {
    setCategories(await getGreenZoneCategories());
  }

  useEffect(() => {
    refreshFacts();
    refreshCategories();
  }, []);

  const activeCategories = (categories ?? []).filter((c) => c.is_active);

  function openAddModal() {
    setEditingFact(null);
    setForm({ ...EMPTY_FORM, category: activeCategories[0]?.label ?? "" });
    setModalOpen(true);
  }

  function openEditModal(fact: GreenZoneFact) {
    setEditingFact(fact);
    setForm({ category: fact.category, factText: fact.fact_text, note: fact.note ?? "" });
    setModalOpen(true);
  }

  async function handleSubmit() {
    if (!form.factText.trim() || !form.category) return;
    if (editingFact) {
      await updateGreenZoneFact(
        editingFact.fact_id,
        { category: form.category, factText: form.factText, note: form.note },
        CURRENT_USER,
      );
    } else {
      await addGreenZoneFact(form.category, form.factText, CURRENT_USER, form.note || undefined);
    }
    setModalOpen(false);
    await refreshFacts();
  }

  async function confirmDeactivate() {
    if (!pendingDeactivate) return;
    await deactivateGreenZoneFact(pendingDeactivate.fact_id, CURRENT_USER);
    setPendingDeactivate(null);
    await refreshFacts();
  }

  async function handleAddCategory() {
    const label = newCategoryLabel.trim();
    if (!label) return;
    await addGreenZoneCategory(label, CURRENT_USER);
    setNewCategoryLabel("");
    await refreshCategories();
  }

  async function confirmDeactivateCategory() {
    if (!pendingDeactivateCategory) return;
    await deactivateGreenZoneCategory(pendingDeactivateCategory.category_id, CURRENT_USER);
    setPendingDeactivateCategory(null);
    await refreshCategories();
  }

  if (!facts || !categories) {
    return <p className="text-sm text-slate-500">Загрузка…</p>;
  }

  const byCategory = (label: string) => facts.filter((f) => f.category === label);
  // Категория могла быть деактивирована, но у неё уже есть факты — не
  // прячем их молча, показываем блок с пометкой "неактивна".
  const referencedLabels = new Set(facts.map((f) => f.category));
  const inactiveWithFacts = categories.filter((c) => !c.is_active && referencedLabels.has(c.label));
  const boardCategories = [...activeCategories, ...inactiveWithFacts];
  // Факты, у которых category не совпадает ни с одной строкой справочника
  // (не должно случаться в норме, но не даём данным исчезнуть, если
  // случится) — отдельный блок "Прочее" в конце.
  const knownLabels = new Set(categories.map((c) => c.label));
  const orphanFacts = facts.filter((f) => !knownLabels.has(f.category));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-600">
          Здесь — не готовые ответы, а подтверждённые факты. Бот использует
          их, чтобы отвечать клиенту своими словами в контексте разговора, а
          не зачитывать шаблон. Одна строка — один факт, список должен
          оставаться небольшим.
        </p>
        <button
          onClick={openAddModal}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Добавить факт
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-medium text-slate-700">Категории</h2>
        <div className="flex flex-wrap gap-2">
          {activeCategories.length === 0 && <span className="text-xs text-slate-400">Пока нет ни одной категории</span>}
          {activeCategories.map((c) => (
            <span
              key={c.category_id}
              className="flex items-center gap-1.5 rounded-full bg-slate-100 py-1 pl-3 pr-1.5 text-xs text-slate-700"
            >
              {c.label}
              <button
                onClick={() => setPendingDeactivateCategory(c)}
                aria-label={`Деактивировать категорию «${c.label}»`}
                className="rounded-full p-0.5 text-slate-400 hover:bg-slate-200 hover:text-red-600"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={newCategoryLabel}
            onChange={(e) => setNewCategoryLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddCategory()}
            placeholder="Новая категория, напр. «Аллергии-опрос»"
            className="w-64 rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
          <button
            onClick={handleAddCategory}
            disabled={!newCategoryLabel.trim()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Добавить категорию
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {boardCategories.map((cat) => {
          const items = byCategory(cat.label);
          const expanded = expandedCats.has(cat.category_id);
          const visibleItems = expanded ? items : items.slice(0, VISIBLE_FACTS_LIMIT);
          return (
            <div key={cat.category_id} className="rounded-xl border border-slate-200 bg-white p-4 ring-1 ring-emerald-100">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50">
                  <Tag className="h-4 w-4 text-emerald-700" aria-hidden="true" />
                </span>
                <h2 className="text-sm font-medium text-slate-900">{cat.label}</h2>
                {!cat.is_active && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                    неактивна
                  </span>
                )}
              </div>

              {items.length === 0 ? (
                <span className="text-xs text-slate-400">Пока пусто</span>
              ) : (
                <div className="space-y-2">
                  {visibleItems.map((f) => (
                    <div key={f.fact_id} className="group rounded-lg bg-emerald-50/60 p-2.5 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <p className={expanded ? "font-medium text-slate-800" : "font-medium text-slate-800 line-clamp-2"}>
                          {f.fact_text}
                        </p>
                        <div className="flex shrink-0 gap-1 opacity-60 group-hover:opacity-100">
                          <button onClick={() => openEditModal(f)} aria-label={`Изменить факт «${f.fact_text}»`}>
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => setPendingDeactivate(f)}
                            aria-label={`Убрать факт «${f.fact_text}»`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      {f.note && expanded && <p className="mt-1 text-slate-500">{f.note}</p>}
                    </div>
                  ))}
                </div>
              )}
              {items.length > VISIBLE_FACTS_LIMIT && (
                <button
                  onClick={() => toggleExpanded(cat.category_id)}
                  className="mt-2 text-xs font-medium text-slate-400 hover:text-slate-700"
                >
                  {expanded ? "Свернуть" : `Показать все (${items.length})`}
                </button>
              )}
            </div>
          );
        })}

        {orphanFacts.length > 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 ring-1 ring-amber-100">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50">
                <Tag className="h-4 w-4 text-amber-700" aria-hidden="true" />
              </span>
              <h2 className="text-sm font-medium text-slate-900">Прочее (категория не найдена)</h2>
            </div>
            <div className="space-y-2">
              {orphanFacts.map((f) => (
                <div key={f.fact_id} className="group rounded-lg bg-amber-50/60 p-2.5 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-slate-800">
                      {f.fact_text} <span className="text-slate-400">({f.category})</span>
                    </p>
                    <div className="flex shrink-0 gap-1 opacity-60 group-hover:opacity-100">
                      <button onClick={() => openEditModal(f)} aria-label={`Изменить факт «${f.fact_text}»`}>
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button onClick={() => setPendingDeactivate(f)} aria-label={`Убрать факт «${f.fact_text}»`}>
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  {f.note && <p className="mt-1 text-slate-500">{f.note}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <AuditLogPanel entityType="green_zone_fact" title="История изменений зелёной зоны" />

      <Modal open={modalOpen} title={editingFact ? "Изменить факт" : "Добавить факт"} onClose={() => setModalOpen(false)}>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-slate-500">Категория</label>
            <select
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              {activeCategories.length === 0 && <option value="">Сначала добавьте категорию выше</option>}
              {/* Если у редактируемого факта категория уже деактивирована — не выкидываем её из списка молча */}
              {editingFact &&
                !activeCategories.some((c) => c.label === editingFact.category) &&
                editingFact.category && <option value={editingFact.category}>{editingFact.category} (неактивна)</option>}
              {activeCategories.map((c) => (
                <option key={c.category_id} value={c.label}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500">Факт (одна строка, без готовой формулировки ответа)</label>
            <input
              value={form.factText}
              onChange={(e) => setForm((f) => ({ ...f, factText: e.target.value }))}
              placeholder="напр. Скидка: неделя — 5%, месяц — 10%"
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500">Заметка (необязательно)</label>
            <input
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              className="mt-1 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSubmit}
              className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              {editingFact ? "Сохранить" : "Добавить"}
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
        title="Убрать факт из зелёной зоны?"
        description={
          pendingDeactivate
            ? `Бот больше не сможет опираться на «${pendingDeactivate.fact_text}» в ответах.`
            : undefined
        }
        confirmLabel="Да, убрать"
        onConfirm={confirmDeactivate}
        onCancel={() => setPendingDeactivate(null)}
      />

      <ConfirmDialog
        open={pendingDeactivateCategory !== null}
        title="Деактивировать категорию?"
        description={
          pendingDeactivateCategory
            ? `Категория «${pendingDeactivateCategory.label}» перестанет предлагаться при добавлении новых фактов. Уже существующие факты в ней останутся видны (с пометкой "неактивна").`
            : undefined
        }
        confirmLabel="Да, деактивировать"
        onConfirm={confirmDeactivateCategory}
        onCancel={() => setPendingDeactivateCategory(null)}
      />
    </div>
  );
}
