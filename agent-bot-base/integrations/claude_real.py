"""
Реальный вызов Claude (Anthropic API).

Согласовано с Игорем 20.07.2026: "пока только эскалируем если что и всё" —
первая версия была БЕЗ tool use, агент только разговаривал по системному
промпту + справочнику фактов зелёной зоны (logic/agent_prompt.py).

25.07.2026 — первый настоящий tool use: перенос даты доставки (level5,
тип "перенос", первый из 4). Реализовано как ОДИН вызов messages.create()
с tools=[ORDER_CHANGE_TOOL], без полного агентного цикла (без обратной
подачи tool_result модели за отдельный шаг) — это осознанное упрощение:
инструмент здесь fire-and-forget (заводит запись на апрув в БД), сам текст
ответа клиенту после вызова инструмента ФИКСИРОВАННЫЙ (собирается
оркестратором), а не текст модели — тот же принцип, что уже применён к
ESCALATE (не доверяем модели сырой текст в чувствительных местах, см. баг
21.07.2026 "утечка ESCALATE клиенту"). Значит эту reply-часть от модели
после tool_use блока мы просто игнорируем, если он есть.

25.07.2026 — второй tool use: оформление подписки (propose_subscription,
Игорь: "Делай" — клиент узнаёт пакеты подписок в чате и берёт один). Тот же
принцип fire-and-forget + недоверие сырому тексту модели рядом с
tool_use, что и у переноса даты. Цена/скидка СЧИТАЮТСЯ НЕ МОДЕЛЬЮ — модель
только передаёт kcal_target/paid_days/start_date, оркестратор сам вызывает
logic/level2_pricing.calc_subscription_price() по подтверждённым числам из
app_settings (см. logic/subscription_pricing.py) — та же логика, что и
"не доверяем арифметику LLM", уже применённая к деньгам в level2 ТЗ агента.

Красная зона (жёсткий стоп-лист) остаётся отдельным слоем ДО этого вызова
(см. orchestrator.py) — Claude вообще не видит сообщения, уже
эскалированные слоем 1, они сюда не доходят.

Протокол эскалации без tool use: промпт (logic/agent_prompt.py) просит
Claude ответить ровно словом ESCALATE, если не уверен / тема не покрыта
зелёной зоной — generate_reply() ловит это и возвращает escalate=True,
дальше решает оркестратор (не отправляет "ESCALATE" клиенту как текст).

Сетевые сбои (таймаут, невалидный ключ, лимит, что угодно) — тоже
трактуются как escalate=True: лучше передать Ольге вручную, чем уронить
обработку сообщения или промолчать клиенту.
"""

from __future__ import annotations

import logging
import os
import threading
import time

from logic.agent_prompt import (
    build_system_prompt_parts,
    is_escalate_signal,
    extract_intended_action,
)

# 19.08.2026 — Игорь: "давай вернем логи быстро, я хочу протестть разницу
# между апи" — сравнение скорости прямого ключа vs прокси теперь, когда
# переключаться можно за 15 сек через админку, не передеплоивая. Минимальный
# вариант (не вся диагностика, что была раньше при поиске бага) — только
# elapsed вокруг messages.create() + какой режим сейчас активен, чтобы сразу
# видно было, какая строка к какому ключу относится. Явный handler нужен по
# той же причине, что и раньше: нигде в проекте нет logging.basicConfig(),
# дефолтный уровень root-логгера — WARNING, INFO молча теряется.
_DIAG_LOGGER = logging.getLogger("agent-bot.claude_real")
_DIAG_LOGGER.setLevel(logging.WARNING)
if not _DIAG_LOGGER.handlers:
    _diag_handler = logging.StreamHandler()
    _diag_handler.setLevel(logging.WARNING)
    _DIAG_LOGGER.addHandler(_diag_handler)

# 19.08.2026 — переключатель "прямой API vs прокси" из админки (Игорь: "для
# тестов нужно быстро переключаться"). Тот же приём опционального импорта,
# что и в logic/agent_prompt.py/logic/start_greeting.py.
try:
    from integrations import supabase_client
except ImportError:  # pragma: no cover
    supabase_client = None

DEFAULT_MODEL = "claude-sonnet-5"

# 19.08.2026 — официальный адрес Anthropic API, ЯВНО передаётся в клиента в
# режиме "direct" (см. _get_client() ниже) — иначе SDK молча подставит
# ANTHROPIC_BASE_URL из окружения (адрес прокси aiprimetech.io, нужен для
# режима "proxy"), и прямой ключ будет слать запросы не туда. Тот же адрес,
# что и дефолт самого SDK (anthropic.Anthropic.__init__) — здесь не
# полагаемся на дефолт SDK, чтобы поведение не зависело от версии пакета.
DIRECT_API_BASE_URL = "https://api.anthropic.com"

# 25.07.2026 — схема инструмента для Anthropic tools=[...]. Модель вызывает
# его САМА, только после явного подтверждения клиента в разговоре (см.
# _ORDER_CHANGE_INSTRUCTION в logic/agent_prompt.py — это текстовая
# инструкция, объясняющая протокол; здесь только формальная JSON-схема
# аргументов). Ничего в БД/Sheet не применяется на этом шаге — вызов
# инструмента лишь заводит запись со статусом pending_approval (см.
# orchestrator.py, db.create_order_change_request).
ORDER_CHANGE_TOOL_NAME = "propose_delivery_reschedule"

ORDER_CHANGE_TOOL = {
    "name": ORDER_CHANGE_TOOL_NAME,
    "description": (
        "Вызывать ТОЛЬКО сразу после того, как клиент явно подтвердил "
        "перенос даты доставки, который ты уже озвучил ему текстом в "
        "предыдущей реплике. Не вызывать на первое упоминание просьбы — "
        "сначала свериться словами, потом, при подтверждении, вызвать это."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "new_date": {
                "type": "string",
                "description": "Новая дата доставки в формате YYYY-MM-DD.",
            },
            "scope": {
                "type": "string",
                "enum": ["one_time", "range", "permanent"],
                "description": (
                    "one_time — только этот конкретный день; range — на "
                    "определённый период (например 'на неделю', тогда "
                    "обязательно укажи range_end_date); permanent — насовсем."
                ),
            },
            "range_end_date": {
                "type": "string",
                "description": "Конечная дата периода в формате YYYY-MM-DD — только если scope='range'.",
            },
            "client_confirmation_quote": {
                "type": "string",
                "description": "Дословная реплика клиента, которой он подтвердил перенос (для аудита).",
            },
        },
        "required": ["new_date", "scope", "client_confirmation_quote"],
    },
}

# 25.07.2026 — второй инструмент: оформление подписки. Вызывается ТОЛЬКО
# после явного подтверждения клиента (см. _SUBSCRIPTION_INSTRUCTION в
# logic/agent_prompt.py) — сама цена не передаётся моделью, оркестратор
# считает её сам по kcal_target/paid_days (см. докстринг файла выше).
#
# 16.08.2026 — этим же инструментом (не отдельным) оформляется и РАЗОВЫЙ
# заказ на один день: paid_days=1, скидка тогда 0% сама по себе (тиры скидок
# начинаются от 5 дней), отдельная инфраструктура под "разовый заказ" не
# нужна — см. _SUBSCRIPTION_INSTRUCTION про то, как модель различает эти два
# случая словами клиенту ("заказ" vs "подписка"), и logic/subscription_apply.py
# про разные тексты поздравления.
SUBSCRIPTION_TOOL_NAME = "propose_subscription"

SUBSCRIPTION_TOOL = {
    "name": SUBSCRIPTION_TOOL_NAME,
    "description": (
        "Вызывать ТОЛЬКО сразу после того, как клиент подтвердил ИТОГОВУЮ "
        "сверку: в предыдущей реплике ты перечислил ему одним списком тариф "
        "и калорийность, срок, дату начала, стоимость, адрес доставки, "
        "удобное время и ограничения по еде для КАЖДОГО рациона — и спросил, "
        "всё ли верно. Не вызывать на первое упоминание интереса к подписке "
        "и не вызывать, пока итоговая сверка не проговорена и не подтверждена. "
        "Этим же инструментом оформляется и разовый заказ на один день "
        "(paid_days=1) — это не подписка, но технически тот же вызов. Если "
        "клиент за один раз подтвердил НЕСКОЛЬКО рационов (напр. разные даты "
        "или разные получатели) — передай первый рацион верхнеуровневыми "
        "полями этого инструмента, а каждый следующий — отдельным объектом "
        "в additional_rations. Один вызов инструмента = одно подтверждение "
        "клиента, сколько бы рационов оно ни покрывало — НЕ вызывай "
        "инструмент повторно на этот же список рационов."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "kcal_target": {
                "type": "integer",
                "description": "Калорийность рациона (напр. 1500, 2500, 3000).",
            },
            "paid_days": {
                "type": "integer",
                "description": (
                    "Срок предоплаты в днях (напр. 'неделя' -> 7, 'месяц' -> 30, либо точное "
                    "число от клиента). 1 — разовый заказ на один день, не подписка."
                ),
            },
            "start_date": {
                "type": "string",
                "description": "Дата начала подписки в формате YYYY-MM-DD.",
            },
            "client_confirmation_quote": {
                "type": "string",
                "description": "Дословная реплика клиента, которой он подтвердил итоговую сверку (для аудита).",
            },
            # 06.08.2026 — то, что клиент подтвердил на финальной сверке.
            # Едет в subscription_requests и при апруве переносится в карточку
            # клиента (миграция 16, logic/subscription_apply.py). Поля
            # необязательные: если клиент не назвал адрес/время, лучше
            # оформить заявку без них, чем не оформить вовсе — менеджер
            # увидит пропуск при апруве.
            "delivery_address": {
                "type": "string",
                "description": (
                    "Адрес доставки, подтверждённый на итоговой сверке — по возможности ссылкой "
                    "из Google Maps, как её прислал клиент. Если ссылки нет, передай адрес "
                    "текстом как есть. Пропусти, если клиент адрес так и не назвал."
                ),
            },
            "delivery_time_text": {
                "type": "string",
                "description": "Удобное время доставки словами, как сказал клиент (напр. '10:00-12:00', 'до обеда'). Пропусти, если не обсуждали.",
            },
            # 06.08.2026 — у клиента может быть несколько параллельных
            # подписок: он может оформить рацион себе и, например, супруге.
            # Агент обязан спросить, для кого, если активная подписка уже есть.
            "recipient_note": {
                "type": "string",
                "description": (
                    "Для кого этот рацион, если не для самого клиента (напр. 'для супруги', "
                    "'для мамы'), словами клиента. Пропусти, если рацион для него самого."
                ),
            },
            "restrictions_note": {
                "type": "string",
                "description": (
                    "Что клиент ответил про аллергии и ограничения по еде на итоговой сверке, "
                    "как есть. Явное 'нет' тоже записывай — это значимый ответ. Пропусти "
                    "только если вопрос не задавался."
                ),
            },
            # 25.08.2026 — Игорь: "клиент может любить фасоль, но не хотеть
            # фасоль в каком-то блюде и попросить в этот день это блюдо без
            # фасоли" — такая просьба НЕ должна лечь в карточку клиента как
            # постоянное "не ест фасоль" (см. logic/subscription_apply.py:
            # только 'always' попадает в client_restrictions, 'this_order' —
            # только в саму заявку). Обязательно только если restrictions_note
            # заполнено — по умолчанию 'always', как раньше.
            "restrictions_scope": {
                "type": "string",
                "enum": ["always", "this_order"],
                "description": (
                    "К чему относится restrictions_note. 'always' — постоянное ограничение: "
                    "аллергия или то, чего клиент вообще не ест (напр. 'аллергия на орехи', "
                    "'не ем молочное'). 'this_order' — просьба только на этот конкретный "
                    "заказ/рацион, не постоянная (напр. клиент любит фасоль, но в этот раз "
                    "попросил без фасоли в конкретном блюде, или 'сегодня без лука'). Если из "
                    "формулировки клиента неясно, что он имел в виду — используй 'always': "
                    "лучше лишний раз сохранить, чем забыть настоящую аллергию."
                ),
            },
            # 17.08.2026 — Игорь: "способ оплаты давай сохранять как-то,
            # менеджер должен знать как хочет оплатить клиент". Отдельно от
            # payment_status (который позже проставляет менеджер при
            # одобрении заявки, см. logic/subscription_apply.py) — это
            # именно то, что ответил клиент в переписке.
            "payment_note": {
                "type": "string",
                "description": (
                    "Как клиент хочет оплатить (напр. 'наличные курьеру', 'QR-код'), "
                    "словами клиента. Пропусти, если способ оплаты не обсуждали."
                ),
            },
            # 19.08.2026 — Игорь вернул это требование обратно (было запрещено
            # спрашивать 17.08.2026, теперь снова обязательно, см.
            # _SUBSCRIPTION_INSTRUCTION). Пишется в subscription_requests.phone
            # и переносится в client_pii.phone при апруве (logic/subscription_apply.py) —
            # тот же приём, что и с адресом (не перетирает phone тарифа
            # коворкинга, если он вдруг там тоже есть — телефон у тарифов не
            # хранится вовсе, этот случай не встречается).
            "phone": {
                "type": "string",
                "description": (
                    "Номер телефона клиента, подтверждённый на итоговой сверке, как есть. "
                    "Обязательное поле — не пропускай."
                ),
            },
            # 18.08.2026 — тарифы с фиксированной ценой за день (обед/ужин,
            # только для коворкинга — см. справочник тарифов выше в
            # промпте). У таких тарифов kcal_target всё равно нужно передать
            # (номинальное значение из справочника), но ЦЕНУ бэкенд посчитает
            # НЕ по ккал-прайслисту, а напрямую по plan_id — если его не
            # передать для тарифа с фиксированным адресом, бэкенд посчитает
            # цену неправильно (по обычному ккал-прайслисту).
            "plan_id": {
                "type": "string",
                "description": (
                    "plan_id тарифа из справочника выше — ОБЯЗАТЕЛЬНО передавай для тарифов "
                    "с фиксированным адресом доставки (обед/ужин для коворкинга), иначе цена "
                    "посчитается неправильно. Для обычного рациона по калорийности — не передавай."
                ),
            },
            "promo_code": {
                "type": "string",
                "description": (
                    "Код промокода, если клиент его назвал (напр. 'SPACE'). Бэкенд сам "
                    "проверит, действует ли он (первый заказ клиента, срок действия, к какому "
                    "тарифу применим) — ты не решаешь и не считаешь скидку по промокоду сам, "
                    "просто передай код как есть."
                ),
            },
            # 24.08.2026 — batch (см. описание инструмента выше и реальный
            # баг dlg-933735147-1): дополнительные рационы того же
            # подтверждения клиента, КРОМЕ первого (он идёт в
            # верхнеуровневых полях этого же инструмента). Каждый элемент —
            # та же форма полей: kcal_target/paid_days/start_date
            # обязательны внутри объекта, остальные — как у верхнеуровневых
            # полей выше (те же правила: пропускай, если не обсуждали).
            "additional_rations": {
                "type": "array",
                "description": (
                    "Остальные рационы этого же подтверждения клиента, кроме первого. Пусто "
                    "или не передавай вовсе, если рацион один."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "kcal_target": {"type": "integer", "description": "Калорийность этого рациона."},
                        "paid_days": {"type": "integer", "description": "Срок предоплаты в днях для этого рациона."},
                        "start_date": {"type": "string", "description": "Дата начала этого рациона в формате YYYY-MM-DD."},
                        "delivery_address": {"type": "string", "description": "Адрес доставки для этого рациона, если отличается или тоже подтверждён."},
                        "delivery_time_text": {"type": "string", "description": "Удобное время доставки для этого рациона."},
                        "recipient_note": {"type": "string", "description": "Для кого этот рацион, если не для самого клиента."},
                        "restrictions_note": {"type": "string", "description": "Ограничения по еде для этого рациона, как ответил клиент."},
                        "restrictions_scope": {
                            "type": "string",
                            "enum": ["always", "this_order"],
                            "description": "Как у верхнеуровневого restrictions_scope — постоянное ('always') или только на этот рацион ('this_order').",
                        },
                        "payment_note": {"type": "string", "description": "Способ оплаты для этого рациона, если обсуждали отдельно."},
                        "phone": {"type": "string", "description": "Номер телефона, подтверждённый на сверке для этого рациона."},
                        "plan_id": {"type": "string", "description": "plan_id тарифа с фиксированным адресом, если применимо к этому рациону."},
                        "promo_code": {"type": "string", "description": "Промокод, если клиент назвал его для этого рациона."},
                    },
                    "required": ["kcal_target", "paid_days", "start_date"],
                },
            },
        },
        "required": ["kcal_target", "paid_days", "start_date", "client_confirmation_quote"],
    },
    # 19.08.2026 — cache_control на ПОСЛЕДНЕМ инструменте кэширует у
    # Anthropic весь tools-блок целиком (оба инструмента — они одинаковые
    # на каждом вызове, порядок в списке важен для кэша). Тот же приём, что
    # и для статической части системного промпта ниже — см.
    # build_system_prompt_parts()/generate_reply().
    "cache_control": {"type": "ephemeral"},
}

# 26.08.2026 — QA-сканер (Игорь: "раз в 6 часов проверяй новые диалоги/
# сообщения, ищи баги/несостыковки, создавай находку в админке и шли
# алерт"). Отдельный, форсированный tool_choice-вызов (см.
# review_dialog_for_issues ниже) — не то же самое, что обычный
# generate_reply: здесь модель не отвечает клиенту, а РЕЦЕНЗИРУЕТ уже
# состоявшийся разговор постфактум, роль другая (QA-ревьюер, не агент
# поддержки).
QA_REVIEW_TOOL_NAME = "report_qa_findings"
QA_REVIEW_TOOL = {
    "name": QA_REVIEW_TOOL_NAME,
    "description": (
        "Сообщить о конкретных проблемах, найденных в НОВОЙ части этого "
        "диалога (см. системный промпт: что считать проблемой, а что "
        "нормальным поведением). Вызывать ВСЕГДА ровно один раз — с пустым "
        "findings, если проблем нет."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "description": "Пусто, если в новой части диалога всё в порядке.",
                "items": {
                    "type": "object",
                    "properties": {
                        "severity": {
                            "type": "string",
                            "enum": ["high", "medium", "low"],
                            "description": (
                                "high — клиенту дана неверная информация/цена, или разговор "
                                "зашёл в тупик без реального решения. medium — противоречие, "
                                "проигнорированный вопрос, путаница. low — стилистическая "
                                "мелочь, не влияющая на клиента."
                            ),
                        },
                        "category": {
                            "type": "string",
                            "enum": [
                                "wrong_info_or_price",
                                "contradiction",
                                "ignored_request",
                                "stalled_promise",
                                "confusion",
                                "other",
                            ],
                        },
                        "summary": {
                            "type": "string",
                            "description": "Одно-два предложения: что именно не так, по-русски.",
                        },
                        "message_excerpt": {
                            "type": "string",
                            "description": "Дословная цитата проблемного сообщения (агента и/или клиента).",
                        },
                    },
                    "required": ["severity", "category", "summary"],
                },
            },
        },
        "required": ["findings"],
    },
}

# 26.08.2026 — то же самое, что реально произошло в dlg-904248388-4
# (см. CLAUDE.md/переписку с Игорем 26.08.2026): считать НЕ багом —
# отдельно от техники (агент осознанно эскалировал, клиент явно попросил
# менеджера, сработала защита agent_forwarding_promise_without_escalate) —
# без этого списка ревьюер завалит админку ложными находками на КАЖДУЮ
# обычную эскалацию.
_QA_REVIEW_SYSTEM_PROMPT = """Ты — QA-ревьюер бота поддержки службы доставки \
здорового питания (Нячанг, Вьетнам). Тебе показывают уже состоявшийся \
разговор бота с клиентом — часть до отметки "--- НОВОЕ ---" это контекст, \
после неё — новые сообщения, которые нужно проверить. Ищи КОНКРЕТНЫЕ \
проблемы именно в новой части (контекст — только чтобы понимать, о чём речь).

Что считать проблемой: агент дал клиенту неверную цену/расчёт; агент \
противоречит тому, что говорил раньше в этом же разговоре; агент \
проигнорировал прямой вопрос клиента; агент пообещал что-то передать \
(«передам менеджеру», «уточню и вернусь») и после этого просто продолжил \
разговор как ни в чём не бывало, без реальной эскалации; агент явно запутался \
в датах/деталях заказа и это осталось неисправленным; агент дал совет/факт \
про меню или условия, которого нет в его базе знаний (похоже на выдумку).

Что НЕ считать проблемой (не флагать): сам факт эскалации/хендоффа \
(«Секунду, уточню у менеджера и вернусь с ответом») — это нормальная, рабочая \
часть системы, а не баг; клиент сам попросил позвать менеджера/дать номер \
телефона — тоже не баг; агент вежливо переспрашивает неоднозначную дату — \
это нормально, а не путаница, если в итоге разобрался.

Вызови report_qa_findings РОВНО ОДИН РАЗ. Если ничего из вышеописанного не \
произошло — вызови его с пустым findings, не выдумывай проблему, чтобы что-то \
отчитаться."""


def review_dialog_for_issues(
    dialog_id: str,
    prior_messages: list[dict],
    new_messages: list[dict],
) -> list[dict]:
    """26.08.2026 — QA-сканер (logic/qa_scanner.py), см. QA_REVIEW_TOOL выше.
    prior_messages/new_messages — та же форма, что history в generate_reply
    ({"role": "client"/"agent"/"olga"/"staff", "text": ...}), только тут ИЗ
    Supabase (dialog_messages), не из живого буфера процесса.

    В отличие от generate_reply — ОДИН вызов, без ретраев/фолбэка между
    режимами: это фоновая, не клиентская задача раз в 6 часов, единичный
    сетевой сбой на одном диалоге не критичен — logic/qa_scanner.py просто
    залогирует и пропустит этот диалог, не роняя весь скан. Если понадобится
    надёжность как у generate_reply — дешевле дождаться повторного скана
    (следующий цикл), чем тащить сюда весь _attempt_plan.

    Возвращает список находок (см. input_schema QA_REVIEW_TOOL) или [] и
    при отсутствии проблем, и при сбое вызова (best-effort, ошибка
    логируется вызывающим кодом)."""

    def _map(m: dict) -> dict:
        return {"role": "assistant" if m["role"] in ("agent", "olga", "staff") else "user", "content": m["text"]}

    messages = [_map(m) for m in prior_messages]
    if messages:
        messages.append({"role": "user", "content": "--- НОВОЕ ---"})
    messages.extend(_map(m) for m in new_messages)
    if not messages:
        return []

    model = os.environ.get("CLAUDE_MODEL") or DEFAULT_MODEL
    client = _get_client()
    response = client.messages.create(
        model=model,
        max_tokens=1024,
        system=_QA_REVIEW_SYSTEM_PROMPT,
        messages=messages,
        tools=[QA_REVIEW_TOOL],
        tool_choice={"type": "tool", "name": QA_REVIEW_TOOL_NAME},
    )
    tool_block = next(
        (b for b in response.content if getattr(b, "type", None) == "tool_use"), None
    )
    if tool_block is None:
        return []
    findings = tool_block.input.get("findings") or []
    for f in findings:
        f["dialog_id"] = dialog_id
    return findings


# 26.08.2026 — вторая часть фичи "заявка на подписку из диалога вручную"
# (Игорь: "Ольга должна иметь возможность нажать на кнопку, увидеть в
# отдельном окне информацию по заказу... и создать"). Тот же SUBSCRIPTION_TOOL,
# что и у обычного агента, форсированный tool_choice — не даём модели
# ответить обычным текстом вместо структурированного черновика. Это ЧЕРНОВИК
# для человека, не автооформление: Ольга видит извлечённое в форме,
# правит, что нужно, и ТОЛЬКО потом жмёт "Создать" (см. main.py,
# /admin/create-subscription-from-dialog) — сама эта функция ничего не
# создаёт и не пишет в Supabase.
_SUBSCRIPTION_EXTRACT_SYSTEM_PROMPT = """Тебе показывают разговор бота с \
клиентом службы доставки здорового питания. Клиент обсуждал оформление \
подписки или разового заказа, но по какой-то причине заявка не была \
оформлена автоматически (диалог эскалирован сотруднику). Твоя задача — \
извлечь из разговора ЧЕРНОВИК заявки инструментом propose_subscription, \
чтобы сотрудник дооформил её вручную.

Правила: заполняй поля тем, что клиент РЕАЛЬНО говорил — не выдумывай. Если \
калорийность/срок/дата не названы явно и однозначно, поставь наиболее \
вероятное значение по контексту и ОБЯЗАТЕЛЬНО укажи это в \
client_confirmation_quote словами вроде "не подтверждено явно — уточнить у \
клиента" вместо дословной цитаты, если самой цитаты подтверждения нет. Если \
клиент обсуждал НЕСКОЛЬКО рационов — передай их через additional_rations, \
как и в обычном режиме. Вызови propose_subscription РОВНО ОДИН РАЗ, даже \
если уверенность в деталях низкая — сотрудник всё проверит и поправит перед \
созданием заявки."""


def extract_subscription_draft(history: list[dict]) -> dict | None:
    """26.08.2026 — см. _SUBSCRIPTION_EXTRACT_SYSTEM_PROMPT выше. history —
    та же форма, что и у generate_reply/review_dialog_for_issues. Возвращает
    dict той же формы, что и subscription_call.input в generate_reply
    (kcal_target/paid_days/start_date/...), либо None при сбое вызова —
    вызывающий код (main.py) в этом случае просто отдаёт пустую форму,
    сотрудник заполняет её полностью вручную."""
    if not history:
        return None
    messages = [
        {"role": "assistant" if m["role"] in ("agent", "olga", "staff") else "user", "content": m["text"]}
        for m in history
    ]
    model = os.environ.get("CLAUDE_MODEL") or DEFAULT_MODEL
    try:
        client = _get_client()
        response = client.messages.create(
            model=model,
            max_tokens=1024,
            system=_SUBSCRIPTION_EXTRACT_SYSTEM_PROMPT,
            messages=messages,
            tools=[SUBSCRIPTION_TOOL],
            tool_choice={"type": "tool", "name": SUBSCRIPTION_TOOL_NAME},
        )
    except Exception as exc:
        _DIAG_LOGGER.warning(
            "subscription_draft_extract_error error_type=%s error=%s", type(exc).__name__, exc,
            exc_info=True,
        )
        return None
    tool_block = next(
        (b for b in response.content if getattr(b, "type", None) == "tool_use"), None
    )
    return dict(tool_block.input) if tool_block is not None else None


_client = None
# 19.08.2026 — какой режим сейчас реально собран в _client ("direct"/"proxy")
# — используется, чтобы понять, нужно ли пересобрать клиент при смене
# переключателя в админке (см. _resolve_credential_mode/_get_client ниже).
_client_mode: str | None = None

# 06.09.2026 — РЕАЛЬНЫЙ БАГ (Игорь, dlg-614269317-6): клиент писал
# сообщения с интервалом чуть больше debounce (3 сек, см. main.py) — каждое
# уходило ОТДЕЛЬНЫМ вызовом generate_reply() в своём потоке
# (asyncio.to_thread, см. main.py/_flush_after_debounce), несколько потоков
# на ОДИН диалог одновременно. _client/_client_mode/_fallback_clients/
# _degraded_mode/_degraded_until ниже — простые module-level переменные,
# читались и писались из этих потоков без какой-либо синхронизации: один
# поток мог оказаться в середине пересборки _client (уже присвоил новый
# объект, но ещё не выставил _client_mode, или наоборот), пока другой поток
# в это же время читал оба значения для СВОЕГО вызова — итог наблюдался как
# TypeError: 'NoneType' object is not iterable (не тот тип исключения, что
# бывает от сетевого сбоя, и падало не на всех параллельных вызовах сразу, а
# через один — характерный признак гонки, не реального отказа прокси).
# threading.local() уже используется в файле для _escalate_reason_local
# ИМЕННО по этой же причине (потоки не должны путать состояние друг друга),
# но там это было применимо (значение нужно только внутри одного вызова);
# здесь состояние ОБЩЕЕ по смыслу (один и тот же клиент Anthropic на весь
# процесс) — обычный Lock вокруг чтения+пересборки, не threading.local().
_client_lock = threading.Lock()

# 21.07.2026: лёгкая видимость расходов — нет доступа к биллингу
# aiprimetech.io/console.anthropic.com прямо из кода, но токены каждого
# ответа Claude сам возвращает (response.usage), и это уже достаточно,
# чтобы прикинуть объём/стоимость по прайсу модели. In-memory, как и
# всё остальное состояние процесса — обнуляется при рестарте бесплатного
# Render-инстанса (тот же класс ограничения, что и db_mock.py).
_usage_totals = {
    "requests": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "escalated_requests": 0,  # включая сетевые сбои — видно долю "потерянных" вызовов
}

# 25.08.2026 — раньше escalate=True из-за сетевого/API-сбоя и escalate=True
# из-за осознанного протокола ESCALATE модели попадали в escalations с ОДНИМ
# и тем же reason="agent_uncertain" (см. orchestrator.py) — отличить один от
# другого можно было только косвенно (agent_intended_action=null), это и
# увело расследование реального инцидента 26.08.2026 (dlg-904248388-4) в
# долгие раскопки. Тот же приём, что и _client_mode/_usage_totals — побочный
# канал состояния для последнего вызова generate_reply(), который
# orchestrator.py читает СРАЗУ после вызова и использует как reason вместо
# жёстко зашитого "agent_uncertain", если он не None.
#
# 26.08.2026 — ПОТОКОБЕЗОПАСНОСТЬ: main.py теперь уводит
# handle_incoming_message() в отдельный поток на каждое сообщение (см.
# asyncio.to_thread в main.py, чтобы ретраи одного диалога не морозили
# event loop для всех остальных клиентов), а значит generate_reply() для
# РАЗНЫХ диалогов может выполняться параллельно в разных потоках. Простая
# module-level переменная тут была бы гонкой: поток A мог бы прочитать
# reason, который поток B уже успел сбросить в None (или в свой собственный
# результат) в начале СВОЕГО вызова generate_reply(). threading.local()
# даёт каждому потоку свою копию — orchestrator.py читает ровно то, что
# записал generate_reply() в ЭТОМ ЖЕ потоке, без пересечений между диалогами.
_escalate_reason_local = threading.local()


def get_last_escalate_reason() -> str | None:
    return getattr(_escalate_reason_local, "value", None)


def _set_last_escalate_reason(value: str | None) -> None:
    _escalate_reason_local.value = value


def get_usage_stats() -> dict:
    return dict(_usage_totals)


# 19.08.2026 — переключатель "прямой ANTHROPIC_API_KEY vs прокси
# ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL" из админки (Игорь купил прямой
# ключ "для теста" и попросил быстро переключаться между ним и боевым
# прокси aiprimetech.io, не трогая переменные окружения на Render — те
# продолжают хранить ОБА набора одновременно, переключатель только решает,
# какой из них использовать). Хранится в Supabase app_settings (тот же
# паттерн, что и claude_credential_mode-соседи — agent_system_prompt,
# start_greeting_texts, renewal_reminder_text — см. logic/agent_prompt.py/
# logic/start_greeting.py), читает и пишет admin-panel
# (app/api/settings/claude-credential/route.ts).
#
# TTL-кэш короче, чем у остальных настроек (60 сек, см. agent_prompt.py) —
# это ручной тумблер для тестирования, а не боевая настройка: Игорь явно
# просил именно быструю реакцию, поэтому 15 сек, а не минута. При этом не
# на каждое сообщение ходим в Supabase — не отменяет прогрев/экономию
# скорости из этой же диагностической сессии.
_CREDENTIAL_MODE_SETTING_KEY = "claude_credential_mode"
_CREDENTIAL_MODE_TTL_SECONDS = 15.0
_credential_mode_cache: str | None = None
_credential_mode_last_check = 0.0


def _resolve_credential_mode(force: bool = False) -> str | None:
    """"direct"/"proxy" — что выбрано в админке, либо None, если настройка
    не задана / Supabase недоступен (тогда _get_client() использует старый
    дефолт: auth_token приоритетнее api_key, если оба заданы)."""
    global _credential_mode_cache, _credential_mode_last_check
    now = time.monotonic()
    if not force and (now - _credential_mode_last_check) < _CREDENTIAL_MODE_TTL_SECONDS:
        return _credential_mode_cache
    _credential_mode_last_check = now
    if supabase_client is None:
        return _credential_mode_cache
    try:
        row = supabase_client.get_app_setting(_CREDENTIAL_MODE_SETTING_KEY)
        value = (row or {}).get("value") if isinstance(row, dict) else None
        mode = value.get("mode") if isinstance(value, dict) else None
        if mode in ("direct", "proxy"):
            _credential_mode_cache = mode
    except Exception:
        pass
    return _credential_mode_cache


def get_active_credential_mode() -> str | None:
    """Что РЕАЛЬНО собрано в текущем _client — это то, что было при
    ПОСЛЕДНЕМ вызове _get_client() (реальное сообщение клиента или прогрев
    на старте, см. main.py), а не обязательно то, что выбрано в админке
    ПРЯМО СЕЙЧАС. Для живого статуса на /health — см. refresh_active_
    credential_mode() ниже, не эту функцию напрямую."""
    return _client_mode


def refresh_active_credential_mode() -> str | None:
    """19.08.2026 — баг, найден Игорем: переключил режим в админке, подождал
    минуту, нажал "Обновить" на /health — там всё ещё старый режим. Причина:
    get_active_credential_mode() отдаёт _client_mode, а он выставляется
    ТОЛЬКО внутри _get_client(), который вызывается только на реальном
    сообщении клиента (или разово на прогреве при старте, main.py) — если с
    момента переключения тумблера ни один клиент боту не писал, _client
    вообще не пересобирался, и /health показывает состояние ДО переключения,
    сколько бы ни ждали и ни жали "Обновить".
    Форсируем реальный _get_client() здесь — это и есть "быстро
    переключиться и сразу увидеть, что сработало" (см. запрос Игоря), без
    похода в Supabase на каждый вызов /health — TTL-кэш _resolve_credential_
    mode() внутри всё ещё уважается. RuntimeError (ни один ключ вообще не
    задан) не должен ронять /health — просто нечего показывать."""
    try:
        _get_client()
    except Exception:
        pass
    return _client_mode


def _resolve_chosen_mode(api_key: str | None, auth_token: str | None, desired_mode: str | None) -> str | None:
    """Чистая функция выбора режима — вынесена из _get_client() 25.08.2026
    (фолбэк на второй API, см. CLAUDE.md "кончился баланс") без изменения
    самой логики, только чтобы generate_reply() могла узнать заранее, какой
    режим _get_client() выберет, и спланировать вокруг него попытки/фолбэк
    (см. _attempt_plan ниже), не дублируя эти четыре строки выбора в двух
    местах с риском, что они разъедутся.

    Два разных способа авторизации у Anthropic SDK — это не опечатка:
    официальный console.anthropic.com выдаёт api_key (заголовок x-api-key),
    а сторонние прокси/реселлеры (напр. кастомный ANTHROPIC_BASE_URL) часто
    выдают именно auth_token (заголовок Authorization: Bearer). Перепутать —
    верный способ словить 401 "invalid x-api-key", даже если сам токен
    рабочий (найдено 21.07.2026 на прокси aiprimetech.io).

    Приоритет выбора: явный desired_mode из админки, если под него реально
    есть ключ; иначе старый дефолт (auth_token приоритетнее api_key, если
    заданы оба — обычно признак именно стороннего прокси); если запрошенный
    в админке режим настроен, но соответствующий ключ не задан на этом
    инстансе — тихо откатываемся на то, что реально доступно, а не роняем
    процесс (лучше ответить не тем ключом, что выбрали, чем не ответить
    вовсе). None — ни один ключ не задан вовсе."""
    if desired_mode == "proxy" and auth_token:
        return "proxy"
    if desired_mode == "direct" and api_key:
        return "direct"
    if auth_token:
        return "proxy"
    if api_key:
        return "direct"
    return None


def _other_mode(mode: str) -> str:
    return "proxy" if mode == "direct" else "direct"


def _mode_has_key(mode: str, api_key: str | None, auth_token: str | None) -> bool:
    return bool(auth_token) if mode == "proxy" else bool(api_key)


# 25.08.2026 — фолбэк на второй API (Игорь, после реального инцидента "у нас
# 2 апи, прямой и через прокси — если у одного ошибка, кончился баланс и
# т.п., переключаемся на второй и пробуем там, не получилось — эскалируем").
# Если основной режим только что подводил, не гоняем его снова на КАЖДОЕ
# сообщение (два заведомо провальных запроса впустую) — на 5 минут пробуем
# сразу запасной первым, а деградировавший остаётся последним шансом перед
# эскалацией (см. _attempt_plan/_is_degraded/_mark_degraded ниже). Раз в 5
# минут всё равно даём основному шанс — сам себя восстановит, если баланс
# пополнили/сеть починили, без участия человека.
_FAILOVER_COOLDOWN_SECONDS = 300.0
_degraded_mode: str | None = None
_degraded_until: float = 0.0

# 26.08.2026 — п.3 (Игорь: "да"), см. комментарий у time.sleep() в
# generate_reply(): короткая пауза МЕЖДУ двумя попытками на ОДНОМ И ТОМ ЖЕ
# API, не "ждём восстановления до 2 минут" (эта формулировка была моей
# ошибочной трактовкой первого сообщения Игоря, он поправил — см. п.1).
# Держит вызов быстрым (доли секунды, не десятки) — блокирующий вызов теперь
# в отдельном потоке (main.py, asyncio.to_thread), но клиент в Telegram всё
# равно ждёт ответа, топить его в минутах ожидания незачем.
_SAME_MODE_RETRY_DELAY_SECONDS = 1.5


def _is_degraded(mode: str | None) -> bool:
    return mode is not None and mode == _degraded_mode and time.monotonic() < _degraded_until


def _mark_degraded(mode: str | None) -> None:
    global _degraded_mode, _degraded_until
    if mode is None:
        return
    _degraded_mode = mode
    _degraded_until = time.monotonic() + _FAILOVER_COOLDOWN_SECONDS


def _clear_degraded(mode: str | None) -> None:
    global _degraded_mode, _degraded_until
    if mode is not None and _degraded_mode == mode:
        _degraded_mode = None
        _degraded_until = 0.0


# 25.08.2026 — кэш клиента для КОНКРЕТНОГО режима, используемый ТОЛЬКО
# фолбэком (см. _client_for_mode ниже) — отдельно от _client/_client_mode
# выше (те остаются кэшем "текущего выбранного в админке режима", как и
# раньше, см. test_get_client_* в test_claude_real.py — их поведение этой
# правкой не меняется). Раздельные кэши, чтобы попытка фолбэка на другой
# режим не пересобирала и не путала основной _client.
_fallback_clients: dict[str, object] = {}


def _build_client_for_mode(mode: str, api_key: str | None, auth_token: str | None):
    # Импорт здесь, а не в топе файла — чтобы путь без ключа/токена
    # (claude_mock) не требовал установленного пакета anthropic вовсе (тот
    # же приём, что и в _get_client() ниже).
    import anthropic

    if mode == "proxy":
        return anthropic.Anthropic(auth_token=auth_token)
    # 19.08.2026 — БАГ, найден Игорем ("апи кей не трогал, дело в коде"):
    # анthropic SDK, если base_url не передан явно, сам берёт его из
    # ANTHROPIC_BASE_URL (см. исходник Anthropic.__init__) — прямой режим
    # должен ВСЕГДА идти на официальный API, не наследовать чужой base_url
    # прокси из окружения (подробности см. в _get_client() ниже).
    return anthropic.Anthropic(api_key=api_key, base_url=DIRECT_API_BASE_URL)


def _client_for_mode(mode: str, api_key: str | None, auth_token: str | None):
    """Клиент для КОНКРЕТНОГО режима — не обязательно того, что сейчас
    выбран в админке (см. _get_client() для него). Используется фолбэком в
    generate_reply(), когда основной режим не ответил дважды подряд.
    Переиспользует _client, если он уже в нужном режиме (не плодит второй
    объект клиента впустую), иначе кэширует отдельно в _fallback_clients —
    один раз собранный клиент для режима переживает вызов до вызова, не
    пересоздаётся на каждое сообщение.

    06.09.2026 — под тем же _client_lock, что и _get_client() (см.
    комментарий у объявления лока выше): читает/пишет те же общие
    переменные (_client/_client_mode/_fallback_clients), фолбэк и
    основной путь не должны видеть друг друга в промежуточном состоянии."""
    with _client_lock:
        if mode == _client_mode and _client is not None:
            return _client
        cached = _fallback_clients.get(mode)
        if cached is not None:
            return cached
        if not _mode_has_key(mode, api_key, auth_token):
            raise RuntimeError(f"ключ для режима {mode!r} не задан — фолбэк недоступен")
        client = _build_client_for_mode(mode, api_key, auth_token)
        _fallback_clients[mode] = client
        return client


def _attempt_plan(chosen_mode: str | None, api_key: str | None, auth_token: str | None):
    """25.08.2026 — план попыток на этот вызов: [(режим, число_попыток,
    через_get_client), ...]. Обычный случай (chosen_mode здоров): основной
    режим — 2 попытки (стучимся, при ошибке пробуем ЕЩЁ РАЗ тот же), затем
    запасной — 1 попытка, если для него вообще есть ключ. Если основной
    только что был признан "не отвечает" (см. _is_degraded) — порядок
    зеркальный: сперва запасной 2 раза, деградировавший — 1 раз последним
    шансом. chosen_mode=None (ключей вообще нет) — единственная запись,
    фолбэк планировать не из чего."""
    if chosen_mode is None:
        return [(None, 2, True)]
    other = _other_mode(chosen_mode)
    other_available = _mode_has_key(other, api_key, auth_token)
    if _is_degraded(chosen_mode) and other_available:
        return [(other, 2, False), (chosen_mode, 1, True)]
    plan = [(chosen_mode, 2, True)]
    if other_available:
        plan.append((other, 1, False))
    return plan


def _get_client():
    global _client, _client_mode
    # 19.08.2026 — тесты (test_claude_real.py) подменяют _client напрямую,
    # в обход этой функции, и намеренно чистят ANTHROPIC_*-переменные из
    # окружения (см. шапку файла) — значит проверка ключей НЕ может стоять
    # раньше короткого пути "клиент уже есть, ключи не нужны". Определяем
    # chosen_mode заранее (может остаться None, если ключей вообще нет), и
    # только если РЕАЛЬНО нужно строить/пересобирать клиента — валимся, если
    # строить не из чего.
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    auth_token = os.environ.get("ANTHROPIC_AUTH_TOKEN")
    chosen_mode = _resolve_chosen_mode(api_key, auth_token, _resolve_credential_mode())

    # 06.09.2026 — реальный баг (см. комментарий у _client_lock выше):
    # несколько сообщений одного диалога обрабатываются в параллельных
    # потоках (main.py, asyncio.to_thread на каждое сообщение) — без лока
    # один поток мог читать _client/_client_mode, пока другой их
    # пересобирал, и ловить состояние ни туда ни сюда. Сама сетевая часть
    # (messages.create) под локом НЕ стоит — она уже вне этой функции, в
    # generate_reply(); здесь только быстрая проверка+пересборка объекта
    # клиента, держать на ней лок безопасно и недорого.
    with _client_lock:
        # Клиент уже собран и либо ключей нет совсем (тестовый обход через
        # прямую подмену _client — см. коммент выше), либо он уже в нужном
        # режиме — ничего пересобирать не нужно.
        if _client is not None and (chosen_mode is None or _client_mode == chosen_mode):
            return _client

        if chosen_mode is None:
            raise RuntimeError(
                "Ни ANTHROPIC_API_KEY, ни ANTHROPIC_AUTH_TOKEN не заданы (см. .env.example)"
            )

        # 19.08.2026 — именно первый `import anthropic` в процессе стабильно
        # занимает ~9 сек на бесплатном Render-инстансе (диагностика в
        # CLAUDE.md); чтобы не платить эту цену на первом реальном сообщении
        # клиента, main.py прогревает _get_client() на старте процесса
        # (lifespan). Пересборка клиента при СМЕНЕ режима (не самый первый
        # вызов) импорт не повторяет — Python кеширует модуль в sys.modules.
        _client = _build_client_for_mode(chosen_mode, api_key, auth_token)
        _client_mode = chosen_mode
        return _client


def generate_reply(
    client_profile: dict, message: str, history: list[dict]
) -> tuple[str, bool, str | None, dict | None, dict | None]:
    """Возвращает (текст_для_клиента, escalate, intended_action,
    order_change_request, subscription_request).

    Если escalate=True, текст — пустая строка, оркестратор сам подставляет
    хендофф-фразу и заводит эскалацию Ольге тем же путём, что и красная
    зона — "ESCALATE" клиенту не уходит ни в каком виде.

    intended_action (21.07.2026) — что бы агент сделал, будь у него
    разрешение/tool use (см. logic/agent_prompt.py, протокол "ESCALATE:
    <мысль>"). None, если модель не пояснила (голый "ESCALATE") или
    эскалация вызвана сетевым сбоем/пустым ответом — анализировать нечего,
    это не ошибка. Сохраняется в escalations.agent_intended_action —
    материал для решения, какие функции стоит открыть агенту (tool use).

    order_change_request (25.07.2026) — dict с аргументами инструмента
    ORDER_CHANGE_TOOL (new_date/scope/range_end_date/client_confirmation_quote),
    если модель ЯВНО вызвала его в этом ответе, иначе None.

    subscription_request (25.07.2026) — dict с аргументами инструмента
    SUBSCRIPTION_TOOL (kcal_target/paid_days/start_date/
    client_confirmation_quote), если модель ЯВНО вызвала его в этом ответе,
    иначе None. Модель никогда не считает цену сама — это делает
    orchestrator.py по подтверждённым числам (см. logic/subscription_pricing.py).

    В обоих случаях tool_use клиенту в этом ответе уходит ФИКСИРОВАННЫЙ
    текст, собранный оркестратором, не текст модели (см. предупреждение в
    шапке файла про недоверие сырому тексту модели рядом с вызовом
    инструмента). Ровно ОДИН из двух tool_call-полей может быть заполнен за
    раз — модель вызывает не больше одного инструмента за ответ.

    25.08.2026 — реальный инцидент (dlg-904248388-4, "кончился баланс"):
    раньше ЛЮБАЯ ошибка API (сеть, лимит, баланс) сразу эскалировала —
    клиент получал "Секунду, уточню у менеджера" на каждое сообщение, пока
    Ольга не подключалась вручную. Теперь два независимых API (см.
    _resolve_chosen_mode/_attempt_plan выше) — при ошибке основного пробуем
    его же ещё раз, не получилось — переключаемся на запасной и пробуем там,
    и только если и он не ответил — эскалируем (см. get_last_escalate_reason()
    ниже — orchestrator.py отличает эту эскалацию от осознанного ESCALATE
    модели по нему, а не гадает по agent_intended_action, как раньше)."""
    _set_last_escalate_reason(None)
    _usage_totals["requests"] += 1
    try:
        messages = [
            # 17.08.2026 — "staff" добавлена в мэппинг: сообщение менеджера,
            # отправленное вручную из DialogThread.tsx (когда бот на паузе,
            # см. orchestrator.py/human_takeover), должно попасть в историю
            # для Claude как РЕПЛИКА НАШЕЙ стороны (assistant), а не клиента
            # (user) — иначе модель решит, что это сказал сам клиент, и
            # запутается, кто на самом деле что подтвердил.
            {"role": "assistant" if m["role"] in ("agent", "olga", "staff") else "user", "content": m["text"]}
            for m in history
        ]
        messages.append({"role": "user", "content": message})

        model = os.environ.get("CLAUDE_MODEL") or DEFAULT_MODEL
        # 19.08.2026 — prompt caching (Игорь: "очень много токенов
        # тратится", $0.3 за 6 сообщений). Раньше system был одной строкой
        # из build_system_prompt() — статика (правила, зелёная зона,
        # ~29 тыс. символов, одинаковая на каждом сообщении) и динамика
        # (дата/время, карточка клиента, язык) склеены вместе, из-за чего
        # Anthropic prompt caching не мог сработать НИ РАЗУ: кэш совпадает
        # только по префиксу запроса целиком, а хвост менялся всегда.
        # build_system_prompt_parts() отдаёт их раздельно — на статический
        # блок ставим cache_control (см. тот же приём на SUBSCRIPTION_TOOL
        # выше), динамический хвост — вторым, некэшируемым блоком. Первый
        # вызов после смены статики/долгого простоя (>5 мин, TTL кэша
        # Anthropic) платит полную цену как раньше, дальше в течение
        # разговора — кэш-цена (см. .env.example/CLAUDE.md про экономику).
        static_system_prompt, dynamic_system_tail = build_system_prompt_parts(
            order_context=client_profile.get("current_order_context"),
            # 06.08.2026 — подсказка стоп-листа красной зоны: решение об
            # эскалации теперь принимает модель, см. build_red_zone_note.
            red_zone_note=client_profile.get("red_zone_note"),
            # 06.08.2026 — данные карточки и тарифы для итоговой сверки
            # перед оформлением подписки.
            client_card_note=client_profile.get("client_card_note"),
            plans_note=client_profile.get("plans_note"),
            language_note=client_profile.get("language_note"),
        )
        create_kwargs = dict(
            model=model,
            max_tokens=1024,
            system=[
                {
                    "type": "text",
                    "text": static_system_prompt,
                    "cache_control": {"type": "ephemeral"},
                },
                {"type": "text", "text": dynamic_system_tail},
            ],
            messages=messages,
            tools=[ORDER_CHANGE_TOOL, SUBSCRIPTION_TOOL],
            # 19.08.2026 — защита от параллельных tool_use (найдено при
            # аудите клиентского пути, не живой баг). Код ниже
            # (tool_blocks/order_call/subscription_call) берёт через next()
            # только ПЕРВОЕ совпадение по каждому инструменту — если бы
            # Claude вернул ДВА tool_use-блока в одном ответе (напр.
            # propose_subscription и propose_delivery_reschedule сразу),
            # второй молча потерялся бы: ни заявки, ни эскалации, ни ошибки,
            # клиент бы решил, что оформлено всё. disable_parallel_tool_use
            # запрещает Claude вернуть больше одного tool_use за раз на
            # уровне API — тот же принцип "не доверяем одному только
            # промпту там, где можно подстраховаться технически", что и
            # везде в этом файле (цена, дата, эскалация).
            # 24.08.2026 — именно поэтому batch-оформление нескольких
            # рационов одного подтверждения (см. additional_rations в
            # SUBSCRIPTION_TOOL выше, реальный баг dlg-933735147-1) сделано
            # МАССИВОМ ВНУТРИ ОДНОГО вызова propose_subscription, а не через
            # несколько parallel tool_use — так ограничение выше не мешает
            # батчу и не нужно его снимать.
            tool_choice={"type": "auto", "disable_parallel_tool_use": True},
        )

        # 25.08.2026 — фолбэк на второй API, см. докстринг функции выше и
        # _attempt_plan/_client_for_mode. api_key/auth_token читаются ЗДЕСЬ
        # (не раньше) — тот же принцип "не читаем окружение заранее без
        # необходимости", что и в _get_client().
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        auth_token = os.environ.get("ANTHROPIC_AUTH_TOKEN")
        chosen_mode = _resolve_chosen_mode(api_key, auth_token, _resolve_credential_mode())
        plan = _attempt_plan(chosen_mode, api_key, auth_token)

        response = None
        succeeded_mode = None
        last_exc: Exception | None = None
        _t_api_start = time.monotonic()
        for mode, tries, use_get_client in plan:
            for attempt_idx in range(1, tries + 1):
                try:
                    call_client = _get_client() if use_get_client else _client_for_mode(mode, api_key, auth_token)
                    response = call_client.messages.create(**create_kwargs)
                    succeeded_mode = mode
                    break
                except Exception as exc:
                    last_exc = exc
                    # 06.09.2026 — раньше тут не было трейсбека, только тип+
                    # текст исключения: реальный инцидент (dlg-614269317-6,
                    # TypeError "'NoneType' object is not iterable") не
                    # получилось локализовать до конкретной строки по одним
                    # только логам Render — пришлось восстанавливать по
                    # косвенным признакам (см. CLAUDE.md). exc_info=True не
                    # меняет формат остальных полей, просто дописывает стек
                    # в конец записи лога.
                    _DIAG_LOGGER.warning(
                        "claude_api_error mode=%s attempt=%s/%s error_type=%s error=%s",
                        mode, attempt_idx, tries, type(exc).__name__, exc,
                        exc_info=True,
                    )
                    # 26.08.2026 — п.3 (Игорь: "да"): короткая пауза ТОЛЬКО
                    # перед повторной попыткой на ТОМ ЖЕ API (attempt_idx <
                    # tries — есть ещё попытка в этом же mode впереди), не
                    # затяжной "ждём до 2 минут" (это была ошибочная трактовка
                    # из моего первого предложения, Игорь явно поправил —
                    # "Нет... Пытается еще раз. Не получается - переключается
                    # на другой апи"). Смысл паузы — не долбить API мгновенно
                    # второй раз в ту же миллисекунду при транзиентном сбое
                    # (rate limit/сетевой затык), а не ждать восстановления.
                    # Перед переключением на второй API паузы нет — это уже
                    # другой ресурс, ждать нечего.
                    if attempt_idx < tries:
                        time.sleep(_SAME_MODE_RETRY_DELAY_SECONDS)
            if response is not None:
                break
        _t_api = time.monotonic() - _t_api_start

        if response is None:
            # И основной, и запасной (если был доступен) не ответили — тот
            # же смысл, что раньше нёс голый except Exception ниже, но
            # теперь мы реально попробовали оба API, а не просто один раз.
            raise last_exc if last_exc is not None else RuntimeError(
                "Ни ANTHROPIC_API_KEY, ни ANTHROPIC_AUTH_TOKEN не заданы (см. .env.example)"
            )

        # 25.08.2026 — самовосстановление: тот режим, что пробовали ПЕРВЫМ в
        # этом вызове (см. _attempt_plan), либо подтвердил, что он снова
        # здоров (тогда снимаем деградацию), либо не ответил, раз ответил
        # именно второй по плану режим (тогда помечаем первый как
        # деградировавший на _FAILOVER_COOLDOWN_SECONDS — см. комментарий у
        # _mark_degraded выше).
        first_mode_in_plan = plan[0][0]
        if succeeded_mode == first_mode_in_plan:
            _clear_degraded(succeeded_mode)
        else:
            _mark_degraded(first_mode_in_plan)

        usage = getattr(response, "usage", None)
        if usage is not None:
            _usage_totals["input_tokens"] += getattr(usage, "input_tokens", 0) or 0
            _usage_totals["output_tokens"] += getattr(usage, "output_tokens", 0) or 0
        # 19.08.2026 — credential_mode в этой же строке — чтобы сравнивать
        # прямой/прокси не пришлось сверять с /health отдельно по времени.
        # 25.08.2026 — теперь это РЕАЛЬНО ответивший режим (succeeded_mode),
        # а не просто "что сейчас выбрано в админке" — при фолбэке они могут
        # отличаться, и именно это тут интереснее увидеть.
        _DIAG_LOGGER.warning(
            "claude_api_call credential_mode=%s model=%s elapsed=%.2fs "
            "input_tokens=%s output_tokens=%s "
            "cache_creation_input_tokens=%s cache_read_input_tokens=%s",
            succeeded_mode,
            model,
            _t_api,
            getattr(usage, "input_tokens", None) if usage else None,
            getattr(usage, "output_tokens", None) if usage else None,
            getattr(usage, "cache_creation_input_tokens", None) if usage else None,
            getattr(usage, "cache_read_input_tokens", None) if usage else None,
        )

        tool_blocks = [block for block in response.content if getattr(block, "type", None) == "tool_use"]
        order_call = next((b for b in tool_blocks if getattr(b, "name", None) == ORDER_CHANGE_TOOL_NAME), None)
        subscription_call = next(
            (b for b in tool_blocks if getattr(b, "name", None) == SUBSCRIPTION_TOOL_NAME), None
        )

        if order_call is not None:
            # Не доверяем сырому тексту модели рядом с вызовом инструмента —
            # фиксированный ответ собирает оркестратор сам (см. докстринг
            # выше). order_change_request отдаём как есть, без валидации —
            # это забота orchestrator.py/db_mock.py (там же матчинг со
            # строкой заказа, см. logic/order_lookup.py).
            return "", False, None, dict(order_call.input), None
        if subscription_call is not None:
            return "", False, None, None, dict(subscription_call.input)

        text = "".join(
            block.text for block in response.content if getattr(block, "type", None) == "text"
        ).strip()

        if not text or is_escalate_signal(text):
            _usage_totals["escalated_requests"] += 1
            intended_action = extract_intended_action(text) if text else None
            return "", True, intended_action, None, None
        return text, False, None, None, None
    except Exception as exc:
        # 19.08.2026 — раньше эта ветка проглатывала исключение ПОЛНОСТЬЮ
        # молча: ни типа ошибки, ни сообщения нигде не оставалось — Игорь
        # переключил ключ на "direct" в админке, реальный ключ на Render
        # оказался нерабочим (401/лимит/что угодно), и КАЖДОЕ сообщение
        # клиента эскалировалось без единого следа причины в логах Render.
        # Отличить "сетевой сбой" от "модель осознанно ответила ESCALATE"
        # по данным в Supabase можно только косвенно (см. escalations.
        # agent_intended_action — у сетевого сбоя он всегда null, у
        # осознанного ESCALATE — обычно заполнен), а сам текст ошибки был
        # виден ТОЛЬКО если знать это заранее. Логируем явно, чтобы в
        # следующий раз причина была видна сразу, без раскопок в Supabase.
        _DIAG_LOGGER.warning(
            "claude_api_error credential_mode=%s error_type=%s error=%s",
            _client_mode, type(exc).__name__, exc,
            exc_info=True,
        )
        _usage_totals["escalated_requests"] += 1
        # 25.08.2026 — именно эта эскалация (а не осознанный ESCALATE модели)
        # должна была быть видна в dlg-904248388-4 с первого взгляда, а не
        # через сопоставление agent_intended_action=null с несколькими
        # таблицами Supabase. orchestrator.py читает get_last_escalate_reason()
        # сразу после generate_reply() и кладёт это значение в reason
        # эскалации вместо "agent_uncertain", когда оно не None.
        _set_last_escalate_reason("claude_api_unavailable")
        return "", True, None, None, None
