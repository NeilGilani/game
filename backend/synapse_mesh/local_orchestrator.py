"""Async prompt → intent vector → vault → weight fusion → response pipeline."""
import asyncio
from contextlib import aclosing
from threading import Event

from .runtime import Runtime


class LocalOrchestrator:
    """Keep blocking tensor work off the event loop.

    The runtime's model lock covers fusion, generation, and restoration as one
    transaction. Cancellation stops at the next stage boundary; an in-flight
    device operation finishes and the generator restores the base before exit.
    """

    def __init__(self, runtime=None, *, intent_orchestrator=None, sentinel=None, lean_cloud_limit=1):
        self.runtime = runtime if runtime is not None else Runtime()
        if sentinel is not None:
            if intent_orchestrator is not None:
                raise ValueError('Supply a sentinel or an intent orchestrator, not both')
            from .intent_orchestrator import IntentOrchestrator
            intent_orchestrator = IntentOrchestrator(self.runtime, sentinel, lean_cloud_limit=lean_cloud_limit)
        self.intent_orchestrator = intent_orchestrator

    async def events(self, prompt, max_new_tokens=192, weights=None, experts=None, *, compare=False):
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()
        stop = Event()
        operation = self.runtime.compare_events if compare else self.runtime.response_events

        def work():
            events = None
            try:
                if self.intent_orchestrator is not None:
                    plan = self.intent_orchestrator.plan(prompt, weights, experts)
                    # Re-read telemetry and classify the evolving prefix before
                    # EVERY next-token forward pass, including mid-run changes.
                    token_planner = lambda text: self.intent_orchestrator.plan(
                        prompt, weights, experts, generated_text=text)
                    events = operation(prompt, max_new_tokens, weights, experts,
                                       execution_plan=plan, token_planner=token_planner)
                else:
                    events = operation(prompt, max_new_tokens, weights, experts)
                while not stop.is_set():
                    try:
                        event = next(events)
                    except StopIteration:
                        break
                    loop.call_soon_threadsafe(queue.put_nowait, ('event', event))
            except Exception as error:
                loop.call_soon_threadsafe(queue.put_nowait, ('error', error))
            finally:
                try:
                    if events is not None:
                        events.close()
                finally:
                    loop.call_soon_threadsafe(queue.put_nowait, ('done', None))

        worker = asyncio.create_task(asyncio.to_thread(work))
        try:
            while True:
                kind, value = await queue.get()
                if kind == 'done':
                    break
                if kind == 'error':
                    raise value
                yield value
        finally:
            stop.set()
            # Shield the worker: cancelling a thread future cannot stop GPU work.
            await asyncio.shield(worker)

    async def run(self, prompt, max_new_tokens=192, weights=None, experts=None):
        """Return the response, coefficients, audit, and completed restore timing."""
        result = {}
        async with aclosing(self.events(prompt, max_new_tokens, weights, experts)) as events:
            async for event in events:
                result[event['event']] = {key: value for key, value in event.items() if key != 'event'}
        return {'text': result['response']['text'], **result}
