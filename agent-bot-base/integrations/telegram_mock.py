"""
ЗАГЛУШКА Telegram Bot API. Ничего никуда не отправляет — только логирует
и возвращает структуру, как будто отправка прошла успешно. Нужна, чтобы
можно было прогнать весь оркестратор (orchestrator.py) от входящего
сообщения до "исходящего" без реального бота/токена (см. решение
"давай на моках сначала", 18.07.2026).

Когда появится реальный токен от Франсуа (BotFather) — заменить тело
send_message на реальный вызов, сигнатуру не менять (вызывающий код
в orchestrator.py трогать не придётся).
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger("agent-bot.telegram_mock")

# Что реально "отправили" за время жизни процесса — для тестов/отладки.
SENT_LOG: list[dict] = []


def send_message(chat_id: str, text: str, reply_to_message_id: Optional[str] = None) -> dict:
    # TODO(telegram): реальный вызов —
    #   POST https://api.telegram.org/bot<TOKEN>/sendMessage
    #   {"chat_id": chat_id, "text": text, "reply_to_message_id": reply_to_message_id}
    # Токен — из переменной окружения TELEGRAM_BOT_TOKEN, не хардкодить.
    record = {"chat_id": chat_id, "text": text, "reply_to_message_id": reply_to_message_id, "mock": True}
    SENT_LOG.append(record)
    logger.info("MOCK telegram send_message -> chat_id=%s text=%r", chat_id, text)
    return {"ok": True, **record}
