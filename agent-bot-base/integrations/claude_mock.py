"""
ЗАГЛУШКА генеративного агента (Claude API). Возвращает простой
keyword-ответ вместо реального обращения к LLM — нужна только чтобы
проверить, что оркестратор (red_zone -> module_registry -> "агент" ->
лог диалога -> отправка) работает от начала до конца. Реальный вызов —
integrations/claude_real.py (подключается автоматически, если задан
ANTHROPIC_API_KEY, см. orchestrator.py) — первая версия БЕЗ tool use,
согласовано с Игорем 20.07.2026.

ВАЖНО: это НЕ модель реальных ответов агента и не образец тона общения.
Реальные формулировки и сценарии зависят от разбора переписок Ольги
(уровень 3, см. CLAUDE.md) — здесь только техническая заглушка.

Сигнатура — tuple (текст, escalate, intended_action, order_change_request,
subscription_request) — та же, что у claude_real.py (21.07.2026: третий
элемент добавлен для логирования "что бы агент сделал", см.
logic/agent_prompt.py; 25.07.2026: четвёртый — для tool use переноса даты
доставки, см. ORDER_CHANGE_TOOL в claude_real.py; тот же день, пятый — для
tool use оформления подписки, см. SUBSCRIPTION_TOOL), чтобы orchestrator.py
работал с обоими одинаково. Мок никогда не эскалирует сам и никогда не
вызывает инструмент (escalate всегда False, intended_action/
order_change_request/subscription_request всегда None) — эскалация из-за
красной зоны решается раньше, до вызова этой функции, а настоящий tool use
у мока просто не реализован (незачем — это заглушка для проверки
остального пайплайна, не для тестирования конкретных сценариев модели).
"""

from __future__ import annotations


def get_usage_stats() -> dict:
    # Тот же интерфейс, что и claude_real.get_usage_stats() (21.07.2026) —
    # мок не тратит токены, но main.py/health не должен знать, real это
    # или мок, чтобы получить статистику.
    return {"requests": 0, "input_tokens": 0, "output_tokens": 0, "escalated_requests": 0}


def generate_reply(
    client_profile: dict, message: str, history: list[dict]
) -> tuple[str, bool, str | None, dict | None, dict | None]:
    text = message.lower().strip()

    if any(w in text for w in ("привет", "здравств", "добрый день", "hi", "hello")):
        name = client_profile.get("display_name") or ""
        return (
            f"Здравствуйте{', ' + name if name else ''}! Это MOCK-ответ агента (реального LLM ещё нет).",
            False,
            None,
            None,
            None,
        )

    if any(w in text for w in ("цена", "стоимость", "сколько стоит", "price")):
        return (
            "MOCK-ответ: расчёт цены подключается через level2_pricing.py (пока заглушка).",
            False,
            None,
            None,
            None,
        )

    return (
        "MOCK-ответ агента: сообщение получено, реальная генерация ответа ещё не подключена.",
        False,
        None,
        None,
        None,
    )
