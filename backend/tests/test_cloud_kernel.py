"""Independent tensor math, warm-cache, rollback, and cloud HTTP contracts."""
import asyncio
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import httpx
from threading import Event

from fastapi.testclient import TestClient
import pytest
import torch

from synapse_mesh.cloud_api import CloudConfig, GenerateRequest, RpcRequest, create_app, kernel_events
from synapse_mesh.kernel import CloudKernel
from synapse_mesh.tensor_fusion import ResidentFusion
from test_tensor_fusion import fixture, reference_weights


class Tokenizer:
    chat_template = 'test'

    def apply_chat_template(self, messages, **kwargs):
        assert len(messages) == 1 and messages[0]['role'] == 'user'
        assert messages[0]['content'] == 'surgical robot software license'
        return {'input_ids': torch.tensor([[1, 2, 3]]), 'attention_mask': torch.ones(1, 3, dtype=torch.long)}

    def decode(self, ids, **kwargs):
        return ' '.join(map(str, ids))


def kernel_fixture(tmp_path, device='cpu'):
    base, reference, paths = fixture(tmp_path, device, torch.float16)
    vault = ResidentFusion(base, paths, adapter_names=('coding', 'medical', 'legal'),
                           base_model_id='test/base', reserve_bytes=0)
    vault.warm()
    kernel = CloudKernel(base, Tokenizer(), vault, max_new_tokens=16,
                         allow_cpu_for_tests=device == 'cpu')
    config = CloudConfig('test/base', dict(zip(vault.names, paths)), 'test-secret', max_new_tokens=16)
    return kernel, reference, config


def test_warm_vault_matches_independent_peft_math_without_disk_reads(tmp_path, monkeypatch):
    kernel, reference, _ = kernel_fixture(tmp_path)
    pristine = deepcopy(kernel.model)
    loads = kernel.vault.loads
    pointers = {name: [(a.data_ptr(), b.data_ptr()) for _, a, b in factors]
                for name, factors in kernel.vault.factors.items()}

    def forbidden(*args, **kwargs):
        raise AssertionError('A warm request must not read adapter files')

    monkeypatch.setattr('synapse_mesh.tensor_fusion.safe_open', forbidden)
    for coefficients in ([.6, .3, .1], [.24, .12, .04], [0, .1, 0], [0, 0, 0]):
        expected = deepcopy(pristine)
        reference_weights(expected, reference, ('code', 'clinical', 'law'), coefficients)
        with kernel.vault.fused(coefficients) as audit:
            assert list(audit['weights'].values()) == coefficients
            assert audit['adapters_loaded'] == 0
            for name, parameter in kernel.model.named_parameters():
                torch.testing.assert_close(parameter, dict(expected.named_parameters())[name], rtol=0, atol=0)
        for name, parameter in kernel.model.named_parameters():
            assert torch.equal(parameter, dict(pristine.named_parameters())[name])
    assert kernel.vault.loads == loads
    assert pointers == {name: [(a.data_ptr(), b.data_ptr()) for _, a, b in factors]
                        for name, factors in kernel.vault.factors.items()}
    assert kernel.vault.resident_bytes == kernel.vault.factor_bytes


def test_matmul_failure_restores_after_partial_mutation(tmp_path, monkeypatch):
    kernel, _, _ = kernel_fixture(tmp_path)
    pristine = {n: p.detach().clone() for n, p in kernel.model.named_parameters()}
    original = torch.matmul
    calls = 0

    def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError('simulated CUDA fault')
        return original(*args, **kwargs)

    monkeypatch.setattr(torch, 'matmul', fail_second)
    with pytest.raises(RuntimeError, match='CUDA fault'):
        kernel.vault.apply([.6, .3, .1])
    for name, parameter in kernel.model.named_parameters():
        assert torch.equal(parameter, pristine[name])


def test_vault_budget_rejected_before_mutation(tmp_path):
    base, _, paths = fixture(tmp_path)
    before = {n: p.detach().clone() for n, p in base.named_parameters()}
    with pytest.raises(MemoryError, match='cache budget'):
        ResidentFusion(base, paths, adapter_names=('coding', 'medical', 'legal'),
                       base_model_id='test/base', cache_bytes=1, compute_dtype=torch.float16)
    for name, parameter in base.named_parameters():
        assert torch.equal(parameter, before[name])


def test_production_refuses_cpu_fallback(tmp_path):
    kernel, _, _ = kernel_fixture(tmp_path)
    with pytest.raises(RuntimeError, match='CUDA GPU'):
        CloudKernel(kernel.model, kernel.tokenizer, kernel.vault)


def test_http_stream_and_json_return_actual_generated_tokens(tmp_path):
    kernel, _, config = kernel_fixture(tmp_path)
    pristine = {n: p.detach().clone() for n, p in kernel.model.named_parameters()}
    body = {'prompt': 'surgical robot software license', 'weight_vector': [.6, .3, .1], 'max_new_tokens': 4}
    headers = {'Authorization': 'Bearer test-secret'}
    with TestClient(create_app(config, kernel)) as client:
        assert client.get('/health').json()['ready'] is True
        assert client.post('/generate', json=body).status_code == 401
        inventory = client.get('/adapters', headers=headers).json()
        assert inventory['adapter_order'] == ['coding', 'medical', 'legal']
        response = client.post('/generate', json=body, headers=headers)
        assert response.status_code == 200
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[0]['event'] == 'fusion'
        result = events[-1]
        assert result['event'] == 'complete' and result['base_restored']
        assert result['token_ids'] == [e['token_id'] for e in events if e['event'] == 'token']
        assert result['audit']['adapters_loaded'] == 0
        result2 = client.post('/v1/generate', json={**body, 'stream': False}, headers=headers).json()
        assert result2['text'] == result['text'] and result2['token_ids'] == result['token_ids']
        for vector in ([.8, .3, .1], [1], [-.1, .6, .5], {'coding': 1}):
            assert client.post('/generate', json={**body, 'weight_vector': vector}, headers=headers).status_code == 422
        assert client.get('/adapters', headers=headers).json()['pending_requests'] == 0
    for name, parameter in kernel.model.named_parameters():
        assert torch.equal(parameter, pristine[name])


def test_close_mid_generation_restores_and_unlocks(tmp_path):
    kernel, _, _ = kernel_fixture(tmp_path)
    pristine = {n: p.detach().clone() for n, p in kernel.model.named_parameters()}
    events = kernel.events('surgical robot software license', [.6, .3, .1], 8)
    assert next(events)['event'] == 'fusion'
    assert kernel.vault.is_fused
    events.close()
    assert not kernel.vault.is_fused and not kernel.lock.locked()
    for name, parameter in kernel.model.named_parameters():
        assert torch.equal(parameter, pristine[name])


def test_decode_failure_restores_and_next_request_succeeds(tmp_path, monkeypatch):
    kernel, _, _ = kernel_fixture(tmp_path)
    before = deepcopy(kernel.model.state_dict())
    original = kernel.model.forward

    def fail(*args, **kwargs):
        raise RuntimeError('decoder failed')

    monkeypatch.setattr(kernel.model, 'forward', fail)
    with pytest.raises(RuntimeError, match='decoder failed'):
        list(kernel.events('surgical robot software license', [.6, .3, .1], 4))
    for name, tensor in kernel.model.state_dict().items():
        assert torch.equal(tensor, before[name])
    monkeypatch.setattr(kernel.model, 'forward', original)
    assert list(kernel.events('surgical robot software license', [0, 0, 0], 4))[-1]['base_restored']


def test_async_backpressure_cancellation_restores_model(tmp_path):
    kernel, _, _ = kernel_fixture(tmp_path)

    async def scenario():
        body = GenerateRequest(prompt='surgical robot software license', weight_vector=[.6, .3, .1], max_new_tokens=16)
        events = kernel_events(kernel, body, body.weight_vector)
        assert (await anext(events))['event'] == 'fusion'
        # Let the producer fill its bounded queue while the consumer pauses.
        await asyncio.sleep(.15)
        await asyncio.wait_for(events.aclose(), timeout=5)
        assert not kernel.lock.locked() and not kernel.vault.is_fused

    asyncio.run(scenario())


def test_cancel_queued_request_does_not_touch_active_transaction(tmp_path):
    kernel, _, _ = kernel_fixture(tmp_path)
    stop = Event()
    kernel.lock.acquire()
    stop.set()
    try:
        assert list(kernel.events('surgical robot software license', [1, 0, 0], 1, stop=stop)) == []
        assert not kernel.vault.is_fused
    finally:
        kernel.lock.release()


def test_transactions_are_serialized_across_vectors(tmp_path):
    kernel, reference, _ = kernel_fixture(tmp_path)
    pristine = deepcopy(kernel.model)
    expected = deepcopy(pristine)
    reference_weights(expected, reference, ('code', 'clinical', 'law'), [.6, .3, .1])
    first = kernel.events('surgical robot software license', [.6, .3, .1], 2)
    assert next(first)['event'] == 'fusion'
    with ThreadPoolExecutor(max_workers=1) as executor:
        second = executor.submit(lambda: list(kernel.events('surgical robot software license', [0, .1, 0], 2)))
        try:
            assert not second.done()
            for name, parameter in kernel.model.named_parameters():
                assert torch.equal(parameter, dict(expected.named_parameters())[name])
        finally:
            first.close()
        result = second.result(timeout=5)[-1]
        assert result['weights'] == {'coding': 0, 'medical': .1, 'legal': 0}
    for name, parameter in kernel.model.named_parameters():
        assert torch.equal(parameter, dict(pristine.named_parameters())[name])


def test_health_remains_responsive_and_admission_is_bounded(tmp_path, monkeypatch):
    kernel, _, config = kernel_fixture(tmp_path)
    config = replace(config, max_pending_requests=1)
    entered = Event()
    proceed = Event()
    original = kernel.model.forward

    def delayed(*args, **kwargs):
        entered.set()
        if not proceed.wait(timeout=5):
            raise RuntimeError('Test consumer failed to release GPU worker')
        return original(*args, **kwargs)

    monkeypatch.setattr(kernel.model, 'forward', delayed)
    headers = {'Authorization': 'Bearer test-secret'}
    body = {'prompt': 'surgical robot software license', 'weight_vector': [.6, .3, .1], 'max_new_tokens': 2}
    with TestClient(create_app(config, kernel)) as client, ThreadPoolExecutor(max_workers=1) as executor:
        request = executor.submit(lambda: client.post('/generate', json=body, headers=headers))
        try:
            assert entered.wait(timeout=5)
            assert client.get('/health').json()['status'] == 'ok'
            assert client.post('/generate', json=body, headers=headers).status_code == 503
        finally:
            proceed.set()
        assert request.result(timeout=5).status_code == 200
        assert client.get('/adapters', headers=headers).json()['pending_requests'] == 0


def test_real_edge_rpc_comparison_contract(tmp_path):
    from synapse_mesh.orchestrator import CloudKernelClient, Orchestrator
    kernel, _, config = kernel_fixture(tmp_path)
    before = deepcopy(kernel.model.state_dict())
    app = create_app(config, kernel)

    class Sifter:
        def resolve_intent(self, prompt, weights, experts):
            return {'weights': {'coding': .6, 'medical': .3, 'legal': .1},
                    'weight_vector': [.6, .3, .1], 'adapter_order': list(kernel.vault.names),
                    'active_experts': list(kernel.vault.names), 'evidence': {}, 'excluded': {}}

    async def scenario():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app)) as client:
                remote = CloudKernelClient('http://cloud.test/rpc', client=client, api_key='test-secret')
                edge = Orchestrator(Sifter(), cloud_client=remote)
                events = [e async for e in edge.events('surgical robot software license', 16, compare=True)]
                assert any(e['event'] == 'baseline' and e['text'] for e in events)
                audit = next(e for e in events if e['event'] == 'fusion')
                assert audit['weights'] == {'coding': .6, 'medical': .3, 'legal': .1}
                assert audit['layers'] and audit['matrix_sample']
                assert events[-1]['event'] == 'complete' and events[-1]['base_restored']
                assert next(e for e in events if e['event'] == 'fused')['text']
                assert app.state.pending == 0

    asyncio.run(scenario())
    for name, tensor in kernel.model.state_dict().items():
        assert torch.equal(tensor, before[name])


def test_rpc_replay_uses_cached_result_without_forward_pass(tmp_path, monkeypatch):
    kernel, _, config = kernel_fixture(tmp_path)
    body = {'jsonrpc': '2.0', 'id': 'same-id', 'method': 'fuse_and_generate',
            'params': {'request_id': 'same-id', 'prompt': 'surgical robot software license',
                       'weights': [.6, .3, .1], 'adapter_order': list(kernel.vault.names), 'max_new_tokens': 4}}
    headers = {'Authorization': 'Bearer test-secret'}
    with TestClient(create_app(config, kernel)) as client:
        first = [json.loads(line) for line in client.post('/rpc', json=body, headers=headers).text.splitlines()]
        chunks = [e for e in first if 'token' in e and not e['done']]
        assert chunks and first[-1]['done'] and first[-1]['base_restored']

        def forbidden(*args, **kwargs):
            raise AssertionError('Completed RPC replay must not generate again')

        monkeypatch.setattr(kernel, 'events', forbidden)
        second_body = {**body, 'params': {**body['params'], 'resume_from': 1}}
        second = [json.loads(line) for line in client.post('/rpc', json=second_body, headers=headers).text.splitlines()]
        assert [e for e in second if 'token' in e and not e['done']] == chunks[1:]
        assert second[-1] == first[-1]
        changed = {**body, 'params': {**body['params'], 'prompt': 'different request'}}
        assert client.post('/rpc', json=changed, headers=headers).status_code == 409


def test_rpc_disconnect_and_resume_conditions_on_exact_token_prefix(tmp_path):
    kernel, _, config = kernel_fixture(tmp_path)
    kernel.model.generation_config.eos_token_id = None
    body = {'jsonrpc': '2.0', 'id': 'resume-id', 'method': 'fuse_and_generate',
            'params': {'request_id': 'resume-id', 'prompt': 'surgical robot software license',
                       'weights': [.6, .3, .1], 'adapter_order': list(kernel.vault.names), 'max_new_tokens': 16}}
    app = create_app(config, kernel)

    async def scenario():
        async with app.router.lifespan_context(app):
            endpoint = next(route.endpoint for route in app.routes if getattr(route, 'path', '') == '/rpc')
            response = await endpoint(RpcRequest(**body))
            iterator = response.body_iterator
            assert json.loads(await anext(iterator))['event'] == 'fusion'
            frame = json.loads(await anext(iterator))
            assert frame['index'] == 1 and frame['token']
            await iterator.aclose()
            record = app.state.rpc_records['resume-id']
            prefix = list(record['token_ids'])
            assert prefix and not record['active'] and app.state.pending == 0
            assert not kernel.lock.locked() and not kernel.vault.is_fused
            expected = list(kernel.events('surgical robot software license', [.24, .12, .04], 16,
                                          prefix_token_ids=prefix))[-1]
            resume_body = {**body, 'params': {**body['params'], 'resume_from': 1,
                                             'weights': [.24, .12, .04], 'network_cap': .4}}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://cloud.test') as client:
                result = await client.post('/rpc', json=resume_body, headers={'Authorization': 'Bearer test-secret'})
            frames = [json.loads(line) for line in result.text.splitlines()]
            assert frames[-1]['done'] and frames[-1]['base_restored']
            assert record['token_ids'] == expected['token_ids']
            assert record['token_ids'][:len(prefix)] == prefix
            assert frame['token'] + ''.join(e['token'] for e in frames if 'token' in e and not e['done']) == expected['text']
            assert next(e for e in frames if e.get('event') == 'fusion')['weights'] == {'coding': .24, 'medical': .12, 'legal': .04}

    asyncio.run(scenario())


@pytest.mark.skipif(not torch.cuda.is_available(), reason='CUDA GPU unavailable')
def test_real_cuda_vault_residency_and_generated_tokens(tmp_path):
    kernel, _, _ = kernel_fixture(tmp_path, 'cuda:0')
    for factors in kernel.vault.factors.values():
        assert all(t.device.type == 'cuda' and t.dtype == torch.float16 for _, a, b in factors for t in (a, b))
    result = list(kernel.events('surgical robot software license', [.6, .3, .1], 4))[-1]
    assert result['audit']['device'].startswith('cuda') and result['base_restored']
