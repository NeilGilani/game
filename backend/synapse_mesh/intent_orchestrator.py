"""Sense → reason: constrain tensor coefficients before every decoding step."""
import math
from .cisco_sentinel import NetworkState
from .tensor_utils import validate_coefficients
import time


def budget_weights(ideal_weights, network_cap, *, strongest_only=False):
    """Normalize nonnegative scores, then spend at most the cap.

    [0.8, 0.8, 0.4] at cap 0.6 becomes [0.24, 0.24, 0.12]. Critical
    mode spends the cap on the maximum, with adapter-order tie breaking.
    """
    if not math.isfinite(network_cap) or not 0 <= network_cap <= 1:
        raise ValueError('Network cap must be finite and between zero and one')
    ideal = {name: float(value) for name, value in ideal_weights.items()}
    if not ideal or any(not math.isfinite(value) or value < 0 for value in ideal.values()):
        raise ValueError('Ideal weights must be a nonempty finite nonnegative vector')
    total = math.fsum(ideal.values())
    if not math.isfinite(total):
        raise ValueError('Ideal weight sum must be finite')
    if not total or not network_cap:
        return dict.fromkeys(ideal, 0.0)
    if strongest_only:
        winner = max(ideal, key=ideal.get)
        return {name: network_cap if name == winner else 0.0 for name in ideal}
    return {name: value / total * network_cap for name, value in ideal.items()}


class IntentOrchestrator:
    def __init__(self, runtime, sentinel, *, lean_cloud_limit=1, remote_execution=False):
        if isinstance(lean_cloud_limit, bool) or not isinstance(lean_cloud_limit, int) or lean_cloud_limit < 1:
            raise ValueError('Lean cloud adapter limit must be a positive integer')
        self.runtime, self.sentinel = runtime, sentinel
        self.lean_cloud_limit = lean_cloud_limit
        self.remote_execution = remote_execution

    def plan(self, prompt, weights=None, experts=None, *, generated_text=''):
        started = time.perf_counter()
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
            raise ValueError('Use a nonempty prompt of at most 8000 characters')
        network = self.sentinel.snapshot()
        if network.state == NetworkState.OFFLINE:
            if self.remote_execution:
                raise RuntimeError('Cloud-Kernel is unreachable while offline; the edge client does not run local inference')
            self.runtime.pre_cache_generalist()
            order = [name for name in self.runtime.adapter_paths() if name != 'generalist'] + ['generalist']
            ideal = {name: float(name == 'generalist') for name in order}
            result = {'evidence': {}, 'method': 'cached generalist; intent classifier bypassed'}
            mode = 'Safe-Mode'
        else:
            # Only the local classifier sees this context. The language model
            # still receives the original user prompt, without extra roles.
            context = prompt
            if generated_text and weights is None:
                context = (prompt[:6000] + '\n' + generated_text[-1999:])[:8000]
            # Manual ideal scores may total more than one, as in the spec's
            # 0.8/0.8/0.4 example. Validate their names using the existing vault
            # API after normalization, but preserve the raw scores in the UI.
            normalized = budget_weights(weights, 1.0) if weights is not None else None
            result = dict(self.runtime.resolve_intent(context, normalized, experts))
            ideal = {name: float(value) for name, value in weights.items()} if weights is not None else result['weights'].copy()
            order = list(result['adapter_order'])
            mode = {NetworkState.OPTIMAL: 'Ultra-Fusion', NetworkState.CONGESTED: 'Lean-Fusion',
                    NetworkState.CRITICAL: 'Critical-Fusion'}[network.state]
        catalog = getattr(self.runtime, 'catalog', None)
        cloud_names = set(catalog.installed()) if catalog is not None else set()
        candidates = {name: value for name, value in ideal.items()}
        pruned_cloud = []
        if network.state == NetworkState.CONGESTED:
            ranked = sorted((name for name in order if name in cloud_names and ideal[name] > 0),
                            key=lambda name: ideal[name], reverse=True)
            pruned_cloud = ranked[self.lean_cloud_limit:]
            for name in pruned_cloud:
                candidates[name] = 0.0
        applied = budget_weights(candidates, network.network_cap, strongest_only=network.state == NetworkState.CRITICAL)
        validate_coefficients(applied, order, network.network_cap)
        result.update(weights=applied, ideal_weights=ideal, intent_weights=ideal, adapter_order=order,
                      weight_vector=[applied[name] for name in order],
                      active_experts=[name for name in order if applied[name] > 0],
                      tensor_dtype='float32', tensor_shape=[len(order)],
                      network=network.to_dict(), network_cap=network.network_cap,
                      budget_spent=math.fsum(applied.values()), fusion_mode=mode,
                      intent_context='prompt + generated prefix' if generated_text and weights is None else 'manual' if weights is not None else 'prompt',
                      token_level=True)
        result.update(cloud_adapters_requested=[name for name in order if name in cloud_names and applied[name] > 0],
                      cloud_adapters_pruned=pruned_cloud, lean_cloud_limit=self.lean_cloud_limit)
        excluded = dict(result.get('excluded', {}))
        if network.state != NetworkState.OFFLINE:
            excluded['generalist'] = 'Reserved for offline Safe-Mode'
        for name, value in applied.items():
            if value > 0:
                excluded.pop(name, None)
            elif network.state != NetworkState.OPTIMAL:
                excluded[name] = f'Inactive under {mode}'
            elif name == 'generalist':
                excluded[name] = 'Reserved for offline Safe-Mode'
        result['excluded'] = excluded
        for name in pruned_cloud:
            excluded[name] = 'Lean-Fusion cloud adapter limit'
        result['reason_ms'] = (time.perf_counter() - started) * 1000
        return result
