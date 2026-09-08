import StaffNotifyManager from "@/components/StaffNotifyManager";

// 20.08.2026 — вынесено из общей /settings (см. app/settings/page.tsx —
// история переноса) в отдельную страницу: единственный блок, который
// реально про уведомления (кто из сотрудников получает пуш об эскалации).
export default function SettingsNotificationsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Уведомления</h1>
        <p className="mt-1 text-sm text-slate-600">Кто из сотрудников получает уведомления об эскалациях.</p>
      </div>
      <StaffNotifyManager />
    </div>
  );
}
