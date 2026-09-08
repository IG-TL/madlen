"""
Madlen — AI Consultant Bot в Telegram.
Вебхук сервер (FastAPI).

Локальный запуск с мок-режиме:
    pip install -r requirements.txt
    uvicorn main_madlen:app --reload --port 8000

Тестовый запрос:
    curl -X POST http://localhost:8000/telegram/webhook \
      -H "Content-Type: application/json" \
      -d '{
        "update_id": 123,
        "message": {
          "message_id": 1,
          "chat": {"id": 111, "type": "private"},
          "from": {"id": 222, "username": "testuser", "is_bot": false},
          "date": 1234567890,
          "text": "привет, помоги мне разобраться"
        }
      }'
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from contextlib import asynccontextmanager

logger = logging.getLogger("madlen-bot.main")

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request

# Загрузить .env локально (на продакшене Render использует Environment переменные)
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())

sys.path.insert(0, str(Path(__file__).parent))

import orchestrator
from integrations.db_mock import MockDb
from integrations import supabase_client
from integrations import telegram_mock
from logic import agent_prompt, message_debounce

# Глобальная БД (in-memory, только для локального тестирования)
_db = MockDb()

# Конфиги
_TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
_HAS_REAL_TELEGRAM = bool(_TELEGRAM_BOT_TOKEN)
_ADMIN_SYNC_TOKEN = os.environ.get("ADMIN_SYNC_TOKEN", "")
_ADMIN_PANEL_BASE_URL = os.environ.get("ADMIN_PANEL_BASE_URL", "http://localhost:3000")

# Дебаунс очередь (накапливать сообщения если они идут подряд)
_debounce_queue: dict[str, list] = {}
_debounce_timers: dict[str, asyncio.Task] = {}


async def _flush_after_debounce(client_id: str, delay_sec: float = 2.0):
    """Отправить сообщение после паузы (дебаунс)."""
    await asyncio.sleep(delay_sec)
    
    if client_id not in _debounce_queue:
        return
    
    messages = _debounce_queue.pop(client_id)
    if not messages:
        return
    
    logger.info(f"Debounce flush: {len(messages)} messages from {client_id}")
    
    # Отправить объединённое сообщение
    combined_text = "\n".join(m.get("text", "") for m in messages)
    combined_update = {
        "update_id": max(int(m.get("update_id", 0)) for m in messages),
        "message": {
            "chat": messages[0].get("message", {}).get("chat", {}),
            "from": messages[0].get("message", {}).get("from", {}),
            "text": combined_text,
        }
    }
    
    result = await orchestrator.handle_incoming_message(combined_update, db=_db)
    logger.info(f"Debounce result: {result.get('status')}")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Инициализация при старте."""
    logger.info("🚀 Madlen Bot starting...")
    
    # Прогреть Claude клиент (если реальный)
    agent_client = getattr(orchestrator, "_agent_client", None)
    if agent_client:
        try:
            stats = orchestrator.get_agent_usage_stats()
            logger.info(f"Agent mode: {orchestrator.get_agent_credential_mode()}")
        except Exception as e:
            logger.warning(f"Could not warm up agent: {e}")
    
    yield
    
    logger.info("🛑 Madlen Bot stopping...")


app = FastAPI(
    title="Madlen AI Consultant Bot",
    description="Telegram webhook для консультанта на основе Claude",
    version="0.1.0",
    lifespan=_lifespan,
)


@app.get("/")
async def root() -> dict:
    """Root endpoint."""
    return {
        "status": "ok",
        "service": "Madlen AI Consultant Bot",
        "mode": "webhook",
    }


@app.get("/health")
async def health() -> dict:
    """Проверка здоровья сервиса."""
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "agent_mode": orchestrator.get_agent_credential_mode(),
        "agent_stats": orchestrator.get_agent_usage_stats(),
    }


@app.post("/admin/sync")
async def admin_sync(request: Request) -> dict:
    """Синхронизировать системный промпт из админ-панели."""
    if not _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_SYNC_TOKEN не настроен")
    
    if request.headers.get("x-admin-token") != _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    payload = await request.json()
    
    # TODO: применить новый промпт, сохранить версию и т.д.
    agent_prompt.refresh_from_supabase()
    
    return {
        "status": "synced",
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/admin/reply-to-client")
async def admin_reply_to_client(request: Request) -> dict:
    """Отправить ответ клиенту из админ-панели (ручное управление)."""
    if not _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_SYNC_TOKEN не настроен")
    
    if request.headers.get("x-admin-token") != _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    payload = await request.json()
    client_id = payload.get("client_id")
    message_text = payload.get("message", "")
    
    if not client_id or not message_text:
        raise HTTPException(status_code=400, detail="client_id и message обязательны")
    
    # Логировать ответ
    _db.append_dialog_message(
        client_id=client_id,
        platform="telegram",
        role="agent",
        text=message_text,
    )
    
    # TODO: отправить в Telegram (нужна реальная интеграция)
    logger.info(f"Admin reply to {client_id}: {message_text[:50]}...")
    
    return {
        "status": "sent",
        "client_id": client_id,
    }


@app.post("/admin/set-human-takeover")
async def admin_set_human_takeover(request: Request) -> dict:
    """Переключить диалог на ручное управление."""
    if not _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_SYNC_TOKEN не настроен")
    
    if request.headers.get("x-admin-token") != _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    payload = await request.json()
    client_id = payload.get("client_id")
    
    if not client_id:
        raise HTTPException(status_code=400, detail="client_id обязателен")
    
    # TODO: сохранить статус в БД
    logger.info(f"Human takeover for {client_id}")
    
    return {
        "status": "takeover_enabled",
        "client_id": client_id,
    }


@app.post("/admin/reset-client-memory")
async def admin_reset_client_memory(request: Request) -> dict:
    """Сбросить память клиента."""
    if not _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=503, detail="ADMIN_SYNC_TOKEN не настроен")
    
    if request.headers.get("x-admin-token") != _ADMIN_SYNC_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    payload = await request.json()
    client_id = payload.get("client_id")
    
    if not client_id:
        raise HTTPException(status_code=400, detail="client_id обязателен")
    
    # TODO: в реальной БД очистить dialog_messages
    _db.clear_dialog(client_id)
    
    logger.info(f"Memory reset for {client_id}")
    
    return {
        "status": "memory_reset",
        "client_id": client_id,
    }


@app.post("/telegram/webhook")
async def telegram_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
) -> dict:
    """
    Telegram вебхук. Получить входящее сообщение и обработать его.
    """
    payload = await request.json()
    
    # Проверить формат
    if "message" not in payload:
        return {"status": "ignored", "reason": "no message in payload"}
    
    message = payload.get("message", {})
    chat_id = message.get("chat", {}).get("id")
    
    if not chat_id:
        return {"status": "ignored", "reason": "no chat_id"}
    
    # Проверить дебаунс
    client_id = f"telegram_{chat_id}"
    text = message.get("text", "").strip()
    
    if not text:
        return {"status": "ignored", "reason": "no text"}
    
    # Проверить, входит ли в очередь дебаунса
    if client_id not in _debounce_queue:
        _debounce_queue[client_id] = []
    
    _debounce_queue[client_id].append({
        "update_id": payload.get("update_id"),
        "message": message,
        "text": text,
    })
    
    # Отменить предыдущий таймер дебаунса
    if client_id in _debounce_timers:
        _debounce_timers[client_id].cancel()
    
    # Установить новый
    task = asyncio.create_task(_flush_after_debounce(client_id, delay_sec=1.0))
    _debounce_timers[client_id] = task
    
    return {
        "status": "queued",
        "client_id": client_id,
        "queue_size": len(_debounce_queue[client_id]),
    }


@app.get("/cron/qa-scan")
async def cron_qa_scan() -> dict:
    """Сканер качества диалогов (опционально)."""
    # TODO: периодически проверять диалоги моделью на баги
    return {"status": "ok", "scanned": 0}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
