// Слой доступа к данным. СЕЙЧАС читает/пишет в моковый массив в памяти
// (см. mockData.ts) — нет живого Supabase-инстанса (ждём доступ, см.
// CLAUDE.md). Каждая функция ниже помечена TODO с точным Supabase-вызовом,
// которым её нужно заменить, когда инстанс появится. Компоненты вызывают
// ТОЛЬКО функции этого файла, не mockData напрямую — замена мока на
// реальный клиент не потребует правок в app/*.

import {
  ModuleConfig,
  PipelineGate,
  GateStatus,
  Client,
  ClientStatus,
  ClientRestriction,
  ClientPreference,
  FavoriteDish,
  SubscriptionSummary,
  RestrictionKind,
  DishStatsRow,
  AgentDialog,
  DialogMessage,
  RedZoneTermEntry,
  RedZoneCategory,
  RedZoneLanguage,
  GreenZoneFact,
  GreenZoneCategory,
  GreenZoneCategoryRow,
  StaffUser,
  StaffRole,
  SubscriptionPlan,
  Escalation,
  EscalationStatus,
  AuditEntityType,
  AuditAction,
  AuditLogEntry,
  PreferenceKind,
  AppSetting,
  ORDER_DEADLINE_SETTING_KEY,
  AGENT_SYSTEM_PROMPT_SETTING_KEY,
  SHEETS_AUTO_IMPORT_TIME_SETTING_KEY,
  SheetImportSummary,
  ClientsSnapshotSummary,
  OrderChangeRequest,
  SubscriptionRequest,
  QaFinding,
  QaFindingStatus,
  SubscriptionDraftRation,
} from "./types";
import {
  MOCK_MODULES,
  MOCK_GATES,
  MOCK_CLIENTS,
  MOCK_RESTRICTIONS,
  MOCK_PREFERENCES,
  MOCK_FAVORITE_DISHES,
  MOCK_DISH_STATS,
  MOCK_SUBSCRIPTIONS,
  MOCK_DIALOGS,
  MOCK_RED_ZONE_TERMS,
  MOCK_GREEN_ZONE_FACTS,
  MOCK_GREEN_ZONE_CATEGORIES,
  MOCK_STAFF_USERS,
  MOCK_ESCALATIONS,
  MOCK_AUDIT_LOG,
  MOCK_APP_SETTINGS,
} from "./mockData";
import { saveMock } from "./mockStore";
import { supabase, hasSupabase } from "./supabaseClient";

// --- История изменений / аудит-лог (19.07.2026) -----------------------------
// "Нужна история изменений. Достаточно кто, когда, что изменил (до/после)".
// Вызывается из мест, где правки потенциально небезопасны/необратимы —
// см. точки вызова ниже (addRedZoneTerm/deactivateRedZoneTerm,
// addRestriction/deactivateRestriction, setReceivesEscalations,
// setCanApproveAfterDeadline).
//
// 21.07.2026: подключён реальный Supabase (минимальный срез, см.
// supabase_minimal_schema.sql) — если переменные окружения не заданы,
// используется старый мок/localStorage (см. lib/supabaseClient.ts).
// client_restrictions/clients — по-прежнему НЕ мигрированы (вне среза),
// поэтому запись аудит-лога по ним всё ещё пишет только в мок ниже
// (реальная таблица audit_log это не блокирует — просто у неё будет
// смешанный источник записей, пока клиенты не переедут тоже).

export async function logAuditEntry(
  entry: Omit<AuditLogEntry, "entry_id" | "changed_at">,
): Promise<void> {
  if (hasSupabase()) {
    const { error } = await supabase!.from("audit_log").insert(entry);
    if (!error) return;
    // Сбой записи в Supabase не должен ронять само действие (термин уже
    // добавлен/факт уже сохранён) — падаем на мок как fallback, не бросаем.
  }
  MOCK_AUDIT_LOG.unshift({
    ...entry,
    entry_id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    changed_at: new Date().toISOString(),
  });
  saveMock("audit_log", MOCK_AUDIT_LOG);
}

export async function getAuditLog(filter?: {
  entityType?: AuditEntityType;
  entityId?: string;
  clientId?: string;
}): Promise<AuditLogEntry[]> {
  if (hasSupabase()) {
    let q = supabase!.from("audit_log").select("*").order("changed_at", { ascending: false });
    if (filter?.entityType) q = q.eq("entity_type", filter.entityType);
    if (filter?.entityId) q = q.eq("entity_id", filter.entityId);
    if (filter?.clientId) q = q.eq("client_id", filter.clientId);
    const { data, error } = await q;
    if (!error && data) return data as AuditLogEntry[];
  }
  let rows = [...MOCK_AUDIT_LOG].sort((a, b) => b.changed_at.localeCompare(a.changed_at));
  if (filter?.entityType) rows = rows.filter((r) => r.entity_type === filter.entityType);
  if (filter?.entityId) rows = rows.filter((r) => r.entity_id === filter.entityId);
  if (filter?.clientId) rows = rows.filter((r) => r.client_id === filter.clientId);
  return rows;
}

// --- Настройки приложения (19.07.2026) ---------------------------------------
// Запрос: "это время [дедлайн приёма изменений заказа] должно
// устанавливаться в админке" — раньше 18:00 было захардкожено прямо в
// GateQueue.tsx. ВАЖНО: само время по-прежнему не подтверждено Франсуа
// (см. CLAUDE.md) — это просто перенос дефолта из кода в настройку, чтобы
// его можно было поменять без разработчика, когда Франсуа ответит.

export async function getOrderDeadlineTime(): Promise<string> {
  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("app_settings")
      .select("value")
      .eq("setting_key", ORDER_DEADLINE_SETTING_KEY)
      .maybeSingle();
    if (!error && data) {
      const time = (data.value as Record<string, unknown> | null)?.time;
      if (typeof time === "string") return time;
    }
  }
  const row = MOCK_APP_SETTINGS.find((s) => s.setting_key === ORDER_DEADLINE_SETTING_KEY);
  const time = row?.value?.time;
  return typeof time === "string" ? time : "18:00";
}

export async function setOrderDeadlineTime(time: string, changedBy: string): Promise<void> {
  const beforeTime = await getOrderDeadlineTime();

  if (hasSupabase()) {
    // 22.07.2026: upsert, не update() — если строка ещё не существует в
    // свежем Supabase-проекте (нет сид-инсерта для app_settings в SQL, см.
    // supabase_minimal_schema.sql), update().eq() молча ничего не делает
    // (0 строк затронуто, но без ошибки) — настройка "сохранялась" бы
    // только в мок, а в реальную таблицу не долетала бы никогда. Найдено
    // при добавлении sheets_auto_import_time_ict (новый ключ без сида) —
    // заодно поправлено и здесь, тот же класс бага.
    const { error } = await supabase!
      .from("app_settings")
      .upsert(
        { setting_key: ORDER_DEADLINE_SETTING_KEY, value: { time }, updated_by: changedBy, updated_at: new Date().toISOString() },
        { onConflict: "setting_key" },
      );
    if (!error) {
      logAuditEntry({
        entity_type: "app_setting",
        entity_id: ORDER_DEADLINE_SETTING_KEY,
        entity_label: "Дедлайн приёма изменений заказа",
        client_id: null,
        action: "updated",
        before: beforeTime,
        after: time,
        changed_by: changedBy,
      }).catch(() => {});
      return;
    }
  }

  const idx = MOCK_APP_SETTINGS.findIndex((s) => s.setting_key === ORDER_DEADLINE_SETTING_KEY);
  if (idx === -1) return;
  const before = MOCK_APP_SETTINGS[idx];
  MOCK_APP_SETTINGS[idx] = {
    ...before,
    value: { time },
    updated_by: changedBy,
    updated_at: new Date().toISOString(),
  };
  saveMock("app_settings", MOCK_APP_SETTINGS);
  logAuditEntry({
    entity_type: "app_setting",
    entity_id: ORDER_DEADLINE_SETTING_KEY,
    entity_label: "Дедлайн приёма изменений заказа",
    client_id: null,
    action: "updated",
    before: beforeTime,
    after: time,
    changed_by: changedBy,
  }).catch(() => {});
}

// --- Автовыгрузка Google Sheets (22.07.2026) --------------------------------
// "Кнопка и время авто выгрузки должны быть редактировать в админке" — тот
// же паттерн app_settings, что и дедлайн заказа. Само время читает и
// agent-bot (см. logic/sheets_import.py, maybe_run_auto_import) — оно
// решает, когда автоматически забрать снимок Google Sheet, дёргается по
// внешнему cron-триггеру. ВАЖНО: 22:00 — рабочий дефолт-плейсхолдер,
// Игорь как раз уточняет у Франсуа фиксированное время (см. CLAUDE.md).

export async function getSheetsAutoImportTime(): Promise<string> {
  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("app_settings")
      .select("value")
      .eq("setting_key", SHEETS_AUTO_IMPORT_TIME_SETTING_KEY)
      .maybeSingle();
    if (!error && data) {
      const time = (data.value as Record<string, unknown> | null)?.time;
      if (typeof time === "string") return time;
    }
  }
  const row = MOCK_APP_SETTINGS.find((s) => s.setting_key === SHEETS_AUTO_IMPORT_TIME_SETTING_KEY);
  const time = row?.value?.time;
  return typeof time === "string" ? time : "22:00";
}

export async function setSheetsAutoImportTime(time: string, changedBy: string): Promise<void> {
  const beforeTime = await getSheetsAutoImportTime();

  if (hasSupabase()) {
    const { error } = await supabase!
      .from("app_settings")
      .upsert(
        { setting_key: SHEETS_AUTO_IMPORT_TIME_SETTING_KEY, value: { time }, updated_by: changedBy, updated_at: new Date().toISOString() },
        { onConflict: "setting_key" },
      );
    if (!error) {
      logAuditEntry({
        entity_type: "app_setting",
        entity_id: SHEETS_AUTO_IMPORT_TIME_SETTING_KEY,
        entity_label: "Время автовыгрузки Google Sheets",
        client_id: null,
        action: "updated",
        before: beforeTime,
        after: time,
        changed_by: changedBy,
      }).catch(() => {});
      return;
    }
  }

  const idx = MOCK_APP_SETTINGS.findIndex((s) => s.setting_key === SHEETS_AUTO_IMPORT_TIME_SETTING_KEY);
  if (idx === -1) return;
  const before = MOCK_APP_SETTINGS[idx];
  MOCK_APP_SETTINGS[idx] = {
    ...before,
    value: { time },
    updated_by: changedBy,
    updated_at: new Date().toISOString(),
  };
  saveMock("app_settings", MOCK_APP_SETTINGS);
  logAuditEntry({
    entity_type: "app_setting",
    entity_id: SHEETS_AUTO_IMPORT_TIME_SETTING_KEY,
    entity_label: "Время автовыгрузки Google Sheets",
    client_id: null,
    action: "updated",
    before: beforeTime,
    after: time,
    changed_by: changedBy,
  }).catch(() => {});
}

// Последний снимок импорта (для отображения в UI — "когда последний раз
// импортировали, сколько строк"). Без реального Supabase показать нечего —
// это не мок-данные, а буквально состояние живого импорта, придумывать
// фейковый снимок в mockData.ts смысла нет.
export async function getLastSheetImport(): Promise<SheetImportSummary | null> {
  if (!hasSupabase()) return null;
  const { data, error } = await supabase!
    .from("sheet_import_log")
    .select("sheet_date, source_tab, row_count, imported_by, imported_at")
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as SheetImportSummary;
}

// Ручная кнопка "Импортировать сейчас" — идёт через server-side прокси
// (app/api/agent-import-sheet/route.ts), тот же принцип, что и syncAgentBot/
// sendMessageToClient: секрет остаётся на сервере Vercel, не в браузере.
// agent-bot сам читает Google Sheet и пишет sheet_import_log — здесь только
// вызов и человекочитаемый результат.
// --- Tool use агента: перенос даты доставки (25.07.2026) --------------------
// order_change_requests закрыт RLS (deny-all, та же чувствительность, что
// clients — есть client_chat_id), поэтому в отличие от sheet_import_log
// выше читаем НЕ напрямую через анонимный supabase-клиент, а через
// server-side роут /api/order-changes (service-role, см. lib/supabaseAdmin.ts).

export async function getOrderChangeRequests(): Promise<OrderChangeRequest[]> {
  try {
    const res = await fetch("/api/order-changes");
    if (res.ok) {
      const { rows } = (await res.json()) as { rows: OrderChangeRequest[] };
      return rows;
    }
  } catch {
    // ignore — нет мокового фолбэка (это живое состояние, не бизнес-данные
    // с примерами, тот же принцип, что и у sheet_import_log/snapshot).
  }
  return [];
}

// Одобрить/отклонить — сначала PATCH статуса (это чистый CRUD, делает сама
// admin-panel через свой service-role ключ), и ТОЛЬКО если approved — сразу
// же вызывает agent-bot (через прокси /api/agent-apply-order-change), чтобы
// он реально оставил заметку в Google Sheet и пометил applied. Если прокси
// недоступен (бот спит и т.п.) — статус всё равно уже approved в БД, просто
// применение можно будет попробовать снова позже (кнопка "Применить ещё раз").
export async function decideOrderChangeRequest(
  requestId: string,
  status: "approved" | "rejected",
  changedBy: string,
): Promise<{ ok: boolean; message: string; after?: OrderChangeRequest }> {
  let after: OrderChangeRequest | undefined;
  try {
    const res = await fetch(`/api/order-changes/${requestId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: body.error || `Не удалось сохранить (${res.status})` };
    }
    const { before, after: afterRow } = body as { before: OrderChangeRequest; after: OrderChangeRequest };
    after = afterRow;
    logAuditEntry({
      entity_type: "order_change_request",
      entity_id: requestId,
      entity_label: `${after.client_display_name} → ${after.new_date}`,
      client_id: null,
      action: "updated",
      before: before.status,
      after: after.status,
      changed_by: changedBy,
    }).catch(() => {});
  } catch {
    return { ok: false, message: "Не удалось сохранить статус (сеть)" };
  }

  if (status !== "approved") {
    return { ok: true, message: "Отклонено." };
  }
  return applyOrderChangeRequest(requestId, after);
}

// Отдельная функция (не только часть decideOrderChangeRequest) — нужна и
// для кнопки "Применить ещё раз", если первая попытка не удалась (бот спал).
export async function applyOrderChangeRequest(
  requestId: string,
  afterHint?: OrderChangeRequest,
): Promise<{ ok: boolean; message: string; after?: OrderChangeRequest }> {
  try {
    const res = await fetch("/api/agent-apply-order-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      applied?: boolean;
      sheet_note_written?: boolean;
      reason?: string | null;
    };
    if (!res.ok) {
      return {
        ok: false,
        message: `Одобрено, но применить пока не удалось: ${body.error || res.status} — попробуйте ещё раз позже`,
        after: afterHint,
      };
    }
    if (body.sheet_note_written) {
      return { ok: true, message: "Одобрено и применено — заметка оставлена в таблице.", after: afterHint };
    }
    return {
      ok: true,
      message: `Одобрено, статус применён, но заметку в таблицу оставить не удалось: ${body.reason || "неизвестная причина"}`,
      after: afterHint,
    };
  } catch {
    return {
      ok: false,
      message: "Одобрено, но бот недоступен (возможно, «спит» — попробуйте применить ещё раз через минуту).",
      after: afterHint,
    };
  }
}

// --- Tool use агента: оформление подписки (25.07.2026) ----------------------
// Тот же паттерн, что и order_change_requests выше — RLS deny-all, читаем
// через server-side роут /api/subscription-requests (service-role).

export async function getSubscriptionRequests(): Promise<SubscriptionRequest[]> {
  try {
    const res = await fetch("/api/subscription-requests");
    if (res.ok) {
      const { rows } = (await res.json()) as { rows: SubscriptionRequest[] };
      return rows;
    }
  } catch {
    // ignore — нет мокового фолбэка, живое состояние.
  }
  return [];
}

export async function decideSubscriptionRequest(
  requestId: string,
  status: "approved" | "rejected",
  changedBy: string,
  // 25.07.2026 — обязателен, если status==="approved" (см. PATCH-роут):
  // "Одобрить с оплатой"/"Одобрить без оплаты" — две отдельные кнопки в
  // SubscriptionRequestsManager.tsx вместо одной.
  paymentStatus?: "paid" | "unpaid",
): Promise<{ ok: boolean; message: string; after?: SubscriptionRequest }> {
  let after: SubscriptionRequest | undefined;
  try {
    const res = await fetch(`/api/subscription-requests/${requestId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, payment_status: paymentStatus }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: body.error || `Не удалось сохранить (${res.status})` };
    }
    const { before, after: afterRow } = body as { before: SubscriptionRequest; after: SubscriptionRequest };
    after = afterRow;
    logAuditEntry({
      entity_type: "subscription_request",
      entity_id: requestId,
      entity_label: `${after.client_display_name} → ${after.kcal_target} ккал / ${after.paid_days} дн.`,
      client_id: null,
      action: "updated",
      before: before.status,
      after: after.payment_status ? `${after.status} (${after.payment_status === "paid" ? "оплачено" : "без оплаты"})` : after.status,
      changed_by: changedBy,
    }).catch(() => {});
  } catch {
    return { ok: false, message: "Не удалось сохранить статус (сеть)" };
  }

  if (status !== "approved") {
    return { ok: true, message: "Отклонено." };
  }
  return applySubscriptionRequest(requestId, after);
}

// Отдельная функция (не только часть decideSubscriptionRequest) — нужна и
// для кнопки "Применить ещё раз". В ОТЛИЧИЕ от applyOrderChangeRequest выше:
// там БД всегда переходит в applied (заметка в Sheet — необязательный
// бонус), здесь реальное создание строки subscriptions — это и есть
// основное действие (см. logic/subscription_apply.py), поэтому body.applied
// === false означает НЕ успех, а "ещё не применилось" — возвращаем ok:false,
// чтобы UI не показал ложное "готово".
export async function applySubscriptionRequest(
  requestId: string,
  afterHint?: SubscriptionRequest,
): Promise<{ ok: boolean; message: string; after?: SubscriptionRequest }> {
  try {
    const res = await fetch("/api/agent-apply-subscription-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      applied?: boolean;
      subscription_id?: string | null;
      reason?: string | null;
    };
    if (!res.ok) {
      return {
        ok: false,
        message: `Одобрено, но применить пока не удалось: ${body.error || res.status} — попробуйте ещё раз позже`,
        after: afterHint,
      };
    }
    if (body.applied) {
      return { ok: true, message: "Одобрено, подписка создана.", after: afterHint };
    }
    return {
      ok: false,
      message: `Одобрено, но подписка ещё не создана: ${body.reason || "неизвестная причина"} — попробуйте ещё раз позже`,
      after: afterHint,
    };
  } catch {
    return {
      ok: false,
      message: "Одобрено, но бот недоступен (возможно, «спит» — попробуйте применить ещё раз через минуту).",
      after: afterHint,
    };
  }
}

// --- QA-сканер (26.08.2026) --------------------------------------------------
// Игорь: "раз в шесть часов проверяй новые диалоги/сообщения на баги...
// создаёшь в админке страницу с описанием, что случилось, и шлёшь в Телегу
// админов". См. QaFindingsList.tsx/app/qa-findings/page.tsx, agent-bot
// logic/qa_scanner.py, supabase_migration_26_qa_findings.sql. Прямое чтение/
// правка через anon-клиента — тот же принцип, что и getEscalations/
// completeEscalation (RLS на qa_findings отключён, тот же минимальный срез).

export async function getQaFindings(statusFilter?: QaFindingStatus): Promise<QaFinding[]> {
  if (!hasSupabase()) return [];
  let query = supabase!.from("qa_findings").select("*").order("created_at", { ascending: false });
  if (statusFilter) query = query.eq("status", statusFilter);
  const { data, error } = await query;
  if (error || !data) return [];
  return data as QaFinding[];
}

export async function resolveQaFinding(
  id: string,
  status: "resolved" | "dismissed",
  resolvedBy: string,
): Promise<{ ok: boolean; message: string }> {
  if (!hasSupabase()) return { ok: false, message: "Supabase не настроен" };
  const { error } = await supabase!
    .from("qa_findings")
    .update({ status, resolved_by: resolvedBy, resolved_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: status === "resolved" ? "Отмечено как исправлено." : "Находка отклонена." };
}

// 26.08.2026 — ручная кнопка "Проверить сейчас" (в обход интервала в 6
// часов, см. qa_scanner.SCAN_INTERVAL_HOURS) — тот же принцип server-side
// прокси, что и sendMessageToClient/setHumanTakeover (секрет
// ADMIN_SYNC_TOKEN остаётся на Vercel, см. app/api/agent-qa-scan/route.ts).
//
// 26.08.2026 (тем же вечером) — bэкенд (agent-bot/main.py::admin_qa_scan)
// переписан на fire-and-forget через FastAPI BackgroundTasks: выяснилось,
// что cron-job.org на бесплатном тарифе жёстко ограничивает таймаут 30
// секундами, а сам скан на 5-30 диалогах может идти дольше — так что
// эндпоинт теперь отвечает {ok, scheduled: true} сразу, НЕ дожидаясь
// окончания скана, и dialogs_reviewed/findings_created в ответе больше
// нет (они появятся только в самой таблице qa_findings, когда скан
// реально закончится — список подхватит их сам, через Realtime, см.
// QaFindingsList.tsx). Сообщение теперь просто подтверждает запуск.
export async function runQaScanNow(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/agent-qa-scan", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      scheduled?: boolean;
      error?: string;
    };
    if (!res.ok || !body.ok) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return {
      ok: true,
      message: "Проверка запущена — займёт до нескольких минут, новые находки появятся здесь автоматически.",
    };
  } catch {
    return {
      ok: false,
      message: "Не удалось достучаться до бота (возможно, «спит» — попробуйте ещё раз через минуту)",
    };
  }
}

// --- Заявка на подписку из диалога вручную (26.08.2026) ---------------------
// Игорь: "Ольга должна иметь возможность нажать на кнопку, увидеть в
// отдельном окне информацию по заказу... и создать". Оба вызова — прокси на
// agent-bot (см. CreateSubscriptionModal.tsx, app/api/agent-extract-
// subscription-draft/route.ts, app/api/agent-create-subscription-from-
// dialog/route.ts).

export async function extractSubscriptionDraft(
  dialogId: string,
): Promise<{ ok: boolean; draft: SubscriptionDraftRation | null; reason?: string }> {
  try {
    const res = await fetch("/api/agent-extract-subscription-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dialog_id: dialogId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      draft?: SubscriptionDraftRation | null;
      reason?: string;
      error?: string;
    };
    if (!res.ok || !body.ok) {
      return { ok: false, draft: null, reason: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return { ok: true, draft: body.draft ?? null, reason: body.reason };
  } catch {
    return {
      ok: false,
      draft: null,
      reason: "Не удалось достучаться до бота (возможно, «спит» — заполните форму вручную)",
    };
  }
}

export async function createSubscriptionFromDialog(
  dialogId: string,
  staffName: string,
  paymentStatus: "paid" | "unpaid",
  rations: SubscriptionDraftRation[],
): Promise<{ ok: boolean; message: string; createdCount?: number }> {
  try {
    const res = await fetch("/api/agent-create-subscription-from-dialog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dialog_id: dialogId, staff_name: staffName, payment_status: paymentStatus, rations }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      created?: { request_id: string; applied: boolean; reason?: string | null }[];
      error?: string;
    };
    if (!res.ok || !body.ok) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    const created = body.created ?? [];
    const appliedCount = created.filter((c) => c.applied).length;
    logAuditEntry({
      entity_type: "subscription_request",
      entity_id: dialogId,
      entity_label: `Заведено вручную из диалога (${created.length} рацион(а/ов))`,
      client_id: null,
      action: "created",
      before: null,
      after: `создано ${created.length}, применено ${appliedCount}`,
      changed_by: staffName,
    }).catch(() => {});
    if (appliedCount === created.length) {
      return { ok: true, message: `Создано и оформлено: ${created.length}.`, createdCount: created.length };
    }
    return {
      ok: true,
      message: `Создано ${created.length}, но применилось не всё (${appliedCount}/${created.length}) — остальное появится в очереди заявок с кнопкой «Применить ещё раз».`,
      createdCount: created.length,
    };
  } catch {
    return {
      ok: false,
      message: "Не удалось достучаться до бота (возможно, «спит» — попробуйте ещё раз через минуту)",
    };
  }
}

// 25.07.2026 — кнопка "Создать вкладки сейчас": поддерживает скользящее
// окно из 7 пустых дневных вкладок-шаблонов в Sheet-песочнице (см.
// agent-bot/logic/sheet_templates.py). Отдельная функция от
// triggerSheetsImport — тот читает ИЗ Sheet в нашу БД, эта пишет пустые
// вкладки В Sheet, разные направления и разный секрет-эндпоинт на agent-bot.
export async function triggerEnsureSheetTemplates(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/agent-ensure-sheet-templates", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      created?: string[];
      already_existed?: string[];
      failed?: string[];
      target_dates?: string[];
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    const created = body.created ?? [];
    const already = body.already_existed ?? [];
    return {
      ok: true,
      message:
        created.length > 0
          ? `Созданы вкладки: ${created.join(", ")} (уже были: ${already.length})`
          : `Всё уже создано (${already.length} вкладок на ближайшие 7 дней)`,
    };
  } catch {
    return {
      ok: false,
      message:
        "Не удалось достучаться до бота (возможно, «спит» на бесплатном тарифе Render — попробуйте ещё раз через минуту)",
    };
  }
}

export async function triggerSheetsImport(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/agent-import-sheet", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      sheet_date?: string;
      row_count?: number;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return {
      ok: true,
      message: `Импортировано: дата ${body.sheet_date}, строк ${body.row_count}`,
    };
  } catch {
    return {
      ok: false,
      message:
        "Не удалось достучаться до бота (возможно, «спит» на бесплатном тарифе Render — попробуйте ещё раз через минуту)",
    };
  }
}

// 22.07.2026: сырой снимок вкладки "1. Клиенты" — тот же принцип, что и
// заказы, но append-only (нет естественного ключа даты у ростера
// клиентов) и без авто-расписания (не запрашивалось, пока только кнопка).
export async function getLastClientsSnapshot(): Promise<ClientsSnapshotSummary | null> {
  if (!hasSupabase()) return null;
  const { data, error } = await supabase!
    .from("sheet_clients_snapshot_log")
    .select("source_tab, row_count, imported_by, imported_at")
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as ClientsSnapshotSummary;
}

// 22.07.2026 — экран "Логи/синхронизация": история импортов, не только
// последний снимок ("зашёл и увидел, что джобы реально сработали").
// sheet_import_log/sheet_clients_snapshot_log — не PII, anon-доступ не
// закрыт (см. supabase_migration_8_auth_infra.sql), обычный клиент подходит.

export async function getSheetImportHistory(limit: number = 20): Promise<SheetImportSummary[]> {
  if (!hasSupabase()) return [];
  const { data, error } = await supabase!
    .from("sheet_import_log")
    .select("sheet_date, source_tab, row_count, imported_by, imported_at")
    .order("imported_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as SheetImportSummary[];
}

export async function getClientsSnapshotHistory(limit: number = 20): Promise<ClientsSnapshotSummary[]> {
  if (!hasSupabase()) return [];
  const { data, error } = await supabase!
    .from("sheet_clients_snapshot_log")
    .select("source_tab, row_count, imported_by, imported_at")
    .order("imported_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data as ClientsSnapshotSummary[];
}

// Последняя дата, когда РЕАЛЬНО сработала автовыгрузка по расписанию (см.
// agent-bot/logic/sheets_import.py, maybe_run_auto_import — пишет сюда
// после успешного запуска). Null означает "ни разу" — полезный сигнал,
// что внешний cron (cron-job.org и т.п.) либо не настроен, либо ещё не
// достучался ни разу.
export async function getSheetsLastAutoImportDate(): Promise<string | null> {
  if (!hasSupabase()) return null;
  const { data, error } = await supabase!
    .from("app_settings")
    .select("value")
    .eq("setting_key", "sheets_last_auto_import_date")
    .maybeSingle();
  if (error || !data) return null;
  const value = (data as { value: { date?: string } }).value;
  return value?.date ?? null;
}

export async function triggerClientsSheetImport(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/agent-import-clients-sheet", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      row_count?: number;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return { ok: true, message: `Импортировано строк: ${body.row_count}` };
  } catch {
    return {
      ok: false,
      message:
        "Не удалось достучаться до бота (возможно, «спит» на бесплатном тарифе Render — попробуйте ещё раз через минуту)",
    };
  }
}

// 22.07.2026 — второй шаг после снимка: разобрать последний сохранённый
// снимок вкладки "1. Клиенты" в реальные clients/client_pii/
// client_restrictions/client_preferences (см. agent-bot/logic/
// clients_parse.py + clients_import.py). Идемпотентно — можно нажимать
// повторно после каждого нового снимка, не плодит дубли.
export async function triggerClientsParse(): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/agent-parse-clients-sheet", { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      created?: number;
      updated?: number;
      total_parsed?: number;
    };
    if (!res.ok || body.ok === false) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return {
      ok: true,
      message: `Разобрано: ${body.total_parsed}, новых: ${body.created}, обновлено: ${body.updated}`,
    };
  } catch {
    return {
      ok: false,
      message:
        "Не удалось достучаться до бота (возможно, «спит» на бесплатном тарифе Render — попробуйте ещё раз через минуту)",
    };
  }
}

// --- Модули ---------------------------------------------------------------

export async function getModules(): Promise<ModuleConfig[]> {
  // TODO(supabase): const { data } = await supabase.from('module_registry').select('*').order('stage');
  return MOCK_MODULES;
}

export async function updateModule(
  moduleKey: string,
  patch: Partial<Pick<ModuleConfig, "enabled" | "mode" | "fallback_on_disable">>,
  updatedBy: string,
): Promise<ModuleConfig | null> {
  // TODO(supabase): await supabase.from('module_registry').update({...patch, updated_by: updatedBy, updated_at: new Date().toISOString()}).eq('module_key', moduleKey);
  const idx = MOCK_MODULES.findIndex((m) => m.module_key === moduleKey);
  if (idx === -1) return null;
  MOCK_MODULES[idx] = {
    ...MOCK_MODULES[idx],
    ...patch,
    updated_by: updatedBy,
    updated_at: new Date().toISOString(),
  };
  saveMock("modules", MOCK_MODULES);
  return MOCK_MODULES[idx];
}

// --- Гейты (очередь ручных апрувов) ----------------------------------------

export async function getGates(status?: GateStatus): Promise<PipelineGate[]> {
  // TODO(supabase): let q = supabase.from('pipeline_gates').select('*').order('created_at', {ascending:false});
  // TODO(supabase): if (status) q = q.eq('status', status);
  const all = MOCK_GATES;
  return status ? all.filter((g) => g.status === status) : all;
}

export async function resolveGate(
  gateId: string,
  decision: Exclude<GateStatus, "pending">,
  resolvedBy: string,
  resolutionPayload?: Record<string, unknown>,
): Promise<PipelineGate | null> {
  // TODO(supabase): await supabase.from('pipeline_gates').update({status: decision, resolution_payload: resolutionPayload ?? null, resolved_by: resolvedBy, resolved_at: new Date().toISOString()}).eq('gate_id', gateId);
  // TODO(следующий шаг): если decision в ('approved','edited') — вызвать
  // pipeline_gate.resume_after_gate() на бэкенде, чтобы флоу продолжился
  // (см. pipeline_gate.py). Отсюда, из UI, только фиксация решения.
  const idx = MOCK_GATES.findIndex((g) => g.gate_id === gateId);
  if (idx === -1) return null;
  MOCK_GATES[idx] = {
    ...MOCK_GATES[idx],
    status: decision,
    resolution_payload: resolutionPayload ?? MOCK_GATES[idx].resolution_payload,
    resolved_by: resolvedBy,
    resolved_at: new Date().toISOString(),
  };
  saveMock("gates", MOCK_GATES);
  return MOCK_GATES[idx];
}

// --- Клиенты (ТЗ агента, уровень 9, п.1 — карточка клиента) ---------------
// 22.07.2026: реальный Supabase подключён (см. supabase_migration_7_clients_core.sql,
// agent-bot/logic/clients_parse.py) — clients/client_pii/client_restrictions/
// client_preferences больше не только мок. favoriteDishes остаются на моке
// (dishes не мигрированы). subscriptions — см. 24.07.2026 ниже, подключены
// к реальному Supabase (ввод пока ручной — автоматического источника
// подписок нет, боевой шитс "2. Заказы на день" не источник истины).
//
// 22.07.2026 (тот же вечер) — вход по QR + RLS: clients/client_pii/
// client_restrictions/client_preferences закрыты от anon (см.
// supabase_migration_8_auth_infra.sql), браузер больше не может читать их
// напрямую через lib/supabaseClient.ts. Доступ теперь только через
// защищённые Route Handler'ы (app/api/clients/**, app/api/restrictions/**,
// app/api/preferences/**) с service role ключом — функции ниже дёргают их
// через fetch(), а не supabase.from(...) напрямую.

interface ClientPiiRow {
  phone: string | null;
  tg_username: string | null;
  address_text: string | null;
  birthday_date: string | null;
}

interface ClientRow {
  client_id: string;
  display_name: string;
  status: ClientStatus;
  preferred_language: "ru" | "en" | "fr" | "vi";
  current_kcal_level: number | null;
  // 06.08.2026 (миграция 19) — свободная операционная заметка о клиенте.
  note?: string | null;
  client_pii: ClientPiiRow | ClientPiiRow[] | null;
  // 25.07.2026 — embed из /api/clients, /api/clients/[id] (см. эти роуты) —
  // нужен только чтобы вычислить active_subscription_kcal ниже.
  subscriptions?: { kcal_target: number; status: string }[] | null;
}

function clientRowToClient(row: ClientRow): Client {
  const pii = Array.isArray(row.client_pii) ? row.client_pii[0] : row.client_pii;
  const activeSub = (row.subscriptions ?? []).find((s) => s.status === "active");
  return {
    client_id: row.client_id,
    display_name: row.display_name,
    status: row.status,
    preferred_language: row.preferred_language,
    current_kcal_level: row.current_kcal_level ?? null,
    active_subscription_kcal: activeSub?.kcal_target ?? null,
    phone: pii?.phone ?? null,
    tg_username: pii?.tg_username ?? null,
    address_text: pii?.address_text ?? null,
    birthday_date: pii?.birthday_date ?? null,
    note: row.note ?? null,
  };
}

export async function getClients(): Promise<Client[]> {
  try {
    const res = await fetch("/api/clients");
    if (res.ok) {
      const { rows } = (await res.json()) as { rows: ClientRow[] };
      return rows.map(clientRowToClient);
    }
  } catch {
    // сеть недоступна/сервер не ответил — падаем на мок ниже
  }
  return MOCK_CLIENTS;
}

// 12.08.2026 — ручное создание клиента из UI (ClientList.tsx, кнопка
// "Добавить клиента"). Без аудит-лога: entity_type в audit_log не включает
// "client" (см. supabase_migration_*, CHECK-констрейнт) — тот же принцип,
// что и у PATCH в app/api/clients/[id]/route.ts, там его тоже нет.
export async function createClient(input: {
  display_name: string;
  phone?: string;
  tg_username?: string;
  address_text?: string;
}): Promise<{ client: Client | null; error: string | null }> {
  try {
    const res = await fetch("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      return { client: clientRowToClient(body.row as ClientRow), error: null };
    }
    return { client: null, error: body.error ?? "не удалось создать" };
  } catch {
    return { client: null, error: "сеть недоступна" };
  }
}

export async function getClient(clientId: string): Promise<Client | null> {
  try {
    const res = await fetch(`/api/clients/${clientId}`);
    if (res.ok) {
      const { row } = (await res.json()) as { row: ClientRow | null };
      if (row) return clientRowToClient(row);
    }
  } catch {
    // ignore, падаем на мок
  }
  return MOCK_CLIENTS.find((c) => c.client_id === clientId) ?? null;
}

export interface ClientCardData {
  client: Client;
  restrictions: ClientRestriction[];
  preferences: ClientPreference[];
  favoriteDishes: FavoriteDish[];
  subscriptions: SubscriptionSummary[];
}

export async function getClientCard(clientId: string): Promise<ClientCardData | null> {
  // 12.08.2026 — эти два запроса раньше шли последовательно (await, потом
  // ещё await) — вместе с самим действием (PATCH/POST) это давало 3
  // запроса подряд на каждый refresh(), отсюда и жалоба "любое сохранение
  // — сервер думает несколько секунд". Независимы друг от друга, гоним
  // параллельно — Promise.all почти вдвое быстрее сериального варианта.
  const [client, cardRes] = await Promise.all([
    getClient(clientId),
    fetch(`/api/clients/${clientId}/card`).catch(() => null),
  ]);
  if (!client) return null;

  let restrictions = MOCK_RESTRICTIONS.filter((r) => r.client_id === clientId);
  let preferences = MOCK_PREFERENCES.filter((p) => p.client_id === clientId);
  let subscriptions = MOCK_SUBSCRIPTIONS.filter((s) => s.client_id === clientId);

  try {
    if (cardRes && cardRes.ok) {
      const body = (await cardRes.json()) as {
        restrictions: ClientRestriction[];
        preferences: ClientPreference[];
        subscriptions: SubscriptionSummary[];
      };
      restrictions = body.restrictions;
      preferences = body.preferences;
      subscriptions = body.subscriptions;
    }
  } catch {
    // ignore, остаёмся на моке выше
  }

  return {
    client,
    restrictions,
    preferences,
    subscriptions,
    // dishes ещё не мигрированы — для реальных клиентов (uuid из Supabase)
    // mock-фильтр просто не найдёт совпадений, вернёт [].
    favoriteDishes: MOCK_FAVORITE_DISHES.filter((f) => f.client_id === clientId),
  };
}

// 24.07.2026: подписки подключены к реальному Supabase (см.
// supabase_migration_10_subscriptions.sql) — тот же защищённый контур, что
// и у restrictions/preferences (FK на client_id, тот же уровень
// чувствительности данных). Ввод пока ТОЛЬКО ручной — источника
// автоматического импорта подписок нет (боевой шитс "2. Заказы на день" —
// формульный лист, не источник истины, см. CLAUDE.md).
export async function addSubscription(
  clientId: string,
  fields: {
    kcalTarget: number;
    startDate: string;
    paidDays: number;
    discountPct: number;
    priceTotal: number;
    // 06.08.2026 — тариф (supabase_migration_15). null допустим: разовая
    // договорённость вне справочника остаётся возможной.
    planId?: string | null;
    // 19.08.2026 — оплатил/не оплатил при ручном создании (Игорь: "при
    // апруве заявки это есть, а в ручном нет"). undefined/null — менеджер
    // ещё не решил, оставляем как есть (тот же смысл, что и у заявок).
    paymentStatus?: "paid" | "unpaid" | null;
  },
  addedBy: string,
): Promise<SubscriptionSummary> {
  try {
    const res = await fetch("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        kcal_target: fields.kcalTarget,
        start_date: fields.startDate,
        paid_days: fields.paidDays,
        discount_pct: fields.discountPct,
        price_total: fields.priceTotal,
        plan_id: fields.planId ?? null,
        status: "active",
        payment_status: fields.paymentStatus ?? null,
      }),
    });
    if (res.ok) {
      const { row } = (await res.json()) as { row: SubscriptionSummary };
      logAuditEntry({
        entity_type: "subscription",
        entity_id: row.subscription_id,
        entity_label: `${fields.kcalTarget} ккал, ${fields.paidDays} дн. с ${fields.startDate}`,
        client_id: clientId,
        action: "created",
        before: null,
        after: `${fields.kcalTarget} ккал, ${fields.paidDays} дн., скидка ${fields.discountPct}%`,
        changed_by: addedBy,
      }).catch(() => {});
      return row;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const row: SubscriptionSummary = {
    subscription_id: `sub-${Date.now()}`,
    client_id: clientId,
    kcal_target: fields.kcalTarget,
    start_date: fields.startDate,
    paid_days: fields.paidDays,
    discount_pct: fields.discountPct,
    price_total: fields.priceTotal,
    status: "active",
    payment_status: fields.paymentStatus ?? null,
  };
  MOCK_SUBSCRIPTIONS.push(row);
  saveMock("subscriptions", MOCK_SUBSCRIPTIONS);
  logAuditEntry({
    entity_type: "subscription",
    entity_id: row.subscription_id,
    entity_label: `${fields.kcalTarget} ккал, ${fields.paidDays} дн. с ${fields.startDate}`,
    client_id: clientId,
    action: "created",
    before: null,
    after: `${fields.kcalTarget} ккал, ${fields.paidDays} дн., скидка ${fields.discountPct}%`,
    changed_by: addedBy,
  }).catch(() => {});
  return row;
}

// 06.08.2026 — вместо двух кнопок «Завершить»/«Отменить» одна: статус
// вычисляется на сервере по плановой дате окончания (см.
// app/api/subscriptions/[id]/finish/route.ts). Возвращает, чем всё
// закончилось, чтобы UI мог честно сказать «завершена досрочно».
export async function finishSubscription(
  subscriptionId: string,
  clientId: string,
  changedBy: string,
): Promise<{ status: "completed" | "cancelled"; early: boolean } | null> {
  try {
    const res = await fetch(`/api/subscriptions/${subscriptionId}/finish`, { method: "POST" });
    if (res.ok) {
      const body = (await res.json()) as {
        before: SubscriptionSummary;
        after: SubscriptionSummary;
        status: "completed" | "cancelled";
        early: boolean;
      };
      logAuditEntry({
        entity_type: "subscription",
        entity_id: subscriptionId,
        entity_label: `${body.after.kcal_target} ккал, ${body.after.paid_days} дн.`,
        client_id: clientId,
        action: "updated",
        before: body.before.status,
        after: body.early ? "завершена досрочно" : "завершена",
        changed_by: changedBy,
      }).catch(() => {});
      return { status: body.status, early: body.early };
    }
  } catch {
    // ignore
  }
  return null;
}

// 06.08.2026 — скрыть подсказку о расхождении цены с тарифом (миграция 20).
// Расхождение в данных остаётся, скрывается только напоминание о нём.
export async function dismissPriceHint(subscriptionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ price_hint_dismissed_at: new Date().toISOString() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function setSubscriptionStatus(
  subscriptionId: string,
  clientId: string,
  status: SubscriptionSummary["status"],
  changedBy: string,
): Promise<void> {
  try {
    const res = await fetch(`/api/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (res.ok) {
      const { before, after } = (await res.json()) as { before: SubscriptionSummary; after: SubscriptionSummary };
      logAuditEntry({
        entity_type: "subscription",
        entity_id: subscriptionId,
        entity_label: `${after.kcal_target} ккал, ${after.paid_days} дн.`,
        client_id: clientId,
        action: "updated",
        before: before.status,
        after: after.status,
        changed_by: changedBy,
      }).catch(() => {});
      return;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const idx = MOCK_SUBSCRIPTIONS.findIndex((s) => s.subscription_id === subscriptionId);
  if (idx === -1) return;
  const before = MOCK_SUBSCRIPTIONS[idx];
  MOCK_SUBSCRIPTIONS[idx] = { ...before, status };
  saveMock("subscriptions", MOCK_SUBSCRIPTIONS);
  logAuditEntry({
    entity_type: "subscription",
    entity_id: subscriptionId,
    entity_label: `${before.kcal_target} ккал, ${before.paid_days} дн.`,
    client_id: clientId,
    action: "updated",
    before: before.status,
    after: status,
    changed_by: changedBy,
  }).catch(() => {});
}

// "Не чёрный ящик — Франсуа/Ольга правят вручную" (ТЗ агента, уровень 9).
// Деактивация — не удаление: valid_to проставляется, история остаётся
// (тот же принцип event-style, что и в hf_schema_v1.sql).
export async function deactivateRestriction(restrictionId: string, resolvedBy: string): Promise<void> {
  try {
    const res = await fetch(`/api/restrictions/${restrictionId}`, { method: "PATCH" });
    if (res.ok) {
      const { before } = (await res.json()) as { before: ClientRestriction };
      logAuditEntry({
        entity_type: "client_restriction",
        entity_id: restrictionId,
        entity_label: `${KIND_LABEL_RU[before.kind]} — ${before.value_text}`,
        client_id: before.client_id,
        action: "deactivated",
        before: `${before.value_text} (активно)`,
        after: null,
        changed_by: resolvedBy,
      }).catch(() => {});
      return;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const idx = MOCK_RESTRICTIONS.findIndex((r) => r.restriction_id === restrictionId);
  if (idx === -1) return;
  const before = MOCK_RESTRICTIONS[idx];
  MOCK_RESTRICTIONS[idx] = {
    ...before,
    is_active: false,
    valid_to: new Date().toISOString(),
  };
  saveMock("restrictions", MOCK_RESTRICTIONS);
  logAuditEntry({
    entity_type: "client_restriction",
    entity_id: restrictionId,
    entity_label: `${KIND_LABEL_RU[before.kind]} — ${before.value_text}`,
    client_id: before.client_id,
    action: "deactivated",
    before: `${before.value_text} (активно)`,
    after: null,
    changed_by: resolvedBy,
  }).catch(() => {});
}

export async function addRestriction(
  clientId: string,
  kind: RestrictionKind,
  valueText: string,
  source: string,
): Promise<ClientRestriction> {
  try {
    const res = await fetch("/api/restrictions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, kind, value_text: valueText, source }),
    });
    if (res.ok) {
      const { row } = (await res.json()) as { row: ClientRestriction };
      logAuditEntry({
        entity_type: "client_restriction",
        entity_id: row.restriction_id,
        entity_label: `${KIND_LABEL_RU[kind]} — ${valueText}`,
        client_id: clientId,
        action: "created",
        before: null,
        after: `${valueText} (${KIND_LABEL_RU[kind]})`,
        changed_by: source,
      }).catch(() => {});
      return row;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const row: ClientRestriction = {
    restriction_id: `r-${Date.now()}`,
    client_id: clientId,
    kind,
    value_text: valueText,
    is_active: true,
    source,
    valid_from: new Date().toISOString(),
    valid_to: null,
  };
  MOCK_RESTRICTIONS.push(row);
  saveMock("restrictions", MOCK_RESTRICTIONS);
  logAuditEntry({
    entity_type: "client_restriction",
    entity_id: row.restriction_id,
    entity_label: `${KIND_LABEL_RU[kind]} — ${valueText}`,
    client_id: clientId,
    action: "created",
    before: null,
    after: `${valueText} (${KIND_LABEL_RU[kind]})`,
    changed_by: source,
  }).catch(() => {});
  return row;
}

// Дублирует KIND_LABEL из ClientCard.tsx — там UI-версия для отображения,
// здесь только для человекочитаемых записей в аудит-логе.
const KIND_LABEL_RU: Record<RestrictionKind, string> = {
  allergy: "аллергия",
  medical: "медицинское",
  dislike: "не любит",
  logistics: "логистика",
};

// --- Предпочтения и любимые блюда (19.07.2026) ------------------------------
// Вопрос "как менять предпочтения и любимые блюда?" — раньше в карточке
// клиента это был только просмотр. Добавление/удаление зеркалит паттерн
// ограничений (add/remove), без soft-delete — это не так чувствительно, как
// аллергии, подтверждающая модалка тут не нужна.

export async function addPreference(
  clientId: string,
  kind: PreferenceKind,
  valueText: string,
  source: string,
): Promise<ClientPreference> {
  try {
    const res = await fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, kind, value_text: valueText, source }),
    });
    if (res.ok) {
      const { row } = (await res.json()) as { row: ClientPreference };
      return row;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const row: ClientPreference = {
    preference_id: `p-${Date.now()}`,
    client_id: clientId,
    kind,
    value_text: valueText,
    source,
  };
  MOCK_PREFERENCES.push(row);
  saveMock("preferences", MOCK_PREFERENCES);
  return row;
}

export async function removePreference(preferenceId: string): Promise<void> {
  try {
    const res = await fetch(`/api/preferences/${preferenceId}`, { method: "DELETE" });
    if (res.ok) return;
  } catch {
    // ignore, падаем на мок ниже
  }

  const idx = MOCK_PREFERENCES.findIndex((p) => p.preference_id === preferenceId);
  if (idx !== -1) {
    MOCK_PREFERENCES.splice(idx, 1);
    saveMock("preferences", MOCK_PREFERENCES);
  }
}

export async function getDishOptions(): Promise<{ dish_id: string; dish_name: string }[]> {
  // TODO(supabase): const { data } = await supabase.from('dishes').select('dish_id, dish_name').order('dish_name');
  return MOCK_DISH_STATS.map((d) => ({ dish_id: d.dish_id, dish_name: d.dish_name }));
}

export async function addFavoriteDish(
  clientId: string,
  dishId: string,
  source: FavoriteDish["source"],
): Promise<FavoriteDish | null> {
  // TODO(supabase): await supabase.from('client_favorite_dishes').insert({client_id: clientId, dish_id: dishId, source});
  const dish = MOCK_DISH_STATS.find((d) => d.dish_id === dishId);
  if (!dish) return null;
  const already = MOCK_FAVORITE_DISHES.find((f) => f.client_id === clientId && f.dish_id === dishId);
  if (already) return already;
  const row: FavoriteDish = { client_id: clientId, dish_id: dishId, dish_name: dish.dish_name, source };
  MOCK_FAVORITE_DISHES.push(row);
  saveMock("favorite_dishes", MOCK_FAVORITE_DISHES);
  return row;
}

export async function removeFavoriteDish(clientId: string, dishId: string): Promise<void> {
  // TODO(supabase): await supabase.from('client_favorite_dishes').delete().eq('client_id', clientId).eq('dish_id', dishId);
  const idx = MOCK_FAVORITE_DISHES.findIndex((f) => f.client_id === clientId && f.dish_id === dishId);
  if (idx !== -1) {
    MOCK_FAVORITE_DISHES.splice(idx, 1);
    saveMock("favorite_dishes", MOCK_FAVORITE_DISHES);
  }
}

// --- Статистика (ТЗ агента, уровень 8 / уровень 9 п.2) ---------------------

export type DishStatsSort = "times_in_ordered_days" | "explicit_favorites" | "avg_rating";

export async function getDishStats(sortBy: DishStatsSort = "times_in_ordered_days"): Promise<DishStatsRow[]> {
  // TODO(supabase): join dish_popularity + dish_favorite_count + dish_sentiment_summary
  // по dish_id, напр. через RPC-функцию на стороне Postgres (проще, чем
  // три отдельных select + склейка на клиенте).
  return [...MOCK_DISH_STATS].sort((a, b) => {
    const av = a[sortBy] ?? -1;
    const bv = b[sortBy] ?? -1;
    return bv - av;
  });
}

// --- Журнал диалогов агента (ТЗ агента, уровень 9, п.3) --------------------
// 18.07.2026: изначально только просмотр постфактум, без перехвата.
// 17.08.2026: добавлен ручной перехват — "Взять диалог на себя" в
// DialogThread.tsx (см. human_takeover/миграция 23), см. ниже.

// Строка таблицы dialogs в Supabase — плоские поля, без вложенного
// messages[] (сообщения — отдельная таблица dialog_messages, см. ниже).
interface DialogRow {
  dialog_id: string;
  client_id: string;
  client_display_name: string;
  channel: string;
  escalated_to: string | null;
  escalation_reason: string | null;
  started_at: string;
  ended_at: string | null;
  human_takeover?: boolean | null;
  human_takeover_by?: string | null;
  client_chat_id?: string | null;
}

interface DialogMessageRow {
  role: DialogMessage["role"];
  text: string;
  created_at: string;
}

function dialogRowToAgentDialog(row: DialogRow, messages: DialogMessage[] = []): AgentDialog {
  return {
    dialog_id: row.dialog_id,
    client_id: row.client_id,
    client_display_name: row.client_display_name,
    channel: row.channel,
    messages,
    escalated_to: row.escalated_to,
    escalation_reason: row.escalation_reason,
    started_at: row.started_at,
    ended_at: row.ended_at,
    human_takeover: row.human_takeover ?? false,
    human_takeover_by: row.human_takeover_by ?? null,
    client_chat_id: row.client_chat_id ?? null,
  };
}

export async function getDialogs(filter?: "escalated"): Promise<AgentDialog[]> {
  // 21.07.2026: раньше только мок — реальные диалоги agent-bot жили в
  // памяти процесса на Render, физически не были видны админке (см.
  // supabase_migration_4_dialogs.sql). Список не показывает сами сообщения
  // (см. DialogList.tsx) — messages: [] здесь достаточно, полный тред
  // подгружает getDialog() отдельно.
  if (hasSupabase()) {
    let query = supabase!.from("dialogs").select("*").order("updated_at", { ascending: false });
    if (filter === "escalated") query = query.not("escalated_to", "is", null);
    const { data, error } = await query;
    if (!error && data) return (data as DialogRow[]).map((row) => dialogRowToAgentDialog(row));
  }
  const all = [...MOCK_DIALOGS].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return filter === "escalated" ? all.filter((d) => d.escalated_to !== null) : all;
}

export async function getDialog(dialogId: string): Promise<AgentDialog | null> {
  if (hasSupabase()) {
    const { data: dialogRow, error: dialogError } = await supabase!
      .from("dialogs")
      .select("*")
      .eq("dialog_id", dialogId)
      .maybeSingle();
    if (!dialogError && dialogRow) {
      const { data: messageRows } = await supabase!
        .from("dialog_messages")
        .select("role, text, created_at")
        .eq("dialog_id", dialogId)
        .order("created_at", { ascending: true });
      const messages: DialogMessage[] = ((messageRows as DialogMessageRow[] | null) ?? []).map((m) => ({
        role: m.role,
        text: m.text,
        at: m.created_at,
      }));
      return dialogRowToAgentDialog(dialogRow as DialogRow, messages);
    }
  }
  return MOCK_DIALOGS.find((d) => d.dialog_id === dialogId) ?? null;
}

// --- Красная зона (ТЗ агента, уровень 9, п.3) ------------------------------
// "Ручное управление зелёной/красной зоной общения — без правки кода".
// Зелёная зона (справочник фактов) — отдельный CRUD-блок ниже
// (getGreenZoneFacts/addGreenZoneFact/deactivateGreenZoneFact).

export async function getRedZoneTerms(): Promise<RedZoneTermEntry[]> {
  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("red_zone_terms")
      .select("*")
      .eq("is_active", true)
      .order("category");
    if (!error && data) return data as RedZoneTermEntry[];
  }
  // TODO(следующий шаг): red_zone_classifier.py должен научиться грузить
  // термины из той же Supabase-таблицы вместо red_zone_terms.yaml — иначе
  // правки в админке не повлияют на реальную работу агента, только на
  // отображение здесь. См. supabase_minimal_schema.sql.
  return MOCK_RED_ZONE_TERMS.filter((t) => t.is_active);
}

export async function addRedZoneTerm(
  category: RedZoneCategory,
  language: RedZoneLanguage,
  pattern: string,
  addedBy: string,
  note?: string,
): Promise<RedZoneTermEntry> {
  const trimmedPattern = pattern.trim();
  const trimmedNote = note?.trim() || null;

  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("red_zone_terms")
      .insert({ category, language, pattern: trimmedPattern, note: trimmedNote, added_by: addedBy })
      .select()
      .single();
    if (!error && data) {
      const row = data as RedZoneTermEntry;
      logAuditEntry({
        entity_type: "red_zone_term",
        entity_id: row.term_id,
        entity_label: `${trimmedPattern} (${language})`,
        client_id: null,
        action: "created",
        before: null,
        after: `${trimmedPattern} — ${category}, ${language}`,
        changed_by: addedBy,
      }).catch(() => {});
      return row;
    }
  }

  const row: RedZoneTermEntry = {
    term_id: `t-${Date.now()}`,
    category,
    language,
    pattern: trimmedPattern,
    note: trimmedNote,
    is_active: true,
    added_by: addedBy,
    added_at: new Date().toISOString(),
  };
  MOCK_RED_ZONE_TERMS.push(row);
  saveMock("red_zone_terms", MOCK_RED_ZONE_TERMS);
  logAuditEntry({
    entity_type: "red_zone_term",
    entity_id: row.term_id,
    entity_label: `${trimmedPattern} (${language})`,
    client_id: null,
    action: "created",
    before: null,
    after: `${trimmedPattern} — ${category}, ${language}`,
    changed_by: addedBy,
  }).catch(() => {});
  return row;
}

export async function deactivateRedZoneTerm(termId: string, deactivatedBy: string): Promise<void> {
  if (hasSupabase()) {
    const { data: before } = await supabase!.from("red_zone_terms").select("*").eq("term_id", termId).maybeSingle();
    const { error } = await supabase!.from("red_zone_terms").update({ is_active: false }).eq("term_id", termId);
    if (!error && before) {
      const b = before as RedZoneTermEntry;
      logAuditEntry({
        entity_type: "red_zone_term",
        entity_id: termId,
        entity_label: `${b.pattern} (${b.language})`,
        client_id: null,
        action: "deactivated",
        before: `${b.pattern} — ${b.category}, ${b.language} (активен)`,
        after: null,
        changed_by: deactivatedBy,
      }).catch(() => {});
      return;
    }
  }

  const idx = MOCK_RED_ZONE_TERMS.findIndex((t) => t.term_id === termId);
  if (idx === -1) return;
  const before = MOCK_RED_ZONE_TERMS[idx];
  MOCK_RED_ZONE_TERMS[idx] = { ...before, is_active: false };
  saveMock("red_zone_terms", MOCK_RED_ZONE_TERMS);
  logAuditEntry({
    entity_type: "red_zone_term",
    entity_id: termId,
    entity_label: `${before.pattern} (${before.language})`,
    client_id: null,
    action: "deactivated",
    before: `${before.pattern} — ${before.category}, ${before.language} (активен)`,
    after: null,
    changed_by: deactivatedBy,
  }).catch(() => {});
}

// --- Живая синхронизация промпта/фактов с agent-bot (21.07.2026) -----------
// Раньше agent-bot читал промпт/факты из РУЧНОГО снимка (agent-bot/logic/
// agent_prompt.py) — правки здесь, в /agent-prompt и /green-zone, на живой
// ответ бота никак не влияли (см. предупреждение, которое раньше висело в
// AgentSystemPromptSetting.tsx). Теперь после сохранения отправляем ТЕКУЩЕЕ
// полное состояние (не дельту — проще и надёжнее, чем накатывать патчи) на
// agent-bot через собственный server-side роут app/api/agent-sync/route.ts —
// секрет (AGENT_BOT_SYNC_TOKEN) остаётся на сервере Vercel, не в браузере.
//
// Если бот недоступен (спит на бесплатном Render, нет сети и т.п.) — не
// роняем сохранение в админке (localStorage-копия уже сохранена мгновенно
// выше), просто возвращаем ok:false с человеческим текстом. Известное
// ограничение (см. agent-bot/logic/agent_prompt.py): override живёт в
// памяти процесса бота, теряется при перезапуске бесплатного инстанса —
// тогда нужно будет пересохранить ещё раз, чтобы протолкнуть заново.
export async function syncAgentBot(): Promise<{ ok: boolean; message: string }> {
  try {
    const [prompt, facts] = await Promise.all([getAgentSystemPrompt(), getGreenZoneFacts()]);
    const res = await fetch("/api/agent-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, facts: facts.map((f) => f.fact_text) }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return { ok: true, message: "Синхронизировано с ботом" };
  } catch {
    return {
      ok: false,
      message:
        "Не удалось достучаться до бота (возможно, «спит» на бесплатном тарифе Render — попробуйте ещё раз через минуту)",
    };
  }
}

// 21.07.2026: "Как Ольге найти клиента, которому надо ответить по
// эскалации? Давай сделаем возможность отвечать из админки" — раньше
// Telegram chat_id клиента нигде не был виден админке, найти чат можно было
// только вручную в самом Telegram. Теперь агент-бот кладёт chat_id прямо в
// саму строку эскалации при создании (см. Escalation.client_chat_id,
// agent-bot/integrations/db_mock.py, create_escalation_record) — этот
// вызов просто передаёт его дальше вместе с текстом. Тот же паттерн
// server-side прокси, что и syncAgentBot() (секрет не должен попасть в
// браузер) — см. app/api/agent-reply/route.ts.
export async function sendMessageToClient(
  clientId: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/agent-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, chat_id: chatId, text }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return { ok: true, message: "Отправлено клиенту в Telegram" };
  } catch {
    return {
      ok: false,
      message:
        "Не удалось достучаться до бота (возможно, «спит» на бесплатном тарифе Render — попробуйте ещё раз через минуту)",
    };
  }
}

// 17.08.2026 — "Взять диалог на себя" / "Вернуть боту" в DialogThread.tsx
// (миграция 23, human_takeover). Тот же принцип server-side прокси, что и
// sendMessageToClient выше — секрет ADMIN_SYNC_TOKEN остаётся на Vercel
// (см. app/api/agent-takeover/route.ts).
export async function setHumanTakeover(
  clientId: string,
  takeover: boolean,
  staffName: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("/api/agent-takeover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, takeover, staff_name: staffName }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !body.ok) {
      return { ok: false, message: body.error || `Бот ответил ошибкой (${res.status})` };
    }
    return {
      ok: true,
      message: takeover ? "Диалог взят на себя — бот больше не отвечает клиенту" : "Диалог возвращён боту",
    };
  } catch {
    return {
      ok: false,
      message:
        "Не удалось достучаться до бота (возможно, «спит» на бесплатном тарифе Render — попробуйте ещё раз через минуту)",
    };
  }
}

// 21.08.2026 — баннер эскалации прямо в чате (DialogThread.tsx): у диалога
// (таблица dialogs) есть свои escalated_to/escalation_reason — денормализо-
// ванный флаг "этот диалог сейчас эскалирован", отдельно от строк в таблице
// escalations (у той свой жизненный цикл new -> in_progress -> completed,
// см. completeEscalation выше, EscalationDetail.tsx). Между ними нет
// внешнего ключа на dialogs, поэтому "завершить эскалацию" из чата делает
// две вещи сразу: чистит флаг на самом диалоге (иначе баннер не исчезнет) и
// заодно закрывает связанные строки escalations по dialog_id (best-effort —
// если их нет или они уже завершены, это не ошибка). Прямой supabase-запрос,
// как и completeEscalation/deactivateRedZoneTerm — RLS на этих таблицах
// отключён (см. комментарий у DialogThread.tsx про Realtime-подписку).
export async function resolveDialogEscalation(dialogId: string, resolvedBy: string): Promise<AgentDialog | null> {
  if (hasSupabase()) {
    const { data: updatedDialog, error } = await supabase!
      .from("dialogs")
      .update({ escalated_to: null, escalation_reason: null })
      .eq("dialog_id", dialogId)
      .select()
      .maybeSingle();
    if (!error) {
      // Best-effort: закрыть незавершённые эскалации, привязанные к этому
      // диалогу. Ошибку здесь намеренно не считаем фатальной для всей
      // операции — баннер в чате уже должен пропасть по обновлению dialogs.
      await supabase!
        .from("escalations")
        .update({ status: "completed", completed_at: new Date().toISOString(), completed_by: resolvedBy })
        .eq("dialog_id", dialogId)
        .neq("status", "completed");
      if (updatedDialog) return dialogRowToAgentDialog(updatedDialog as DialogRow);
      return getDialog(dialogId);
    }
  }

  const idx = MOCK_DIALOGS.findIndex((d) => d.dialog_id === dialogId);
  if (idx === -1) return null;
  MOCK_DIALOGS[idx] = { ...MOCK_DIALOGS[idx], escalated_to: null, escalation_reason: null };
  saveMock("dialogs", MOCK_DIALOGS);

  let escalationsChanged = false;
  for (let i = 0; i < MOCK_ESCALATIONS.length; i++) {
    if (MOCK_ESCALATIONS[i].dialog_id === dialogId && MOCK_ESCALATIONS[i].status !== "completed") {
      MOCK_ESCALATIONS[i] = {
        ...MOCK_ESCALATIONS[i],
        status: "completed",
        completed_at: new Date().toISOString(),
        completed_by: resolvedBy,
      };
      escalationsChanged = true;
    }
  }
  if (escalationsChanged) saveMock("escalations", MOCK_ESCALATIONS);

  return MOCK_DIALOGS[idx];
}

// --- Зелёная зона (ТЗ агента, уровень 9, п.3 — "ручное управление зелёной/
// красной зоной общения без правки кода"), переосмыслено 20.07.2026 -------
// Была модель "точная пара вопрос-ответ" — не масштабируется на живой
// разговорный агент (см. подробное обоснование в types.ts, GreenZoneFact).
// Теперь Ольга/Франсуа подтверждают ФАКТЫ (одна строка на факт), а не
// формулировки ответов — агент сам решает, как сказать это клиенту.
// CRUD-паттерн по-прежнему зеркалит addRedZoneTerm/deactivateRedZoneTerm.

export async function getGreenZoneFacts(): Promise<GreenZoneFact[]> {
  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("green_zone_facts")
      .select("*")
      .eq("is_active", true)
      .order("category");
    if (!error && data) return data as GreenZoneFact[];
  }
  return MOCK_GREEN_ZONE_FACTS.filter((f) => f.is_active);
}

export async function addGreenZoneFact(
  category: GreenZoneCategory,
  factText: string,
  addedBy: string,
  note?: string,
): Promise<GreenZoneFact> {
  const trimmedText = factText.trim();
  const trimmedNote = note?.trim() || null;

  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("green_zone_facts")
      .insert({ category, fact_text: trimmedText, note: trimmedNote, added_by: addedBy })
      .select()
      .single();
    if (!error && data) {
      const row = data as GreenZoneFact;
      logAuditEntry({
        entity_type: "green_zone_fact",
        entity_id: row.fact_id,
        entity_label: trimmedText,
        client_id: null,
        action: "created",
        before: null,
        after: `${trimmedText} (${category})`,
        changed_by: addedBy,
      }).catch(() => {});
      void syncAgentBot();
      return row;
    }
  }

  const row: GreenZoneFact = {
    fact_id: `gzf-${Date.now()}`,
    category,
    fact_text: trimmedText,
    note: trimmedNote,
    is_active: true,
    added_by: addedBy,
    added_at: new Date().toISOString(),
  };
  MOCK_GREEN_ZONE_FACTS.push(row);
  saveMock("green_zone_facts", MOCK_GREEN_ZONE_FACTS);
  logAuditEntry({
    entity_type: "green_zone_fact",
    entity_id: row.fact_id,
    entity_label: trimmedText,
    client_id: null,
    action: "created",
    before: null,
    after: `${trimmedText} (${category})`,
    changed_by: addedBy,
  }).catch(() => {});
  void syncAgentBot(); // best-effort, не блокирует и не роняет добавление факта
  return row;
}

// Запрос 20.07.2026: "редактировать зелёные нельзя — надо добавить" —
// раньше факт можно было только добавить или деактивировать+добавить
// заново (что теряет старый added_by/added_at и плодит лишние записи в
// аудит-логе). Правка на месте — тот же факт, новый текст/категория/
// заметка, action: "updated" в аудите с было/стало.
export async function updateGreenZoneFact(
  factId: string,
  patch: { category?: GreenZoneCategory; factText?: string; note?: string | null },
  updatedBy: string,
): Promise<GreenZoneFact | null> {
  if (hasSupabase()) {
    const { data: beforeRow } = await supabase!.from("green_zone_facts").select("*").eq("fact_id", factId).maybeSingle();
    if (beforeRow) {
      const before = beforeRow as GreenZoneFact;
      const patchDb = {
        category: patch.category ?? before.category,
        fact_text: patch.factText !== undefined ? patch.factText.trim() : before.fact_text,
        note: patch.note !== undefined ? patch.note?.trim() || null : before.note,
      };
      const { data, error } = await supabase!
        .from("green_zone_facts")
        .update(patchDb)
        .eq("fact_id", factId)
        .select()
        .single();
      if (!error && data) {
        const after = data as GreenZoneFact;
        logAuditEntry({
          entity_type: "green_zone_fact",
          entity_id: factId,
          entity_label: after.fact_text,
          client_id: null,
          action: "updated",
          before: `${before.fact_text} (${before.category})`,
          after: `${after.fact_text} (${after.category})`,
          changed_by: updatedBy,
        }).catch(() => {});
        void syncAgentBot();
        return after;
      }
    }
  }

  const idx = MOCK_GREEN_ZONE_FACTS.findIndex((f) => f.fact_id === factId);
  if (idx === -1) return null;
  const before = MOCK_GREEN_ZONE_FACTS[idx];
  const after: GreenZoneFact = {
    ...before,
    category: patch.category ?? before.category,
    fact_text: patch.factText !== undefined ? patch.factText.trim() : before.fact_text,
    note: patch.note !== undefined ? (patch.note?.trim() || null) : before.note,
  };
  MOCK_GREEN_ZONE_FACTS[idx] = after;
  saveMock("green_zone_facts", MOCK_GREEN_ZONE_FACTS);
  logAuditEntry({
    entity_type: "green_zone_fact",
    entity_id: factId,
    entity_label: after.fact_text,
    client_id: null,
    action: "updated",
    before: `${before.fact_text} (${before.category})`,
    after: `${after.fact_text} (${after.category})`,
    changed_by: updatedBy,
  }).catch(() => {});
  void syncAgentBot();
  return after;
}

export async function deactivateGreenZoneFact(factId: string, deactivatedBy: string): Promise<void> {
  if (hasSupabase()) {
    const { data: beforeRow } = await supabase!.from("green_zone_facts").select("*").eq("fact_id", factId).maybeSingle();
    const { error } = await supabase!.from("green_zone_facts").update({ is_active: false }).eq("fact_id", factId);
    if (!error && beforeRow) {
      const before = beforeRow as GreenZoneFact;
      logAuditEntry({
        entity_type: "green_zone_fact",
        entity_id: factId,
        entity_label: before.fact_text,
        client_id: null,
        action: "deactivated",
        before: `${before.fact_text} (активен)`,
        after: null,
        changed_by: deactivatedBy,
      }).catch(() => {});
      void syncAgentBot();
      return;
    }
  }

  const idx = MOCK_GREEN_ZONE_FACTS.findIndex((f) => f.fact_id === factId);
  if (idx === -1) return;
  const before = MOCK_GREEN_ZONE_FACTS[idx];
  MOCK_GREEN_ZONE_FACTS[idx] = { ...before, is_active: false };
  saveMock("green_zone_facts", MOCK_GREEN_ZONE_FACTS);
  logAuditEntry({
    entity_type: "green_zone_fact",
    entity_id: factId,
    entity_label: before.fact_text,
    client_id: null,
    action: "deactivated",
    before: `${before.fact_text} (активен)`,
    after: null,
    changed_by: deactivatedBy,
  }).catch(() => {});
  void syncAgentBot();
}

// --- Категории зелёной зоны (23.07.2026) ------------------------------------
// Запрос Игоря: "нужно иметь возможность редактировать категории и создавать
// их" — раньше GreenZoneCategory был жёстким TS-enum из 6 значений. Сделано
// ТОЛЬКО для зелёной зоны (для красной категория завязана на матчинг regex
// в red_zone_classifier.py — риск оставлен как есть, см. CLAUDE.md). Тот же
// паттерн, что и у фактов/терминов: добавление + деактивация, без
// переименования (переименование молча оборвало бы связь с уже
// существующими green_zone_facts.category по тексту).

export async function getGreenZoneCategories(): Promise<GreenZoneCategoryRow[]> {
  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("green_zone_categories")
      .select("*")
      .order("sort_order");
    if (!error && data) return data as GreenZoneCategoryRow[];
  }
  return [...MOCK_GREEN_ZONE_CATEGORIES].sort((a, b) => a.sort_order - b.sort_order);
}

export async function addGreenZoneCategory(label: string, addedBy: string): Promise<GreenZoneCategoryRow> {
  const trimmedLabel = label.trim();

  if (hasSupabase()) {
    const { data: existing } = await supabase!
      .from("green_zone_categories")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1);
    const nextOrder = existing && existing.length ? (existing[0] as { sort_order: number }).sort_order + 1 : 0;
    const { data, error } = await supabase!
      .from("green_zone_categories")
      .insert({ label: trimmedLabel, sort_order: nextOrder, created_by: addedBy })
      .select()
      .single();
    if (!error && data) {
      const row = data as GreenZoneCategoryRow;
      logAuditEntry({
        entity_type: "green_zone_category",
        entity_id: row.category_id,
        entity_label: trimmedLabel,
        client_id: null,
        action: "created",
        before: null,
        after: trimmedLabel,
        changed_by: addedBy,
      }).catch(() => {});
      return row;
    }
  }

  const nextOrder = MOCK_GREEN_ZONE_CATEGORIES.length
    ? Math.max(...MOCK_GREEN_ZONE_CATEGORIES.map((c) => c.sort_order)) + 1
    : 0;
  const row: GreenZoneCategoryRow = {
    category_id: `gzc-${Date.now()}`,
    label: trimmedLabel,
    sort_order: nextOrder,
    is_active: true,
    created_by: addedBy,
    created_at: new Date().toISOString(),
  };
  MOCK_GREEN_ZONE_CATEGORIES.push(row);
  saveMock("green_zone_categories", MOCK_GREEN_ZONE_CATEGORIES);
  logAuditEntry({
    entity_type: "green_zone_category",
    entity_id: row.category_id,
    entity_label: trimmedLabel,
    client_id: null,
    action: "created",
    before: null,
    after: trimmedLabel,
    changed_by: addedBy,
  }).catch(() => {});
  return row;
}

export async function deactivateGreenZoneCategory(categoryId: string, deactivatedBy: string): Promise<void> {
  if (hasSupabase()) {
    const { data: beforeRow } = await supabase!
      .from("green_zone_categories")
      .select("*")
      .eq("category_id", categoryId)
      .maybeSingle();
    const { error } = await supabase!
      .from("green_zone_categories")
      .update({ is_active: false })
      .eq("category_id", categoryId);
    if (!error && beforeRow) {
      const before = beforeRow as GreenZoneCategoryRow;
      logAuditEntry({
        entity_type: "green_zone_category",
        entity_id: categoryId,
        entity_label: before.label,
        client_id: null,
        action: "deactivated",
        before: `${before.label} (активна)`,
        after: null,
        changed_by: deactivatedBy,
      }).catch(() => {});
      return;
    }
  }

  const idx = MOCK_GREEN_ZONE_CATEGORIES.findIndex((c) => c.category_id === categoryId);
  if (idx === -1) return;
  const before = MOCK_GREEN_ZONE_CATEGORIES[idx];
  MOCK_GREEN_ZONE_CATEGORIES[idx] = { ...before, is_active: false };
  saveMock("green_zone_categories", MOCK_GREEN_ZONE_CATEGORIES);
  logAuditEntry({
    entity_type: "green_zone_category",
    entity_id: categoryId,
    entity_label: before.label,
    client_id: null,
    action: "deactivated",
    before: `${before.label} (активна)`,
    after: null,
    changed_by: deactivatedBy,
  }).catch(() => {});
}

// --- Системный промпт агента (20.07.2026) -----------------------------------
// "Нужно, чтобы в админке был прописан промт (редактируемый)... чтобы
// Франсуа мог менять сам". Тот же паттерн app_settings, что и дедлайн.

export async function getAgentSystemPrompt(): Promise<string> {
  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("app_settings")
      .select("value")
      .eq("setting_key", AGENT_SYSTEM_PROMPT_SETTING_KEY)
      .maybeSingle();
    if (!error && data) {
      const text = (data.value as Record<string, unknown> | null)?.text;
      if (typeof text === "string") return text;
    }
  }
  const row = MOCK_APP_SETTINGS.find((s) => s.setting_key === AGENT_SYSTEM_PROMPT_SETTING_KEY);
  const text = row?.value?.text;
  return typeof text === "string" ? text : "";
}

export async function setAgentSystemPrompt(text: string, changedBy: string): Promise<void> {
  const beforeText = await getAgentSystemPrompt();
  const auditPatch = {
    entity_type: "app_setting" as const,
    entity_id: AGENT_SYSTEM_PROMPT_SETTING_KEY,
    entity_label: "Системный промпт агента",
    client_id: null,
    action: "updated" as const,
    before: beforeText.length > 120 ? `${beforeText.slice(0, 120)}…` : beforeText,
    after: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    changed_by: changedBy,
  };

  if (hasSupabase()) {
    // 22.07.2026: upsert, не update() — см. комментарий в setOrderDeadlineTime
    // выше, тот же класс бага (строка могла не существовать в свежем проекте).
    const { error } = await supabase!
      .from("app_settings")
      .upsert(
        { setting_key: AGENT_SYSTEM_PROMPT_SETTING_KEY, value: { text }, updated_by: changedBy, updated_at: new Date().toISOString() },
        { onConflict: "setting_key" },
      );
    if (!error) {
      logAuditEntry(auditPatch).catch(() => {});
      return;
    }
  }

  const idx = MOCK_APP_SETTINGS.findIndex((s) => s.setting_key === AGENT_SYSTEM_PROMPT_SETTING_KEY);
  if (idx === -1) return;
  const before = MOCK_APP_SETTINGS[idx];
  MOCK_APP_SETTINGS[idx] = {
    ...before,
    value: { text },
    updated_by: changedBy,
    updated_at: new Date().toISOString(),
  };
  saveMock("app_settings", MOCK_APP_SETTINGS);
  logAuditEntry(auditPatch).catch(() => {});
}

// --- Справочник тарифов (06.08.2026) ---------------------------------------
// Читается в карточке клиента для выпадающего списка. Полное управление
// тарифами — на отдельной странице (/plans, PlansManager.tsx), там свои
// прямые вызовы /api/plans, без обёрток здесь: это админский CRUD одной
// страницы, а не общий для приложения слой данных.

export async function getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
  try {
    const res = await fetch("/api/plans");
    if (res.ok) {
      const { rows } = (await res.json()) as { rows: SubscriptionPlan[] };
      return (rows ?? []).filter((p) => p.is_active);
    }
  } catch {
    // ignore — без Supabase просто не будет тарифов в списке
  }
  return [];
}

// Смена тарифа у уже существующей подписки. Сознательно НЕ пересчитывает
// price_total задним числом: клиент заплатил конкретную сумму, и переписывать
// её молча нельзя. Меняем привязку к тарифу и целевую калорийность, разницу
// показываем в UI подсказкой — решение о доплате/возврате принимает человек.
export async function setSubscriptionPlan(
  subscriptionId: string,
  clientId: string,
  plan: SubscriptionPlan | null,
  changedBy: string = "francois",
): Promise<boolean> {
  try {
    const res = await fetch(`/api/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        // price_hint_dismissed_at сбрасывается: после смены тарифа
        // расхождение цены уже другое, и его нужно увидеть заново, даже если
        // прошлое скрывали (миграция 20).
        plan
          ? { plan_id: plan.plan_id, kcal_target: plan.kcal_target, price_hint_dismissed_at: null }
          : { plan_id: null, price_hint_dismissed_at: null },
      ),
    });
    if (res.ok) {
      const { before } = (await res.json()) as { before: SubscriptionSummary };
      logAuditEntry({
        entity_type: "subscription",
        entity_id: subscriptionId,
        entity_label: "тариф подписки",
        client_id: clientId,
        action: "updated",
        before: `тариф: ${before.plan_name ?? "не задан"}, ${before.kcal_target} ккал`,
        after: plan ? `тариф: ${plan.name}, ${plan.kcal_target} ккал` : "тариф снят",
        changed_by: changedBy,
      }).catch(() => {});
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// --- Пользователи админки / получатели пушей об эскалации (19.07.2026) ----
// "В настройках выбрать из всех пользователей, кто получает пуши об
// эскалации" — здесь только receives_escalations, привязка Telegram
// (telegram_chat_id) происходит только через "/link <код>" в самом боте
// (agent-bot/orchestrator.py), из админки её не выставить.

export async function getStaffUsers(): Promise<StaffUser[]> {
  try {
    const res = await fetch("/api/staff");
    if (res.ok) {
      const { rows } = (await res.json()) as { rows: StaffUser[] };
      return rows;
    }
  } catch {
    // ignore, падаем на мок ниже
  }
  return [...MOCK_STAFF_USERS].sort((a, b) => a.display_name.localeCompare(b.display_name));
}

// 02.08.2026 — создание нового сотрудника из UI (запрос Игоря: "добавить
// возможность добавлять юзеров, чтобы линк у них появлялся для тест
// аккаунтов и эскалаций"). Код /link генерируется на сервере (см.
// app/api/staff/route.ts, POST) — здесь только отправка формы + мок-фоллбек
// с тем же алфавитом, чтобы работало и без Supabase.
const MOCK_LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function mockGenerateLinkCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += MOCK_LINK_CODE_ALPHABET[Math.floor(Math.random() * MOCK_LINK_CODE_ALPHABET.length)];
  }
  return code;
}

export async function createStaffUser(
  displayName: string,
  role: StaffRole,
  changedBy: string = "francois",
): Promise<{ user: StaffUser | null; error: string | null }> {
  try {
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: displayName, role }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      const created = body.row as StaffUser;
      logAuditEntry({
        entity_type: "staff_user",
        entity_id: created.user_id,
        entity_label: `${created.display_name} — новый сотрудник`,
        client_id: null,
        action: "created",
        before: null,
        after: `роль: ${created.role}`,
        changed_by: changedBy,
      }).catch(() => {});
      return { user: created, error: null };
    }
    return { user: null, error: body.error ?? "не удалось создать" };
  } catch {
    // ignore, падаем на мок ниже
  }

  if (MOCK_STAFF_USERS.some((u) => u.display_name === displayName)) {
    return { user: null, error: "сотрудник с таким именем уже есть" };
  }
  const created: StaffUser = {
    user_id: `u-${Date.now()}`,
    display_name: displayName,
    email: null,
    role,
    is_active: true,
    receives_escalations: false,
    telegram_chat_id: null,
    telegram_link_code: mockGenerateLinkCode(),
    telegram_linked_at: null,
    can_approve_after_deadline: false,
    notify_new_dialogs: false,
  };
  MOCK_STAFF_USERS.push(created);
  saveMock("staff_users", MOCK_STAFF_USERS);
  logAuditEntry({
    entity_type: "staff_user",
    entity_id: created.user_id,
    entity_label: `${created.display_name} — новый сотрудник`,
    client_id: null,
    action: "created",
    before: null,
    after: `роль: ${created.role}`,
    changed_by: changedBy,
  }).catch(() => {});
  return { user: created, error: null };
}

export async function setReceivesEscalations(
  userId: string,
  value: boolean,
  changedBy: string = "francois",
): Promise<StaffUser | null> {
  try {
    const res = await fetch(`/api/staff/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { receives_escalations: value } }),
    });
    if (res.ok) {
      const { before, after } = (await res.json()) as { before: StaffUser; after: StaffUser };
      logAuditEntry({
        entity_type: "staff_user",
        entity_id: userId,
        entity_label: `${before.display_name} — эскалация`,
        client_id: null,
        action: "updated",
        before: `эскалация: ${before.receives_escalations ? "вкл" : "выкл"}`,
        after: `эскалация: ${value ? "вкл" : "выкл"}`,
        changed_by: changedBy,
      }).catch(() => {});
      return after;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const idx = MOCK_STAFF_USERS.findIndex((u) => u.user_id === userId);
  if (idx === -1) return null;
  const before = MOCK_STAFF_USERS[idx];
  MOCK_STAFF_USERS[idx] = { ...before, receives_escalations: value };
  saveMock("staff_users", MOCK_STAFF_USERS);
  logAuditEntry({
    entity_type: "staff_user",
    entity_id: userId,
    entity_label: `${before.display_name} — эскалация`,
    client_id: null,
    action: "updated",
    before: `эскалация: ${before.receives_escalations ? "вкл" : "выкл"}`,
    after: `эскалация: ${value ? "вкл" : "выкл"}`,
    changed_by: changedBy,
  }).catch(() => {});
  return MOCK_STAFF_USERS[idx];
}

// Запрос 19.07.2026: "столбец с тогглами... те, кто после 18:00 изменения
// внёс (вроде до 18 можно)" — см. подробное толкование в types.ts на поле
// can_approve_after_deadline. Тумблер в настройках выдаёт/забирает право
// одобрять заявки на изменение заказа после 18:00.
export async function setCanApproveAfterDeadline(
  userId: string,
  value: boolean,
  changedBy: string = "francois",
): Promise<StaffUser | null> {
  try {
    const res = await fetch(`/api/staff/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { can_approve_after_deadline: value } }),
    });
    if (res.ok) {
      const { before, after } = (await res.json()) as { before: StaffUser; after: StaffUser };
      logAuditEntry({
        entity_type: "staff_user",
        entity_id: userId,
        entity_label: `${before.display_name} — одобрение после 18:00`,
        client_id: null,
        action: "updated",
        before: `после 18:00: ${before.can_approve_after_deadline ? "вкл" : "выкл"}`,
        after: `после 18:00: ${value ? "вкл" : "выкл"}`,
        changed_by: changedBy,
      }).catch(() => {});
      return after;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const idx = MOCK_STAFF_USERS.findIndex((u) => u.user_id === userId);
  if (idx === -1) return null;
  const before = MOCK_STAFF_USERS[idx];
  MOCK_STAFF_USERS[idx] = { ...before, can_approve_after_deadline: value };
  saveMock("staff_users", MOCK_STAFF_USERS);
  logAuditEntry({
    entity_type: "staff_user",
    entity_id: userId,
    entity_label: `${before.display_name} — одобрение после 18:00`,
    client_id: null,
    action: "updated",
    before: `после 18:00: ${before.can_approve_after_deadline ? "вкл" : "выкл"}`,
    after: `после 18:00: ${value ? "вкл" : "выкл"}`,
    changed_by: changedBy,
  }).catch(() => {});
  return MOCK_STAFF_USERS[idx];
}

// 12.08.2026 — запрос Игоря: пуш о новом диалоге отдельным подписчикам,
// см. types.ts на поле notify_new_dialogs и orchestrator._notify_new_dialog_recipients
// в agent-bot. Тот же паттерн PATCH + оптимистичный апдейт, что и выше.
export async function setNotifyNewDialogs(
  userId: string,
  value: boolean,
  changedBy: string = "francois",
): Promise<StaffUser | null> {
  try {
    const res = await fetch(`/api/staff/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patch: { notify_new_dialogs: value } }),
    });
    if (res.ok) {
      const { before, after } = (await res.json()) as { before: StaffUser; after: StaffUser };
      logAuditEntry({
        entity_type: "staff_user",
        entity_id: userId,
        entity_label: `${before.display_name} — новые диалоги`,
        client_id: null,
        action: "updated",
        before: `новые диалоги: ${before.notify_new_dialogs ? "вкл" : "выкл"}`,
        after: `новые диалоги: ${value ? "вкл" : "выкл"}`,
        changed_by: changedBy,
      }).catch(() => {});
      return after;
    }
  } catch {
    // ignore, падаем на мок ниже
  }

  const idx = MOCK_STAFF_USERS.findIndex((u) => u.user_id === userId);
  if (idx === -1) return null;
  const before = MOCK_STAFF_USERS[idx];
  MOCK_STAFF_USERS[idx] = { ...before, notify_new_dialogs: value };
  saveMock("staff_users", MOCK_STAFF_USERS);
  logAuditEntry({
    entity_type: "staff_user",
    entity_id: userId,
    entity_label: `${before.display_name} — новые диалоги`,
    client_id: null,
    action: "updated",
    before: `новые диалоги: ${before.notify_new_dialogs ? "вкл" : "выкл"}`,
    after: `новые диалоги: ${value ? "вкл" : "выкл"}`,
    changed_by: changedBy,
  }).catch(() => {});
  return MOCK_STAFF_USERS[idx];
}

// --- Очередь эскалаций (19.07.2026) -----------------------------------------
// Запрос: статусы новая/в работе/завершена, "в работе" выставляется
// автоматически при открытии, дефолтная сортировка "в работе -> новая ->
// завершена", плюс сортировка по типу эскалации, пагинация 20/страница по
// ВСЕМУ объёму (сортируем полный массив, потом режем на страницу — не
// наоборот, иначе сортировка была бы только внутри текущей страницы).

export type EscalationSort = "status" | "category" | "date";

const STATUS_ORDER: Record<EscalationStatus, number> = { in_progress: 0, new: 1, completed: 2 };
const CATEGORY_ORDER: Record<Escalation["category"], number> = {
  allergy_medical: 0,
  indirect_pattern: 1,
  complaint_negative: 2,
  agent_uncertain: 3,
};

export interface EscalationPage {
  rows: Escalation[];
  total: number;
}

export async function getEscalations(
  sortBy: EscalationSort = "status",
  page: number = 1,
  pageSize: number = 20,
): Promise<EscalationPage> {
  // Сортировка/пагинация — на клиенте, после select('*') целиком. На
  // реальном объёме это стоило бы перенести на сторону запроса
  // (.order(...).range(...)), но сейчас данных мало (это и раньше было ok
  // для мока, для Supabase на этом объёме — тоже) и своя многоключевая
  // сортировка (статус -> дата) неудобно ложится в один .order().
  let allRows: Escalation[] = MOCK_ESCALATIONS;
  if (hasSupabase()) {
    const { data, error } = await supabase!.from("escalations").select("*");
    if (!error && data) allRows = data as Escalation[];
  }

  const sorted = [...allRows].sort((a, b) => {
    if (sortBy === "status") {
      const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      if (byStatus !== 0) return byStatus;
      return b.created_at.localeCompare(a.created_at);
    }
    if (sortBy === "category") {
      const byCategory = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
      if (byCategory !== 0) return byCategory;
      return b.created_at.localeCompare(a.created_at);
    }
    // sortBy === "date"
    return b.created_at.localeCompare(a.created_at);
  });

  const total = sorted.length;
  const start = (page - 1) * pageSize;
  const rows = sorted.slice(start, start + pageSize);
  return { rows, total };
}

export async function getEscalation(escalationId: string): Promise<Escalation | null> {
  if (hasSupabase()) {
    const { data, error } = await supabase!.from("escalations").select("*").eq("escalation_id", escalationId).maybeSingle();
    if (!error) return (data as Escalation | null) ?? null;
  }
  return MOCK_ESCALATIONS.find((e) => e.escalation_id === escalationId) ?? null;
}

export async function openEscalation(escalationId: string, openedBy: string): Promise<Escalation | null> {
  // Открытие карточки = автоматический переход "новая" -> "в работе".
  // Повторное открытие уже "в работе"/"завершена" статус не меняет —
  // .eq('status','new') в самом update гарантирует это на уровне запроса.
  if (hasSupabase()) {
    const { data: updated, error } = await supabase!
      .from("escalations")
      .update({ status: "in_progress", opened_at: new Date().toISOString(), opened_by: openedBy })
      .eq("escalation_id", escalationId)
      .eq("status", "new")
      .select()
      .maybeSingle();
    if (!error) {
      if (updated) return updated as Escalation;
      // Не обновилось (уже не "new" или не найдено) — просто вернуть текущее.
      return getEscalation(escalationId);
    }
  }

  const idx = MOCK_ESCALATIONS.findIndex((e) => e.escalation_id === escalationId);
  if (idx === -1) return null;
  if (MOCK_ESCALATIONS[idx].status === "new") {
    MOCK_ESCALATIONS[idx] = {
      ...MOCK_ESCALATIONS[idx],
      status: "in_progress",
      opened_at: new Date().toISOString(),
      opened_by: openedBy,
    };
    saveMock("escalations", MOCK_ESCALATIONS);
  }
  return MOCK_ESCALATIONS[idx];
}

// 21.07.2026: свободное поле для реального ответа Ольги клиенту — не
// обязательно (можно завершить эскалацию и без него), но нужно как
// источник для "сохранить как факт зелёной зоны" на карточке (см.
// components/EscalationDetail.tsx). Без сохранённого текста ответа
// превратить эскалацию в факт было не из чего.
export async function setEscalationResolution(
  escalationId: string,
  resolutionText: string,
  changedBy: string,
): Promise<Escalation | null> {
  const trimmed = resolutionText.trim() || null;
  void changedBy; // зарезервировано для будущего аудит-лога эскалаций (сейчас его нет, см. types.ts)

  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("escalations")
      .update({ resolution_text: trimmed })
      .eq("escalation_id", escalationId)
      .select()
      .maybeSingle();
    if (!error) return (data as Escalation | null) ?? null;
  }

  const idx = MOCK_ESCALATIONS.findIndex((e) => e.escalation_id === escalationId);
  if (idx === -1) return null;
  MOCK_ESCALATIONS[idx] = {
    ...MOCK_ESCALATIONS[idx],
    resolution_text: trimmed,
  };
  saveMock("escalations", MOCK_ESCALATIONS);
  return MOCK_ESCALATIONS[idx];
}

export async function completeEscalation(escalationId: string, completedBy: string): Promise<Escalation | null> {
  if (hasSupabase()) {
    const { data, error } = await supabase!
      .from("escalations")
      .update({ status: "completed", completed_at: new Date().toISOString(), completed_by: completedBy })
      .eq("escalation_id", escalationId)
      .select()
      .maybeSingle();
    if (!error) return (data as Escalation | null) ?? null;
  }

  const idx = MOCK_ESCALATIONS.findIndex((e) => e.escalation_id === escalationId);
  if (idx === -1) return null;
  MOCK_ESCALATIONS[idx] = {
    ...MOCK_ESCALATIONS[idx],
    status: "completed",
    completed_at: new Date().toISOString(),
    completed_by: completedBy,
  };
  saveMock("escalations", MOCK_ESCALATIONS);
  return MOCK_ESCALATIONS[idx];
}
