"""19.08.2026 — приветствие на голый /start.

Раньше был один жёстко прописанный текст (orchestrator.py, с 24.07.2026) —
Игорь попросил несколько вариантов вразнобой (рандом, не под копирку) и
возможность править их в админке без деплоя — тот же приём, что и у
logic/renewal_reminders.py (app_settings.{"texts": [...]}, запасной список
на случай, если Supabase недоступен или настройка ещё не создана).

Выбор ДЕЙСТВИТЕЛЬНО случайный (не по хешу от client_id, как у напоминаний о
продлении, см. renewal_reminders.pick_template) — там детерминированность
нужна была из-за повторных прогонов одного и того же крона по одному и тому
же клиенту, здесь /start у каждого клиента бывает по факту один раз,
повторов бояться не от чего.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    from integrations import supabase_client
except ImportError:  # pragma: no cover
    supabase_client = None

SETTING_KEY = "start_greeting_texts"

DEFAULT_GREETINGS: list[str] = [
    "Привет! 👋 Я ассистент HealthyFood — сервиса доставки полезной еды в "
    "Нячанге. Готовим блюда на пару, без сахара, сбалансированно и вкусно. "
    "Помогу подобрать меню, расскажу про тарифы и доставку. Оформим ваш "
    "первый заказ?",
    "Здравствуйте! Я ассистент HealthyFood. Мы готовим полезные блюда на "
    "пару без сахара — удобно, вкусно и без лишних хлопот на кухне. Помогу "
    "с выбором меню, тарифами и доставкой. Хотите оформить заказ?",
    "Здравствуйте! 🙌 Я ассистент HealthyFood — доставляем сбалансированную "
    "еду на пару, без сахара, прямо к вам домой. Подскажу по меню, тарифам "
    "и условиям доставки. Готовы попробовать?",
    "Привет! Я ассистент HealthyFood — помогаю с меню, тарифами и доставкой "
    "полезной еды на пару без сахара. Оформим заказ?",
]


def get_greetings() -> list[str]:
    """Тот же формат настройки, что и у renewal_reminder_text — поддерживаем
    и {"texts": [...]} (новый формат, несколько вариантов), и одиночный
    {"text": "..."} на случай, если кто-то в админке сохранит только один."""
    if supabase_client is None:
        return DEFAULT_GREETINGS
    try:
        row = supabase_client.get_app_setting(SETTING_KEY)
        value = (row or {}).get("value") if isinstance(row, dict) else None
        if isinstance(value, dict):
            texts = value.get("texts")
            if isinstance(texts, list):
                cleaned = [t for t in texts if isinstance(t, str) and t.strip()]
                if cleaned:
                    return cleaned
            single = value.get("text")
            if isinstance(single, str) and single.strip():
                return [single]
    except Exception:
        pass
    return DEFAULT_GREETINGS


def pick_greeting() -> str:
    greetings = get_greetings()
    return random.choice(greetings) if greetings else DEFAULT_GREETINGS[0]
