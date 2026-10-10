import asyncio
from copy import deepcopy
import json
import shutil

import httpx
import pytest
import torch

from synapse_mesh.cisco_sentinel import CiscoSentinel, NetworkState
from synapse_mesh.intent_orchestrator import IntentOrchestrator
from synapse_mesh.orchestrator import Orchestrator
from test_tensor_fusion import runtime_fixture, SURGICAL_PROMPT


class Clock:
    value = 0.0
    def __call__(self): return self.value


def telemetry(rx, tx, speed=1_000_000, status='up', discontinuity='initial'):
    return {'ietf-interfaces:interfaces-state': {'interface': [{
        'name': 'GigabitEthernet1', 'oper-status': status, 'speed': speed,
        'statistics': {'in-octets': rx, 'out-octets': tx, 'discontinuity-time': discontinuity},
    }]}}


def test_mock_modes_and_revision():
    sentinel = CiscoSentinel()
    assert sentinel.snapshot().state == NetworkState.OPTIMAL
    previous = sentinel.snapshot().revision
    for state in ('CONGESTED', 'CRITICAL', 'OFFLINE', 'OPTIMAL'):
        sample = sentinel.set_mock_state(state)
        assert sample.state == state and sample.source == 'mock'
        assert sample.revision > previous
        previous = sample.revision
        assert sentinel.set_mock_state(state).revision == previous
    with pytest.raises(ValueError): sentinel.set_mock_state('INVALID')


def test_restconf_real_counter_rates_resets_and_staleness():
    clock = Clock()
    counters = [telemetry(0, 0), telemetry(200_000, 100_000), telemetry(201_000, 101_000), telemetry(0, 0, discontinuity='reset')]
    def handler(request):
        assert request.url.path == '/restconf/data/ietf-interfaces:interfaces-state'
        assert request.headers['Accept'] == 'application/yang-data+json'
        assert request.headers['Authorization'].startswith('Basic ')
        return httpx.Response(200, json=counters.pop(0))
    sentinel = CiscoSentinel('https://router.example', 'user', 'secret', mock_mode=False,
                             transport=httpx.MockTransport(handler), clock=clock)
    assert sentinel.poll().state == 'CONGESTED'  # No fabricated first-sample rate.
    clock.value = 2
    jam = sentinel.poll()
    assert jam.utilization == pytest.approx(.8) and jam.state == 'CONGESTED'
    assert jam.interfaces[0]['rx_bps'] == 800_000
    assert jam.interfaces[0]['tx_bps'] == 400_000
    clock.value = 4
    assert sentinel.poll().state == 'OPTIMAL'
    clock.value = 11
    stale = sentinel.snapshot()
    assert stale.state == 'OFFLINE'
    assert sentinel.snapshot().revision == stale.revision
    clock.value = 12
    reset = sentinel.poll()
    assert reset.state == 'CONGESTED' and reset.utilization is None


def test_latency_can_trigger_lean_even_at_low_traffic():
    clock = Clock()
    counter = 0
    def handler(request):
        nonlocal counter
        clock.value += .3
        counter += 10
        return httpx.Response(200, json=telemetry(counter, counter))
    sentinel = CiscoSentinel('https://router.example', 'user', 'secret', mock_mode=False,
                             transport=httpx.MockTransport(handler), clock=clock)
    sentinel.poll()
    clock.value += 2
    sample = sentinel.poll()
    assert sample.utilization < .01
    assert sample.latency_ms == pytest.approx(300)
    assert sample.state == 'CONGESTED'


@pytest.mark.parametrize('failure', ['auth', 'timeout', 'bad-json', 'down'])
def test_restconf_failure_is_offline_without_credentials_in_response(failure):
    def handler(request):
        if failure == 'auth': return httpx.Response(401)
        if failure == 'timeout': raise httpx.ReadTimeout('secret should not appear', request=request)
        if failure == 'bad-json': return httpx.Response(200, text='invalid')
        return httpx.Response(200, json=telemetry(0, 0, status='down'))
    sentinel = CiscoSentinel('https://router.example', 'user', 'secret', mock_mode=False,
                             transport=httpx.MockTransport(handler))
    sample = sentinel.poll()
    assert sample.state == 'OFFLINE'
    assert 'secret' not in json.dumps(sample.to_dict())
    with pytest.raises(ValueError, match='disabled'): sentinel.set_mock_state('OPTIMAL')


class IntentRuntime:
    calls = 0
    cached = False
    def adapter_paths(self): return dict.fromkeys(('coding', 'medical', 'legal', 'generalist'), 'local')
    def pre_cache_generalist(self): self.cached = True
    def resolve_intent(self, *args):
        self.calls += 1
        return {'weights': {'coding': .7, 'medical': .2, 'legal': .1},
                'adapter_order': ['coding', 'medical', 'legal'], 'evidence': {}, 'excluded': {}}


def test_intent_modes_preserve_normalize_and_bypass_classifier():
    runtime, sentinel = IntentRuntime(), CiscoSentinel()
    reasoner = IntentOrchestrator(runtime, sentinel)
    ultra = reasoner.plan('Python medical license')
    assert ultra['weights'] == {'coding': .7, 'medical': .2, 'legal': .1}
    sentinel.set_mock_state('CONGESTED')
    lean = reasoner.plan('Python medical license')
    assert lean['weights'] == pytest.approx({'coding': .28, 'medical': .08, 'legal': .04})
    assert lean['intent_weights'] == ultra['intent_weights']
    sentinel.set_mock_state('OFFLINE')
    safe = reasoner.plan('Python medical license')
    assert runtime.calls == 2 and runtime.cached
    assert safe['weights'] == {'coding': 0, 'medical': 0, 'legal': 0, 'generalist': .1}
    for result, mode in zip((ultra, lean, safe), ('Ultra-Fusion', 'Lean-Fusion', 'Safe-Mode')):
        assert result['fusion_mode'] == mode
        assert sum(result['weight_vector']) == pytest.approx(result['network_cap'])
        assert result['weight_vector'] == [result['weights'][name] for name in result['adapter_order']]
    with pytest.raises(ValueError): reasoner.plan('   ')


@pytest.mark.parametrize('state,loaded', [('OPTIMAL', ['coding', 'medical', 'legal']), ('CONGESTED', ['coding', 'medical', 'legal']), ('CRITICAL', ['coding']), ('OFFLINE', ['generalist'])])
def test_network_pipeline_modifies_real_tensors_and_restores(tmp_path, monkeypatch, state, loaded):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    # Synthetic test factors are separate from the production trained generalist.
    shutil.copytree(tmp_path / 'legal', tmp_path / 'generalist')
    sentinel = CiscoSentinel(); sentinel.set_mock_state(state)
    reasoner = IntentOrchestrator(runtime, sentinel)
    before = {name: parameter.clone() for name, parameter in runtime.model.named_parameters()}
    original = runtime.model.forward
    def observed_forward(*args, **kwargs):
        assert any(not torch.equal(parameter, before[name]) for name, parameter in runtime.model.named_parameters())
        return original(*args, **kwargs)
    monkeypatch.setattr(runtime.model, 'forward', observed_forward)
    result = asyncio.run(Orchestrator(runtime, intent_orchestrator=reasoner).run(SURGICAL_PROMPT, 16, {'coding': .6, 'medical': .3, 'legal': .1}))
    assert result['fusion']['loaded_adapters'] == loaded
    assert result['fusion']['network']['state'] == state
    assert result['fusion']['weights'] == pytest.approx(result['intent']['weights'])
    assert result['complete']['base_restored']
    for name, parameter in runtime.model.named_parameters(): assert torch.equal(parameter, before[name])


def test_network_api_updates_policy_and_rejects_invalid_states(monkeypatch):
    from fastapi.testclient import TestClient
    from synapse_mesh import api
    sentinel = CiscoSentinel()
    monkeypatch.setattr(api, 'sentinel', sentinel)
    monkeypatch.setattr(api, 'reasoner', IntentOrchestrator(IntentRuntime(), sentinel))
    client = TestClient(api.app)
    assert client.get('/network').json()['source'] == 'mock'
    assert client.post('/network/mock', json={'state': 'CONGESTED'}).status_code == 200
    assert client.post('/intent', json={'prompt': 'Python medical license'}).json()['fusion_mode'] == 'Lean-Fusion'
    assert client.post('/network/mock', json={'state': 'INVALID'}).status_code == 422
    assert client.post('/network/mock', json={'state': 'OFFLINE'}).status_code == 200
    assert client.post('/intent', json={'prompt': 'Python medical license'}).json()['active_experts'] == ['generalist']


def test_safe_mode_does_not_need_specialist_files_or_classifier(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    shutil.copytree(tmp_path / 'legal', tmp_path / 'generalist')
    shutil.rmtree(tmp_path / 'coding')
    shutil.rmtree(tmp_path / 'medical')
    shutil.rmtree(tmp_path / 'legal')
    def unavailable(*args): raise AssertionError('Offline must not invoke the classifier')
    monkeypatch.setattr(runtime, 'resolve_intent', unavailable)
    sentinel = CiscoSentinel(); sentinel.set_mock_state('OFFLINE')
    result = asyncio.run(Orchestrator(runtime, intent_orchestrator=IntentOrchestrator(runtime, sentinel)).run(SURGICAL_PROMPT, 16))
    assert result['fusion']['loaded_adapters'] == ['generalist']
    assert result['complete']['base_restored']
