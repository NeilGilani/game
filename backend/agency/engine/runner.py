"""Background execution of cases: one asyncio task per active case."""

from __future__ import annotations

import asyncio
import logging

from ..models import CaseStatus
from .engine import Engine

log = logging.getLogger("agency.runner")


class CaseRunner:
    def __init__(self, engine: Engine, *, inline: bool = False) -> None:
        self.engine = engine
        self.inline = inline
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._again: set[str] = set()

    async def kick(self, case_id: str) -> None:
        if self.inline:
            await self._run_once(case_id)
            return
        task = self._tasks.get(case_id)
        if task and not task.done():
            self._again.add(case_id)
            return
        self._tasks[case_id] = asyncio.create_task(self._loop(case_id))

    async def _loop(self, case_id: str) -> None:
        while True:
            self._again.discard(case_id)
            await self._run_once(case_id)
            if case_id not in self._again:
                return

    async def _run_once(self, case_id: str) -> None:
        try:
            await self.engine.run_case(case_id)
        except Exception:
            log.exception("case %s crashed", case_id)
            self.engine.store.set_case(case_id, status=CaseStatus.NEEDS_ATTENTION)
            self.engine.store.audit(
                case_id,
                "engine_error",
                "Something went wrong inside AGENCY while working on this case. I stopped it so nothing "
                "unexpected happens. Press Resume to try again.",
                actor="system",
            )

    def busy(self, case_id: str) -> bool:
        task = self._tasks.get(case_id)
        return bool(task and not task.done())

    async def shutdown(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        for task in self._tasks.values():
            try:
                await task
            except asyncio.CancelledError:
                log.info("stopped work on a case for shutdown; it will be reconciled on next start")
            except Exception:
                log.exception("case task failed during shutdown")
