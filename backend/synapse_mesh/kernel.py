"""Legacy PEFT comparison reference, used only by regression tests.

The production engine is tensor_fusion.fuse_weights on an ordinary base model.
"""
from contextlib import contextmanager
import math
import time
from typing import Mapping

import torch
from peft.tuners.lora.layer import LoraLayer


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
