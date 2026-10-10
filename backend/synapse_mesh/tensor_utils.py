"""Device clocks and coefficient validation; no adapter framework imports."""
import math
from typing import Mapping
import torch


def synchronize(device):
    device = torch.device(device)
    if device.type == 'cuda': torch.cuda.synchronize(device)
    elif device.type == 'mps': torch.mps.synchronize()


def validate_weights(weights: Mapping[str, float], experts):
    if set(weights) != set(experts): raise ValueError(f'Weights must contain exactly {tuple(experts)}')
    result = {name: float(weights[name]) for name in experts}
    if any(not math.isfinite(w) or w < 0 for w in result.values()):
        raise ValueError('Weights must be finite and nonnegative')
    if not math.isclose(math.fsum(result.values()), 1, abs_tol=1e-5):
        raise ValueError('Weights must sum to one')
    return result


def validate_coefficients(weights: Mapping[str, float], experts, cap=1.0):
    """Applied coefficients are a budgeted sub-probability vector, not re-normalized."""
    if set(weights) != set(experts):
        raise ValueError(f'Weights must contain exactly {tuple(experts)}')
    result = {name: float(weights[name]) for name in experts}
    if not math.isfinite(cap) or not 0 <= cap <= 1:
        raise ValueError('Network cap must be finite and between zero and one')
    if any(not math.isfinite(w) or w < 0 for w in result.values()) or math.fsum(result.values()) > cap + 1e-5:
        raise ValueError('Coefficients must be finite, nonnegative, and stay within the network cap')
    return result
