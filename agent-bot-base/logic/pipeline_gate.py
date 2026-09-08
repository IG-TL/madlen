"""
HEALTHY FOOD NHA TRANG — паттерн run_step() для всех будущих микросервисов.
Дата: 18.07.2026

Зачем
-----
Запрос: любой модуль (S3 генератор постов, S6 списки кухни, уровни агента и
т.д.) должен уметь быть отключён из админки, и при этом весь процесс либо
(а) идёт дальше без этого шага, либо (б) останавливается и ждёт, пока
Франсуа/Ольга внесут правку или апрув вручную — а затем продолжает как ни в
чём не бывало.

Это не должно решаться отдельным if/else в каждом модуле — иначе через
десяток модулей поведение расползётся и админка перестанет быть "единой
точкой контроля" (см. ТЗ агента, уровень 9). Поэтому здесь один универсальный
контракт поверх таблиц module_registry / pipeline_gates (hf_schema_v1.sql,
раздел 10).

Контракт
--------
Каждый модуль пишет ОДНУ функцию — "как посчитать результат из входных
данных" — и оборачивает вызов в run_step(). Всё остальное (проверка
enabled/mode, создание гейта, ожидание апрува) берёт на себя run_step().

    def build_kitchen_list(order_batch: dict) -> dict:
        ...  # логика S6, ничего не знает про gates/module_registry
        return {"list_text": "..."}

    result = run_step(
        module_key="S6_kitchen_list",
        entity_type="kitchen_list",
        entity_id=order_batch["date"],
        compute_fn=lambda: build_kitchen_list(order_batch),
        idempotency_key=f"S6_kitchen_list:{order_batch['date']}",
    )

    if result.status == StepStatus.DONE:
        publish(result.payload)
    elif result.status == StepStatus.SKIPPED:
        pass  # модуль выключен, fallback=skip — идём дальше как есть
    elif result.status == StepStatus.WAITING:
        return  # гейт создан, дальше процесс продолжится отдельным
                # вызовом resume_after_gate() при апруве в админке

Это референсная реализация с прямыми SQL-запросами через любой драйвер
(psycopg/asyncpg/supabase-py) — заглушки `db.*` ниже нужно подключить к
реальному клиенту БД на этапе фазы 2.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable, Optional


class StepStatus(str, Enum):
    DONE = "done"          # модуль включён, mode=auto, результат готов сразу
    SKIPPED = "skipped"     # модуль выключен, fallback=skip
    WAITING = "waiting"     # либо mode=manual_approval, либо выключен с fallback=wait_for_manual —
                            # гейт создан, флоу стоит


@dataclass
class StepResult:
    status: StepStatus
    payload: Optional[dict] = None
    gate_id: Optional[str] = None


class Db:
    """Заглушка интерфейса БД. Подключить к реальному клиенту в фазе 2."""

    def get_module_config(self, module_key: str) -> dict:
        raise NotImplementedError

    def find_gate_by_idempotency_key(self, idempotency_key: str) -> Optional[dict]:
        raise NotImplementedError

    def insert_gate(self, **kwargs) -> str:
        raise NotImplementedError

    def resolve_gate(self, gate_id: str, status: str, resolution_payload: dict, resolved_by: str) -> None:
        raise NotImplementedError


def run_step(
    module_key: str,
    entity_type: str,
    entity_id: Any,
    compute_fn: Callable[[], dict],
    idempotency_key: str,
    db: Db,
) -> StepResult:
    """
    Единая точка входа для любого шага пайплайна. Логика:

      1. Прочитать module_registry по module_key.
      2. enabled=false:
           fallback_on_disable='skip'            -> StepStatus.SKIPPED, шаг
                                                      не выполняется вообще
                                                      (compute_fn НЕ вызывается —
                                                      экономим сайд-эффекты)
           fallback_on_disable='wait_for_manual' -> создать/найти гейт,
                                                      StepStatus.WAITING
      3. enabled=true, mode='auto'      -> выполнить compute_fn(), вернуть DONE
      4. enabled=true, mode='manual_approval' -> выполнить compute_fn() как
           черновик, создать/найти гейт с draft_payload, StepStatus.WAITING
    """
    config = db.get_module_config(module_key)

    if not config.get("enabled", True):
        if config.get("fallback_on_disable") == "skip":
            return StepResult(status=StepStatus.SKIPPED)
        return _ensure_gate(
            db, module_key, entity_type, entity_id, idempotency_key,
            draft_payload={"note": "module_disabled_wait_for_manual"},
        )

    if config.get("mode") == "manual_approval":
        draft = compute_fn()
        return _ensure_gate(db, module_key, entity_type, entity_id, idempotency_key, draft)

    # mode == 'auto' и enabled == true
    payload = compute_fn()
    return StepResult(status=StepStatus.DONE, payload=payload)


def _ensure_gate(
    db: Db,
    module_key: str,
    entity_type: str,
    entity_id: Any,
    idempotency_key: str,
    draft_payload: dict,
) -> StepResult:
    existing = db.find_gate_by_idempotency_key(idempotency_key)
    if existing:
        # Уже есть гейт на этот шаг — не плодим дубли при повторном запуске
        # (напр. cron перезапустил джобу до того, как гейт разрешили).
        return StepResult(status=StepStatus.WAITING, gate_id=existing["gate_id"])

    gate_id = db.insert_gate(
        gate_id=str(uuid.uuid4()),
        module_key=module_key,
        entity_type=entity_type,
        entity_id=entity_id,
        draft_payload=draft_payload,
        status="pending",
        idempotency_key=idempotency_key,
    )
    return StepResult(status=StepStatus.WAITING, gate_id=gate_id)


def resume_after_gate(
    gate_id: str,
    decision: str,  # 'approved' | 'edited' | 'rejected'
    resolved_by: str,
    db: Db,
    resolution_payload: Optional[dict] = None,
    next_step_fn: Optional[Callable[[dict], None]] = None,
) -> None:
    """
    Вызывается админкой, когда Франсуа/Ольга нажали "одобрить" / "поправить и
    отправить" / "отклонить" по конкретному гейту. Это то самое место, где
    "процесс идёт дальше по флоу", если модуль был выключен/ждал апрува.
    """
    db.resolve_gate(
        gate_id=gate_id,
        status=decision,
        resolution_payload=resolution_payload or {},
        resolved_by=resolved_by,
    )

    if decision in ("approved", "edited") and next_step_fn is not None:
        next_step_fn(resolution_payload or {})
    # decision == 'rejected' -> шаг считается неудавшимся для этой entity,
    # дальнейшая обработка зависит от entity_type (решается на уровне
    # конкретного модуля, не здесь).
