"""Independent tensor and forward-pass checks for adaptive token budgets."""
import asyncio
from contextlib import aclosing
import json
from pathlib import Path
import shutil

import httpx
import pytest
from safetensors.torch import load_file, save_file
import torch

from synapse_mesh.cisco_sentinel import CiscoSentinel
from synapse_mesh.intent_orchestrator import IntentOrchestrator, budget_weights
from synapse_mesh.local_orchestrator import LocalOrchestrator as Orchestrator
from synapse_mesh.tensor_fusion import AdapterTensorStore, fuse_weights, restore_weights
from test_network_fusion import Clock, telemetry
from test_tensor_fusion import fixture, runtime_fixture, SURGICAL_PROMPT


def test_raw_scores_spend_exact_budget_and_critical_kills_other_adapters():
    ideal = {'coding': .8, 'legal': .8, 'medical': .4}
    assert budget_weights(ideal, .6) == pytest.approx({'coding': .24, 'legal': .24, 'medical': .12})
    assert budget_weights(ideal, .4) == pytest.approx({'coding': .16, 'legal': .16, 'medical': .08})
    assert budget_weights(ideal, .1, strongest_only=True) == {'coding': .1, 'legal': 0, 'medical': 0}
    assert budget_weights(ideal, 0) == dict.fromkeys(ideal, 0)
    assert budget_weights({'coding': 0}, .4) == {'coding': 0}


@pytest.mark.parametrize('ideal,cap', [({'coding': float('nan')}, .4), ({'coding': -1}, .4),
                                     ({'coding': 1}, float('inf')), ({'coding': 1}, 1.1),
                                     ({'coding': 1}, -.1), ({}, .1)])
def test_invalid_budget_cannot_reach_kernel(ideal, cap):
    with pytest.raises(ValueError): budget_weights(ideal, cap)


def test_real_critical_traffic_and_latency_produce_point_one_cap():
    clock = Clock()
    samples = [telemetry(0, 0), telemetry(250_000, 100)]
    sentinel = CiscoSentinel('https://router.example', 'user', 'secret', mock_mode=False,
                             clock=clock, transport=httpx.MockTransport(lambda request: httpx.Response(200, json=samples.pop(0))))
    sentinel.poll(); clock.value = 2
    snapshot = sentinel.poll()
    assert snapshot.state == 'CRITICAL' and snapshot.network_cap == .1
    assert snapshot.to_dict()['network_cap'] == .1
    def delayed(request):
        clock.value += 1.1
        return httpx.Response(200, json=telemetry(1, 1))
    slow = CiscoSentinel('https://router.example', 'user', 'secret', mock_mode=False,
                        clock=clock, transport=httpx.MockTransport(delayed))
    assert slow.poll().state == 'CRITICAL'


def test_kernel_preserves_small_coefficients_and_zero_cap(tmp_path):
    base, _, paths = fixture(tmp_path)
    pristine = {name: p.detach().clone() for name, p in base.named_parameters()}
    fuse_weights(base, paths, [.24, .12, .04], base_model_id='test/base')
    assert base._synapse_fusion_audit['weights'] == {'expert_0': .24, 'expert_1': .12, 'expert_2': .04}
    for module, row in [(base.get_submodule(row['module']), row) for row in base._synapse_fusion_audit['layers']]:
        assert any(value > 0 for value in row['delta_norms'].values())
        assert not torch.equal(module.weight, pristine[row['module'] + '.weight'])
    # A zero budget must restore the base and never open missing adapter files.
    fuse_weights(base, ['/missing'], [0.0], base_model_id='test/base')
    assert base._synapse_fusion_audit['loaded_adapters'] == []
    assert base._synapse_fusion_audit['layer_count'] == 0
    assert base._synapse_fusion_audit['matrix_sample'] is None
    for name, p in base.named_parameters(): assert torch.equal(p, pristine[name])


def test_audit_norm_cache_avoids_reductions_and_invalidates_changed_files(tmp_path, monkeypatch):
    base, _, paths = fixture(tmp_path)
    store = AdapterTensorStore()
    fuse_weights(base, paths, [.6, .3, .1], base_model_id='test/base', tensor_store=store)
    first = {row['module']: row['delta_norms'].copy() for row in base._synapse_fusion_audit['layers']}
    original = torch.linalg.vector_norm
    def unexpected(*args, **kwargs): raise AssertionError('Repeated raw norm should come from the audit cache')
    monkeypatch.setattr(torch.linalg, 'vector_norm', unexpected)
    fuse_weights(base, paths, [.24, .12, .04], base_model_id='test/base', tensor_store=store)
    assert base._synapse_fusion_audit['audit_norms_computed'] == 0
    assert base._synapse_fusion_audit['audit_norm_cache_hits'] == 10
    for row in base._synapse_fusion_audit['layers']:
        for name, value in row['delta_norms'].items(): assert value == pytest.approx(first[row['module']][name] * .4)
    monkeypatch.setattr(torch.linalg, 'vector_norm', original)
    changed = paths[0] / 'adapter_model.safetensors'
    tensors = load_file(changed)
    for key in tensors:
        if '.lora_B.' in key: tensors[key] *= 2
    save_file(tensors, changed)
    fuse_weights(base, paths, [.6, .3, .1], base_model_id='test/base', tensor_store=store)
    assert base._synapse_fusion_audit['audit_norms_computed'] == 4
    assert base._synapse_fusion_audit['audit_norm_cache_hits'] == 6
    for row in base._synapse_fusion_audit['layers']:
        if 'expert_0' in row['delta_norms']:
            assert row['delta_norms']['expert_0'] == pytest.approx(first[row['module']]['expert_0'] * 2)
    restore_weights(base)


def independent_matrix_state(runtime, pristine, weights):
    expected = {name: value.clone() for name, value in pristine.items()}
    for name, coefficient in weights.items():
        if not coefficient: continue
        path = Path(runtime.adapter_paths()[name])
        config = json.loads((path / 'adapter_config.json').read_text())
        factors = load_file(path / 'adapter_model.safetensors')
        scale = config['lora_alpha'] / (config['r'] ** .5 if config.get('use_rslora') else config['r'])
        for key, a in factors.items():
            if '.lora_A.' not in key: continue
            b = factors[key.replace('.lora_A.', '.lora_B.')]
            module = key.removeprefix('base_model.model.').split('.lora_A.')[0]
            expected[module + '.weight'].add_(b.half() @ a.half(), alpha=coefficient * scale)
    return expected


def test_network_changes_apply_to_next_token_with_exact_matrices_and_fresh_cache(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    shutil.copytree(tmp_path / 'legal', tmp_path / 'generalist')
    runtime.model.generation_config.eos_token_id = None
    sentinel = CiscoSentinel()
    reasoner = IntentOrchestrator(runtime, sentinel)
    pristine = {name: p.detach().clone() for name, p in runtime.model.named_parameters()}
    original = runtime.model.forward
    observed = []
    transitions = {0: 'CONGESTED', 1: 'CRITICAL', 2: 'OFFLINE', 3: 'OPTIMAL'}
    def forward(*args, **kwargs):
        audit = runtime.model._synapse_fusion_audit
        expected = independent_matrix_state(runtime, pristine, audit['weights'])
        for name, p in runtime.model.named_parameters(): torch.testing.assert_close(p, expected[name], rtol=0, atol=0)
        index = len(observed)
        observed.append((audit['network']['state'], audit['weights'].copy(), kwargs['past_key_values'], kwargs['input_ids'].shape[-1]))
        result = original(*args, **kwargs)
        if index in transitions: sentinel.set_mock_state(transitions[index])
        return result
    monkeypatch.setattr(runtime.model, 'forward', forward)
    result = asyncio.run(Orchestrator(runtime, intent_orchestrator=reasoner).run(
        SURGICAL_PROMPT, 16, {'coding': .6, 'medical': .3, 'legal': .1}))
    assert [row[0] for row in observed[:5]] == ['OPTIMAL', 'CONGESTED', 'CRITICAL', 'OFFLINE', 'OPTIMAL']
    assert observed[1][1] == pytest.approx({'coding': .24, 'medical': .12, 'legal': .04})
    assert observed[2][1] == {'coding': .1, 'medical': 0, 'legal': 0}
    assert observed[3][1]['generalist'] == .1
    # Each transition invalidated the cache before that step; no stale KV reuse.
    assert [row[3] for row in observed[:5]] == [3, 4, 5, 6, 7]
    assert all(row[2] is None for row in observed[:5])
    assert all(row[3] == 1 for row in observed[5:])
    assert result['response']['cache_rebuilds'] == 5
    assert result['response']['cache_reuses'] == 11
    assert result['response']['kernel_updates'] == 5
    assert result['complete']['base_restored']
    for step in result['response']['token_schedule']:
        assert sum(step['weights'].values()) == pytest.approx(step['network_cap'])
    for name, p in runtime.model.named_parameters(): assert torch.equal(p, pristine[name])


def test_classifier_receives_generated_prefix_and_manual_scores_can_exceed_one(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    runtime.model.generation_config.eos_token_id = None
    contexts = []
    def classify(context, experts=None):
        contexts.append(context)
        legal = .2 if context == SURGICAL_PROMPT else .7
        weights = {'coding': 1 - legal, 'medical': 0, 'legal': legal}
        return {'weights': weights, 'evidence': {}, 'excluded': {}, 'adapter_order': list(weights),
                'active_experts': ['coding', 'legal']}
    monkeypatch.setattr(runtime, 'classify', classify)
    sentinel = CiscoSentinel()
    reasoner = IntentOrchestrator(runtime, sentinel)
    result = asyncio.run(Orchestrator(runtime, intent_orchestrator=reasoner).run(SURGICAL_PROMPT, 16))
    assert contexts[0] == SURGICAL_PROMPT and contexts[1] == SURGICAL_PROMPT
    assert contexts[2].startswith(SURGICAL_PROMPT + '\n')
    schedule = result['response']['token_schedule']
    assert schedule[0]['ideal_weights']['legal'] == .2
    assert schedule[1]['ideal_weights']['legal'] == .7
    assert schedule[1]['cache_action'] == 'rebuild'
    sentinel.set_mock_state('CONGESTED')
    raw = reasoner.plan(SURGICAL_PROMPT, {'coding': .8, 'medical': .4, 'legal': .8})
    assert raw['ideal_weights'] == {'coding': .8, 'medical': .4, 'legal': .8}
    assert raw['weights'] == pytest.approx({'coding': .16, 'medical': .08, 'legal': .16})


def test_token_forward_failure_and_early_stream_close_restore_base(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    pristine = {name: p.detach().clone() for name, p in runtime.model.named_parameters()}
    reasoner = IntentOrchestrator(runtime, CiscoSentinel())
    original = runtime.model.forward
    def fail(*args, **kwargs): raise RuntimeError('token forward failed')
    monkeypatch.setattr(runtime.model, 'forward', fail)
    with pytest.raises(RuntimeError, match='token forward failed'):
        asyncio.run(Orchestrator(runtime, intent_orchestrator=reasoner).run(SURGICAL_PROMPT, 16, {'coding': .6, 'medical': .3, 'legal': .1}))
    for name, p in runtime.model.named_parameters(): assert torch.equal(p, pristine[name])
    assert not runtime.lock.locked()
    monkeypatch.setattr(runtime.model, 'forward', original)
    async def cancel_at_token_boundary():
        async with aclosing(Orchestrator(runtime, intent_orchestrator=reasoner).events(SURGICAL_PROMPT, 16)) as events:
            async for event in events:
                if event['event'] == 'token_fusion': break
    asyncio.run(cancel_at_token_boundary())
    for name, p in runtime.model.named_parameters(): assert torch.equal(p, pristine[name])
    assert not runtime.lock.locked()
