import EscalationList from "@/components/EscalationList";

export default function EscalationsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Эскалации</h1>
        <p className="mt-1 text-sm text-slate-600">
          Сообщения, которые бот передал человеку. Строка ведёт в чат с
          клиентом — там же можно ответить и сразу завершить эскалацию
          (кнопка «Завершить эскалацию» в баннере над перепиской).
        </p>
      </div>
      <EscalationList />
    </div>
  );
}
