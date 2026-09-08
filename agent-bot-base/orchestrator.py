"""
Madlen — AI Consultant Bot в Telegram.
Оркестратор входящего сообщения (минимальная версия из HF).

Флоу одного сообщения:
    входящее сообщение
        -> лог в dialogs/dialog_messages
        -> Red Zone Classifier (до вызова модели)
        -> если escalate: хендофф-ответ + уведомление команде
        -> иначе: вызов Claude (real или mock)
        -> получение ответа или эскалация от модели
        -> отправка клиенту
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

logger = logging.getLogger("madlen-bot.orchestrator")

sys.path.insert(0, str(Path(__file__).parent))

from logic import red_zone_classifier
from logic import agent_prompt

from integrations import telegram_mock, supabase_client
from integrations.db_mock import MockDb

# Выбор "агента": реальный Claude или mock
if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
    from integrations import claude_real as _agent_client
else:
    from integrations import claude_mock as _agent_client


def get_agent_usage_stats() -> dict:
    """Статистика использования Claude API."""
    return _agent_client.get_usage_stats()


def get_agent_credential_mode() -> str | None:
    """Режим аутентификации (реальный API или mock)."""
    return getattr(_agent_client, "get_credential_mode", lambda: "mock")()


@dataclass
class EscalationResult:
    """Результат эскалации."""
    escalated: bool
    reason: str  # "red_zone", "agent_uncertain", "network_error"
    message: str  # текст ответа клиенту


def _send_escalation_handoff(
    client_id: str,
    chat_id: int,
    escalation_reason: str,
    client_message: str,
) -> str:
    """Отправить хендофф-сообщение при эскалации."""
    # TODO: при реальной интеграции нужно сохранить в escalations,
    # пустить пуш команде, отправить сообщение клиенту
    
    handoff_text = (
        f"Спасибо за ваше сообщение. "
        f"Это требует внимания нашей команды. "
        f"Мы свяжемся с вами в ближайшее время."
    )
    
    if os.environ.get("TELEGRAM_BOT_TOKEN"):
        # Реальный Telegram (не реализовано, нужен интеграция)
        pass
    else:
        # Mock: логируем
        telegram_mock.send_message(chat_id, handoff_text)
    
    return handoff_text


async def handle_incoming_message(
    telegram_update: dict,
    db: Optional[MockDb] = None,
) -> dict:
    """
    Обработать входящее сообщение от Telegram.
    
    Возвращает:
        {
            "status": "success" | "error",
            "message": текст ответа или сообщение об ошибке,
            "escalated": True если был хендофф команде
        }
    """
    if db is None:
        db = MockDb()
    
    try:
        # Извлечь данные сообщения
        message = telegram_update.get("message") or {}
        chat = message.get("chat") or {}
        from_user = message.get("from") or {}
        
        chat_id = chat.get("id")
        user_id = from_user.get("id")
        username = from_user.get("username", f"user_{user_id}")
        text = message.get("text", "").strip()
        
        if not chat_id or not user_id or not text:
            return {
                "status": "error",
                "message": "Invalid message format",
                "escalated": False,
            }
        
        # Дедуп по update_id (идемпотентность)
        update_id = telegram_update.get("update_id")
        if update_id:
            seen = db.has_seen_update(update_id)
            if seen:
                logger.info(f"Дедуп: update_id {update_id} уже обработан")
                return {
                    "status": "success",
                    "message": "Already processed",
                    "escalated": False,
                }
            db.mark_update_seen(update_id)
        
        # Клиент
        client_id = f"telegram_{chat_id}"
        
        # Логирование входящего сообщения
        db.append_dialog_message(
            client_id=client_id,
            platform="telegram",
            role="client",
            text=text,
        )
        logger.info(f"[{username}] {text}")
        
        # Слой 1: Red Zone Classification
        rz_result = red_zone_classifier.classify(text)
        
        if rz_result.matched_terms:
            logger.warning(
                f"🔴 Red Zone triggered: {rz_result.matched_terms} "
                f"(confidence: {rz_result.confidence})"
            )
            
            escalation = _send_escalation_handoff(
                client_id=client_id,
                chat_id=chat_id,
                escalation_reason="red_zone",
                client_message=text,
            )
            
            db.append_dialog_message(
                client_id=client_id,
                platform="telegram",
                role="agent",
                text=escalation,
            )
            
            return {
                "status": "success",
                "message": escalation,
                "escalated": True,
            }
        
        # Слой 2: Вызов Claude
        try:
            # Получить историю диалога
            history = db.get_dialog_messages(client_id)
            
            # Получить актуальный системный промпт
            system_prompt_parts = agent_prompt.build_system_prompt_parts()
            
            # Вызвать модель
            response, should_escalate = await _agent_client.generate_reply(
                messages=history,
                system_prompt_parts=system_prompt_parts,
            )
            
            if should_escalate:
                logger.warning(f"⚠️ Model escalation requested")
                
                escalation = _send_escalation_handoff(
                    client_id=client_id,
                    chat_id=chat_id,
                    escalation_reason="agent_uncertain",
                    client_message=text,
                )
                
                db.append_dialog_message(
                    client_id=client_id,
                    platform="telegram",
                    role="agent",
                    text=escalation,
                )
                
                return {
                    "status": "success",
                    "message": escalation,
                    "escalated": True,
                }
            
            # Отправить ответ клиенту
            db.append_dialog_message(
                client_id=client_id,
                platform="telegram",
                role="agent",
                text=response,
            )
            
            # Mock Telegram отправка
            telegram_mock.send_message(chat_id, response)
            
            logger.info(f"✓ Reply sent to {username}")
            
            return {
                "status": "success",
                "message": response,
                "escalated": False,
            }
        
        except Exception as e:
            logger.exception("Claude call failed")
            
            fallback = (
                "Извините, произошла ошибка. Пожалуйста, попробуйте ещё раз или свяжитесь с поддержкой."
            )
            
            db.append_dialog_message(
                client_id=client_id,
                platform="telegram",
                role="agent",
                text=fallback,
            )
            
            return {
                "status": "error",
                "message": fallback,
                "escalated": False,
            }
    
    except Exception as e:
        logger.exception("Unexpected error in handle_incoming_message")
        return {
            "status": "error",
            "message": str(e),
            "escalated": False,
        }
