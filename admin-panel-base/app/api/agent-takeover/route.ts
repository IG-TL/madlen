// 17.08.2026 — server-side прокси для "Взять диалог на себя" / "Вернуть
// боту" (DialogThread.tsx, миграция 23 — dialogs.human_takeover).
//
// Тот же принцип, что и app/api/agent-reply/route.ts: секрет
// (AGENT_BOT_SYNC_TOKEN / ADMIN_SYNC_TOKEN на стороне agent-bot) не должен
// попасть в браузер — Route Handler выполняется на сервере Vercel.
// Переиспользуем ТОТ ЖЕ секрет, что и остальные /admin/* эндпоинты
// agent-bot — заводить отдельный токен под ещё одну ручку избыточно.

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const botUrl = process.env.AGENT_BOT_URL;
  const token = process.env.AGENT_BOT_SYNC_TOKEN;

  if (!botUrl || !token) {
    return NextResponse.json(
      {
        error:
          "AGENT_BOT_URL / AGENT_BOT_SYNC_TOKEN не настроены на сервере (Vercel → Settings → Environment Variables)",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Некорректное тело запроса" }, { status: 400 });
  }

  try {
    const res = await fetch(`${botUrl.replace(/\/$/, "")}/admin/set-human-takeover`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": token,
      },
      body: JSON.stringify(body),
      // На бесплатном Render первый запрос после "сна" может занять ~50 сек.
      signal: AbortSignal.timeout(60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: (data as { detail?: string }).detail || `Бот ответил ошибкой (${res.status})` },
        { status: res.status },
      );
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Не удалось связаться с ботом (сеть, таймаут или бот ещё просыпается)" },
      { status: 502 },
    );
  }
}
