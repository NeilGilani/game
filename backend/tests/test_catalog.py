from copy import deepcopy
import json

import pytest
import torch
from peft import LoraConfig

from synapse_mesh.catalog import CloudCatalog, validate_config
from synapse_mesh.intent import IntentClassifier
from synapse_mesh.kernel import FusionKernel
from synapse_mesh.runtime import Runtime
from test_kernel import small_model

CONFIG = {'base_model_name_or_path': 'org/base', 'revision': None, 'peft_type': 'LORA',
          'task_type': 'CAUSAL_LM', 'r': 16, 'target_modules': ['q_proj', 'v_proj'], 'bias': 'none'}


def test_local_vault_paths_and_readiness_require_weights(tmp_path):
    runtime = Runtime(vault=tmp_path, base_model='org/base', device='cpu')
    directory = tmp_path / 'coding'
    directory.mkdir()
    (directory / 'adapter_config.json').write_text(json.dumps(CONFIG))
    row = runtime.vault_status()[0]
    assert not row['available']
    assert row['missing_files'] == ['adapter_model.safetensors']
    (directory / 'adapter_model.safetensors').write_bytes(b'fixture')
    row = runtime.vault_status()[0]
    assert row['available'] and row['metadata']['rank'] == 16
    assert row['missing_files'] == []
    assert row['path'] == runtime.adapter_paths()['coding'] == str(directory.resolve())
    assert row['weights_path'] == str(directory / 'adapter_model.safetensors')
    (directory / 'adapter_config.json').unlink()
    assert not runtime.vault_status()[0]['available']


def test_cloud_relative_paths_use_vault_and_require_both_files(tmp_path, monkeypatch):
    catalog = CloudCatalog(tmp_path, 'org/base')
    directory = tmp_path / 'snapshot'
    directory.mkdir()
    (directory / 'adapter_model.safetensors').write_bytes(b'fixture')
    catalog.registry.write_text(json.dumps({'cloud': {'path': 'snapshot'}}))
    monkeypatch.chdir(tmp_path.parent)
    assert catalog.adapter_paths(('coding',))['cloud'] == str(directory)
    assert catalog.file_status(directory)['missing_files'] == ['adapter_config.json']
    (directory / 'adapter_config.json').write_text(json.dumps(CONFIG))
    assert catalog.file_status(directory)['available']


def test_configuration_compatibility():
    validate_config(CONFIG, 'org/base', 'pinned')
    for patch in ({'base_model_name_or_path': 'org/other'}, {'revision': 'different'},
                  {'use_dora': True}, {'modules_to_save': ['lm_head']}, {'r': 512},
                  {'target_modules': ['embed_tokens']}, {'target_parameters': ['foo']},
                  {'peft_type': 'IA3'}, {'fan_in_fan_out': True}):
        with pytest.raises(ValueError):
            validate_config({**CONFIG, **patch}, 'org/base', 'pinned')


def test_catalog_pagination_does_not_fetch_user_urls(tmp_path, monkeypatch):
    calls = []
    class Response:
        links = {'next': {'url': 'https://huggingface.co/api/models?cursor=next-page'}}
        def raise_for_status(self): pass
        def json(self):
            return [{'id': 'org/lora', 'sha': 'commit', 'downloads': 2,
                     'cardData': {'base_model': 'org/base'},
                     'siblings': [{'rfilename': 'adapter_config.json'}, {'rfilename': 'adapter_model.safetensors'}]},
                    {'id': 'org/full', 'siblings': [], 'cardData': {}}]
    def request(url, **kwargs):
        calls.append((url, kwargs['params']))
        return Response()
    monkeypatch.setattr('synapse_mesh.catalog.requests.get', request)
    catalog = CloudCatalog(tmp_path, 'org/base')
    first = catalog.search('coding', 'compatible')
    assert first['next_cursor'] == 'next-page'
    assert first['models'][0]['candidate']
    assert not first['models'][1]['candidate']
    catalog.search('coding', 'compatible', first['next_cursor'])
    assert calls[1][0] == 'https://huggingface.co/api/models'
    assert calls[1][1]['cursor'] == 'next-page'
    assert calls[1][1]['search'] == 'coding'


def test_cloud_experts_change_intent_without_prompt_injection(tmp_path):
    runtime = Runtime(vault=tmp_path, base_model='org/base', device='cpu')
    snapshot = tmp_path / 'snapshot'; snapshot.mkdir()
    runtime.catalog.registry.write_text(json.dumps({'cloud_a': {'path': str(snapshot), 'expertise': 'finance tax accounting'}}))
    result = runtime.classify('write python tax accounting code', ['coding', 'cloud_a'])
    assert set(result['weights']) == {'coding', 'cloud_a'}
    assert result['evidence']['cloud_a'] == ['accounting', 'tax']
    assert sum(result['weights'].values()) == pytest.approx(1)
    assert runtime.selected_experts(['coding']) == ('coding',)  # Lean-Fusion uses one expert.
    with pytest.raises(ValueError): runtime.selected_experts([])
    with pytest.raises(ValueError): runtime.selected_experts(['coding', 'unknown'])


def test_four_experts_then_unload_new_projection_preserves_base():
    model = small_model()
    model.add_adapter('cloud', LoraConfig(r=4, lora_alpha=8, target_modules=['o_proj'], task_type='CAUSAL_LM'))
    for name, p in model.named_parameters():
        if 'lora_' in name and '.cloud.' in name: torch.nn.init.normal_(p, std=.1)
    reference = deepcopy(model)
    names = ('coding', 'medical', 'legal', 'cloud')
    mixture = {name: .25 for name in names}
    kernel = FusionKernel(model, names)
    with kernel.fused(mixture) as audit:
        assert len(audit['weights']) == 4
        assert any(row['delta_norms'].get('cloud', 0) > 0 for row in audit['layers'])
        for (_, layer, base) in kernel.layers:
            expected = base.clone()
            for name in names:
                if name in layer.lora_A: expected += .25 * layer.get_delta_weight(name)
            torch.testing.assert_close(layer.get_base_layer().weight, expected)
    model.delete_adapter('cloud')
    reduced = FusionKernel(model, names[:3])
    assert len(reduced.layers) == 4
    with reduced.fused(dict(zip(names[:3], [.5, .25, .25]))): pass
    ids = torch.tensor([[1, 2, 3]])
    with model.disable_adapter(), reference.disable_adapter(), torch.no_grad():
        torch.testing.assert_close(model(ids).logits, reference(ids).logits, rtol=0, atol=0)
