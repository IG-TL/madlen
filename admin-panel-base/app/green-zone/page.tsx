import { redirect } from "next/navigation";

// 21.08.2026 — Игорь: красная и зелёная зона объединены в одну компактную
// страницу /red-zone (две вкладки, см. app/red-zone/page.tsx). Этот URL
// оставлен как редирект, чтобы старые ссылки/закладки на /green-zone не
// ломались.
export default function GreenZonePage() {
  redirect("/red-zone");
}
