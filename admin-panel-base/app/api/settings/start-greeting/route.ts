// 19.08.2026 — несколько вариантов приветствия на голый /start (раньше был
// один жёсткий текст в orchestrator.py). Тот же приём, что и у
// /api/settings/renewal: app_settings.{"texts": [...]}, читается agent-bot
// напрямую из Supabase (logic/start_greeting.py) — правка доезжает до бота
// без деплоя.

import { NextResponse } from "next/server";
import { supabaseAdmin, hasSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUser } from "@/lib/session";

const TEXT_KEY = "start_greeting_texts";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "не авторизован" }, { status: 401 });
  if (!hasSupabaseAdmin()) return NextResponse.json({ error: "Supabase не настроен" }, { status: 503 });

  const { data } = await supabaseAdmin!
    .from("app_settings")
    .select("value")
    .eq("setting_key", TEXT_KEY)
    .maybeSingle();

  const value = data?.value as { text?: string; texts?: string[] } | undefined;
  // Поддерживаем оба формата: {texts: [...]} — новый, {text: "..."} — старый.
  const texts = Array.isArray(value?.texts) ? value!.texts! : value?.text ? [value.text] : [];

  return NextResponse.json({ texts });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "не авторизован" }, { status: 401 });
  if (!hasSupabaseAdmin()) return NextResponse.json({ error: "Supabase не настроен" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const texts = Array.isArray(body?.texts)
    ? (body.texts as unknown[]).filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];

  // В отличие от /api/settings/renewal, пустой список тут не пропускаем
  // молча — если сотрудник специально стёр все варианты и сохранил, лучше
  // явная ошибка, чем тихий откат на дефолт из кода без объяснения.
  if (texts.length === 0) {
    return NextResponse.json({ error: "нужен хотя бы один вариант приветствия" }, { status: 400 });
  }

  const { error } = await supabaseAdmin!.from("app_settings").upsert(
    [
      {
        setting_key: TEXT_KEY,
        value: { texts: texts.map((t) => t.trim()) } as never,
        updated_by: user.display_name,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: "setting_key" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
