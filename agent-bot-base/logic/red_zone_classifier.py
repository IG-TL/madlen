"""
HEALTHY FOOD NHA TRANG — классификатор красной зоны (слой 1: стоп-лист)
Дата: 18.07.2026

Назначение
----------
Первый (детерминированный, дешёвый, быстрый) фильтр перед тем, как сообщение
клиента вообще попадёт к генеративному агенту. Согласно handoff (раздел 5):

    "Красная зона — отдельный классификатор на входе, до генерации ответа"
    "Асимметричный порог: ложная эскалация бесплатна, пропуск — цена здоровья"

Это значит: классификатор оптимизирован под recall (ничего не пропустить),
не под precision. Ложные срабатывания — норма и приемлемы.

Известное ограничение (осознанное, не баг)
-------------------------------------------
Стоп-лист ловит СЛОВА и типовые непрямые конструкции. Он не ловит полный
перифраз без единого триггер-слова и без упоминания симптома
("у меня иногда бывает нехорошо после некоторых продуктов" — без слов
аллерг*/непереноси*/итд.). Это ограничение стоп-листа как класса решений,
не конкретной реализации. Устойчивость к полному перефразированию требует
второго слоя — семантического классификатора (LLM-based), который
целесообразно строить ПОСЛЕ того, как накопится размеченный корпус (см.
критерий приёмки: 100-200 реальных сообщений Ольги). Стоп-лист — это то, что
работает с первого дня без обучающих данных.

Использование
--------------
    from red_zone_classifier import classify

    result = classify("у сына вроде на орехи что-то было, ничего?")
    result.escalate       # True
    result.matched_terms  # ['орех\\w*']
    result.category       # 'allergy_medical'

Результат classify() напрямую маппится на колонки таблицы red_zone_events
(см. hf_schema_v1.sql): matched_stoplist, classifier_score, escalated.
"""

from __future__ import annotations

import re
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

# 21.07.2026: живые термины из Supabase (см. /red-zone в admin-panel — до
# этой правки изменения там влияли только на отображение в UI, реальный
# классификатор их не видел вообще, см. CLAUDE.md). Опциональный импорт —
# этот файл используется и как отдельный, вне agent-bot (см. red_zone_classifier.py
# в корне проекта, без integrations/ рядом), поэтому не должен падать, если
# integrations недоступен по какой-то причине.
sys.path.insert(0, str(Path(__file__).parent.parent))
try:
    from integrations import supabase_client
except ImportError:  # pragma: no cover
    supabase_client = None

DEFAULT_TERMS_PATH = Path(__file__).parent / "red_zone_terms.yaml"

# Соответствие между category, как она называется в БД (см.
# supabase_minimal_schema.sql, CHECK на red_zone_terms.category — там
# "indirect_pattern", в единственном числе) и внутренним ключом словаря
# терминов ниже (YAML исторически использует "indirect_patterns", во
# множественном — менять YAML ради этого не стали, проще смэппить один раз).
_DB_CATEGORY_TO_INTERNAL = {
    "allergy_medical": "allergy_medical",
    "indirect_pattern": "indirect_patterns",
    "complaint_negative": "complaint_negative",
}


# ----------------------------------------------------------------------------
# Нормализация текста
# ----------------------------------------------------------------------------
# Цель: сделать матчинг устойчивым к типичным вариациям в реальной переписке,
# не полагаясь на то, что клиент напишет грамотно.

_YO_MAP = str.maketrans({"ё": "е", "Ё": "Е"})

# Латинские буквы, визуально похожие на кириллические — частая "случайная"
# смена раскладки в мобильном наборе (a/а, e/е, o/о, p/р, c/с, x/х, y/у).
_LATIN_TO_CYRILLIC = str.maketrans({
    "a": "а", "e": "е", "o": "о", "p": "р", "c": "с",
    "x": "х", "y": "у", "A": "А", "E": "Е", "O": "О",
    "P": "Р", "C": "С", "X": "Х", "Y": "У",
})


def normalize(text: str) -> str:
    """Приводит текст к виду, максимально удобному для стоп-лист матчинга."""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", text)
    text = text.translate(_YO_MAP)
    text = text.translate(_LATIN_TO_CYRILLIC)
    text = text.lower()
    return text


# ----------------------------------------------------------------------------
# Загрузка терминов
# ----------------------------------------------------------------------------

def _load_terms(path: Path = DEFAULT_TERMS_PATH) -> dict:
    if yaml is None or not path.exists():
        # Фолбэк: минимальный набор из handoff, если YAML/pyyaml недоступны —
        # чтобы классификатор никогда не отказывал полностью.
        return {
            "allergy_medical": {"ru": [
                "аллерг\\w*", "непереноси\\w*", "диабет\\w*", "беременн\\w*",
                "лекарств\\w*", "орех\\w*", "глютен\\w*", "лактоз\\w*",
            ]},
            "complaint_negative": {"ru": ["жалоб\\w*", "недовол\\w*"]},
            "indirect_patterns": {"ru": []},
            "tone_heuristics": {
                "caps_ratio_threshold": 0.6,
                "min_length_for_caps_check": 10,
                "repeated_punctuation_pattern": "[!?]{3,}",
                "negative_emoji": ["😡", "😠", "🤬", "😢", "💔", "🤢"],
            },
        }
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def _compile_category(raw: dict, category: str) -> list[re.Pattern]:
    patterns = []
    for lang, terms in raw.get(category, {}).items():
        for term in terms:
            patterns.append(re.compile(r"\b" + term, re.IGNORECASE | re.UNICODE))
    return patterns


# ----------------------------------------------------------------------------
# Результат классификации
# ----------------------------------------------------------------------------

@dataclass
class RedZoneResult:
    escalate: bool
    category: Optional[str]           # 'allergy_medical' | 'complaint_negative' | 'tone' | None
    matched_terms: list[str] = field(default_factory=list)
    reason: str = ""
    # classifier_score: эвристический, НЕ вероятность в статистическом смысле.
    # 1.0 — прямое попадание по термину здоровья (максимальный приоритет),
    # 0.7 — совпадение только по тону/эмодзи/жалобе.
    classifier_score: float = 0.0


class RedZoneClassifier:
    def __init__(self, terms_path: Path = DEFAULT_TERMS_PATH, db_refresh_seconds: float = 60.0):
        raw = _load_terms(terms_path)
        self._allergy_patterns = _compile_category(raw, "allergy_medical")
        self._indirect_patterns = _compile_category(raw, "indirect_patterns")
        self._complaint_patterns = _compile_category(raw, "complaint_negative")
        tone = raw.get("tone_heuristics", {})
        self._caps_ratio_threshold = tone.get("caps_ratio_threshold", 0.6)
        self._min_len_for_caps = tone.get("min_length_for_caps_check", 10)
        self._repeated_punct = re.compile(tone.get("repeated_punctuation_pattern", "[!?]{3,}"))
        self._negative_emoji = set(tone.get("negative_emoji", []))

        # 21.07.2026: термины из Supabase (red_zone_terms, добавленные через
        # /red-zone в admin-panel) — ДОПОЛНИТЕЛЬНО к YAML выше, никогда не
        # вместо него. YAML — это гарантированный минимум покрытия, который
        # не может исчезнуть из-за пустой/ещё не настроенной таблицы; DB —
        # живое расширение, которое Ольга/Франсуа могут пополнять без
        # деплоя. Обновляется не на каждое сообщение (сеть), а по TTL — см.
        # _refresh_db_terms().
        self._db_refresh_seconds = db_refresh_seconds
        self._db_last_refresh = 0.0
        self._db_allergy_patterns: list[re.Pattern] = []
        self._db_indirect_patterns: list[re.Pattern] = []
        self._db_complaint_patterns: list[re.Pattern] = []
        self._refresh_db_terms(force=True)

    def _refresh_db_terms(self, force: bool = False) -> None:
        if supabase_client is None:
            return
        now = time.monotonic()
        if not force and (now - self._db_last_refresh) < self._db_refresh_seconds:
            return
        self._db_last_refresh = now
        try:
            rows = supabase_client.list_red_zone_terms()
        except Exception:
            # Сбой сети/Supabase — остаёмся на уже закешированном наборе
            # (или пустом, если ни разу не получалось), YAML не затрагивается.
            return
        if not rows:
            return
        by_internal_key: dict[str, list[re.Pattern]] = {
            "allergy_medical": [],
            "indirect_patterns": [],
            "complaint_negative": [],
        }
        for row in rows:
            internal_key = _DB_CATEGORY_TO_INTERNAL.get(row.get("category"))
            pattern = row.get("pattern")
            if not internal_key or not pattern:
                continue
            try:
                by_internal_key[internal_key].append(
                    re.compile(r"\b" + pattern, re.IGNORECASE | re.UNICODE)
                )
            except re.error:
                # Битый regex, введённый вручную через UI — пропускаем этот
                # конкретный термин, не роняем весь классификатор из-за него.
                continue
        self._db_allergy_patterns = by_internal_key["allergy_medical"]
        self._db_indirect_patterns = by_internal_key["indirect_patterns"]
        self._db_complaint_patterns = by_internal_key["complaint_negative"]

    def classify(self, message: str) -> RedZoneResult:
        if not message or not message.strip():
            return RedZoneResult(escalate=False, category=None, reason="empty_message")

        self._refresh_db_terms()
        normalized = normalize(message)

        # 1. Здоровье/аллергии — высший приоритет, эскалация без исключений.
        #    YAML-база + живые термины из Supabase (см. _refresh_db_terms).
        matched = [
            p.pattern
            for p in (self._allergy_patterns + self._db_allergy_patterns)
            if p.search(normalized)
        ]
        if matched:
            return RedZoneResult(
                escalate=True,
                category="allergy_medical",
                matched_terms=matched,
                reason="stoplist_term_health",
                classifier_score=1.0,
            )

        # 2. Косвенные конструкции про здоровье (см. пример из handoff).
        matched = [
            p.pattern
            for p in (self._indirect_patterns + self._db_indirect_patterns)
            if p.search(normalized)
        ]
        if matched:
            return RedZoneResult(
                escalate=True,
                category="allergy_medical",
                matched_terms=matched,
                reason="indirect_health_pattern",
                classifier_score=0.9,
            )

        # 3. Жалобы / явно негативная лексика.
        matched = [
            p.pattern
            for p in (self._complaint_patterns + self._db_complaint_patterns)
            if p.search(normalized)
        ]
        if matched:
            return RedZoneResult(
                escalate=True,
                category="complaint_negative",
                matched_terms=matched,
                reason="stoplist_term_complaint",
                classifier_score=0.8,
            )

        # 4. Тон без ключевых слов: КАПС, повторная пунктуация, злые эмодзи.
        tone_reason = self._check_tone(message)
        if tone_reason:
            return RedZoneResult(
                escalate=True,
                category="complaint_negative",
                matched_terms=[],
                reason=tone_reason,
                classifier_score=0.7,
            )

        return RedZoneResult(escalate=False, category=None, reason="no_match")

    def _check_tone(self, message: str) -> Optional[str]:
        letters = [c for c in message if c.isalpha()]
        if len(letters) >= self._min_len_for_caps:
            caps_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
            if caps_ratio >= self._caps_ratio_threshold:
                return "tone_excessive_caps"

        if self._repeated_punct.search(message):
            return "tone_repeated_punctuation"

        if any(ch in self._negative_emoji for ch in message):
            return "tone_negative_emoji"

        return None


# Модульный синглтон для простого импорта: `from red_zone_classifier import classify`
_default_classifier: Optional[RedZoneClassifier] = None


def classify(message: str) -> RedZoneResult:
    global _default_classifier
    if _default_classifier is None:
        _default_classifier = RedZoneClassifier()
    return _default_classifier.classify(message)


def to_db_row(client_id: str, channel: str, message: str) -> dict:
    """Готовая строка для INSERT в red_zone_events (см. hf_schema_v1.sql)."""
    result = classify(message)
    return {
        "client_id": client_id,
        "channel": channel,
        "raw_message": message,
        "matched_stoplist": result.matched_terms or None,
        "classifier_score": result.classifier_score,
        "escalated": result.escalate,
        "escalation_reason": result.reason,
    }
