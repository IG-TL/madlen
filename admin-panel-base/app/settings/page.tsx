import OrderDeadlineSetting from "@/components/OrderDeadlineSetting";
import ClaudeCredentialSettings from "@/components/ClaudeCredentialSettings";
import TestAccountReset from "@/components/TestAccountReset";
import CollapsibleSection from "@/components/CollapsibleSection";

// 20.08.2026 — раньше это была общая страница /settings на 6 блоков сразу
// (напоминания клиенту, дедлайн, приветствие, уведомления сотрудникам,
// ключ Claude, сброс теста), а пункт в сайдбаре при этом назывался
// «Уведомления» — Игорь: "раздел не соответствует наполнению, там не
// только уведомления". Разнесено на 3 страницы (см. Sidebar.tsx, группа
// «Настройки»):
// - /settings/notifications — уведомления сотрудникам (реально про
//   уведомления);
// - /settings/messages — тексты, которые уходят КЛИЕНТУ (приветствие на
//   /start + напоминания о продлении);
// - /settings (эта страница) — то, что осталось: технические настройки,
//   не привязанные ни к уведомлениям, ни к текстам для клиента.
export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Общие настройки</h1>
        <p className="mt-1 text-sm text-slate-600">
          Дедлайн приёма изменений заказа, ключ Claude для тестов и сброс тестового аккаунта.
        </p>
      </div>

      <CollapsibleSection title="Дедлайн приёма изменений">
        <OrderDeadlineSetting />
      </CollapsibleSection>

      {/* 21.08.2026 — Игорь: страница настроек стала слишком длинной, все
          блоки должны быть свёрнуты по умолчанию (раньше этот был исключением
          и разворачивался сразу — убрано, см. также app/settings/messages/page.tsx). */}
      <CollapsibleSection title="Ключ Claude (прямой API / прокси)">
        <ClaudeCredentialSettings />
      </CollapsibleSection>

      {/* 19.08.2026 — запрос Игоря: сброс тестового аккаунта сотрудника в
          Telegram, чтобы для теста бот встречал его как нового клиента.
          Внизу страницы намеренно — деструктивная операция, не должна быть
          первым, на что падает взгляд. */}
      <CollapsibleSection title="Сброс тестового аккаунта">
        <TestAccountReset />
      </CollapsibleSection>
    </div>
  );
}
