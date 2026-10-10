"""Verify the exported function against independently built PEFT deltas/logits."""
from copy import deepcopy
import json
from pathlib import Path

import pytest
import torch
from peft import LoraConfig, get_peft_model
from safetensors.torch import save_file
from transformers import Qwen2Config, Qwen2ForCausalLM

from synapse_mesh.tensor_fusion import AdapterTensorStore, fuse_weights, restore_weights
from synapse_mesh.intent import IntentClassifier

SURGICAL_PROMPT = 'Draft a legally binding Software License Agreement for a new AI-driven surgical robot, but write it as a medical prescription that a surgeon would read, ensuring it maintains strict legal enforceability while using clinical terminology to describe the technical constraints of the hardware.'


def fixture(tmp_path, device='cpu', dtype=torch.float32):
    torch.manual_seed(47)
    base = Qwen2ForCausalLM(Qwen2Config(vocab_size=64, hidden_size=16, intermediate_size=24,
                                      num_hidden_layers=2, num_attention_heads=2, num_key_value_heads=2)).eval()
    peft = get_peft_model(deepcopy(base), LoraConfig(r=2, lora_alpha=3, target_modules=['q_proj', 'v_proj'], task_type='CAUSAL_LM'), adapter_name='code')
    peft.add_adapter('clinical', LoraConfig(r=3, lora_alpha=4, use_rslora=True, target_modules=['q_proj', 'v_proj'], task_type='CAUSAL_LM'))
    peft.add_adapter('law', LoraConfig(r=1, lora_alpha=2, target_modules=['q_proj'], task_type='CAUSAL_LM'))
    for name, parameter in peft.named_parameters():
        if 'lora_' in name: torch.nn.init.normal_(parameter, std=.1)
    paths = []
    for name in ('code', 'clinical', 'law'):
        path = tmp_path / name; path.mkdir()
        config = peft.peft_config[name].to_dict(); config['base_model_name_or_path'] = 'test/base'
        # Convert enum and target set to JSON representations as save_pretrained does.
        config['target_modules'] = sorted(config['target_modules'])
        (path / 'adapter_config.json').write_text(json.dumps(config))
        tensors = {}
        for module, layer in peft.named_modules():
            if hasattr(layer, 'lora_A') and name in layer.lora_A:
                tensors[module + '.lora_A.weight'] = layer.lora_A[name].weight.detach().contiguous()
                tensors[module + '.lora_B.weight'] = layer.lora_B[name].weight.detach().contiguous()
        save_file(tensors, path / 'adapter_model.safetensors')
        paths.append(path)
    return base.to(device=device, dtype=dtype), peft.to(device=device, dtype=dtype), paths


def reference_weights(model, reference, names, coefficients):
    # Match the required half-precision product, but construct it independently
    # using PEFT's layer registry and recorded per-adapter scaling.
    with torch.no_grad():
        for module, layer in reference.named_modules():
            if hasattr(layer, 'lora_A'):
                target = model.get_submodule(module.removeprefix('base_model.model.')).weight
                for name, coefficient in zip(names, coefficients):
                    if name in layer.lora_A:
                        delta = layer.lora_B[name].weight.half() @ layer.lora_A[name].weight.half()
                        target.add_(delta, alpha=coefficient * layer.scaling[name])


def test_function_changes_plain_base_and_logits_then_restores(tmp_path):
    base, reference, paths = fixture(tmp_path)
    pristine = {name: p.detach().clone() for name, p in base.named_parameters()}
    expected = deepcopy(base)
    coefficients = [.6, .3, .1]
    reference_weights(expected, reference, ('code', 'clinical', 'law'), coefficients)
    store = AdapterTensorStore()
    result = fuse_weights(base, paths, coefficients, base_model_id='test/base', tensor_store=store)
    assert result is base and not base.training
    assert not any(p.requires_grad for p in base.parameters())
    assert not any(hasattr(layer, 'lora_A') for layer in base.modules())
    ids = torch.tensor([[1, 2, 3, 4]])
    with torch.no_grad(): torch.testing.assert_close(base(ids).logits, expected(ids).logits, rtol=0, atol=0)
    assert base._synapse_fusion_audit['compute_dtype'] == 'float16'
    assert base._synapse_fusion_audit['factor_pairs_loaded'] == 10
    restore_weights(base)
    for name, p in base.named_parameters(): assert torch.equal(p, pristine[name])
    for _ in range(3):
        fuse_weights(base, paths, [.1, .2, .7], base_model_id='test/base', tensor_store=store)
        restore_weights(base)
    assert base._synapse_fusion_audit['factor_pairs_loaded'] == 0
    assert base._synapse_fusion_audit['factor_cache_hits'] == 10
    for name, p in base.named_parameters(): assert torch.equal(p, pristine[name])


def test_zero_weight_adapter_is_never_opened(tmp_path):
    base, _, paths = fixture(tmp_path)
    fuse_weights(base, [paths[0], '/does/not/exist'], [1., 0.], base_model_id='test/base')
    assert base._synapse_fusion_audit['loaded_adapters'] == ['expert_0']
    assert len(base._synapse_fusion_audit['weights']) == 2
    restore_weights(base)


def test_all_shapes_preflight_before_mutation(tmp_path):
    base, _, paths = fixture(tmp_path)
    before = {name: p.detach().clone() for name, p in base.named_parameters()}
    broken = paths[1] / 'adapter_model.safetensors'
    save_file({'base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight': torch.ones(3, 99),
               'base_model.model.model.layers.0.self_attn.q_proj.lora_B.weight': torch.ones(16, 3)}, broken)
    with pytest.raises(ValueError, match='factor shapes'):
        fuse_weights(base, paths, [.6, .3, .1], base_model_id='test/base')
    for name, p in base.named_parameters(): assert torch.equal(p, before[name])


def test_failure_during_factor_materialization_rolls_back(tmp_path):
    base, _, paths = fixture(tmp_path)
    before = {name: p.detach().clone() for name, p in base.named_parameters()}
    class FailingStore(AdapterTensorStore):
        def factors(self, *args):
            if self.loads == 2: raise RuntimeError('simulated allocation failure')
            return super().factors(*args)
    with pytest.raises(RuntimeError, match='allocation failure'):
        fuse_weights(base, paths, [.6, .3, .1], base_model_id='test/base', tensor_store=FailingStore())
    for name, p in base.named_parameters(): assert torch.equal(p, before[name])


def test_surgical_prompt_weights_are_relevant_and_dynamic():
    experts = ('coding', 'medical', 'legal', 'chinese', 'finance')
    descriptions = {'chinese': 'Chinese text correction spelling grammar translation', 'finance': 'finance tax accounting'}
    classifier = IntentClassifier()
    surgery = classifier.classify(SURGICAL_PROMPT, experts, descriptions)
    assert surgery['weights']['legal'] > surgery['weights']['coding'] > 0
    assert surgery['weights']['medical'] > 0
    assert surgery['weights']['chinese'] == 0
    assert surgery['weights']['finance'] == 0
    chinese = classifier.classify('Correct Chinese spelling and grammar', experts, descriptions)
    assert chinese['weights']['chinese'] > surgery['weights']['chinese']
    assert sum(surgery['weights'].values()) == pytest.approx(1)


@pytest.mark.skipif(not torch.backends.mps.is_available(), reason='Metal unavailable')
def test_real_metal_half_precision_in_place(tmp_path):
    base, reference, paths = fixture(tmp_path, 'mps', torch.float16)
    before = {name: p.detach().clone() for name, p in base.named_parameters()}
    expected = deepcopy(base)
    reference_weights(expected, reference, ('code', 'clinical', 'law'), [.6, .3, .1])
    fuse_weights(base, paths, [.6, .3, .1], base_model_id='test/base')
    audit = base._synapse_fusion_audit
    assert audit['device'].startswith('mps') and audit['compute_dtype'] == 'float16'
    for name, p in base.named_parameters(): torch.testing.assert_close(p, dict(expected.named_parameters())[name], rtol=0, atol=0)
    assert audit['disk_writes'] == 0 and audit['adapter_forward_branches'] == 0
    restore_weights(base)
    for name, p in base.named_parameters(): assert torch.equal(p, before[name])


def runtime_fixture(tmp_path, monkeypatch):
    from synapse_mesh.runtime import Runtime
    base, _, paths = fixture(tmp_path)
    for path, name in zip(paths, ('coding', 'medical', 'legal')): path.rename(tmp_path / name)
    runtime = Runtime(tmp_path, 'test/base', 'cpu')
    runtime.model = base
    runtime.revision = None
    class Tokenizer:
        pad_token_id = 0
        def apply_chat_template(self, messages, **kwargs):
            # The messages contain exactly the user prompt, no expert system role.
            assert messages == [{'role': 'user', 'content': SURGICAL_PROMPT}]
            class Inputs(dict):
                def to(self, device): return self
            return Inputs(input_ids=torch.tensor([[1, 2, 3]]))
        def decode(self, ids, **kwargs): return ' '.join(map(str, ids.tolist()))
    runtime.tokenizer = Tokenizer()
    return runtime


def test_pipeline_timings_cover_fusion_and_restoration(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    before = {name: p.detach().clone() for name, p in runtime.model.named_parameters()}
    events = list(runtime.compare_events(SURGICAL_PROMPT, 16))
    assert [e['event'] for e in events] == ['intent', 'loading', 'baseline', 'fusion', 'fused', 'complete']
    timing = events[-1]['timing']
    assert timing['fused_total_ms'] >= timing['fusion_ms'] + timing['fused_generation_ms'] + timing['restore_ms']
    assert timing['comparison_wall_ms'] >= timing['baseline_total_ms'] + timing['fused_total_ms']
    assert events[2]['total_ms'] >= events[2]['generation_ms']
    for name, p in runtime.model.named_parameters(): assert torch.equal(p, before[name])


def test_generation_failure_restores_plain_model(tmp_path, monkeypatch):
    runtime = runtime_fixture(tmp_path, monkeypatch)
    before = {name: p.detach().clone() for name, p in runtime.model.named_parameters()}
    original = runtime.generate
    count = 0
    def generation(*args):
        nonlocal count
        count += 1
        if count == 2: raise RuntimeError('fused generation failed')
        return original(*args)
    monkeypatch.setattr(runtime, 'generate', generation)
    with pytest.raises(RuntimeError, match='fused generation failed'):
        list(runtime.compare_events(SURGICAL_PROMPT, 16))
    for name, p in runtime.model.named_parameters(): assert torch.equal(p, before[name])
