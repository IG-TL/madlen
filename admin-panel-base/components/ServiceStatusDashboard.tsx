"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  Sparkles,
  Database,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Clock,
  MessageSquareText,
} from "lucide-react";
import { hasSupabase } from "@/lib/supabaseClient";

// 21.07.2026 — "health, но красиво" (прямой запрос Игоря). Технически это
// просто визуализация того же /health agent-bot, что уже существовал (см.
// main.py), плюс собственный статус Supabase на стороне admin-panel (эти
// две стороны настраиваются раздельно — Vercel и Render — поэтому могут
// разойтись, полезно видеть обе).
//
// Fetch идёт через app/api/agent-health/route.ts (server-side прокси) —
// прямой fetch из браузера на *.onrender.com упёрся бы в CORS, у agent-bot
// нет соответствующих заголовков (см. комментарий в самом роуте).

type ServiceState = "ok" | "degraded" | "down" | "loading";

interface AgentHealth {
  ok: boolean;
  telegram: "real" | "mock";
  claude: "real" | "mock";
  supabase?: "real" | "mock"; // может отсутствовать, если Render ещё не подхватил обновлённый main.py
  admin_sync?: {
    prompt_synced_from_admin: boolean;
    facts_synced_from_admin: boolean;
    facts_count?: number;
  };
  claude_usage?: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    escalated_requests: number;
  };
  // 19.08.2026 — какой ключ реально используется сейчас: "direct"
  // (ANTHROPIC_API_KEY, официальный) / "proxy" (ANTHROPIC_AUTH_TOKEN,
  // aiprimetech.io) / null (клиент ещё не собран или claude_mock). См.
  // переключатель на /settings (ClaudeCredentialSettings) и
  // orchestrator.get_agent_credential_mode() на стороне agent-bot.
  claude_credential_mode?: "direct" | "proxy" | null;
}

const STATE_STYLE: Record<ServiceState, string> = {
  ok: "bg-emerald-50 border-emerald-200",
  degraded: "bg-amber-50 border-amber-200",
  down: "bg-red-50 border-red-200",
  loading: "bg-slate-50 border-slate-200",
};

const BADGE_STYLE: Record<ServiceState, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  degraded: "bg-amber-100 text-amber-700",
  down: "bg-red-100 text-red-700",
  loading: "bg-slate-100 text-slate-500",
};

function StateIcon({ state }: { state: ServiceState }) {
  const cls = "h-4 w-4";
  if (state === "ok") return <CheckCircle2 className={cls} aria-hidden="true" />;
  if (state === "degraded") return <AlertTriangle className={cls} aria-hidden="true" />;
  if (state === "down") return <XCircle className={cls} aria-hidden="true" />;
  return <Loader2 className={`${cls} animate-spin`} aria-hidden="true" />;
}

function ServiceCard({
  icon: Icon,
  title,
  state,
  badgeText,
  description,
}: {
  icon: typeof Bot;
  title: string;
  state: ServiceState;
  badgeText: string;
  description: string;
}) {
  return (
    <div className={`rounded-xl border p-4 ${STATE_STYLE[state]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-slate-700" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        </div>
        <span className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${BADGE_STYLE[state]}`}>
          <StateIcon state={state} />
          {badgeText}
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-600">{description}</p>
    </div>
  );
}

export default function ServiceStatusDashboard() {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [waking, setWaking] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const checkHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Бесплатный Render засыпает после 15 мин простоя — первый запрос
    // после паузы может занять ~50 сек, показываем это явно, а не молчим.
    const wakeTimer = setTimeout(() => setWaking(true), 3000);
    try {
      const res = await fetch("/api/agent-health", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`);
        setHealth(null);
      } else {
        setHealth(data);
      }
    } catch {
      setError("Не удалось проверить статус (сеть недоступна)");
      setHealth(null);
    } finally {
      clearTimeout(wakeTimer);
      setWaking(false);
      setLoading(false);
      setLastChecked(new Date());
    }
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  const adminSupabaseState: ServiceState = hasSupabase() ? "ok" : "degraded";
  const botReachableState: ServiceState = loading ? "loading" : health ? "ok" : "down";
  const telegramState: ServiceState = !health ? "loading" : health.telegram === "real" ? "ok" : "degraded";
  const claudeState: ServiceState = !health ? "loading" : health.claude === "real" ? "ok" : "degraded";
  const botSupabaseState: ServiceState =
    !health ? "loading" : health.supabase === "real" ? "ok" : health.supabase === "mock" ? "degraded" : "degraded";

  const usage = health?.claude_usage;
  const sync = health?.admin_sync;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Clock className="h-4 w-4" aria-hidden="true" />
          {lastChecked
            ? `Последняя проверка: ${lastChecked.toLocaleTimeString("ru-RU")}`
            : "Проверяю…"}
          {waking && (
            <span className="text-amber-600">
              — бот на бесплатном тарифе Render просыпается, это может занять ~50 сек
            </span>
          )}
        </div>
        <button
          onClick={checkHealth}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          Проверить снова
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-medium">Бот недоступен: {error}</p>
          <p className="mt-1 text-xs text-red-600">
            Если это бесплатный тариф Render и он давно не получал запросов — попробуйте
            «Проверить снова» ещё раз, первое пробуждение может занять около минуты.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <ServiceCard
          icon={Bot}
          title="Telegram-бот"
          state={botReachableState}
          badgeText={loading ? "проверяю…" : health ? "на связи" : "недоступен"}
          description={
            health
              ? health.telegram === "real"
                ? "Реальный Telegram Bot API — сообщения уходят настоящим клиентам."
                : "Работает на заглушке (мок) — реальный TELEGRAM_BOT_TOKEN не задан."
              : "Не удалось достучаться до сервиса на Render."
          }
        />

        <ServiceCard
          icon={Sparkles}
          title="Claude (агент)"
          state={claudeState}
          badgeText={
            !health
              ? "проверяю…"
              : health.claude !== "real"
                ? "заглушка"
                : health.claude_credential_mode === "direct"
                  ? "реальный · прямой ключ"
                  : health.claude_credential_mode === "proxy"
                    ? "реальный · прокси"
                    : "реальный"
          }
          description={
            usage
              ? `Запросов: ${usage.requests}, эскалировано агентом: ${usage.escalated_requests}, токенов вход/выход: ${usage.input_tokens}/${usage.output_tokens}.`
              : health?.claude === "real"
                ? "Реальный вызов Anthropic API."
                : "Отвечает заглушка claude_mock.py — реальный ключ (ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN) не задан."
          }
        />

        <ServiceCard
          icon={Database}
          title="Supabase — agent-bot"
          state={botSupabaseState}
          badgeText={!health ? "проверяю…" : health.supabase === "real" ? "подключён" : "мок"}
          description={
            !health
              ? "Проверяю подключение бота к базе…"
              : health.supabase === "real"
                ? "Render видит SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY — staff_users и эскалации пишутся в реальную БД."
                : health.supabase === "mock"
                  ? "Работает на in-memory моке — переменные Supabase ещё не заданы на Render, либо сервис не передеплоился."
                  : "Поле supabase отсутствует в ответе — на Render ещё старая версия кода (нужен git push + редеплой)."
          }
        />

        <ServiceCard
          icon={Database}
          title="Supabase — admin-panel"
          state={adminSupabaseState}
          badgeText={hasSupabase() ? "подключён" : "мок/localStorage"}
          description={
            hasSupabase()
              ? "Vercel видит NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY — данные читаются из реальной БД."
              : "NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY не заданы в Vercel — панель работает на моке/localStorage браузера."
          }
        />

        <ServiceCard
          icon={MessageSquareText}
          title="Синхронизация промпта/фактов"
          state={!health ? "loading" : sync?.prompt_synced_from_admin ? "ok" : "degraded"}
          badgeText={!health ? "проверяю…" : sync?.prompt_synced_from_admin ? "синхронизирован" : "дефолт из кода"}
          description={
            sync
              ? `Факты зелёной зоны: ${sync.facts_synced_from_admin ? "из админки" : "дефолтные"} (${sync.facts_count ?? "?"} шт).`
              : "Промпт/факты живут в памяти процесса agent-bot — теряются при каждом «засыпании»/редеплое Render, пока кто-то не пересохранит в /agent-prompt ещё раз."
          }
        />
      </div>
    </div>
  );
}
