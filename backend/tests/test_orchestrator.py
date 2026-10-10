import asyncio
from contextlib import aclosing
from threading import Event

import pytest
import torch

from synapse_mesh.orchestrator import Orchestrator
from test_tensor_fusion import SURGICAL_PROMPT, runtime_fixture


def snapshot(runtime):
    return {name: p.detach().clone() for name, p in runtime.model.named_parameters()}


def assert_restored(runtime, before):
    for name, p in runtime.model.named_parameters():
        assert torch.equal(p, before[name])
    assert not runtime.lock.locked()


def test_response_pipeline_and_concurrent_mixtures(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    before = snapshot(runtime)
    observed = []
    original = runtime.generate

    def generate(*args):
        observed.append(runtime.model._synapse_fusion_audit['weights'].copy())
        return original(*args)

    monkeypatch.setattr(runtime, 'generate', generate)
    weights = [{'coding': .6, 'medical': .3, 'legal': .1},
               {'coding': .1, 'medical': .2, 'legal': .7}]

    async def run():
        orchestrator = Orchestrator(runtime)
        return await asyncio.gather(*(orchestrator.run(SURGICAL_PROMPT, 16, w) for w in weights))

    results = asyncio.run(run())
    for result, mixture in zip(results, weights):
        assert result['text'] == result['response']['text']
        assert result['intent']['weights'] == mixture
        assert result['complete']['base_restored']
        assert 'baseline' not in result
    assert (all(actual == pytest.approx(expected) for actual, expected in zip(observed, weights))
            or all(actual == pytest.approx(expected) for actual, expected in zip(observed, reversed(weights))))
    assert_restored(runtime, before)


def test_slow_fusion_does_not_block_event_loop(tmp_path, monkeypatch):
    from synapse_mesh import runtime as runtime_module
    runtime = runtime_fixture(tmp_path, monkeypatch)
    entered, release = Event(), Event()
    original = runtime_module.fuse_weights

    def slow_fusion(*args, **kwargs):
        entered.set()
        if not release.wait(5):
            raise RuntimeError('Event loop failed to release fusion')
        return original(*args, **kwargs)

    monkeypatch.setattr(runtime_module, 'fuse_weights', slow_fusion)

    async def run():
        task = asyncio.create_task(Orchestrator(runtime).run(SURGICAL_PROMPT, 16))
        try:
            async with asyncio.timeout(3):
                while not entered.is_set():
                    await asyncio.sleep(.001)
                # This heartbeat can run while fusion is blocked in its worker.
                await asyncio.sleep(.01)
        finally:
            release.set()
        await task

    asyncio.run(run())


def test_cancellation_during_generation_restores(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    before = snapshot(runtime)
    entered, release = Event(), Event()

    def generate(*args):
        entered.set()
        assert release.wait(5)
        return {'text': 'done', 'tokens': 1, 'phase_ms': 1, 'generation_ms': 1}

    monkeypatch.setattr(runtime, 'generate', generate)

    async def run():
        # Cancellation during an in-flight forward pass must still restore.
        task = asyncio.create_task(Orchestrator(runtime).run(SURGICAL_PROMPT, 16))
        async with asyncio.timeout(3):
            while not entered.is_set():
                await asyncio.sleep(.001)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert_restored(runtime, before)


def test_generation_failure_propagates_and_restores(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    before = snapshot(runtime)

    def fail(*args):
        raise RuntimeError('forward failed')

    monkeypatch.setattr(runtime, 'generate', fail)
    with pytest.raises(RuntimeError, match='forward failed'):
        asyncio.run(Orchestrator(runtime).run(SURGICAL_PROMPT, 16))
    assert_restored(runtime, before)


def test_early_stream_close_runs_cleanup(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    before = snapshot(runtime)

    async def run():
        async with aclosing(Orchestrator(runtime).events(SURGICAL_PROMPT, 16)) as events:
            async for event in events:
                if event['event'] == 'fusion':
                    break

    asyncio.run(run())
    assert_restored(runtime, before)


def test_generate_api_stream(monkeypatch):
    from fastapi.testclient import TestClient
    from synapse_mesh import api

    class Pipeline:
        async def events(self, prompt, max_new_tokens, weights, experts, *, compare):
            assert not compare
            yield {'event': 'intent', 'weights': {'coding': .5, 'legal': .5}}
            yield {'event': 'response', 'text': prompt}
            yield {'event': 'complete', 'base_restored': True}

    monkeypatch.setattr(api, 'orchestrator', Pipeline())
    with TestClient(api.app) as client:
        response = client.post('/generate', json={'prompt': 'Python license'})
    assert response.status_code == 200
    assert '"event": "response"' in response.text
    assert '"base_restored": true' in response.text
