import asyncio
import json
from threading import Event

import httpx
import pytest
import torch

from synapse_mesh.cisco_sentinel import CiscoSentinel
from synapse_mesh.local_orchestrator import LocalOrchestrator as Orchestrator
from test_tensor_fusion import SURGICAL_PROMPT, runtime_fixture


class Clock:
    value = 0.0
    def __call__(self):
        return self.value


@pytest.mark.parametrize('rtt,state', [(149, 'OPTIMAL'), (150, 'OPTIMAL'), (151, 'CONGESTED'), (1000, 'CRITICAL')])
def test_cloud_rtt_threshold(rtt, state):
    clock = Clock()
    def probe(request):
        assert str(request.url) == 'https://kernel.example/health'
        assert 'Authorization' not in request.headers
        clock.value += rtt / 1000
        return httpx.Response(200)
    sentinel = CiscoSentinel(mock_mode=False, cloud_kernel_url='https://kernel.example/health',
                             transport=httpx.MockTransport(probe), clock=clock)
    sample = sentinel.poll()
    assert sample.state == state
    assert sample.latency_ms == pytest.approx(rtt)
    assert sample.source == 'cloud-rtt'
    assert 'Cloud-Kernel' in sample.latency_kind


@pytest.mark.parametrize('failure', ['timeout', 'http'])
def test_failed_cloud_probe_is_offline(failure):
    def probe(request):
        if failure == 'timeout':
            raise httpx.ReadTimeout('private details', request=request)
        return httpx.Response(503)
    sentinel = CiscoSentinel(mock_mode=False, cloud_kernel_url='https://kernel.example/health',
                             transport=httpx.MockTransport(probe))
    assert sentinel.poll().state == 'OFFLINE'
    assert 'private details' not in str(sentinel.snapshot().to_dict())


def test_pending_probe_does_not_block_snapshot_or_event_loop():
    entered, release = Event(), Event()
    def probe(request):
        entered.set()
        assert release.wait(3)
        return httpx.Response(200)
    sentinel = CiscoSentinel(mock_mode=False, cloud_kernel_url='https://kernel.example/health',
                             transport=httpx.MockTransport(probe))
    async def run():
        task = asyncio.create_task(asyncio.to_thread(sentinel.poll))
        try:
            async with asyncio.timeout(2):
                while not entered.is_set():
                    await asyncio.sleep(.001)
                # Read in another worker so a regression fails by timeout.
                sample = await asyncio.to_thread(sentinel.snapshot)
                assert sample.revision == 0
        finally:
            release.set()
            await task
    asyncio.run(run())


def test_rtt_signals_real_orchestrator_prunes_cloud_and_recovers(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    registry = {name: {'path': str(tmp_path / adapter), 'label': name, 'expertise': 'Python', 'repo_id': name}
                for name, adapter in [('cloud_a', 'coding'), ('cloud_b', 'medical')]}
    runtime.catalog.registry.write_text(json.dumps(registry))
    clock = Clock()
    latency = 151
    def probe(request):
        clock.value += latency / 1000
        return httpx.Response(200)
    sentinel = CiscoSentinel(mock_mode=False, cloud_kernel_url='https://kernel.example/health',
                             transport=httpx.MockTransport(probe), clock=clock)
    pipeline = Orchestrator(runtime, sentinel=sentinel)
    before = {name: p.detach().clone() for name, p in runtime.model.named_parameters()}
    weights = {'coding': .2, 'medical': .1, 'legal': .1, 'cloud_a': .4, 'cloud_b': .2}
    async def run():
        await asyncio.to_thread(sentinel.poll)
        lean = await pipeline.run(SURGICAL_PROMPT, 16, weights, list(weights))
        assert lean['intent']['fusion_mode'] == 'Lean-Fusion'
        assert lean['intent']['cloud_adapters_requested'] == ['cloud_a']
        assert lean['intent']['cloud_adapters_pruned'] == ['cloud_b']
        assert lean['intent']['weights']['cloud_b'] == 0
        assert lean['intent']['ideal_weights'] == weights
        assert set(lean['fusion']['loaded_adapters']) == {'coding', 'medical', 'legal', 'cloud_a'}
        assert lean['fusion']['cloud_adapters_requested'] == ['cloud_a']
        assert all(step['cloud_adapters_pruned'] == ['cloud_b'] for step in lean['response']['token_schedule'])
        nonlocal latency
        latency = 100
        await asyncio.to_thread(sentinel.poll)
        recovered = await pipeline.run(SURGICAL_PROMPT, 16, weights, list(weights))
        assert recovered['intent']['fusion_mode'] == 'Ultra-Fusion'
        assert recovered['intent']['cloud_adapters_requested'] == ['cloud_a', 'cloud_b']
        assert set(recovered['fusion']['loaded_adapters']) == set(weights)
    asyncio.run(run())
    for name, p in runtime.model.named_parameters():
        assert torch.equal(p, before[name])


def test_cloud_env_configuration(monkeypatch):
    monkeypatch.setenv('CISCO_MODE', 'cloud')
    monkeypatch.setenv('SYNAPSE_CLOUD_KERNEL_URL', 'https://kernel.example/health')
    monkeypatch.delenv('CISCO_LATENCY_THRESHOLD_MS', raising=False)
    sentinel = CiscoSentinel.from_env()
    assert not sentinel.mock_mode
    assert sentinel.latency_threshold_ms == 150
    monkeypatch.delenv('SYNAPSE_CLOUD_KERNEL_URL')
    with pytest.raises(ValueError, match='SYNAPSE_CLOUD_KERNEL_URL'):
        CiscoSentinel.from_env()
