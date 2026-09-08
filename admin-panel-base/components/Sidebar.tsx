"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  Workflow,
  BarChart3,
  Settings,
  Activity,
  CalendarDays,
  ChevronRight,
  LogOut,
} from "lucide-react";
import { useCurrentUser } from "@/lib/useCurrentUser";
import QuickClientSearch from "./QuickClientSearch";

// Запрос 19.07.2026: страниц становится много, нужно левое меню с
// разделами и подпунктами (по образцу присланного скриншота), а не
// плоский горизонтальный список. Разделы — не техническое деление, а
// группировка по смыслу для нетехнического владельца бизнеса: "Общение"
// объединяет всё, что касается переписки бота с клиентом (диалоги,
// эскалации, стоп-лист), "Автоматизация" — то, что можно включать/
// выключать и что ждёт одобрения. С запасом под рост: каждая группа
// сейчас 1-3 пункта, но по роадмапу (S3/S6/S7 и т.д.) появятся ещё.

interface NavItem {
  href: string;
  label: string;
  // 21.07.2026: запрос Игоря — визуально пометить разделы, которые ещё
  // читают/пишут только mockData.ts (не Supabase), чтобы не путать с
  // реальными данными. Список сверен с dataClient.ts (hasSupabase()):
  // клиенты/диалоги/модули/апрувы/статистика блюд — уровни 1/2/4/5/6/8 ТЗ
  // ещё не подключены к живому коду (см. CLAUDE.md), поэтому у них
  // объективно нет реальной таблицы, не путать с багом.
  mock?: boolean;
}

interface NavGroup {
  key: string;
  label: string;
  icon: typeof Users;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    // 06.08.2026 — раздел назывался "Клиенты" и содержал ещё доставки и
    // тарифы (Игорь: "раздел клиенты не соответствует наполнению").
    // Доставки — ежедневная операционная работа, вынесены в свой раздел;
    // здесь остались справочники: кто наши клиенты и на каких пакетах.
    key: "deliveries",
    label: "Доставки",
    icon: CalendarDays,
    items: [
      { href: "/deliveries", label: "Доставки на день" },
      // 21.08.2026 — Игорь: календарная сетка на весь месяц (количество
      // доставок + выручка за день, клик по дню ведёт на "Доставки на день"
      // на эту дату), см. app/deliveries/month/page.tsx.
      { href: "/deliveries/month", label: "Доставки за месяц" },
    ],
  },
  {
    key: "clients",
    label: "Клиенты и тарифы",
    icon: Users,
    // 22.07.2026: getClients()/getClientCard() получили реальную Supabase-
    // ветку (см. dataClient.ts, supabase_migration_7_clients_core.sql) —
    // значок "мок" снят. favoriteDishes/subscriptions внутри карточки
    // клиента пока всё ещё на моке (dishes/subscriptions не мигрированы).
    // 06.08.2026: "Доставки на день" — перенос функционала боевой
    // Google-таблицы ("2. Заказы на день") внутрь системы, чтобы не держать
    // два источника истины. Список вычисляется из подписок, не вводится
    // руками — см. lib/deliveries.ts.
    // 06.08.2026: "Тарифы" — справочник пакетов подписок (создание/правка,
    // видно клиентов на каждом тарифе), см. supabase_migration_15.
    items: [
      { href: "/clients", label: "Клиенты" },
      { href: "/plans", label: "Тарифы" },
      // 18.08.2026 — промокоды (коворкинг, SPACE): код, % скидки, к каким
      // тарифам применим, фиксированный адрес, срок действия, лимит
      // использований — см. supabase_migration_27.
      { href: "/promo-codes", label: "Промокоды" },
    ],
  },
  {
    key: "communication",
    label: "Общение",
    icon: MessageSquare,
    items: [
      // 21.07.2026 вечером: getDialogs()/getDialog() получили реальную
      // Supabase-ветку (см. dataClient.ts) — значок "мок" снят, он был
      // проставлен чуть раньше в тот же день, до того как подключение
      // было доделано, и с тех пор устарел.
      { href: "/dialogs", label: "Диалоги" },
      { href: "/escalations", label: "Эскалации" },
      // 26.08.2026 — QA-сканер (Игорь: "раз в шесть часов проверяй новые
      // диалоги/сообщения на баги... создаёшь в админке страницу") — рядом
      // с "Эскалации", тот же раздел "Общение".
      { href: "/qa-findings", label: "QA-находки" },
      // 21.08.2026 — красная и зелёная зона объединены в одну компактную
      // страницу с вкладками (см. app/red-zone/page.tsx), /green-zone
      // теперь просто редиректит сюда — один пункт меню вместо двух.
      { href: "/red-zone", label: "Красная и зелёная зона" },
      { href: "/agent-prompt", label: "Промпт агента" },
      // 20.08.2026 — Ольга раз в неделю вводит меню на всю неделю (пн-вс)
      // одним текстом, бот дословно присылает его клиенту на любой вопрос
      // про меню (см. logic/menu_guard.py в agent-bot) — влияет на ответы
      // бота, поэтому рядом с остальными разделами "Общение", не в
      // "Клиенты и тарифы".
      { href: "/weekly-menu", label: "Меню недели" },
    ],
  },
  {
    key: "automation",
    label: "Автоматизация",
    icon: Workflow,
    items: [
      { href: "/modules", label: "Модули", mock: true },
      { href: "/gates", label: "Апрувы", mock: true },
      // 22.07.2026: раньше жило внутри /settings ("Уведомления") — прямой
      // фидбек Игоря, что импорт заказов не имеет отношения к
      // уведомлениям сотрудников, вынесено на отдельную страницу.
      { href: "/sheets-import", label: "Импорт Google Sheets" },
      // 25.07.2026: первый tool use агента (перенос даты доставки) —
      // отдельная очередь апрува от /gates (тот всё ещё на моках/не
      // подключён к живым данным, см. CLAUDE.md), эта — реальная.
      { href: "/order-changes", label: "Перенос доставки" },
      // 25.07.2026: второй tool use агента (оформление подписки) — тот же
      // принцип, отдельная реальная очередь апрува.
      { href: "/subscription-requests", label: "Заявки на подписку" },
    ],
  },
  {
    key: "stats",
    label: "Статистика",
    icon: BarChart3,
    // 06.08.2026: раздел был одним пунктом "Блюда" на моках. После появления
    // реальной статистики по подпискам разнесено на два пункта — у них
    // разный статус данных, и держать их под одним ярлыком было неверно.
    items: [
      { href: "/stats", label: "Подписки" },
      { href: "/stats/dishes", label: "Блюда", mock: true },
    ],
  },
  {
    key: "settings",
    label: "Настройки",
    icon: Settings,
    // 20.08.2026 — раньше был один пункт "Уведомления", ведущий на общую
    // /settings с 6 не связанными между собой блоками — Игорь: "раздел не
    // соответствует наполнению, там не только уведомления". Разнесено на
    // 3 страницы по смыслу содержимого (см. app/settings/*/page.tsx):
    // уведомления сотрудникам, тексты для клиента, технические настройки.
    items: [
      { href: "/settings/notifications", label: "Уведомления" },
      { href: "/settings/messages", label: "Сообщения клиентам" },
      { href: "/settings", label: "Общие настройки" },
    ],
  },
  {
    // 21.07.2026 — "health, но красиво": живой статус Telegram/Claude/
    // Supabase/синхронизации, не бизнес-настройка, поэтому отдельная
    // группа, а не пункт внутри "Настройки".
    key: "system",
    label: "Система",
    icon: Activity,
    items: [
      { href: "/status", label: "Статус сервисов" },
      // 22.07.2026 — "засунем логи выгрузок, чтоб зашёл и увидел, что джобы
      // сработали": история импортов Google Sheets + автовыгрузка + весь
      // аудит-лог в одном месте.
      { href: "/system-logs", label: "Логи и синхронизация" },
    ],
  },
];

// 06.08.2026 — после появления /stats/dishes рядом с /stats префиксной
// проверки стало недостаточно: на вложенной странице подсвечивались оба
// пункта. Берём самое ДЛИННОЕ совпадение среди всех пунктов меню — это
// работает для любой будущей вложенности, без ручных флагов на каждый пункт.
const ALL_HREFS = GROUPS.flatMap((g) => g.items.map((i) => i.href));

function isActive(pathname: string, href: string): boolean {
  const matches = ALL_HREFS.filter((h) => pathname === h || pathname.startsWith(h + "/"));
  if (matches.length === 0) return false;
  const best = matches.reduce((a, b) => (b.length > a.length ? b : a));
  return best === href;
}

export default function Sidebar() {
  const pathname = usePathname();
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  // 22.07.2026 — страница входа не должна показывать навигацию (ей всё
  // равно нельзя воспользоваться без сессии, middleware.ts тут же вернёт
  // на /login) — проще скрыть сайдбар на этой одной странице, чем заводить
  // отдельный root layout через route group ради одной страницы.
  if (pathname === "/login") return null;

  // Раздел, в котором лежит текущая страница, разворачивается сам —
  // не нужно искать, где ты находишься, руками кликая по всем разделам.
  useEffect(() => {
    const activeGroup = GROUPS.find((g) => g.items.some((i) => isActive(pathname, i.href)));
    if (activeGroup) {
      setOpenGroups((prev) => new Set(prev).add(activeGroup.key));
    }
  }, [pathname]);

  function toggleGroup(key: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <aside className="flex h-screen w-64 flex-shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-5 py-4">
        <p className="text-sm font-semibold text-slate-900">HF Nha Trang</p>
        <p className="text-xs text-slate-400">Панель управления</p>
      </div>

      {/* 21.08.2026 — Игорь: быстрый поиск клиента, доступный с любой
          страницы, а не только со списка /clients. */}
      <QuickClientSearch />

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        <Link
          href="/"
          className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium ${
            pathname === "/" ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
          }`}
        >
          <LayoutDashboard className="h-4 w-4" aria-hidden="true" />
          Обзор
        </Link>

        {GROUPS.map((group) => {
          const GroupIcon = group.icon;
          const isOpen = openGroups.has(group.key);
          const groupHasActive = group.items.some((i) => isActive(pathname, i.href));
          return (
            <div key={group.key}>
              <button
                onClick={() => toggleGroup(group.key)}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium uppercase tracking-wide ${
                  groupHasActive ? "text-slate-900" : "text-slate-500"
                } hover:bg-slate-100`}
              >
                <GroupIcon className="h-4 w-4" aria-hidden="true" />
                <span className="flex-1">{group.label}</span>
                <ChevronRight
                  className={`h-3.5 w-3.5 transition-transform ${isOpen ? "rotate-90" : ""}`}
                  aria-hidden="true"
                />
              </button>
              {isOpen && (
                <div className="ml-3 mt-0.5 space-y-0.5 border-l border-slate-200 pl-3">
                  {group.items.map((item) => {
                    const active = isActive(pathname, item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        title={item.mock ? "Пока моковые данные, не Supabase" : undefined}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ${
                          active
                            ? "border-l-2 border-slate-900 -ml-[13px] bg-slate-50 pl-[15px] font-medium text-slate-900"
                            : "text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        <span className="flex-1">{item.label}</span>
                        {item.mock && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                            мок
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <CurrentUserFooter />
    </aside>
  );
}

// 22.07.2026 — показывает, кто вошёл (Telegram QR-логин, см.
// app/login/page.tsx), и кнопка выхода. Пока сессия ещё грузится (первый
// рендер) — просто ничего не показываем, не мигаем "неизвестно".
function CurrentUserFooter() {
  const { user, loading } = useCurrentUser();
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/login/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (loading || !user) return null;

  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3">
      <span className="truncate text-xs text-slate-600">{user.display_name}</span>
      <button
        onClick={handleLogout}
        title="Выйти"
        className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
