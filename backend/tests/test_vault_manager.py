import asyncio
from copy import deepcopy
import json
from threading import Event

import pytest
import torch

from synapse_mesh.runtime import Runtime
from synapse_mesh.tensor_fusion import fuse_weights, restore_weights
from synapse_mesh.vault_manager import VaultManager, SharedVolumeFusion
from synapse_mesh.vault_migration import migrate
from test_tensor_fusion import fixture


def library(tmp_path, device='cpu', **kwargs):
    base, reference, paths = fixture(tmp_path, device)
    entries = {name: {'path': path.name} for name, path in zip(('coding', 'medical', 'legal'), paths)}
    (tmp_path / 'vault.json').write_text(json.dumps({'base_model': 'test/base', 'adapters': entries}))
    return base, reference, VaultManager(tmp_path, base_model_id='test/base', device=device, **kwargs)


def test_concurrent_requests_share_one_upload_and_pointers(tmp_path, monkeypatch):
    base, _, manager = library(tmp_path)
    entered, release = Event(), Event()
    original = manager._load
    def slow(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)
    monkeypatch.setattr(manager, '_load', slow)
    async def run():
        async def request():
            async with manager.lease('coding', base) as entry:
                return [tensor.data_ptr() for tensor in entry.factors.values()]
        tasks = [asyncio.create_task(request()) for _ in range(12)]
        while not entered.is_set():
            await asyncio.sleep(.001)
        # The event loop stays responsive during shared-volume loading.
        await asyncio.sleep(.01)
        release.set()
        pointers = await asyncio.gather(*tasks)
        assert all(value == pointers[0] for value in pointers)
    asyncio.run(run())
    assert manager.loads == 1 and manager.status()['leases'] == 0
    assert manager.status()['inflight'] == 0
    with manager.lease_sync('coding', base):
        assert manager.loads == 1
    manager.close()


def test_cancellation_releases_lease_without_cancelling_shared_load(tmp_path, monkeypatch):
    base, _, manager = library(tmp_path)
    entered, release = Event(), Event()
    original = manager._load
    def slow(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)
    monkeypatch.setattr(manager, '_load', slow)
    async def request():
        async with manager.lease('coding', base):
            pytest.fail('Cancelled caller must not enter the lease body')
    async def run():
        task = asyncio.create_task(request())
        while not entered.is_set():
            await asyncio.sleep(.001)
        task.cancel()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(run())
    assert manager.status()['leases'] == 0 and manager.loads == 1
    manager.close()


def test_memory_budget_never_evicts_live_leases_and_failure_retries(tmp_path):
    base, _, manager = library(tmp_path)
    with manager.lease_sync('coding', base) as first:
        manager.limit = first.bytes
        with pytest.raises(MemoryError):
            with manager.lease_sync('legal', base):
                pass
        assert manager.loads == 1
    with manager.lease_sync('legal', base):
        assert manager.evictions == 1 and manager.loads == 2
    assert manager.status()['leases'] == 0
    manager.close()


def test_runtime_fusion_reuses_shared_factors_and_matches_local_result(tmp_path):
    base, _, manager = library(tmp_path)
    expected = deepcopy(base)
    paths = [manager.paths[name] for name in ('coding', 'medical', 'legal')]
    fuse_weights(expected, paths, [.6, .3, .1], base_model_id='test/base')
    runtime = Runtime(vault=tmp_path, base_model='test/base', device='cpu', vault_manager=manager)
    runtime.model = base
    runtime.fuse_adapters(('coding', 'medical', 'legal'), [.6, .3, .1])
    for actual, wanted in zip(base.parameters(), expected.parameters()):
        torch.testing.assert_close(actual, wanted, rtol=0, atol=0)
    assert manager.loads == 3
    restore_weights(base)
    runtime.fuse_adapters(('coding', 'medical', 'legal'), [.2, .3, .5])
    assert manager.loads == 3
    assert base._synapse_fusion_audit['factor_pairs_loaded'] == 0
    assert base._synapse_fusion_audit['factor_cache_hits'] > 0
    restore_weights(base)
    assert manager.status()['leases'] == 0
    manager.close()


def test_zero_coefficients_never_load_inactive_shared_adapters(tmp_path):
    base, _, manager = library(tmp_path)
    runtime = Runtime(vault=tmp_path, base_model='test/base', device='cpu', vault_manager=manager)
    runtime.model = base
    runtime.fuse_adapters(('coding', 'medical', 'legal'), [1, 0, 0])
    assert manager.loads == 1
    restore_weights(base)
    manager.close()


def test_cloud_kernel_vault_interface_restores_and_is_lazy(tmp_path):
    base, _, manager = library(tmp_path)
    before = {name: p.clone() for name, p in base.named_parameters()}
    vault = SharedVolumeFusion(base, manager)
    vault.warm()
    assert vault.loads == 0 and list(vault.factors) == []
    for weights in ([1, 0, 0], [.7, 0, 0]):
        with vault.fused(weights) as audit:
            assert audit['execution_location'] == 'cloud'
            assert audit['weights']['coding'] == weights[0]
            assert manager.status()['leases'] == 1
        for name, p in base.named_parameters():
            assert torch.equal(p, before[name])
    assert vault.loads == 1 and list(vault.factors) == ['coding']
    assert manager.status()['leases'] == 0
    vault.close()


def test_cloud_http_service_uses_shared_volume_and_reuses_matrices(tmp_path):
    from fastapi.testclient import TestClient
    from synapse_mesh.cloud_api import CloudConfig, create_app
    from synapse_mesh.kernel import CloudKernel
    from test_cloud_kernel import Tokenizer
    base, _, manager = library(tmp_path)
    vault = SharedVolumeFusion(base, manager)
    kernel = CloudKernel(base, Tokenizer(), vault, max_new_tokens=16, allow_cpu_for_tests=True)
    config = CloudConfig('test/base', manager.paths, 'test-key')
    headers = {'Authorization': 'Bearer test-key'}
    body = {'prompt': 'surgical robot software license', 'weight_vector': [.6, .3, .1],
            'max_new_tokens': 4, 'stream': False}
    with TestClient(create_app(config, kernel)) as client:
        for _ in range(2):
            response = client.post('/generate', json=body, headers=headers)
            assert response.status_code == 200
            result = response.json()
            assert result['base_restored'] and result['audit']['shared_vault']['loads'] == 3
        inventory = client.get('/adapters', headers=headers).json()
        assert inventory['adapter_loads'] == 3
        assert inventory['resident_adapters'] == ['coding', 'medical', 'legal']
    assert manager.resident_bytes == 0


def test_cloud_config_reads_migrated_and_legacy_manifests(tmp_path, monkeypatch):
    from synapse_mesh.cloud_api import CloudConfig
    data = {'base_model': 'test/base', 'adapters': {'coding': {'path': 'coding', 'rank': 2}, 'legal': 'legal'}}
    manifest = tmp_path / 'vault.json'
    manifest.write_text(json.dumps(data))
    monkeypatch.setenv('CLOUD_VAULT_MANIFEST', str(manifest))
    monkeypatch.setenv('CLOUD_API_KEY', 'test-key')
    config = CloudConfig.from_env()
    assert config.vault_root == tmp_path
    assert config.adapters == {'coding': tmp_path / 'coding', 'legal': tmp_path / 'legal'}
    manager = VaultManager(tmp_path, base_model_id='test/base', device='cpu')
    assert manager.paths == config.adapters
    manager.close()


def test_changed_files_invalidate_device_cache(tmp_path):
    base, _, manager = library(tmp_path)
    with manager.lease_sync('coding', base):
        pass
    config = manager.paths['coding'] / 'adapter_config.json'
    config.write_text(config.read_text() + '\n')
    with manager.lease_sync('coding', base):
        assert manager.loads == 2
    manager.close()


def test_manifest_cannot_escape_mount_and_missing_mount_fails(tmp_path):
    with pytest.raises(FileNotFoundError, match='not mounted'):
        VaultManager(tmp_path / 'absent', base_model_id='test/base', device='cpu')
    (tmp_path / 'vault.json').write_text(json.dumps({'base_model': 'test/base', 'adapters': {'coding': {'path': '../escape'}}}))
    with pytest.raises(ValueError, match='inside'):
        VaultManager(tmp_path, base_model_id='test/base', device='cpu')


def test_migration_is_verified_idempotent_and_does_not_remove_originals(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    base, _, paths = fixture(source)
    for name, path in zip(('coding', 'medical', 'legal'), paths):
        path.rename(source / name)
    target = tmp_path / 'shared'
    target.mkdir()
    manifest = migrate(source, target, 'test/base')
    assert manifest == migrate(source, target, 'test/base')
    assert (source / 'coding/adapter_model.safetensors').is_file()
    manager = VaultManager(target, base_model_id='test/base', device='cpu')
    with manager.lease_sync('coding', base):
        pass
    manager.close()
    config = target / manifest['adapters']['coding']['path'] / 'adapter_config.json'
    config.write_text(config.read_text() + '\n')
    manager = VaultManager(target, base_model_id='test/base', device='cpu')
    with pytest.raises(ValueError, match='checksum'):
        with manager.lease_sync('coding', base):
            pass
    assert manager.resident_bytes == 0 and manager.status()['leases'] == 0
    manager.close()


@pytest.mark.parametrize('device', ['cuda:0', 'mps'])
def test_real_accelerator_factors_stay_resident(tmp_path, device):
    if device.startswith('cuda') and not torch.cuda.is_available():
        pytest.skip('CUDA unavailable')
    if device == 'mps' and not torch.backends.mps.is_available():
        pytest.skip('Metal unavailable')
    base, _, manager = library(tmp_path, device)
    with manager.lease_sync('coding', base) as first:
        pointers = [tensor.data_ptr() for tensor in first.factors.values()]
        assert all(tensor.device.type == device.split(':')[0] for tensor in first.factors.values())
    with manager.lease_sync('coding', base) as second:
        assert pointers == [tensor.data_ptr() for tensor in second.factors.values()]
    assert manager.loads == 1
    manager.close()
