"""Resident cloud kernel plus the legacy PEFT regression reference.

CloudKernel owns one plain GPU base and a VRAM-resident ResidentFusion vault.
FusionKernel is retained only for compatibility with the PEFT reference tests.
"""
from contextlib import contextmanager
import math
import time
from threading import Event, Lock
from typing import Mapping

import torch
from peft.tuners.lora.layer import LoraLayer

from .tensor_fusion import ResidentFusion, _weights


class CloudKernel:
    """One model per process; fusion, decoding, and restoration are atomic.

    Production construction is CUDA-only. CPU injection exists solely for tiny
    deterministic tests; it is never selected by the service's model loader.
    """

    def __init__(self, model, tokenizer, vault, *, max_input_tokens=4096,
                 max_new_tokens=512, allow_cpu_for_tests=False):
        if vault.model is not model:
            raise ValueError('Vault and kernel must share the exact base model')
        if vault.device.type != 'cuda' and not allow_cpu_for_tests:
            raise RuntimeError('The cloud kernel requires a CUDA GPU; no laptop fallback')
        self.model = model.eval().requires_grad_(False)
        self.tokenizer = tokenizer
        self.vault = vault
        self.lock = Lock()
        self.max_input_tokens = max_input_tokens
        self.max_new_tokens = max_new_tokens
        self.context_limit = getattr(model.config, 'max_position_embeddings', max_input_tokens + max_new_tokens)

    @classmethod
    def load(cls, config):
        import os
        from pathlib import Path
        from transformers import AutoModelForCausalLM, AutoTokenizer
        from .vault_manager import VaultManager, SharedVolumeFusion
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA unavailable: deploy this service on the Outshift GPU host')
        device = torch.device(config.device)
        if device.type != 'cuda':
            raise ValueError('CLOUD_DEVICE must be a CUDA device')
        with torch.cuda.device(device):
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
            if config.dtype == 'float16':
                dtype = torch.float16
            elif config.dtype == 'bfloat16':
                if not torch.cuda.is_bf16_supported():
                    raise RuntimeError('This GPU does not support requested BF16')
                dtype = torch.bfloat16
            # Files download only at startup. No model/API routing during requests.
            tokenizer = AutoTokenizer.from_pretrained(
                config.base_model, revision=config.base_revision,
                trust_remote_code=False, local_files_only=config.local_files_only)
            model = AutoModelForCausalLM.from_pretrained(
                config.base_model, revision=config.base_revision,
                torch_dtype=dtype, device_map={'': str(device)},
                trust_remote_code=False, local_files_only=config.local_files_only)
            if config.vault_mode == 'resident':
                vault = ResidentFusion(model, list(config.adapters.values()),
                                       adapter_names=list(config.adapters), base_model_id=config.base_model,
                                       base_revision=config.base_revision, compute_dtype=dtype,
                                       cache_bytes=config.adapter_cache_bytes,
                                       reserve_bytes=config.generation_reserve_bytes)
            else:
                root = config.vault_root or Path(os.path.commonpath([str(path.parent) for path in config.adapters.values()]))
                manager = VaultManager(root, base_model_id=config.base_model, base_revision=config.base_revision,
                                       device=device, dtype=dtype, cache_bytes=config.adapter_cache_bytes,
                                       adapter_paths=config.adapters, reserve_bytes=config.generation_reserve_bytes)
                vault = SharedVolumeFusion(model, manager)
            try:
                vault.warm()
            except BaseException:
                if hasattr(vault, 'close'):
                    vault.close()
                raise
        return cls(model, tokenizer, vault, max_input_tokens=config.max_input_tokens,
                   max_new_tokens=config.max_new_tokens)

    def validate(self, prompt, weight_vector, max_new_tokens):
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError('Prompt must not be empty')
        if len(prompt) > self.max_input_tokens * 16:
            raise ValueError('Prompt exceeds the character limit')
        if isinstance(max_new_tokens, bool) or not isinstance(max_new_tokens, int) or not 1 <= max_new_tokens <= self.max_new_tokens:
            raise ValueError(f'max_new_tokens must be between 1 and {self.max_new_tokens}')
        return _weights(self.vault.names, weight_vector)

    @torch.no_grad()
    def _inputs(self, prompt, max_new_tokens):
        # The unchanged user prompt is the ONLY message; no specialist roles.
        if getattr(self.tokenizer, 'chat_template', None):
            inputs = self.tokenizer.apply_chat_template(
                [{'role': 'user', 'content': prompt}], add_generation_prompt=True,
                tokenize=True, return_dict=True, return_tensors='pt')
        else:
            inputs = self.tokenizer(prompt, return_tensors='pt')
        length = inputs['input_ids'].shape[1]
        if length > self.max_input_tokens or length + max_new_tokens > self.context_limit:
            raise ValueError('Tokenized prompt plus output exceeds the configured context limit')
        return {name: value.to(self.vault.device) for name, value in inputs.items()
                if name in ('input_ids', 'attention_mask')}

    def events(self, prompt, weight_vector, max_new_tokens=192, *, stop=None, prefix_token_ids=None):
        weights = self.validate(prompt, weight_vector, max_new_tokens)
        stop = stop if stop is not None else Event()
        started = time.perf_counter()
        # Poll rather than block forever when a queued HTTP request disconnects.
        while not self.lock.acquire(timeout=.05):
            if stop.is_set():
                return
        try:
            if stop.is_set():
                return
            inputs = self._inputs(prompt, max_new_tokens)
            input_length = inputs['input_ids'].shape[1]
            ids = list(prefix_token_ids or [])
            if (len(ids) > max_new_tokens or any(isinstance(t, bool) or not isinstance(t, int)
                    or not 0 <= t < self.model.config.vocab_size for t in ids)):
                raise ValueError('Invalid cached generation prefix')
            text = self.tokenizer.decode(ids, skip_special_tokens=True) if ids else ''
            eos = getattr(self.model.generation_config, 'eos_token_id', None)
            eos = {eos} if isinstance(eos, int) else set(eos or [])
            reason = 'length'
            with torch.inference_mode(), self.vault.fused(weights) as audit:
                yield {'event': 'fusion', **audit, 'audit': audit,
                       'execution': {'location': 'cloud', 'device': str(self.vault.device)}}
                generation_started = time.perf_counter()
                past = None
                next_input = inputs['input_ids']
                mask = inputs.get('attention_mask', torch.ones_like(next_input))
                if ids:
                    prefix = torch.tensor([ids], device=self.vault.device, dtype=next_input.dtype)
                    next_input = torch.cat((next_input, prefix), dim=1)
                    mask = torch.cat((mask, torch.ones_like(prefix)), dim=1)
                remaining = max_new_tokens - len(ids)
                if ids and ids[-1] in eos:
                    remaining, reason = 0, 'eos'
                for index in range(len(ids), len(ids) + remaining):
                    if stop.is_set():
                        return
                    output = self.model(input_ids=next_input, attention_mask=mask,
                                        past_key_values=past, use_cache=True, return_dict=True)
                    token = output.logits[:, -1, :].argmax(dim=-1, keepdim=True)
                    token_id = int(token.item())
                    ids.append(token_id)
                    new_text = self.tokenizer.decode(ids, skip_special_tokens=True)
                    delta = new_text[len(text):] if new_text.startswith(text) else ''
                    text = new_text
                    past = output.past_key_values
                    del output
                    yield {'event': 'token', 'index': index, 'token_id': token_id,
                           'delta': delta, 'text': text}
                    if token_id in eos:
                        reason = 'eos'
                        break
                    next_input = token
                    mask = torch.cat((mask, torch.ones_like(token)), dim=1)
                synchronize(self.vault.device)
                generation_ms = (time.perf_counter() - generation_started) * 1000
                # Release KV cache before accepting the next transaction.
                del past
                restore_started = time.perf_counter()
            synchronize(self.vault.device)
            restore_ms = (time.perf_counter() - restore_started) * 1000
            yield {'event': 'complete', 'text': text, 'token_ids': ids,
                   'input_tokens': input_length, 'output_tokens': len(ids),
                   'finish_reason': reason, 'weights': audit['weights'], 'audit': audit,
                   'base_restored': True,
                   'timing': {'fusion_ms': audit['fusion_ms'], 'generation_ms': generation_ms,
                              'restore_ms': restore_ms,
                              'total_ms': (time.perf_counter() - started) * 1000}}
        finally:
            self.lock.release()


def synchronize(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize(device)
    elif device.type == "mps":
        torch.mps.synchronize()


def validate_weights(weights: Mapping[str, float], experts: tuple[str, ...]) -> dict[str, float]:
    if set(weights) != set(experts):
        raise ValueError(f"Weights must contain exactly {experts}")
    result = {name: float(weights[name]) for name in experts}
    if any(not math.isfinite(w) or w < 0 for w in result.values()):
        raise ValueError("Weights must be finite and nonnegative")
    if not math.isclose(math.fsum(result.values()), 1.0, abs_tol=1e-5):
        raise ValueError("Weights must sum to one")
    return result


class FusionKernel:
    """Owns immutable on-device snapshots of adapter-targeted base matrices.

    The caller serializes access to the model for the entire context. Each
    request starts from pristine tensors, preventing accumulated roundoff.
    Supported: ordinary Linear LoRA, including different ranks and rsLoRA
    scaling. Unsupported adapter transformations fail before mutation.
    """

    def __init__(self, model, experts: tuple[str, ...]):
        self.model = model
        self.experts = experts
        self.layers = []
        for name in experts:
            config = model.peft_config[name]
            if config.bias != "none" or config.modules_to_save or config.use_dora or getattr(config, 'lora_bias', False):
                raise ValueError("Only bias-free ordinary LoRA without modules_to_save is supported")
        for name, layer in model.named_modules():
            if not isinstance(layer, LoraLayer):
                continue
            base = layer.get_base_layer()
            if not isinstance(base, torch.nn.Linear) or base.weight.dtype not in (torch.float32, torch.float16, torch.bfloat16):
                raise ValueError(f"{name}: requires an unquantized floating-point Linear base")
            if layer.merged or layer.fan_in_fan_out:
                raise ValueError(f"{name}: already merged or transposed LoRA is unsupported")
            present = [expert for expert in experts if expert in layer.lora_A]
            if not present:
                continue  # Empty wrappers can remain after a cloud adapter is unloaded.
            for expert in present:
                if layer.use_dora.get(expert, False):
                    raise ValueError("DoRA is unsupported")
                if layer.lora_A[expert].weight.device != base.weight.device:
                    raise ValueError("All adapter factors must reside on the base matrix device")
                if layer.lora_B[expert].weight.device != base.weight.device or layer.lora_B[expert].bias is not None:
                    raise ValueError("LoRA B must be bias-free and on the base matrix device")
            self.layers.append((name, layer, base.weight.detach().clone()))
        if not self.layers:
            raise ValueError("No LoRA matrices were found")
        devices = {pristine.device for _, _, pristine in self.layers}
        if len(devices) != 1:
            raise ValueError("This proof of concept requires one device")
        self.device = next(iter(devices))

    @torch.no_grad()
    def restore(self):
        for _, layer, pristine in self.layers:
            layer.get_base_layer().weight.copy_(pristine)

    @contextmanager
    def fused(self, weights: Mapping[str, float]):
        weights = validate_weights(weights, self.experts)
        synchronize(self.device)
        started = time.perf_counter()
        rows = []
        sample = None
        try:
            with torch.no_grad():
                for name, layer, pristine in self.layers:
                    target = layer.get_base_layer().weight
                    target.copy_(pristine)
                    contributions = {}
                    sampled_contributions = {}
                    for expert, weight in weights.items():
                        if expert not in layer.lora_A or weight == 0:
                            continue
                        # Do NOT average A and B separately: that introduces
                        # cross-expert B_i @ A_j terms absent from the equation.
                        a = layer.lora_A[expert].weight.to(dtype=target.dtype)
                        b = layer.lora_B[expert].weight.to(dtype=target.dtype)
                        delta = torch.matmul(b, a)
                        scale = weight * float(layer.scaling[expert])
                        target.add_(delta, alpha=scale)
                        contributions[expert] = float(torch.linalg.vector_norm(delta.float()).item()) * scale
                        if sample is None:
                            sampled_contributions[expert] = (delta[:6, :6] * scale).detach().cpu().tolist()
                    rows.append({"module": name, "shape": list(target.shape), "delta_norms": contributions})
                    if sample is None:
                        sample = {"module": name, "base": pristine[:6, :6].detach().cpu().tolist(),
                                  "fused": target[:6, :6].detach().cpu().tolist(),
                                  "contributions": sampled_contributions}
            synchronize(self.device)
            audit = {
                "device": str(self.device), "weights": weights, "layers": rows,
                "layer_count": len(rows), "fusion_ms": (time.perf_counter() - started) * 1000,
                "snapshot_bytes": sum(p.numel() * p.element_size() for _, _, p in self.layers),
                "equation": "W_base + sum(w_i * scale_i * (B_i @ A_i))",
                "disk_writes": 0,
                "matrix_sample": sample,
            }
            # PEFT's normal adapter path must be disabled: the deltas are
            # already in the base matrix, and applying them again doubles them.
            with self.model.disable_adapter():
                yield audit
        finally:
            self.restore()
