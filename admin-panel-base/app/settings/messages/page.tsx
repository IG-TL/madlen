import StartGreetingSettings from "@/components/StartGreetingSettings";
import RenewalSettings from "@/components/RenewalSettings";
import CollapsibleSection from "@/components/CollapsibleSection";

// 20.08.2026 — вынесено из общей /settings (см. app/settings/page.tsx —
// история переноса): тексты, которые бот отправляет КЛИЕНТУ автоматически,
// а не технические настройки и не уведомления сотрудникам.
export default function SettingsMessagesPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Сообщения клиентам</h1>
        <p className="mt-1 text-sm text-slate-600">
          Тексты, которые бот отправляет клиенту сам — приветствие на /start и напоминания о продлении подписки.
        </p>
      </div>

      {/* 21.08.2026 — Игорь: все блоки настроек должны быть свёрнуты по
          умолчанию (раньше этот был исключением и разворачивался сразу). */}
      <CollapsibleSection title="Напоминания о продлении">
        <RenewalSettings />
      </CollapsibleSection>

      <CollapsibleSection title="Приветствие на /start">
        <StartGreetingSettings />
      </CollapsibleSection>
    </div>
  );
}
