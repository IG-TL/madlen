"""
ЗАГЛУШКА хранилища (Supabase/Postgres). Всё в памяти процесса — при
рестарте всё теряется, это ожидаемо для этапа "на моках" (см. решение
18.07.2026). Повторяет ту же идею, что и admin-panel/lib/mockData.ts +
dataClient.ts: одна точка доступа к данным, каждая операция помечена
TODO(supabase) с точным будущим запросом, вызывающий код (orchestrator.py)
эту заглушку не обходит напрямую.

Реализует интерфейс pipeline_gate.Db (get_module_config,
find_gate_by_idempotency_key, insert_gate, resolve_gate) — чтобы
run_step()/resume_after_gate() из logic/pipeline_gate.py работали
без изменений поверх этого мока.
"""

from __future__ import annotations

import secrets
import string
import sys
import uuid
from collections import OrderedDict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).parent.parent))
from logic.pipeline_gate import Db  # noqa: E402

# TODO(madlen): удалены HF-специфичные импорты:
# - client_bootstrap (создание записей клиентов)
# - supabase_client (реальная БД)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# 10.08.2026 — три структуры ниже росли неограниченно в памяти одного
# долгоживущего процесса (см. CLAUDE.md, "Утечка памяти в agent-bot").
# На Render free это маскировалось тем, что инстанс каждые ~15 мин простоя
# засыпал и просыпался с чистой памятью — по сути бесплатный сброс. При
# переезде на свой сервер процесс живёт постоянно, и без границ рано или
# поздно упрётся в OOM. Ниже — жёсткие потолки, подобранные с запасом
# относительно реальной нужды каждой структуры (см. комментарии у каждой).
_MAX_DIALOG_MESSAGES = 40  # это ТОЛЬКО контекст для Claude (orchestrator.py передаёт dialog["messages"] в history без другой обрезки) — полная история навсегда лежит в Supabase dialog_messages, admin-panel читает оттуда, не отсюда.
_MAX_SEEN_UPDATE_IDS = 5000  # дедуп повторной обработки одного и того же вебхука Telegram (сетевые ретраи) — актуальны только недавние update_id, не вся история с момента старта процесса.
_MAX_RED_ZONE_EVENTS = 1000  # запись сюда ничем не смягчена Supabase (insert в реальную таблицу red_zone_events ещё не реализован, см. supabase_client.py) — сейчас это чисто отладочный буфер в рамках процесса, не источник истины.


def _generate_link_code() -> str:
    # 6 символов, без легко путаемых (0/O, 1/I) — код диктуют/копируют руками.
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


class MockDb(Db):
    def __init__(self) -> None:
        # module_registry — TODO(supabase): SELECT * FROM module_registry WHERE module_key = %s
        # Дефолт для "agent_conversation" — свежий module_key, специально
        # заведённый под этот сервис (в hf_schema_v1.sql module_registry
        # уже существует как таблица, но конкретных строк под уровни ТЗ
        # агента там ещё нет — заводим по мере надобности, это техническая
        # деталь оркестрации, не продуктовое решение).
        self.modules: dict[str, dict] = {
            "agent_conversation": {
                "module_key": "agent_conversation",
                "enabled": True,
                "mode": "auto",
                "fallback_on_disable": "wait_for_manual",
            },
        }
        # clients / client_pii — TODO(supabase): SELECT * FROM clients WHERE client_id = %s
        self.clients: dict[str, dict] = {}
        # agent_dialogs — TODO(supabase): INSERT/UPDATE INTO agent_dialogs
        self.dialogs: dict[str, dict] = {}
        self._dialog_by_client: dict[str, str] = {}  # активный диалог на клиента (упрощение мока)
        # 17.08.2026 — реальный баг: "Новый диалог" пуш уходил менеджерам на
        # КАЖДОЕ первое сообщение после рестарта Render (свободный тариф
        # засыпает — _dialog_by_client пуст в памяти нового процесса), даже
        # если диалог на самом деле продолжается годами и просто
        # переиспользован из Supabase (см. get_or_create_dialog ниже). Игорь
        # поймал это на себе: свой же тестовый чат сам себе прислал "новый
        # диалог" сразу после деплоя. См. докстринг get_or_create_dialog.
        self._last_dialog_was_new: bool = False
        # red_zone_events — TODO(supabase): INSERT INTO red_zone_events.
        # deque(maxlen=...) — см. _MAX_RED_ZONE_EVENTS выше, старые события
        # молча вытесняются новыми вместо неограниченного роста.
        self.red_zone_events: deque[dict] = deque(maxlen=_MAX_RED_ZONE_EVENTS)
        # pipeline_gates — TODO(supabase): INSERT/SELECT/UPDATE pipeline_gates
        self.gates: dict[str, dict] = {}
        self._gate_by_idempotency: dict[str, str] = {}

        # staff_users — TODO(supabase): SELECT/UPDATE staff_users (hf_schema_v1.sql,
        # раздел 11). Сотрудники (не клиенты) — Франсуа/Ольга/Игорь для теста.
        # receives_escalations управляется из админки; telegram_chat_id
        # заполняется только через /link-код (см. orchestrator.py) — бот не
        # может написать первым тому, кто ещё ни разу ему не писал.
        self.staff_users: dict[str, dict] = {}
        self._staff_by_link_code: dict[str, str] = {}
        for name, role in (("Франсуа", "owner"), ("Ольга", "ops"), ("Игорь", "dev")):
            self.add_staff_user(name, role=role, created_by="seed")

        # 21.07.2026: дедуп по Telegram update_id (см. orchestrator.py,
        # handle_incoming_message). Раньше единственная защита от повтора
        # была idempotency_key на самом гейте agent_conversation — она НЕ
        # спасала от повторной обработки всего сообщения целиком (лог в
        # диалог, красная зона, реальная отправка клиенту), если Telegram
        # реально ретраит один и тот же вебхук (сетевой сбой/таймаут на
        # Render). TODO(supabase): в реальной БД это была бы просто
        # UNIQUE-констрейнт колонка (или отдельная таблица processed_updates),
        # набор в памяти не переживает рестарт процесса — тот же класс
        # ограничения, что и у остального db_mock.py.
        # 10.08.2026: OrderedDict вместо set — нужна FIFO-эвикция самых
        # старых id при превышении _MAX_SEEN_UPDATE_IDS (см. выше), простой
        # set рос бы неограниченно на постоянно живущем процессе.
        self._seen_update_ids: OrderedDict[str, None] = OrderedDict()

        # escalations — 21.07.2026: локальная копия для симметрии/тестов;
        # если SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY заданы, каждая
        # эскалация ТАКЖЕ (best-effort) пишется в реальную таблицу
        # escalations — раньше это был "архитектурный тупик" (см. CLAUDE.md,
        # 21.07.2026): agent-bot писал только сюда, в память процесса,
        # /escalations в admin-panel физически не могла это увидеть.
        self.escalations: list[dict] = []

        # order_change_requests — 25.07.2026, первый tool use агента
        # (перенос даты доставки). Та же симметрия локальная копия + Supabase
        # best-effort, что и у escalations выше.
        self.order_change_requests: list[dict] = []

        # subscription_requests — 25.07.2026, второй tool use агента
        # (оформление подписки). Та же симметрия, что и order_change_requests.
        self.subscription_requests: list[dict] = []

    def check_and_mark_update(self, update_id: Optional[str]) -> bool:
        """True, если update_id уже видели раньше (дубль, обрабатывать не
        нужно). Если update_id не передан (мок/тесты/старый вызов без
        Telegram) — дедуп не применяется, всегда False."""
        if not update_id:
            return False
        if update_id in self._seen_update_ids:
            self._seen_update_ids.move_to_end(update_id)
            return True
        self._seen_update_ids[update_id] = None
        if len(self._seen_update_ids) > _MAX_SEEN_UPDATE_IDS:
            self._seen_update_ids.popitem(last=False)  # вытесняем самый старый
        return False

    # --- pipeline_gate.Db интерфейс ----------------------------------------

    def get_module_config(self, module_key: str) -> dict:
        # Неизвестный модуль -> безопасный дефолт: включён, авто. Отдельный
        # модуль заводится явно (см. self.modules выше), это не решение "по
        # умолчанию всё выключено" — такое решение продуктовое, не наше.
        return self.modules.get(
            module_key,
            {"module_key": module_key, "enabled": True, "mode": "auto", "fallback_on_disable": "skip"},
        )

    def find_gate_by_idempotency_key(self, idempotency_key: str) -> Optional[dict]:
        gate_id = self._gate_by_idempotency.get(idempotency_key)
        return self.gates.get(gate_id) if gate_id else None

    def insert_gate(self, **kwargs) -> str:
        gate_id = kwargs["gate_id"]
        kwargs.setdefault("created_at", _now_iso())
        self.gates[gate_id] = kwargs
        self._gate_by_idempotency[kwargs["idempotency_key"]] = gate_id
        return gate_id

    def resolve_gate(self, gate_id: str, status: str, resolution_payload: dict, resolved_by: str) -> None:
        gate = self.gates.get(gate_id)
        if not gate:
            return
        gate.update(
            status=status,
            resolution_payload=resolution_payload,
            resolved_by=resolved_by,
            resolved_at=_now_iso(),
        )

    # --- clients -------------------------------------------------------------

    def get_or_create_client(
        self,
        client_id: str,
        display_name: Optional[str] = None,
        tg_username: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> dict:
        if client_id not in self.clients:
            self.clients[client_id] = {
                "client_id": client_id,
                "display_name": display_name or client_id,
                "status": "active",
                "preferred_language": None,
            }
            # 25.07.2026: best-effort автосоздание в Supabase clients/
            # client_pii (см. logic/client_bootstrap.py) — только при ПЕРВОМ
            # создании локальной записи, не на каждое сообщение уже
            # известного клиента. Игорь: "заводи сразу", без апрува — апрув
            # нужен позже, для отдельного действия "оформить подписку" (см.
            # докстринг client_bootstrap.py), не для самого факта появления
            # клиента.
            # 12.08.2026: chat_id (явный параметр, не полагаемся на то, что
            # client_id == chat_id — это так в приватных чатах Telegram
            # сегодня, но выводить это неявно из client_id рискованно) идёт
            # в client_pii.telegram_chat_id — единственное, куда бот вообще
            # может написать проактивно (напоминания и т.п.), см.
            # докстринг client_bootstrap.ensure_client_record.
            # TODO(madlen): реальное создание в Supabase
            self.clients[client_id]["supabase_client_id"] = f"mock_{client_id}"
        return self.clients[client_id]

    # --- agent_dialogs ---------------------------------------------------------

    def get_or_create_dialog(self, client_id: str, channel: str, chat_id: Optional[str] = None) -> dict:
        dialog_id = self._dialog_by_client.get(client_id)
        if dialog_id and self.dialogs[dialog_id]["ended_at"] is None:
            self._last_dialog_was_new = False
            return self.dialogs[dialog_id]

        # display_name — денормализовано для UI (admin-panel читает готовым,
        # без join на clients, которых в этом минимальном срезе Supabase нет).
        display_name = self.clients.get(client_id, {}).get("display_name", client_id)

        # 17.08.2026 — БАГ (см. CLAUDE.md, разбор бага 17.08.2026): память
        # agent-bot пустая при каждом холодном старте Render (свободный тариф
        # засыпает после ~15 мин простоя), а этот метод раньше ВСЕГДА заводил
        # новый dialog_id в такой ситуации — переписка/пауза "взял на себя"
        # после рестарта уходили в НОВУЮ строку Supabase, а не в ту, что уже
        # открыта по старой ссылке /dialogs/<id> в админке (и не видна там
        # никогда, пока кто-то не найдёт новую ссылку). Теперь сначала
        # смотрим в Supabase — есть ли уже диалог этого клиента — и
        # переиспользуем ЕГО dialog_id вместо того, чтобы плодить новый.
        # Best-effort: без Supabase (или при ошибке) — как раньше, новый.
        existing = supabase_client.get_dialog_by_client(client_id)
        if existing and not existing.get("ended_at"):
            self._last_dialog_was_new = False
            dialog_id = existing["dialog_id"]
            dialog = {
                "dialog_id": dialog_id,
                "client_id": client_id,
                "client_display_name": existing.get("client_display_name") or display_name,
                "channel": existing.get("channel") or channel,
                # Буфер для Claude пуст сразу после рестарта — это ожидаемо
                # (см. _MAX_DIALOG_MESSAGES выше): полная история навсегда в
                # Supabase dialog_messages, admin-panel читает её оттуда, не
                # отсюда. Следующие сообщения клиента снова наполнят буфер.
                "messages": [],
                "escalated_to": existing.get("escalated_to"),
                "escalation_reason": existing.get("escalation_reason"),
                "started_at": existing.get("started_at") or _now_iso(),
                "ended_at": None,
                "human_takeover": bool(existing.get("human_takeover")),
                "human_takeover_by": existing.get("human_takeover_by"),
            }
        else:
            self._last_dialog_was_new = True
            dialog_id = f"dlg-{client_id}-{len(self.dialogs) + 1}"
            dialog = {
                "dialog_id": dialog_id,
                "client_id": client_id,
                "client_display_name": display_name,
                "channel": channel,
                "messages": [],
                "escalated_to": None,
                "escalation_reason": None,
                "started_at": _now_iso(),
                "ended_at": None,
                "human_takeover": False,
                "human_takeover_by": None,
            }

        self.dialogs[dialog_id] = dialog
        self._dialog_by_client[client_id] = dialog_id
        # 21.07.2026: best-effort в Supabase (если настроен) — раньше
        # диалоги были видны только в памяти процесса agent-bot, /dialogs
        # и "смотреть переписку" из карточки эскалации в admin-panel не
        # могли их увидеть физически (см. supabase_migration_4_dialogs.sql).
        # upsert по dialog_id — если диалог переиспользован (ветка выше),
        # это просто обновление той же строки, не создание дубля.
        # 17.08.2026: client_chat_id — только если передан (см. докстринг
        # get_or_create_client про то же самое поле у client_pii: не
        # выводим chat_id из client_id неявно, даже если в приватных чатах
        # Telegram они сегодня совпадают).
        upsert_row = {
            "dialog_id": dialog_id,
            "client_id": client_id,
            "client_display_name": dialog["client_display_name"],
            "channel": dialog["channel"],
        }
        if chat_id:
            upsert_row["client_chat_id"] = chat_id
        supabase_client.upsert_dialog(upsert_row)
        return dialog

    def append_dialog_message(
        self, client_id: str, channel: str, role: str, text: str, chat_id: Optional[str] = None
    ) -> dict:
        dialog = self.get_or_create_dialog(client_id, channel, chat_id=chat_id)
        dialog["messages"].append({"role": role, "text": text, "at": _now_iso()})
        # 10.08.2026: обрезаем хвост — dialog["messages"] уходит напрямую в
        # Claude как history (см. orchestrator.py -> claude_real.generate_reply)
        # без всякой другой обрезки, так что без этого лимита он рос бы и
        # памятью процесса, и токенами/ценой запроса на каждое сообщение
        # долгоживущего клиента. Полная история навсегда пишется в Supabase
        # dialog_messages чуть ниже — admin-panel читает оттуда, эта обрезка
        # её не касается.
        if len(dialog["messages"]) > _MAX_DIALOG_MESSAGES:
            del dialog["messages"][: -_MAX_DIALOG_MESSAGES]
        supabase_client.insert_dialog_message(
            {"dialog_id": dialog["dialog_id"], "role": role, "text": text}
        )
        upsert_row = {
            "dialog_id": dialog["dialog_id"],
            "client_id": client_id,
            "client_display_name": dialog["client_display_name"],
            "channel": channel,
            "updated_at": _now_iso(),
        }
        # 17.08.2026 — self-heal client_chat_id и на уже существующих
        # диалогах (та же логика, что и telegram_chat_id, CLAUDE.md
        # 12.08.2026): если раньше диалог завёлся без chat_id, следующее же
        # сообщение его дозаполнит.
        if chat_id:
            upsert_row["client_chat_id"] = chat_id
        supabase_client.upsert_dialog(upsert_row)
        return dialog

    def set_human_takeover(
        self, client_id: str, channel: str, takeover: bool, staff_name: Optional[str] = None
    ) -> dict:
        """17.08.2026 — менеджер берёт диалог на себя из админки (см.
        POST /admin/set-human-takeover в main.py, кнопка "Взять диалог на
        себя" в DialogThread.tsx). Пока флаг включён, handle_incoming_message
        по-прежнему сохраняет входящие сообщения клиента (контекст не
        теряется — модель увидит их и сообщения менеджера при возврате
        управления), но не генерирует и не шлёт автоответ, не эскалирует и
        не гоняет красную зону. Явный тумблер (не автовозврат по таймауту —
        решение Игоря 17.08.2026): "вернуть боту" — та же ручка с
        takeover=False."""
        dialog = self.get_or_create_dialog(client_id, channel)
        dialog["human_takeover"] = takeover
        dialog["human_takeover_by"] = staff_name if takeover else None
        supabase_client.upsert_dialog(
            {
                "dialog_id": dialog["dialog_id"],
                "client_id": client_id,
                "client_display_name": dialog["client_display_name"],
                "channel": channel,
                "human_takeover": takeover,
                "human_takeover_by": dialog["human_takeover_by"],
                "human_takeover_at": _now_iso(),
            }
        )
        return dialog

    def escalate_dialog(self, client_id: str, channel: str, escalated_to: str, reason: str) -> dict:
        dialog = self.get_or_create_dialog(client_id, channel)
        dialog["escalated_to"] = escalated_to
        dialog["escalation_reason"] = reason
        supabase_client.upsert_dialog(
            {
                "dialog_id": dialog["dialog_id"],
                "client_id": client_id,
                "client_display_name": dialog["client_display_name"],
                "channel": channel,
                "escalated_to": escalated_to,
                "escalation_reason": reason,
            }
        )
        return dialog

    # --- сброс тестового аккаунта (19.08.2026) ------------------------------

    def reset_client_memory(self, client_id: str) -> dict:
        """19.08.2026 — запрос Игоря: возможность "чистить историю переписки
        у аккаунтов админов в тг", чтобы при следующем сообщении бот
        встретил их как нового пользователя (для тестов). Реальное удаление
        строк (clients/client_pii/dialogs/dialog_messages/... в Supabase)
        делает admin-panel напрямую (см. app/api/testing/reset-client/route.ts
        — там же проверка, что client_id это привязанный telegram_chat_id
        кого-то из staff_users, а не случайный реальный клиент). Эта функция
        чистит ТОЛЬКО память живого процесса agent-bot — без неё после
        удаления в Supabase процесс, если он не спал с рестарта, всё равно
        помнил бы старый dialog_id/client_id из self._dialog_by_client и
        self.clients (get_or_create_dialog смотрит туда ПЕРВЫМ делом, до
        Supabase — см. докстринг выше) и "новый" разговор продолжил бы
        старый диалог вместо создания нового. На холодном Render (спит
        ~15 мин простоя) это не проявилось бы само по себе — но полагаться
        на то, что процесс окажется холодным именно в момент теста,
        ненадёжно, поэтому чистим явно."""
        dialog_id = self._dialog_by_client.pop(client_id, None)
        had_dialog = dialog_id is not None
        if dialog_id:
            self.dialogs.pop(dialog_id, None)
        had_client = client_id in self.clients
        self.clients.pop(client_id, None)
        return {"had_dialog": had_dialog, "had_client": had_client}

    # --- red_zone_events ---------------------------------------------------

    def log_red_zone_event(self, row: dict) -> None:
        self.red_zone_events.append(row)

    # --- staff_users (получатели пушей об эскалации) ------------------------

    def add_staff_user(self, display_name: str, role: str = "ops", created_by: Optional[str] = None) -> dict:
        # TODO(supabase): INSERT INTO staff_users (display_name, role, telegram_link_code, created_by) ...
        user_id = str(uuid.uuid4())
        row = {
            "user_id": user_id,
            "display_name": display_name,
            "email": None,
            "role": role,
            "is_active": True,
            "receives_escalations": False,
            # 12.08.2026 — отдельная галочка от receives_escalations: пуш о
            # том, что клиент написал впервые (новый диалог), это не то же
            # самое, что эскалация. См. get_new_dialog_recipients ниже.
            "notify_new_dialogs": False,
            "telegram_chat_id": None,
            "telegram_username_hint": None,
            "telegram_link_code": _generate_link_code(),
            "telegram_linked_at": None,
            "created_by": created_by,
            "created_at": _now_iso(),
        }
        self.staff_users[user_id] = row
        self._staff_by_link_code[row["telegram_link_code"]] = user_id
        return row

    def list_staff_users(self) -> list[dict]:
        # 21.07.2026: если Supabase настроен — читаем реальную таблицу
        # (общий источник истины с admin-panel/settings, галочки
        # receives_escalations/can_approve_after_deadline теперь видны
        # без ручного дублирования в два мока). Пустой список при
        # ошибке/недоступности намеренно трактуем как "падаем на локальный
        # сид" — известный компромисс: если таблица В Supabase реально
        # пуста (сид не прогнали), это тоже даст локальный фолбэк, а не
        # честную пустоту. Приемлемо, т.к. seed из supabase_minimal_schema.sql
        # всегда заводит 3 строки.
        if supabase_client.is_configured():
            rows = supabase_client.list_staff_users()
            if rows:
                return rows
        return list(self.staff_users.values())

    def set_receives_escalations(self, user_id: str, value: bool) -> Optional[dict]:
        # TODO(supabase): UPDATE staff_users SET receives_escalations = %s WHERE user_id = %s
        user = self.staff_users.get(user_id)
        if not user:
            return None
        user["receives_escalations"] = value
        return user

    def set_notify_new_dialogs(self, user_id: str, value: bool) -> Optional[dict]:
        # 12.08.2026 — тот же паттерн, что set_receives_escalations выше;
        # реальное переключение делает admin-panel напрямую в Supabase
        # (см. staff_users_notify_new_dialogs), это для локальных тестов.
        user = self.staff_users.get(user_id)
        if not user:
            return None
        user["notify_new_dialogs"] = value
        return user

    def regenerate_link_code(self, user_id: str) -> Optional[dict]:
        user = self.staff_users.get(user_id)
        if not user:
            return None
        old_code = user["telegram_link_code"]
        if old_code:
            self._staff_by_link_code.pop(old_code, None)
        new_code = _generate_link_code()
        user["telegram_link_code"] = new_code
        self._staff_by_link_code[new_code] = user_id
        return user

    def link_staff_user(self, code: str, telegram_chat_id: str) -> Optional[dict]:
        # Вызывается из orchestrator.py при команде "/link <код>" — единственный
        # способ заполнить telegram_chat_id (см. комментарий в __init__).
        code_norm = code.strip().upper()
        if supabase_client.is_configured():
            # Supabase — источник истины настоящих кодов, если настроен: не
            # откатываемся на локальный сид при "код не найден" (иначе можно
            # было бы связать чужой локальный код, который в реальности уже
            # не существует). Сетевой сбой здесь тоже даёт None — сотрудник
            # увидит "код не найден", попробует ещё раз, это приемлемый
            # fail-safe (см. supabase_client.py, best-effort).
            staff = supabase_client.find_staff_by_link_code(code_norm)
            if not staff:
                return None
            updated = supabase_client.update_staff_user(
                staff["user_id"],
                {"telegram_chat_id": telegram_chat_id, "telegram_linked_at": _now_iso()},
            )
            return updated or staff
        user_id = self._staff_by_link_code.get(code_norm)
        if not user_id:
            return None
        user = self.staff_users[user_id]
        user["telegram_chat_id"] = telegram_chat_id
        user["telegram_linked_at"] = _now_iso()
        return user

    def find_staff_by_chat_id(self, chat_id: str) -> Optional[dict]:
        """22.07.2026 — вход в admin-panel по QR через Telegram (см.
        CLAUDE.md). Ищет уже привязанного сотрудника (см. link_staff_user/
        "/link <код>" — привязка должна произойти РАНЬШЕ первого входа по
        QR) по chat_id того, кто написал боту. list_staff_users() уже сама
        решает Supabase-vs-локальный-сид (см. выше)."""
        for user in self.list_staff_users():
            if user.get("telegram_chat_id") == chat_id:
                return user
        return None

    def confirm_login_token(self, token: str, staff_user_id: str) -> bool:
        """Подтверждает вход в admin-panel по QR (см. CLAUDE.md,
        "Вход в админку по QR через Telegram") — требует настоящего
        Supabase (login_tokens там же, где admin-panel читает статус
        опроса) — в мок-режиме отдельного состояния для входа нет, входа
        просто не будет (возвращаем False, бот ответит понятной ошибкой,
        см. orchestrator.py)."""
        if supabase_client.is_configured():
            return supabase_client.confirm_login_token(token, staff_user_id)
        return False

    def get_escalation_recipients(self) -> list[dict]:
        # 21.07.2026: используем list_staff_users() (уже проксирует в
        # Supabase, если настроен) вместо прямого чтения self.staff_users —
        # иначе получатели пушей не видели бы галочки, включённые через
        # admin-panel/settings в реальной БД.
        return [
            u
            for u in self.list_staff_users()
            if u.get("receives_escalations") and u.get("telegram_chat_id") and u.get("is_active", True)
        ]

    def get_new_dialog_recipients(self) -> list[dict]:
        # 12.08.2026 — тот же паттерн, что get_escalation_recipients выше,
        # отдельный флаг (см. миграция staff_users_notify_new_dialogs):
        # "новый диалог" — не эскалация, у него свои подписчики.
        return [
            u
            for u in self.list_staff_users()
            if u.get("notify_new_dialogs") and u.get("telegram_chat_id") and u.get("is_active", True)
        ]

    # --- escalations (видны в /escalations админки, 21.07.2026) --------------

    def create_escalation_record(
        self,
        client_id: str,
        dialog_id: Optional[str],
        client_display_name: str,
        channel: str,
        message_text: str,
        category: str,
        reason: str,
        agent_intended_action: Optional[str] = None,
        client_chat_id: Optional[str] = None,
    ) -> str:
        """Пишет реальную эскалацию и в локальную копию (симметрия/тесты),
        и (best-effort, если настроен) в Supabase — раньше это было
        невозможно физически, см. комментарий у self.escalations в __init__.
        Сбой записи в Supabase не влияет на ответ клиенту — insert_escalation
        сама глотает исключения (см. supabase_client.py).

        agent_intended_action (21.07.2026) — что бы агент сделал, будь у
        него разрешение/tool use (см. logic/agent_prompt.py). None для
        эскалаций красной зоны (Claude вообще не видит эти сообщения) и для
        self-escalation без пояснения (голый "ESCALATE") — это ожидаемо, не
        ошибка. Требует колонку escalations.agent_intended_action в Supabase
        (см. supabase_migration_2_agent_intended_action.sql).

        client_chat_id (21.07.2026) — Telegram chat_id клиента, сохраняется
        прямо в строке эскалации, чтобы Ольга/Франсуа могли ответить клиенту
        из админки (см. POST /admin/reply-to-client в main.py) без ручного
        поиска чата — раньше chat_id нигде персистентно не хранился и был
        недоступен админке. Требует колонку escalations.client_chat_id
        (см. supabase_migration_3_client_chat_id.sql).

        Возвращает escalation_id (24.07.2026) — генерируем его здесь сами
        (не полагаемся на дефолт Supabase) и передаём тем же значением и в
        локальную копию, и в Supabase — чтобы оркестратор мог сразу
        построить ссылку на карточку эскалации в админке для пуша в
        Telegram (см. orchestrator._notify_escalation_recipients), не делая
        отдельный запрос на чтение только что созданной строки."""
        escalation_id = str(uuid.uuid4())
        row = {
            "escalation_id": escalation_id,
            "dialog_id": dialog_id or f"dlg-{client_id}",
            "client_id": client_id,
            "client_display_name": client_display_name,
            "channel": channel,
            "message_text": message_text,
            "category": category,
            "reason": reason,
            "agent_intended_action": agent_intended_action,
            "client_chat_id": client_chat_id,
        }
        self.escalations.append(row)
        supabase_client.insert_escalation(row)
        return escalation_id

    # --- order_change_requests (25.07.2026, первый tool use агента) ---------

    def create_order_change_request(
        self,
        client_id: str,
        client_display_name: str,
        dialog_id: Optional[str],
        new_date: str,
        scope: str,
        client_confirmation_quote: str,
        range_end_date: Optional[str] = None,
        current_date_hint: Optional[str] = None,
        matched_via: str = "none",
        matched_order_name: Optional[str] = None,
        client_chat_id: Optional[str] = None,
    ) -> str:
        """Заводит запрос на перенос даты доставки со статусом
        pending_approval — НИКОГДА не применяется здесь автоматически (см.
        supabase_migration_11_order_change_requests.sql, Игорь: "давай
        сделаем всегда апрув от админа"). Локальная копия + best-effort
        запись в Supabase, тот же паттерн, что create_escalation_record выше."""
        request_id = str(uuid.uuid4())
        row = {
            "request_id": request_id,
            "client_id": client_id,
            "client_display_name": client_display_name,
            "client_chat_id": client_chat_id,
            "dialog_id": dialog_id,
            "scope": scope,
            "current_date_hint": current_date_hint,
            "new_date": new_date,
            "range_end_date": range_end_date,
            "matched_via": matched_via,
            "matched_order_name": matched_order_name,
            "client_confirmation_quote": client_confirmation_quote,
            "status": "pending_approval",
        }
        self.order_change_requests.append(row)
        supabase_client.insert_order_change_request(row)
        return request_id

    # --- subscription_requests (25.07.2026, второй tool use агента) --------

    def create_subscription_request(
        self,
        client_id: str,
        client_display_name: str,
        dialog_id: Optional[str],
        kcal_target: int,
        start_date: str,
        paid_days: int,
        discount_pct: float,
        price_total: float,
        client_confirmation_quote: str,
        supabase_client_id: Optional[str] = None,
        client_chat_id: Optional[str] = None,
        # 06.08.2026 (миграция 16) — подтверждённое клиентом на итоговой
        # сверке. Все три опциональны: клиент мог не назвать адрес/время, а
        # блокировать из-за этого оформление неправильно.
        delivery_address: Optional[str] = None,
        delivery_time_text: Optional[str] = None,
        restrictions_note: Optional[str] = None,
        # 25.08.2026 — 'always' (постоянное ограничение, идёт в карточку
        # клиента) / 'this_order' (только этот заказ, не идёт в карточку) —
        # см. logic/subscription_apply.py и _SUBSCRIPTION_INSTRUCTION.
        # По умолчанию 'always' — тот же смысл, что был у restrictions_note
        # ДО этого разделения (миграция add_restrictions_scope_to_
        # subscription_requests, тот же дефолт и в самой колонке).
        restrictions_scope: str = "always",
        # 06.08.2026 (миграция 18) — для кого рацион, если не для самого
        # клиента. У одного клиента бывает несколько параллельных подписок.
        recipient_note: Optional[str] = None,
        # 17.08.2026 — способ оплаты, как ответил клиент (Игорь: "менеджер
        # должен знать как хочет оплатить клиент"). Отдельно от
        # payment_status, который проставляет менеджер при апруве.
        payment_note: Optional[str] = None,
        # 19.08.2026 (миграция add_phone_to_subscription_flow) — снова
        # обязательное поле (было запрещено спрашивать 17.08.2026, Игорь
        # вернул требование обратно). Тот же паттерн, что payment_note —
        # копируется в client_pii.phone при апруве, см. subscription_apply.py.
        phone: Optional[str] = None,
        # 18.08.2026 (миграция 27/28) — коворкинг: тариф с фиксированной
        # ценой (обед/ужин, см. logic/promo_codes.calc_flat_rate_price) и
        # применённый промокод. Оба опциональны — обычная подписка по ккал
        # без промокода передаёт их как None, ничего не меняется.
        plan_id: Optional[str] = None,
        promo_code_id: Optional[str] = None,
        promo_code_text: Optional[str] = None,
        # 26.08.2026 — заявка, созданная Ольгой вручную из карточки диалога
        # (см. main.py, /admin/create-subscription-from-dialog), а не ботом
        # по итогам обычного propose_subscription — Игорь: "бывает, что
        # происходит эскалация и Ольге нужно вручную создавать заявку, хотя
        # в диалоге есть вся инфа и агент просто не создал заявку". None —
        # обычный путь через бота (как и раньше), имя сотрудника — этот
        # путь. Отдельно от decided_by (тот же человек тоже сразу
        # "одобряет" — created_by отличает "заведено вручную" от "заведено
        # ботом, одобрено потом").
        created_by: Optional[str] = None,
    ) -> str:
        """Заводит запрос на оформление подписки со статусом
        pending_approval — НИКОГДА не применяется здесь автоматически (тот
        же принцип, что и create_order_change_request выше, Игорь: "Делай"
        после уточнения — апрув всегда, автоматики нет). Локальная копия +
        best-effort запись в Supabase.

        supabase_client_id — uuid Supabase clients.client_id (см.
        logic/client_bootstrap.py), нужен для реального создания строки
        subscriptions при апруве (см. logic/subscription_apply.py). Может
        быть None, если у клиента в Telegram нет публичного username —
        см. ограничение в client_bootstrap.py, апрув такой заявки потребует
        ручного вмешательства."""
        request_id = str(uuid.uuid4())
        row = {
            "request_id": request_id,
            "client_id": client_id,
            "client_display_name": client_display_name,
            "client_chat_id": client_chat_id,
            "dialog_id": dialog_id,
            "supabase_client_id": supabase_client_id,
            "kcal_target": kcal_target,
            "start_date": start_date,
            "paid_days": paid_days,
            "discount_pct": discount_pct,
            "price_total": price_total,
            "client_confirmation_quote": client_confirmation_quote,
            "delivery_address": delivery_address,
            "delivery_time_text": delivery_time_text,
            "restrictions_note": restrictions_note,
            "restrictions_scope": restrictions_scope,
            "recipient_note": recipient_note,
            "payment_note": payment_note,
            "phone": phone,
            "plan_id": plan_id,
            "promo_code_id": promo_code_id,
            "promo_code_text": promo_code_text,
            "created_by": created_by,
            "status": "pending_approval",
        }
        self.subscription_requests.append(row)
        supabase_client.insert_subscription_request(row)
        return request_id
