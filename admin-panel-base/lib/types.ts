// Соответствует hf_schema_v1.sql, раздел 10 (module_registry / pipeline_gates)
// и разделу "5. КРАСНАЯ ЗОНА" / "6. НАПОМИНАНИЯ". Типы держать в синхроне
// со схемой вручную, пока нет генератора типов из реального Supabase-проекта
// (supabase gen types typescript — включить, когда появится живой инстанс).

export type ModuleMode = "auto" | "manual_approval";
export type FallbackOnDisable = "skip" | "wait_for_manual";

export interface ModuleConfig {
  module_key: string;
  display_name: string;
  description: string | null;
  stage: string | null;
  enabled: boolean;
  mode: ModuleMode;
  fallback_on_disable: FallbackOnDisable;
  updated_by: string | null;
  updated_at: string; // ISO
}

export type GateStatus = "pending" | "approved" | "edited" | "rejected";

export interface PipelineGate {
  gate_id: string;
  module_key: string;
  entity_type: string;
  entity_id: string | null;
  draft_payload: Record<string, unknown>;
  status: GateStatus;
  resolution_payload: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// --- Клиентская карточка (ТЗ агента, уровень 9, п.1 + уровень 4) ----------
// Соответствует clients / client_pii / client_restrictions /
// client_preferences / client_favorite_dishes / subscriptions.

export type ClientStatus = "active" | "paused" | "churned_silent" | "churned_declined";

export interface Client {
  client_id: string;
  display_name: string;
  status: ClientStatus;
  preferred_language: "ru" | "en" | "fr" | "vi";
  phone: string | null;
  tg_username: string | null;
  address_text: string | null;
  birthday_date: string | null; // ISO date
  // 22.07.2026 — снимок текущего уровня ккал из вкладки "1. Клиенты"
  // Google Sheet (см. supabase_migration_7_clients_core.sql,
  // agent-bot/logic/clients_parse.py). НЕ полноценная запись subscriptions
  // (в источнике нет дат/оплаты) — просто последнее известное значение.
  current_kcal_level: number | null;
  // 25.07.2026 — денормализованное поле (не колонка в Supabase, считается
  // на клиенте из embedded subscriptions при чтении, см. dataClient.ts
  // clientRowToClient) — kcal_target активной подписки, если она есть.
  // Нужно, чтобы после апрува заявки на подписку (см. subscription_requests)
  // ккал было видно в списке/карточке клиента даже без снимка из Sheet.
  active_subscription_kcal: number | null;
  // 06.08.2026 (миграция 19) — свободная операционная заметка о клиенте
  // («оставлять у ворот», «звонить заранее»). Не для персональных данных.
  note?: string | null;
}

export type RestrictionKind = "allergy" | "dislike" | "medical" | "logistics";

export interface ClientRestriction {
  restriction_id: string;
  client_id: string;
  kind: RestrictionKind;
  value_text: string;
  is_active: boolean;
  source: string;
  valid_from: string;
  valid_to: string | null;
}

export type PreferenceKind = "favorite_product" | "favorite_cuisine" | "taste_profile";

export interface ClientPreference {
  preference_id: string;
  client_id: string;
  kind: PreferenceKind;
  value_text: string;
  source: string;
}

export interface FavoriteDish {
  client_id: string;
  dish_id: string;
  dish_name: string; // денормализовано для UI, в реальном запросе — join с dishes
  source: "agent_asked" | "agent_inferred_from_orders" | "olga";
}

// --- Tool use агента: перенос даты доставки (25.07.2026) --------------------
// Соответствует order_change_requests (supabase_migration_11_order_change_requests.sql).
// Заявка заводится агентом (реальный Anthropic tool use, см. agent-bot/
// integrations/claude_real.py, ORDER_CHANGE_TOOL) ТОЛЬКО после явного
// подтверждения клиента — здесь она ждёт ручного апрува (Игорь, 25.07.2026:
// "давай сделаем всегда апрув от админа" — никакого автоприменения).

export type OrderChangeScope = "one_time" | "range" | "permanent";
export type OrderChangeStatus = "pending_approval" | "approved" | "rejected" | "applied";

export interface OrderChangeRequest {
  request_id: string;
  client_id: string;
  client_display_name: string;
  client_chat_id: string | null;
  dialog_id: string | null;
  change_type: "reschedule_date";
  scope: OrderChangeScope;
  current_date_hint: string | null;
  new_date: string;
  range_end_date: string | null;
  // matched_via — сейчас всегда 'name' или 'none' (в строке "Заказы на
  // день" ещё нет tg_username), 'telegram' зарезервирован на будущее.
  matched_via: "telegram" | "name" | "none";
  matched_order_name: string | null;
  client_confirmation_quote: string;
  status: OrderChangeStatus;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
}

// --- Tool use агента: оформление подписки (25.07.2026) ----------------------
// Соответствует subscription_requests (supabase_migration_12_subscription_requests.sql).
// Тот же принцип, что и OrderChangeRequest выше: агент вызывает инструмент
// (agent-bot/integrations/claude_real.py, SUBSCRIPTION_TOOL) ТОЛЬКО после
// явного подтверждения клиента, цена/скидка считаются детерминированно на
// бэкенде agent-bot (см. logic/subscription_pricing.py, logic/level2_pricing.py) —
// заявка ждёт ручного апрува, никакого автоприменения.

export type SubscriptionRequestStatus = "pending_approval" | "approved" | "rejected" | "applied";

export interface SubscriptionRequest {
  request_id: string;
  client_id: string;
  client_display_name: string;
  client_chat_id: string | null;
  dialog_id: string | null;
  // supabase_client_id — uuid реального clients.client_id (см.
  // client_bootstrap.py на стороне agent-bot), может быть null, если у
  // клиента в Telegram нет публичного username — тогда апрув не сможет
  // автоматически создать строку subscriptions, потребуется ручное действие.
  supabase_client_id: string | null;
  kcal_target: number;
  start_date: string;
  paid_days: number;
  discount_pct: number;
  price_total: number;
  // payment_status (25.07.2026) — заполняется в момент апрува одной из
  // двух кнопок ("Одобрить с оплатой"/"Одобрить без оплаты"), см.
  // SubscriptionRequestsManager.tsx. null, пока заявка pending_approval/rejected.
  payment_status: "paid" | "unpaid" | null;
  client_confirmation_quote: string;
  // 06.08.2026 (миграция 16) — подтверждённое клиентом на итоговой сверке
  // перед оформлением. null = не прозвучало в разговоре; при апруве адрес и
  // ограничения переносятся в карточку клиента (subscription_apply.py).
  delivery_address: string | null;
  delivery_time_text: string | null;
  restrictions_note: string | null;
  // 06.08.2026 (миграция 18) — «для супруги» и т.п., если рацион не для
  // самого клиента: у одного клиента бывает несколько параллельных подписок.
  recipient_note: string | null;
  // 17.08.2026 — способ оплаты, как ответил клиент в переписке (Игорь:
  // "менеджер должен знать как хочет оплатить клиент"). Отдельно от
  // payment_status выше (тот проставляет менеджер при апруве).
  payment_note: string | null;
  // 19.08.2026 — Игорь вернул требование обратно (было запрещено спрашивать
  // 17.08.2026): номер телефона, подтверждённый на итоговой сверке.
  // Переносится в client_pii.phone и subscriptions.phone при апруве.
  phone: string | null;
  status: SubscriptionRequestStatus;
  decided_by: string | null;
  decided_at: string | null;
  applied_at: string | null;
  created_at: string;
  // 26.08.2026 — заявка, заведённая Ольгой вручную из карточки диалога (см.
  // CreateSubscriptionModal.tsx, agent-bot main.py /admin/create-subscription-
  // from-dialog), а не ботом по итогам обычного propose_subscription. null —
  // обычный путь через бота. Отдельно от decided_by (тот же человек в этом
  // случае и "одобряет", но семантически другое поле — "кто завёл").
  created_by: string | null;
  // 17.08.2026 — день рождения клиента (join на clients.birthday_date по
  // supabase_client_id, см. app/api/subscription-requests/route.ts). null,
  // если клиент не привязан (нет Telegram-username) или ДР не заполнен.
  client_birthday_date: string | null;
  // 19.08.2026 — вычисляется в API (route.ts) по правилу "тариф сверху"
  // (resolve_price_tier), не хранится в БД. null для заявок с plan_id
  // (коворкинг/промо-тарифы — там цена не по kcal_price_table) или если
  // kcal_target выше самого крупного тарифа. Показывает, по какому тарифу
  // реально посчитана price_total, когда он не совпадает с kcal_target.
  price_tier: number | null;
}

export interface SubscriptionSummary {
  subscription_id: string;
  client_id: string;
  kcal_target: number;
  start_date: string;
  paid_days: number;
  // 24.07.2026: discount_pct/price_total добавлены при подключении
  // subscriptions к реальному Supabase (supabase_migration_10_subscriptions.sql)
  // — раньше тип покрывал только то, что показывалось в моке, теперь
  // нужны и для формы ручного добавления/правки подписки.
  discount_pct: number;
  price_total: number;
  status: "active" | "completed" | "cancelled";
  // payment_status (25.07.2026) — переносится из subscription_requests при
  // апруве через бота, null для подписок, заведённых вручную до этой правки.
  payment_status: "paid" | "unpaid" | null;
  // 06.08.2026 — тариф (пакет подписки), см. supabase_migration_15. Nullable:
  // подписки, заведённые до появления справочника, тарифа не имеют.
  plan_id?: string | null;
  plan_name?: string | null;
  // 06.08.2026 (миграция 20) — когда скрыли подсказку о расхождении цены с
  // тарифом. Не null = подсказку больше не показываем.
  price_hint_dismissed_at?: string | null;
}

// --- Справочник тарифов (06.08.2026, supabase_migration_15) ----------------
// Запрос Игоря: "справочник тарифов, где админ может создавать/менять тарифы
// (пакеты подписок)". Цена/калорийность живут здесь, а не в
// app_settings.kcal_price_table, как было раньше.
export interface SubscriptionPlan {
  plan_id: string;
  name: string;
  kcal_target: number;
  price_per_day: number;
  default_days: number | null;
  discount_pct: number;
  is_active: boolean;
  sort_order: number;
}

// --- Агрегированная статистика (ТЗ агента, уровень 8 / уровень 9 п.2) -----
// Соответствует materialized views dish_popularity, dish_favorite_count,
// dish_sentiment_summary (hf_schema_v1.sql). Объединены в одну строку на UI
// для удобства просмотра — в реальном запросе это join трёх views по dish_id.

export interface DishStatsRow {
  dish_id: string;
  dish_name: string;
  category: "breakfast" | "lunch_dinner";
  // dish_popularity: сколько раз блюдо стояло в заказанном дне.
  // ВАЖНО (см. комментарий на materialized view в схеме): это НЕ "клиент
  // выбрал блюдо" — при подписке на общее меню дня такой метрики нет.
  times_in_ordered_days: number;
  // dish_favorite_count
  explicit_favorites: number;
  inferred_favorites: number;
  // dish_sentiment_summary — пусто, пока не подключён анализ тональности
  // (см. схему) — тут NULL, а не 0, чтобы отличать "нет данных" от "нейтрально"
  positive_count: number | null;
  neutral_count: number | null;
  negative_count: number | null;
  avg_rating: number | null;
}

// --- Журнал диалогов агента (ТЗ агента, уровень 9, п.3) --------------------
// Соответствует agent_dialogs. ТОЛЬКО просмотр — не перехват живого диалога
// (обсуждено 18.07.2026: "никто следить за перепиской не будет" в реальном
// времени, это пост-фактум журнал/аудит).

export interface DialogMessage {
  // "staff" (21.07.2026) — сообщение, отправленное менеджером прямо из
  // админки (см. EscalationDetail.tsx, sendMessageToClient) — отдельно от
  // "agent" (сгенерировано ботом). "olga" — старое поле в существующих
  // моковых данных, оставлено для обратной совместимости, новые реальные
  // диалоги пишут "staff".
  role: "client" | "agent" | "olga" | "staff";
  text: string;
  at: string; // ISO
}

export interface AgentDialog {
  dialog_id: string;
  client_id: string;
  client_display_name: string; // денормализовано для UI
  channel: string;
  messages: DialogMessage[];
  escalated_to: string | null; // 'olga' | null
  escalation_reason: string | null;
  started_at: string;
  ended_at: string | null;
  // 17.08.2026 (миграция 23) — "Взять диалог на себя" в DialogThread.tsx:
  // пока true, agent-bot не отвечает клиенту сам (см. orchestrator.py,
  // human_takeover). Опционально — моковые диалоги (mockData.ts) их не
  // задают, трактуется как false/null.
  human_takeover?: boolean;
  human_takeover_by?: string | null;
  // 17.08.2026 (миграция 23) — chat_id клиента, самозаполняется agent-bot
  // на каждое сообщение. Нужен, чтобы DialogThread.tsx могло отправить
  // сообщение через sendMessageToClient (см. lib/dataClient.ts). Может быть
  // null для очень старых диалогов, если клиент ни разу не писал после
  // выката миграции 23 (self-heal произойдёт на следующее его сообщение).
  client_chat_id?: string | null;
}

// --- Красная зона (ТЗ агента, уровень 9, п.3) ------------------------------
// Соответствует red_zone_terms.

export type RedZoneCategory = "allergy_medical" | "indirect_pattern" | "complaint_negative";
export type RedZoneLanguage = "ru" | "fr" | "en";

export interface RedZoneTermEntry {
  term_id: string;
  category: RedZoneCategory;
  language: RedZoneLanguage;
  pattern: string;
  note: string | null;
  is_active: boolean;
  added_by: string;
  added_at: string;
}

// --- Зелёная зона (ТЗ агента, уровень 9, п.3 — "ручное управление
// зелёной/красной зоной общения без правки кода") (20.07.2026,
// переосмыслено 20.07.2026 вечером) -----------------------------------------
// Первая версия (см. историю в CLAUDE.md) была списком точных пар
// "вопрос клиента → готовый ответ" — прямая калька с красной зоны. Игорь
// указал на реальную проблему: с живым разговорным агентом (не
// скриптованным ботом) это не масштабируется — клиент может спросить одно
// и то же сотней формулировок, Ольге пришлось бы предугадывать их все
// годами.
//
// Модель поменяна на факты, а не пары вопрос-ответ: Ольга/Франсуа
// подтверждают ОДИН факт/правило ("скидка: неделя → 5%, месяц → 10%"), а
// agent (настоящий Claude, когда подключим) сам решает, как сказать это
// клиенту своими словами в контексте разговора — разнообразие формулировок
// даёт модель, не список. Зелёная зона так и остаётся маленькой и растёт
// медленно (одна строка на факт), а не бесконечным списком фраз.
//
// Категории изначально были те же, что в черновой автоматической карте
// (level3_zone_map_draft.md) — фиксированный TS-enum из 6 значений.
//
// 23.07.2026: запрос Игоря — "нужно иметь возможность редактировать
// категории и создавать их". Уточнил отдельно: для красной зоны это
// рискованно (категория там не просто ярлык — определяет, в какой из 3
// наборов regex-паттернов классификатора попадёт термин, см.
// red_zone_classifier.py и разговор в CLAUDE.md, 23.07.2026) — Игорь
// согласился делать динамическими ТОЛЬКО категории зелёной зоны, красную
// зону не трогаем. Для зелёной зоны категория и раньше была чисто
// UI-группировкой (agent-bot видит только текст факта, не категорию, см.
// syncAgentBot() в dataClient.ts) — сделать её свободной было безопасно.
//
// Теперь это не жёсткий union, а свободная строка, которая должна совпадать
// с label одной из строк нового справочника `green_zone_categories`
// (GreenZoneCategoryRow ниже) — Ольга/Франсуа заводят/деактивируют
// категории сами через UI (GreenZoneManager.tsx), без правки кода.
export type GreenZoneCategory = string;

// Справочник категорий зелёной зоны (23.07.2026) — редактируется из
// /green-zone. Тот же паттерн, что и везде в проекте: добавление +
// деактивация (не переименование и не удаление) — переименовывать категорию
// не даём осознанно, иначе старые факты с прежним текстом category "отвалятся"
// от неё молча; хочешь другое название — заведи новую, старую деактивируй.
export interface GreenZoneCategoryRow {
  category_id: string;
  label: string;
  sort_order: number;
  is_active: boolean;
  created_by: string;
  created_at: string;
}

export interface GreenZoneFact {
  fact_id: string;
  category: GreenZoneCategory;
  fact_text: string; // подтверждённый факт/правило одной строкой — агент формулирует ответ сам
  note: string | null;
  is_active: boolean;
  added_by: string;
  added_at: string;
}

// --- Пользователи админки / получатели пушей об эскалации (19.07.2026) ----
// Соответствует staff_users (hf_schema_v1.sql, раздел 11). Сотрудники, НЕ
// клиенты. receives_escalations правится из админки; фактическая доставка
// пуша в Telegram зависит от того, привязан ли telegram_chat_id — а это
// происходит только через одноразовую команду "/link <код>" в самом боте
// (Telegram не даёт написать первым тому, кто ещё не писал боту), см.
// agent-bot/orchestrator.py.

export type StaffRole = "owner" | "ops" | "dev";

export interface StaffUser {
  user_id: string;
  display_name: string;
  email: string | null;
  role: StaffRole;
  is_active: boolean;
  receives_escalations: boolean;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  telegram_linked_at: string | null;
  // Запрос 19.07.2026: "столбец с тогглами... кто после 18:00 изменения
  // внёс (вроде до 18 можно)". Моё толкование (флагую явно — формулировка
  // была не до конца однозначной): это про уже существующее правило из
  // level5_order_changes.py (decide_routing) — заявки на изменение заказа
  // после 18:00 дня перед доставкой идут не автоматом, а через ручное
  // одобрение. Этот флаг — кто из сотрудников имеет право такие заявки
  // одобрять. См. GateQueue.tsx, где это используется (подсветка гейтов
  // order_change, заведённых после 18:00, + список тех, кто может одобрить).
  can_approve_after_deadline: boolean;
  // 12.08.2026 — запрос Игоря: пуш в Telegram, когда клиент пишет боту
  // впервые (заводится новый диалог), со ссылкой на карточку диалога.
  // Отдельно от receives_escalations — обычный новый разговор не эскалация.
  notify_new_dialogs: boolean;
}

// --- Очередь эскалаций (19.07.2026) ----------------------------------------
// Соответствует escalations (hf_schema_v1.sql, раздел 8). Рабочий статус
// поверх red_zone_events/agent_dialogs — см. комментарий на таблице в схеме:
// "не мешать исторические факты классификации с текущим состоянием разбора".

export type EscalationStatus = "new" | "in_progress" | "completed";

export interface Escalation {
  escalation_id: string;
  dialog_id: string;
  client_id: string;
  client_display_name: string; // денормализовано для UI
  channel: string;
  message_text: string;
  // "agent_uncertain" — 21.07.2026: агент (Claude) сам эскалирует, когда не
  // уверен/тема вне зелёной зоны (протокол ESCALATE, см. agent-bot/logic/
  // agent_prompt.py) — это не термин из красного стоп-листа, отдельная
  // категория. См. supabase_minimal_schema.sql, CHECK на escalations.category.
  category: RedZoneCategory | "agent_uncertain";
  reason: string;
  status: EscalationStatus;
  created_at: string;
  opened_at: string | null;
  opened_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  // 21.07.2026: реальный ответ Ольги клиенту по этой эскалации — записывается
  // вручную на карточке (необязательно, можно завершить и без него). Нужен
  // как источник для кнопки "сохранить как факт зелёной зоны" (см.
  // CLAUDE.md, 20.07.2026: "чтобы реальный ответ Ольги одним кликом
  // предлагался как новый факт") — без этого поля превратить эскалацию в
  // факт было не из чего.
  resolution_text: string | null;
  // 21.07.2026: что бы АГЕНТ сделал, будь у него разрешение/tool use (см.
  // agent-bot/logic/agent_prompt.py, протокол "ESCALATE: <мысль>") — не
  // путать с resolution_text (что РЕАЛЬНО сделала Ольга). Пара "бот хотел /
  // админ сделал" — материал для будущего решения, какие функции открыть
  // агенту. Null для эскалаций красной зоны (Claude их не видит) и для
  // self-escalation без пояснения (голый "ESCALATE").
  agent_intended_action: string | null;
  // 21.07.2026: Telegram chat_id клиента на момент эскалации — позволяет
  // ответить клиенту прямо из карточки эскалации (см. dataClient.ts,
  // sendMessageToClient() → POST /api/agent-reply → agent-bot
  // POST /admin/reply-to-client), без ручного поиска чата в Telegram.
  // Null для старых/моковых записей — кнопка отправки тогда недоступна.
  client_chat_id: string | null;
}

// --- QA-сканер (26.08.2026) --------------------------------------------------
// Игорь, разбор dlg-904248388-4: "раз в шесть часов проверяй, какие есть
// новые диалоги либо новые сообщения в старых диалогах... находишь баги,
// несостыковки — создаёшь в админке и шлёшь алерт в Телеграм". Соответствует
// таблице qa_findings (agent-bot/supabase_migration_26_qa_findings.sql).
// Отдельно от Escalation выше: находка QA-сканера — это то, что заметил САМ
// бэкенд постфактум по прошедшему разговору, не то, что бот эскалировал
// клиенту в моменте.

export type QaFindingSeverity = "high" | "medium" | "low";
export type QaFindingCategory =
  | "wrong_info_or_price"
  | "contradiction"
  | "ignored_request"
  | "stalled_promise"
  | "confusion"
  | "other";
export type QaFindingStatus = "new" | "resolved" | "dismissed";

export interface QaFinding {
  id: string;
  dialog_id: string;
  client_id: string;
  client_display_name: string;
  severity: QaFindingSeverity;
  category: QaFindingCategory;
  summary: string;
  message_excerpt: string | null;
  status: QaFindingStatus;
  created_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

// --- Заявка на подписку из диалога вручную (26.08.2026) ---------------------
// Игорь: "Ольга должна иметь возможность нажать на кнопку, увидеть в
// отдельном окне информацию по заказу, иметь возможность что-то
// отредактировать и создать". Черновик одного рациона — та же форма, что
// agent-bot/integrations/claude_real.py::SUBSCRIPTION_TOOL (kcal_target/
// paid_days/... /additional_rations), но здесь ВСЕ поля опциональны — это
// РЕДАКТИРУЕМАЯ форма для человека, не готовый вызов инструмента. "Сразу с
// batch" (решение Игоря) — CreateSubscriptionModal.tsx держит массив таких
// черновиков, не один.
export interface SubscriptionDraftRation {
  kcal_target: number | null;
  paid_days: number | null;
  start_date: string | null;
  delivery_address: string | null;
  delivery_time_text: string | null;
  restrictions_note: string | null;
  restrictions_scope: "always" | "this_order" | null;
  recipient_note: string | null;
  payment_note: string | null;
  phone: string | null;
  plan_id: string | null;
  promo_code: string | null;
  client_confirmation_quote: string | null;
}

// --- История изменений / аудит-лог (19.07.2026) ----------------------------
// Запрос: "нужна история изменений. Достаточно кто, когда, что изменил
// (до/после)". Подключено к трём местам, где правки могут быть по ошибке
// необратимы или спорны: термины красной зоны, ограничения клиента,
// настройки уведомлений сотрудников. Не таблица в hf_schema_v1.sql пока —
// это чисто admin-panel фича поверх мока, схему заводить будем, когда
// решим, что логировать в проде (не всё подряд — иначе таблица распухнет).

export type AuditEntityType =
  | "red_zone_term"
  | "client_restriction"
  | "staff_user"
  | "app_setting"
  | "green_zone_fact"
  | "green_zone_category"
  | "subscription"
  | "order_change_request"
  | "subscription_request";
export type AuditAction = "created" | "deactivated" | "updated";

export interface AuditLogEntry {
  entry_id: string;
  entity_type: AuditEntityType;
  entity_id: string;
  entity_label: string; // человекочитаемое описание — что именно изменили
  client_id: string | null; // заполнено для client_restriction — фильтр по карточке клиента
  action: AuditAction;
  before: string | null;
  after: string | null;
  changed_by: string;
  changed_at: string;
}

// --- Настройки приложения (19.07.2026) --------------------------------------
// Соответствует app_settings (hf_schema_v1.sql, раздел 10). Запрос:
// "это время [дедлайн приёма изменений заказа] должно устанавливаться в
// админке" — раньше 18:00 было захардкожено в GateQueue.tsx, теперь это
// настройка, которую Франсуа/Ольга могут поменять сами. ВАЖНО: время само
// по себе всё ещё не подтверждено Франсуа (см. CLAUDE.md, открытый вопрос
// про дедлайн) — 18:00 здесь только дефолт до его ответа.
export const ORDER_DEADLINE_SETTING_KEY = "order_deadline_ict";

// Запрос 20.07.2026: "нужно, чтобы в админке был прописан промт
// (редактируемый), который определяет правила и границы общения агента с
// клиентами. Чтобы Франсуа мог менять сам". Тот же паттерн, что и
// order_deadline_ict — обычная строка в app_settings, без новой таблицы.
// Хранится как текст (value.text), не структурированные поля — это
// свободный текст системного промпта для настоящего Claude (когда
// подключим), не форма. См. AgentSystemPromptSetting.tsx.
export const AGENT_SYSTEM_PROMPT_SETTING_KEY = "agent_system_prompt";

// 22.07.2026: время автоматической выгрузки снимка Google Sheets
// ("Заказы на день") в нашу БД, см. agent-bot/logic/sheets_import.py —
// тот же паттерн, что и order_deadline_ict. ВАЖНО: само время (дефолт
// "22:00") ещё не подтверждено Франсуа — Игорь как раз уточняет у него
// фиксированное время, после которого таблица точно не редактируется
// (см. CLAUDE.md, переписка 22.07.2026).
export const SHEETS_AUTO_IMPORT_TIME_SETTING_KEY = "sheets_auto_import_time_ict";

export interface AppSetting {
  setting_key: string;
  value: Record<string, unknown>;
  description: string | null;
  updated_by: string | null;
  updated_at: string;
}

// 22.07.2026: последний снимок импорта Google Sheets (см. sheet_import_log
// в Supabase, agent-bot/logic/sheets_import.py). raw_rows сознательно НЕ
// включены сюда — это сырой лист целиком, для UI-статуса нужен только
// заголовок снимка, не содержимое.
export interface SheetImportSummary {
  sheet_date: string;
  source_tab: string;
  row_count: number;
  imported_by: "manual" | "auto";
  imported_at: string;
}

// 22.07.2026: то же самое, но для сырого снимка вкладки "1. Клиенты" —
// без sheet_date (это ростер, не датированный снимок дня), append-only,
// см. sheet_clients_snapshot_log в Supabase.
export interface ClientsSnapshotSummary {
  source_tab: string;
  row_count: number;
  imported_by: "manual" | "auto";
  imported_at: string;
}
