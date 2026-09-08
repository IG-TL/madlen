// 19.08.2026 — переключатель "прямой ANTHROPIC_API_KEY vs прокси
// ANTHROPIC_AUTH_TOKEN" (aiprimetech.io) для agent-bot. Игорь: "для тестов
// нужно быстро переключаться" — не редеплоить/не трогать Environment на
// Render каждый раз, а щёлкнуть тумблер в админке. Тот же приём, что и у
// /api/settings/start-greeting: app_settings.{"mode": "direct"|"proxy"},
// agent-bot читает его напрямую из Supabase (integrations/claude_real.py,
// _resolve_credential_mode) с коротким TTL-кэшем (15 сек — быстрее, чем у
// остальных настроек, это ручной тумблер для тестирования, а не боевая
// настройка).
//
// ВАЖНО: сам ключ (ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN) этот переключатель
// не хранит и не передаёт — он только выбирает, какой из ДВУХ уже
// прописанных на Render ключей использовать. Если на инстансе задан только
// один из них — agent-bot тихо откатится на доступный (см. фолбэк в
// _get_client()), а не упадёт.

import { NextResponse } from "next/server";
import { supabaseAdmin, hasSupabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUser } from "@/lib/session";

const SETTING_KEY = "claude_credential_mode";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "не авторизован" }, { status: 401 });
  if (!hasSupabaseAdmin()) return NextResponse.json({ error: "Supabase не настроен" }, { status: 503 });

  const { data } = await supabaseAdmin!
    .from("app_settings")
    .select("value")
    .eq("setting_key", SETTING_KEY)
    .maybeSingle();

  const value = data?.value as { mode?: string } | undefined;
  const mode = value?.mode === "direct" || value?.mode === "proxy" ? value.mode : null;

  return NextResponse.json({ mode });
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "не авторизован" }, { status: 401 });
  if (!hasSupabaseAdmin()) return NextResponse.json({ error: "Supabase не настроен" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const mode = body?.mode;
  if (mode !== "direct" && mode !== "proxy") {
    return NextResponse.json({ error: "mode должен быть 'direct' или 'proxy'" }, { status: 400 });
  }

  const { error } = await supabaseAdmin!.from("app_settings").upsert(
    [
      {
        setting_key: SETTING_KEY,
        value: { mode } as never,
        updated_by: user.display_name,
        updated_at: new Date().toISOString(),
      },
    ],
    { onConflict: "setting_key" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
