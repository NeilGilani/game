"""Exercise genuine bitsandbytes NF4 loading and real PEFT factor files."""
from copy import deepcopy
import importlib.util
import json

import pytest
from peft import LoraConfig, get_peft_model
from safetensors.torch import save_file
import torch
from transformers import LlamaConfig, LlamaForCausalLM

from synapse_mesh.adapter_vault import AdapterVault, LLAMA_3_8B


@pytest.fixture
def library(tmp_path):
    torch.manual_seed(3)
    base = LlamaForCausalLM(LlamaConfig(vocab_size=64, hidden_size=32, intermediate_size=64,
                                      num_hidden_layers=2, num_attention_heads=4, num_key_value_heads=2)).eval()
    base_path = tmp_path / 'base'; base.save_pretrained(base_path)
    peft = get_peft_model(deepcopy(base), LoraConfig(r=2, lora_alpha=4, target_modules=['q_proj', 'v_proj'],
                                                    task_type='CAUSAL_LM'), adapter_name='coding')
    peft.add_adapter('medical', LoraConfig(r=3, lora_alpha=5, use_rslora=True,
                                         target_modules=['q_proj', 'v_proj'], task_type='CAUSAL_LM'))
    peft.add_adapter('legal', LoraConfig(r=1, lora_alpha=2, target_modules=['q_proj'], task_type='CAUSAL_LM'))
    for name, p in peft.named_parameters():
        if 'lora_' in name: torch.nn.init.normal_(p, std=.05)
    paths, expected = {}, {}
    for name in ('coding', 'medical', 'legal'):
        path = tmp_path / name; path.mkdir()
        config = peft.peft_config[name].to_dict(); config['base_model_name_or_path'] = str(base_path)
        config['target_modules'] = sorted(config['target_modules'])
        (path / 'adapter_config.json').write_text(json.dumps(config))
        weights, expected[name] = {}, {}
        for module, layer in peft.named_modules():
            if hasattr(layer, 'lora_A') and name in layer.lora_A:
                a, b = layer.lora_A[name].weight.detach().clone(), layer.lora_B[name].weight.detach().clone()
                weights[module + '.lora_A.weight'] = a; weights[module + '.lora_B.weight'] = b
                expected[name][module.removeprefix('base_model.model.')] = (a.half(), b.half(), layer.scaling[name])
        save_file(weights, path / 'adapter_model.safetensors')
        paths[name] = path
    return base_path, paths, expected


def register(vault, paths):
    for name, path in paths.items(): vault.register(name.title(), path)


@pytest.mark.skipif(importlib.util.find_spec('bitsandbytes') is None, reason='optional bitsandbytes dependency absent')
def test_actual_nf4_base_and_factor_retrieval(library):
    path, paths, expected = library
    vault = AdapterVault(path, device='cpu')
    register(vault, paths)
    assert vault.status()['base_loaded'] is False and vault.resident_bytes == 0
    model = vault.load_base_model()
    assert model.is_loaded_in_4bit and not model.training
    assert model.config.quantization_config.bnb_4bit_quant_type == 'nf4'
    assert model.config.quantization_config.bnb_4bit_use_double_quant
    assert any(type(layer).__name__ == 'Linear4bit' for layer in model.modules())
    assert all(not p.requires_grad for p in model.parameters())
    before = {name: p.detach().clone() for name, p in model.named_parameters()}
    assert vault.layer_names('Medical') == tuple(expected['medical'])
    assert vault.resident_bytes == 0, 'Header listing must not materialize factors'
    matrices = vault.get_matrices('MEDICAL')
    assert set(matrices) == set(expected['medical'])
    for module, pair in matrices.items():
        a, b, scaling = expected['medical'][module]
        torch.testing.assert_close(pair.A, a, rtol=0, atol=0)
        torch.testing.assert_close(pair.B, b, rtol=0, atol=0)
        assert pair.scaling == pytest.approx(scaling)
        assert pair.A.dtype == pair.B.dtype == torch.float16
        assert not pair.A.requires_grad and not pair.B.requires_grad
        assert (pair.B @ pair.A).shape == (pair.B.shape[0], pair.A.shape[1])
    first = next(iter(matrices))
    assert vault.get_pair('medical', 'base_model.model.' + first).A.data_ptr() == matrices[first].A.data_ptr()
    for name, p in model.named_parameters(): assert torch.equal(p, before[name])
    with torch.no_grad(): assert torch.isfinite(model(torch.tensor([[1, 2, 3]])).logits).all()
    assert vault.unload_adapter('medical') and vault.resident_bytes == 0
    vault.close(); assert vault.status()['base_loaded'] is False


@pytest.mark.skipif(importlib.util.find_spec('bitsandbytes') is None, reason='optional bitsandbytes dependency absent')
def test_lru_eviction_and_oversized_adapter(library):
    path, paths, _ = library
    vault = AdapterVault(path, device='cpu', max_resident_adapters=1)
    register(vault, paths)
    vault.load_adapter('coding'); vault.load_adapter('legal')
    statuses = {s['name']: s['loaded'] for s in vault.status()['specialists']}
    assert statuses == {'coding': False, 'medical': False, 'legal': True}
    vault.max_adapter_bytes = 1
    with pytest.raises(MemoryError, match='budget'): vault.load_adapter('medical')
    assert next(s['loaded'] for s in vault.status()['specialists'] if s['name'] == 'medical') is False


def test_registry_is_lazy_persistent_and_case_insensitive(tmp_path, monkeypatch):
    def unexpected(*args, **kwargs): raise AssertionError('Registration must not load a base or adapter')
    monkeypatch.setattr('synapse_mesh.adapter_vault.AutoModelForCausalLM.from_pretrained', unexpected)
    manifest = tmp_path / 'library.json'
    vault = AdapterVault(manifest=manifest)
    vault.register('Medical', 'owner/medical-adapter', revision='immutable-commit')
    with pytest.raises(ValueError, match='already registered'): vault.register('MEDICAL', 'owner/other')
    restored = AdapterVault(manifest=manifest)
    assert restored._specialists['medical'].revision == 'immutable-commit'
    assert restored.status()['base_model'] == LLAMA_3_8B
    with pytest.raises(ValueError, match='different base'): AdapterVault('other/base', manifest=manifest)
    with pytest.raises(ValueError, match='subfolder'): vault.register('Legal', 'owner/legal', subfolder='../escape')
    restored.unregister('MEDICAL')
    assert AdapterVault(manifest=manifest).status()['specialists'] == []


@pytest.mark.skipif(torch.cuda.is_available(), reason='test requires a machine without CUDA')
def test_default_vram_mode_does_not_silently_fall_back():
    with pytest.raises(RuntimeError, match='CUDA is unavailable'): AdapterVault().load_base_model()
    with pytest.raises(ValueError, match='MPS'): AdapterVault(device='mps')


@pytest.mark.skipif(importlib.util.find_spec('bitsandbytes') is None, reason='optional bitsandbytes dependency absent')
def test_wrong_base_and_missing_specialist(library):
    path, paths, _ = library
    vault = AdapterVault(path, device='cpu'); register(vault, paths)
    with pytest.raises(KeyError, match='Unknown specialist'): vault.get_matrices('unknown')
    config_path = paths['coding'] / 'adapter_config.json'
    config = json.loads(config_path.read_text()); config['base_model_name_or_path'] = 'wrong/base'
    config_path.write_text(json.dumps(config))
    with pytest.raises(ValueError, match='different base'): vault.load_adapter('coding')
    assert vault.resident_bytes == 0


@pytest.mark.skipif(not torch.cuda.is_available() or importlib.util.find_spec('bitsandbytes') is None,
                    reason='CUDA + bitsandbytes required for real VRAM integration')
def test_cuda_nf4_and_specialist_vram(library):
    path, paths, _ = library
    vault = AdapterVault(path, device='cuda:0'); register(vault, paths)
    assert vault.model.is_loaded_in_4bit
    pairs = vault.get_matrices('medical')
    assert all(pair.A.device.type == pair.B.device.type == 'cuda' for pair in pairs.values())
    with torch.no_grad(): assert torch.isfinite(vault.model(torch.tensor([[1, 2, 3]], device='cuda')).logits).all()
