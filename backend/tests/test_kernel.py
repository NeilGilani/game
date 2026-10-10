from copy import deepcopy
import math

import pytest
import torch
from peft import LoraConfig, get_peft_model
from transformers import Qwen2Config, Qwen2ForCausalLM

from synapse_mesh.intent import EXPERTS, IntentClassifier
from synapse_mesh.kernel import FusionKernel, validate_weights


def small_model(device="cpu"):
    torch.manual_seed(12)
    base = Qwen2ForCausalLM(Qwen2Config(vocab_size=64, hidden_size=16, intermediate_size=24,
                                      num_hidden_layers=2, num_attention_heads=2, num_key_value_heads=2))
    model = get_peft_model(base, LoraConfig(r=2, lora_alpha=3, target_modules=["q_proj", "v_proj"],
                                          task_type="CAUSAL_LM"), adapter_name=EXPERTS[0])
    model.add_adapter(EXPERTS[1], LoraConfig(r=3, lora_alpha=4, use_rslora=True,
                                          target_modules=["q_proj", "v_proj"], task_type="CAUSAL_LM"))
    model.add_adapter(EXPERTS[2], LoraConfig(r=1, lora_alpha=2, target_modules=["q_proj"],
                                          task_type="CAUSAL_LM"))
    for name, parameter in model.named_parameters():
        if 'lora_' in name:
            torch.nn.init.normal_(parameter, std=0.1)
    return model.to(device).eval()


def test_exact_dense_sum_and_forward_pass():
    model = small_model()
    reference = deepcopy(model)
    kernel = FusionKernel(model, EXPERTS)
    weights = dict(zip(EXPERTS, [0.7, 0.2, 0.1]))
    with torch.no_grad():
        for module in reference.modules():
            if hasattr(module, 'lora_A'):
                expected = module.get_base_layer().weight.detach().clone()
                for expert, weight in weights.items():
                    if expert in module.lora_A:
                        expected += weight * module.get_delta_weight(expert)
                module.get_base_layer().weight.copy_(expected)
    ids = torch.tensor([[1, 2, 3, 4]])
    with kernel.fused(weights) as audit, torch.no_grad(), reference.disable_adapter():
        assert audit['layer_count'] == 4
        assert audit['disk_writes'] == 0
        sample = audit['matrix_sample']
        reconstructed = torch.tensor(sample['base'])
        for contribution in sample['contributions'].values():
            reconstructed += torch.tensor(contribution)
        torch.testing.assert_close(reconstructed, torch.tensor(sample['fused']))
        torch.testing.assert_close(model(ids).logits, reference(ids).logits)
        for (_, module, pristine), other in zip(kernel.layers, [m for m in reference.modules() if hasattr(m, 'lora_A')]):
            torch.testing.assert_close(module.get_base_layer().weight, other.get_base_layer().weight)
    for _, module, pristine in kernel.layers:
        assert torch.equal(module.get_base_layer().weight, pristine)


def test_exception_restores_and_repeated_mixtures_do_not_drift():
    model = small_model()
    kernel = FusionKernel(model, EXPERTS)
    for i in range(20):
        with pytest.raises(RuntimeError, match='generation failed'):
            with kernel.fused(dict(zip(EXPERTS, [0.1, 0.8, 0.1]))):
                raise RuntimeError('generation failed')
        for _, module, pristine in kernel.layers:
            assert torch.equal(module.get_base_layer().weight, pristine)
    with kernel.fused(dict(zip(EXPERTS, [1., 0., 0.]))):
        for _, module, pristine in kernel.layers:
            torch.testing.assert_close(module.get_base_layer().weight, pristine + module.get_delta_weight('coding'))


@pytest.mark.parametrize('weights', [
    {'coding': 1}, dict(zip(EXPERTS, [-.1, .5, .6])),
    dict(zip(EXPERTS, [math.nan, 0, 1])), dict(zip(EXPERTS, [.1, .1, .1])),
    dict(zip(EXPERTS, [math.inf, 0, 0])),
])
def test_invalid_weights_fail_before_mutation(weights):
    kernel = FusionKernel(small_model(), EXPERTS)
    with pytest.raises(ValueError):
        with kernel.fused(weights):
            pass
    for _, module, pristine in kernel.layers:
        assert torch.equal(module.get_base_layer().weight, pristine)


def test_classifier_mixes_and_records_evidence():
    intent = IntentClassifier().classify('Write Python software for clinical trial consent and legal privacy compliance')
    assert all(0 < value < 1 for value in intent['weights'].values())
    assert sum(intent['weights'].values()) == pytest.approx(1)
    assert 'python' in intent['evidence']['coding']
    assert 'clinical' in intent['evidence']['medical']
    assert 'compliance' in intent['evidence']['legal']
    assert IntentClassifier().classify('hello')['weights']['coding'] == pytest.approx(1/3)
    coding_task = IntentClassifier().classify('Write a Python function for clinical trial consent and privacy')
    assert all(value > 0 for value in coding_task['weights'].values())
    assert coding_task['weight_vector'] == list(coding_task['weights'].values())


def test_quantized_and_dora_are_rejected():
    model = small_model()
    model.peft_config['medical'].use_dora = True
    with pytest.raises(ValueError, match='ordinary LoRA'):
        FusionKernel(model, EXPERTS)


@pytest.mark.skipif(not torch.backends.mps.is_available(), reason='Metal is unavailable')
def test_real_metal_matrices():
    kernel = FusionKernel(small_model('mps'), EXPERTS)
    with kernel.fused(dict(zip(EXPERTS, [.4, .3, .3]))) as audit:
        assert torch.device(audit['device']).type == 'mps'
        for _, module, pristine in kernel.layers:
            expected = pristine.clone()
            for expert, weight in zip(EXPERTS, [.4, .3, .3]):
                if expert in module.lora_A:
                    expected += weight * module.get_delta_weight(expert)
            torch.testing.assert_close(module.get_base_layer().weight, expected)
    for _, module, pristine in kernel.layers:
        assert torch.equal(module.get_base_layer().weight, pristine)
