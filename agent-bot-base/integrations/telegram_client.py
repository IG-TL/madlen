"""
Реальный клиент Telegram Bot API (не мок). Используется poll.py.

Токен НЕ хардкодится сюда — читается из переменной окружения
TELEGRAM_BOT_TOKEN (см. .env / poll.py). Это тестовый бот, созданный
Игорем через @BotFather 18.07.2026, только для локальной проверки флоу —
не продовый бот François.

Режим — long polling (getUpdates), не webhook: не нужен публичный HTTPS-URL
и деплой, можно гонять прямо с ноутбука. Когда дойдём до реального
показа клиенту — переключим main.py (FastAPI /telegram/webhook) на
webhook-режим через setWebhook, эта функция здесь не понадобится.
"""

from __future__ import annotations

import os
from typing import Optional

import requests

API_BASE = "https://api.telegram.org"
DEFAULT_TIMEOUT = 35  # чуть больше long-poll timeout ниже, чтобы не рвать соединение раньше времени


def _token() -> str:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError(
            "TELEGRAM_BOT_TOKEN не задан. Положи токен в agent-bot/.env "
            "(см. .env.example) или экспортируй переменную окружения."
        )
    return token


def get_me() -> dict:
    """Простая проверка токена — вернёт данные бота или бросит исключение."""
    resp = requests.get(f"{API_BASE}/bot{_token()}/getMe", timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_updates(offset: Optional[int] = None, timeout: int = 30) -> list[dict]:
    params = {"timeout": timeout}
    if offset is not None:
        params["offset"] = offset
    resp = requests.get(f"{API_BASE}/bot{_token()}/getUpdates", params=params, timeout=DEFAULT_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram getUpdates вернул ошибку: {data}")
    return data["result"]


def set_webhook(url: str) -> dict:
    """Один раз после деплоя — сказать Telegram слать апдейты сюда вместо getUpdates."""
    resp = requests.post(f"{API_BASE}/bot{_token()}/setWebhook", json={"url": url}, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram setWebhook вернул ошибку: {data}")
    return data


def delete_webhook() -> dict:
    """Снять вебхук — нужно перед возвратом к polling (poll.py), Telegram не даёт оба режима сразу."""
    resp = requests.post(f"{API_BASE}/bot{_token()}/deleteWebhook", timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_webhook_info() -> dict:
    resp = requests.get(f"{API_BASE}/bot{_token()}/getWebhookInfo", timeout=10)
    resp.raise_for_status()
    return resp.json()


def send_message(chat_id: str, text: str, reply_to_message_id: Optional[str] = None) -> dict:
    payload = {"chat_id": chat_id, "text": text}
    if reply_to_message_id is not None:
        payload["reply_to_message_id"] = reply_to_message_id
    resp = requests.post(f"{API_BASE}/bot{_token()}/sendMessage", json=payload, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram sendMessage вернул ошибку: {data}")
    return data["result"]
