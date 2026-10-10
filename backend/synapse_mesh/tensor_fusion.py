"""Direct weight fusion. No adapter forward branches, prompting, or model routing.

PEFT stores A as [rank, in] and B as [out, rank], so its on-disk factors
form B @ A, not A @ B. alpha/r (or alpha/sqrt(r)) is part of the trained delta.
"""
from collections import OrderedDict
from contextlib import ExitStack
from contextlib import contextmanager
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
import time

from safetensors import safe_open
import torch

from .catalog import validate_config
from .tensor_utils import synchronize


@torch.no_grad()
def dynamic_fusion_kernel(w_base, lora_pairs, alpha):
    """Return W_base + sum(alpha[i] * (A[i] @ B[i])) on the base device.

    W_base is [out, in]; each pair is ([out, rank_i], [rank_i, in]).
    All matrices must already share a floating dtype and device; no factors
    are copied to CPU or implicitly moved/cast. PEFT callers should pass
    their stored factors in (B, A) order and include LoRA scaling in alpha.

    alpha is a sequence of finite real coefficients (no normalization required)
    or a floating 1-D tensor on the base device. Tensor coefficients stay on
    that device; only the finite-value validation synchronizes once. The output
    and one reusable dense delta buffer are the only full-size allocations.
    Inputs are unchanged. This is an inference kernel, without autograd.
    """
    if (not isinstance(w_base, torch.Tensor) or w_base.ndim != 2
            or not w_base.is_floating_point() or w_base.layout != torch.strided):
        raise ValueError('w_base must be a dense floating 2-D tensor')
    pairs = list(lora_pairs)
    if isinstance(alpha, torch.Tensor):
        if (alpha.ndim != 1 or alpha.numel() != len(pairs)
                or not alpha.is_floating_point() or alpha.layout != torch.strided
                or alpha.device != w_base.device):
            raise ValueError('alpha must be a floating vector on the base device with one coefficient per pair')
        if not torch.isfinite(alpha).all():
            raise ValueError('alpha coefficients must be finite')
        coefficients = alpha
    else:
        coefficients = [float(value) for value in alpha]
        if len(coefficients) != len(pairs) or any(not math.isfinite(value) for value in coefficients):
            raise ValueError('alpha must provide one finite coefficient per pair')
    # Check all pairs before launching products or allocating dense workspace.
    for index, pair in enumerate(pairs):
        if len(pair) != 2:
            raise ValueError(f'LoRA pair {index} must contain A and B')
        a, b = pair
        if any(not isinstance(t, torch.Tensor) or t.ndim != 2
               or t.layout != torch.strided for t in (a, b)):
            raise ValueError(f'LoRA pair {index} must contain dense 2-D tensors')
        if any(t.device != w_base.device or t.dtype != w_base.dtype for t in (a, b)):
            raise ValueError(f'LoRA pair {index} must share the base dtype and device')
        if a.shape[0] != w_base.shape[0] or b.shape[1] != w_base.shape[1] or a.shape[1] != b.shape[0]:
            raise ValueError(f'LoRA pair {index}: A @ B must match the base shape')
    fused = w_base.detach().clone()
    if not pairs:
        return fused
    delta = torch.empty(w_base.shape, dtype=w_base.dtype, device=w_base.device)
    for index, (a, b) in enumerate(pairs):
        if not isinstance(coefficients, torch.Tensor) and coefficients[index] == 0:
            continue
        torch.matmul(a, b, out=delta)
        if isinstance(coefficients, torch.Tensor):
            # Scaling on-device avoids .item() and synchronization per adapter.
            torch.mul(delta, coefficients[index], out=delta)
            torch.add(fused, delta, out=fused)
        else:
            torch.add(fused, delta, alpha=coefficients[index], out=fused)
    return fused


@dataclass(frozen=True)
class Pair:
    module: str
    a_key: str
    b_key: str
    scale: float


class AdapterTensorStore:
    """Read metadata first; materialize one factor pair only when it is needed.

    The bounded CPU cache holds half-precision factors, never dense deltas.
    Device residency is one A/B pair plus one delta at a time.
    """
    def __init__(self, cache_bytes=128 * 1024 * 1024):
        self.limit = cache_bytes
        self.cache = OrderedDict()
        self.bytes = 0
        self.loads = 0
        self.hits = 0
        # Raw B@A does not depend on a token coefficient. Audit norms may be
        # reused without retaining dense deltas or skipping the actual matmul.
        self.norm_cache = OrderedDict()

    def norm_key(self, filename, pair, dtype):
        stat = Path(filename).stat()
        return (filename, stat.st_mtime_ns, stat.st_size, pair.a_key, dtype)

    def remember_norm(self, key, value):
        self.norm_cache[key] = value
        self.norm_cache.move_to_end(key)
        while len(self.norm_cache) > 4096:
            self.norm_cache.popitem(last=False)

    def factors(self, reader, filename, pair, dtype, device):
        stat = Path(filename).stat()
        key = (filename, stat.st_mtime_ns, stat.st_size, pair.a_key, dtype)
        if key in self.cache:
            a, b = self.cache.pop(key)
            self.cache[key] = (a, b)
            self.hits += 1
        else:
            a = reader.get_tensor(pair.a_key).to(dtype=dtype)
            b = reader.get_tensor(pair.b_key).to(dtype=dtype)
            if not torch.isfinite(a).all() or not torch.isfinite(b).all():
                raise ValueError('Adapter factors must be finite in the selected compute precision')
            size = (a.numel() + b.numel()) * a.element_size()
            self.loads += 1
            if size <= self.limit:
                while self.bytes + size > self.limit and self.cache:
                    _, previous = self.cache.popitem(last=False)
                    self.bytes -= sum(t.numel() * t.element_size() for t in previous)
                self.cache[key] = (a, b)
                self.bytes += size
        return a.to(device=device), b.to(device=device)


class ResidentFusion:
    """Prepared, immutable adapter vault on the SAME device as a plain base.

    Metadata is validated once. Factors load lazily, then remain resident until
    shutdown; warm() loads the entire configured vault before readiness. There
    is no CPU cache, eviction, disk access, or device transfer on a warm request.
    The caller must serialize the entire fused forward-pass transaction.
    """

    @torch.no_grad()
    def __init__(self, model, adapter_paths, *, adapter_names, base_model_id,
                 base_revision=None, cache_bytes=512 * 1024 * 1024,
                 reserve_bytes=1024 * 1024 * 1024, compute_dtype=None):
        self.model = model.eval().requires_grad_(False)
        self.names = tuple(adapter_names)
        if not self.names or len(set(self.names)) != len(self.names) or len(self.names) != len(adapter_paths):
            raise ValueError('Distinct adapter names must match the configured paths')
        parameters = list(model.parameters())
        devices = {p.device for p in parameters}
        if len(devices) != 1 or not all(p.is_floating_point() for p in parameters):
            raise ValueError('Resident fusion requires a floating base on one device')
        if getattr(model, 'is_loaded_in_4bit', False) or getattr(model, 'is_loaded_in_8bit', False):
            raise ValueError('Packed quantized base weights cannot be modified with add_')
        if any(hasattr(m, 'lora_A') for m in model.modules()):
            raise ValueError('Resident fusion requires a plain base without PEFT forward branches')
        self.device = next(iter(devices))
        self.dtype = compute_dtype or parameters[0].dtype
        if self.dtype not in (torch.float16, torch.bfloat16):
            raise ValueError('Resident LoRA products must use FP16 or BF16')
        self.modules = dict(model.named_modules())
        self.plans = dict(zip(self.names, (
            _adapter_plan(path, model, base_model_id, base_revision) for path in adapter_paths)))
        target_names = sorted({pair.module for _, pairs in self.plans.values() for pair in pairs})
        self.factor_bytes = 0
        for filename, pairs in self.plans.values():
            with safe_open(filename, framework='pt', device='cpu') as reader:
                self.factor_bytes += sum(math.prod(reader.get_slice(key).get_shape()) * 2
                                         for pair in pairs for key in (pair.a_key, pair.b_key))
        if cache_bytes < 0 or reserve_bytes < 0 or self.factor_bytes > cache_bytes:
            raise MemoryError('Configured adapter vault exceeds the resident factor cache budget')
        snapshot_bytes = sum(self.modules[name].weight.numel() * self.modules[name].weight.element_size()
                             for name in target_names)
        workspace_elements = max(self.modules[name].weight.numel() for name in target_names)
        self.workspace_bytes = workspace_elements * 2
        if self.device.type == 'cuda':
            free, _ = torch.cuda.mem_get_info(self.device)
            if snapshot_bytes + self.workspace_bytes + self.factor_bytes + reserve_bytes > free:
                raise MemoryError('Insufficient VRAM for vault, snapshots, workspace, and generation reserve')
        self.pristine = {name: self.modules[name].weight.detach().clone() for name in target_names}
        self.workspace = torch.empty(workspace_elements, device=self.device, dtype=self.dtype)
        self.factors = {}
        self.norms = {}
        self.loads = 0
        self.hits = 0
        self.is_fused = False

    @torch.no_grad()
    def load_adapter(self, name):
        if name in self.factors:
            self.hits += 1
            return self.factors[name]
        filename, pairs = self.plans[name]
        loaded = []
        norms = []
        with safe_open(filename, framework='pt', device='cpu') as reader:
            for pair in pairs:
                a = reader.get_tensor(pair.a_key).to(device=self.device, dtype=self.dtype)
                b = reader.get_tensor(pair.b_key).to(device=self.device, dtype=self.dtype)
                if not torch.isfinite(a).all() or not torch.isfinite(b).all():
                    raise ValueError('Adapter factors must be finite in the compute precision')
                loaded.append((pair, a, b))
                target = self.modules[pair.module].weight
                delta = self.workspace[:target.numel()].view(target.shape)
                torch.matmul(b, a, out=delta)
                norms.append(torch.linalg.vector_norm(delta, dtype=torch.float32))
        self.norms[name] = dict(zip((pair.module for pair in pairs), torch.stack(norms).cpu().tolist()))
        self.factors[name] = tuple(loaded)
        self.loads += 1
        return self.factors[name]

    def warm(self):
        for name in self.names:
            self.load_adapter(name)
        synchronize(self.device)

    def get_matrices(self, name):
        """Return module -> (A:[rank,in], B:[out,rank], trained scaling)."""
        return {pair.module: (a, b, pair.scale) for pair, a, b in self.load_adapter(name)}

    @property
    def resident_bytes(self):
        return sum(t.numel() * t.element_size() for factors in self.factors.values()
                   for _, a, b in factors for t in (a, b))

    @torch.no_grad()
    def restore(self):
        for name, pristine in self.pristine.items():
            self.modules[name].weight.copy_(pristine)
        self.is_fused = False

    @torch.no_grad()
    def apply(self, weight_vector):
        """Modify real base matrices before forward; coefficients are never normalized."""
        coefficients = _weights(self.names, weight_vector)
        if self.is_fused:
            self.restore()
        synchronize(self.device)
        started = time.perf_counter()
        loads, hits = self.loads, self.hits
        sample = None
        layer_names = set()
        rows = {}
        try:
            # Resolve every active adapter before touching a base matrix.
            active = [(name, weight, self.load_adapter(name))
                      for name, weight in zip(self.names, coefficients) if weight > 0]
            self.is_fused = bool(active)  # Roll back even if a later matmul fails.
            for name, weight, factors in active:
                for pair, a, b in factors:
                    target = self.modules[pair.module].weight
                    delta = self.workspace[:target.numel()].view(target.shape)
                    torch.matmul(b, a, out=delta)
                    scale = weight * pair.scale
                    target.add_(delta, alpha=scale)
                    layer_names.add(pair.module)
                    row = rows.setdefault(pair.module, {'module': pair.module, 'shape': list(target.shape),
                                                         'delta_norms': {}})
                    row['delta_norms'][name] = self.norms[name][pair.module] * scale
                    if sample is None:
                        sample = {'module': pair.module,
                                  'base': self.pristine[pair.module][:6, :6].float().cpu().tolist(),
                                  'contributions': {}}
                    if pair.module == sample['module']:
                        sample['contributions'][name] = (delta[:6, :6].float() * scale).cpu().tolist()
            if sample:
                sample['fused'] = self.modules[sample['module']].weight[:6, :6].float().cpu().tolist()
            synchronize(self.device)
            return {'weights': dict(zip(self.names, coefficients)), 'device': str(self.device),
                    'compute_dtype': str(self.dtype).removeprefix('torch.'),
                    'base_dtype': str(next(self.model.parameters()).dtype).removeprefix('torch.'),
                    'fusion_ms': (time.perf_counter() - started) * 1000,
                    'layer_count': len(layer_names), 'layers': list(rows.values()),
                    'resident_adapter_bytes': self.resident_bytes,
                    'snapshot_bytes': sum(t.numel() * t.element_size() for t in self.pristine.values()),
                    'workspace_bytes': self.workspace_bytes, 'adapters_loaded': self.loads - loads,
                    'adapter_cache_hits': self.hits - hits, 'matrix_sample': sample,
                    'loaded_adapters': [name for name, _, _ in active],
                    'gpu_resident_factors': self.device.type == 'cuda',
                    'adapter_forward_branches': 0, 'disk_writes': 0,
                    'equation': 'W_base + sum(w_i * scale_i * (B_i @ A_i))'}
        except BaseException:
            self.restore()
            raise

    @contextmanager
    def fused(self, weight_vector):
        try:
            yield self.apply(weight_vector)
        finally:
            self.restore()


def _pattern_value(pattern, module, default):
    for name, value in pattern.items():
        if re.match(rf'(.*\.)?({name})$', module):
            return value
    return default


def _adapter_plan(path, model, base_model_id, base_revision):
    path = Path(path).resolve()
    config = json.loads((path / 'adapter_config.json').read_text())
    validate_config(config, base_model_id, base_revision)
    # Transformations that change the base or activate conditionally are not
    # equivalent to a static weighted ordinary-LoRA delta.
    if any(config.get(k) for k in ('alora_invocation_tokens', 'use_qalora', 'trainable_token_indices', 'arrow_config', 'use_bdlora')):
        raise ValueError('Only unconditional ordinary Linear LoRA is supported')
    filename = str(path / 'adapter_model.safetensors')
    pairs = []
    modules = dict(model.named_modules())
    with safe_open(filename, framework='pt', device='cpu') as reader:
        keys = set(reader.keys())
        consumed = set()
        for key in sorted(keys):
            match = re.fullmatch(r'(.+)\.lora_A(?:\.[^.]+)?\.weight', key)
            if not match:
                continue
            raw = match.group(1)
            module = raw.removeprefix('base_model.model.')
            layer = modules.get(module)
            if not isinstance(layer, torch.nn.Linear) or hasattr(layer, 'lora_A'):
                raise ValueError(f'{raw}: requires an ordinary unquantized base Linear layer')
            b_key = key.replace('.lora_A', '.lora_B')
            if b_key not in keys:
                raise ValueError(f'{raw}: missing B factor')
            a_shape = reader.get_slice(key).get_shape()
            b_shape = reader.get_slice(b_key).get_shape()
            rank = _pattern_value(config.get('rank_pattern', {}), module, config['r'])
            alpha = _pattern_value(config.get('alpha_pattern', {}), module, config.get('lora_alpha', rank))
            if a_shape != [rank, layer.in_features] or b_shape != [layer.out_features, rank]:
                raise ValueError(f'{raw}: factor shapes do not match rank/base matrix')
            scale = float(alpha) / (math.sqrt(rank) if config.get('use_rslora') else rank)
            if not math.isfinite(scale) or scale <= 0:
                raise ValueError('LoRA scaling must be finite and positive')
            pairs.append(Pair(module, key, b_key, scale))
            consumed.update((key, b_key))
        if not pairs or keys != consumed:
            raise ValueError('Adapter must contain only complete A/B factor pairs')
    return filename, pairs


def _weights(adapter_paths, weight_vector):
    values = [float(value) for value in weight_vector]
    if len(adapter_paths) != len(values) or not values:
        raise ValueError('Provide one coefficient per adapter path')
    if any(not math.isfinite(w) or w < 0 or w > 1 + 1e-5 for w in values) or math.fsum(values) > 1 + 1e-5:
        raise ValueError('Coefficients must be finite, nonnegative, and sum to at most one')
    return values


@torch.no_grad()
def restore_weights(model):
    """Restore bit-for-bit pristine matrices after generation or any failure."""
    state = getattr(model, '_synapse_base_snapshots', {})
    modules = dict(model.named_modules())
    for module, pristine in state.items():
        modules[module].weight.copy_(pristine)
    model._synapse_is_fused = False


@torch.no_grad()
def fuse_weights(model, adapter_paths, weight_vector, *, adapter_names=None,
                 compute_dtype=None, base_model_id=None, base_revision=None,
                 tensor_store=None):
    """Return the SAME base model with W := W_base + Σ w_i scale_i (B_i @ A_i).

    adapter_paths: local PEFT safetensors directories, in coefficient order.
    weight_vector: nonnegative coefficients summing to AT MOST one. The network
                   budget is preserved; it must never be normalized away here.
                   Zero paths are never opened or loaded, including a zero cap.
    CUDA uses BF16 when supported, otherwise FP16. Metal uses FP16. CPU is a
    correctness/debugging fallback. The caller serializes model access and calls
    restore_weights(model) in a finally block after its fused forward pass.
    """
    coefficients = _weights(adapter_paths, weight_vector)
    names = list(adapter_names or [f'expert_{i}' for i in range(len(adapter_paths))])
    if len(names) != len(adapter_paths) or len(set(names)) != len(names):
        raise ValueError('Adapter names must be distinct and match adapter paths')
    parameters = list(model.parameters())
    devices = {p.device for p in parameters}
    if len(devices) != 1 or not all(p.is_floating_point() for p in parameters):
        raise ValueError('Fusion requires an unquantized model on one device')
    device = next(iter(devices))
    if compute_dtype is None:
        compute_dtype = torch.bfloat16 if device.type == 'cuda' and torch.cuda.is_bf16_supported() else torch.float16
    if compute_dtype not in (torch.float16, torch.bfloat16):
        raise ValueError('Delta multiplication must use FP16 or BF16')
    if any(hasattr(m, 'lora_A') for m in model.modules()):
        raise ValueError('Pass a plain base model; PEFT forward branches are not part of this kernel')
    model.eval()
    model.requires_grad_(False)
    config = model.config
    base_model_id = base_model_id or getattr(config, '_name_or_path', '')
    base_revision = base_revision or getattr(config, '_commit_hash', None)
    store = tensor_store or AdapterTensorStore()
    restore_weights(model)
    synchronize(device)
    start = time.perf_counter()
    # Validate every active pair BEFORE any base matrix is modified.
    plans = [(i, *_adapter_plan(path, model, base_model_id, base_revision))
             for i, (path, weight) in enumerate(zip(adapter_paths, coefficients)) if weight > 0]
    modules = dict(model.named_modules())
    snapshots = getattr(model, '_synapse_base_snapshots', {})
    target_names = {pair.module for _, _, pairs in plans for pair in pairs}
    snapshots = {name: value for name, value in snapshots.items() if name in target_names}
    model._synapse_base_snapshots = snapshots  # Release inactive snapshots before allocating.
    estimated = sum(modules[name].weight.numel() * modules[name].weight.element_size()
                    for name in target_names if name not in snapshots)
    max_delta = max((modules[name].weight.numel() * 2 for name in target_names), default=0)
    if device.type == 'cuda':
        free, _ = torch.cuda.mem_get_info(device)
        if estimated + max_delta > free * .8:
            raise MemoryError('Not enough VRAM for base snapshots plus a streamed delta; use fewer/narrower adapters')
    elif device.type == 'mps':
        free = torch.mps.recommended_max_memory() - torch.mps.current_allocated_memory()
        if estimated + max_delta > free * .8:
            raise MemoryError('Not enough Metal memory for this mixture; use fewer/narrower adapters')
    for name in sorted(target_names):
        if name not in snapshots:
            snapshots[name] = modules[name].weight.detach().clone()
    model._synapse_base_snapshots = snapshots
    metadata_ms = (time.perf_counter() - start) * 1000
    rows = {name: {'module': name, 'shape': list(modules[name].weight.shape), 'delta_norms': {}} for name in sorted(target_names)}
    first = sorted(target_names)[0] if target_names else None
    sample = {'module': first, 'base': snapshots[first][:6, :6].float().cpu().tolist(), 'contributions': {}} if first else None
    norms, positions, norm_keys = [], [], []
    norm_hits = 0
    loads_before, hits_before = store.loads, store.hits
    peak_workspace_bytes = 0
    try:
        with ExitStack() as stack:
            for i, filename, pairs in plans:
                reader = stack.enter_context(safe_open(filename, framework='pt', device='cpu'))
                for pair in pairs:
                    target = modules[pair.module].weight
                    a, b = store.factors(reader, filename, pair, compute_dtype, device)
                    # PEFT layout: A:[r,in], B:[out,r]. No factor averaging,
                    # cross-expert products, routing, or prompt substitution.
                    delta = torch.matmul(b, a)       # FP16/BF16, on the base GPU
                    scale = coefficients[i] * pair.scale
                    target.add_(delta, alpha=scale)  # modifies the real base W
                    # Half precision inputs; FP32 reduction for audit accuracy.
                    norm_key = store.norm_key(filename, pair, compute_dtype)
                    if norm_key in store.norm_cache:
                        rows[pair.module]['delta_norms'][names[i]] = store.norm_cache[norm_key] * scale
                        norm_hits += 1
                    else:
                        norms.append(torch.linalg.vector_norm(delta, dtype=torch.float32))
                        positions.append((pair.module, names[i], scale))
                        norm_keys.append(norm_key)
                    if pair.module == first:
                        sample['contributions'][names[i]] = (delta[:6, :6].float() * scale).cpu().tolist()
                    peak_workspace_bytes = max(peak_workspace_bytes, sum(t.numel() * t.element_size() for t in (a, b, delta)))
                    del a, b, delta
        # One batched scalar transfer; no per-layer GPU synchronization.
        for (module, expert, scale), key, norm in zip(positions, norm_keys, torch.stack(norms).cpu().tolist() if norms else []):
            store.remember_norm(key, norm)
            rows[module]['delta_norms'][expert] = norm * scale
        if sample:
            sample['fused'] = modules[first].weight[:6, :6].float().cpu().tolist()
        synchronize(device)
        model._synapse_is_fused = bool(plans)
        model._synapse_fusion_audit = {
            'weights': dict(zip(names, coefficients)), 'device': str(device),
            'compute_dtype': str(compute_dtype).removeprefix('torch.'),
            'base_dtype': str(parameters[0].dtype).removeprefix('torch.'),
            'fusion_ms': (time.perf_counter() - start) * 1000,
            'adapter_metadata_ms': metadata_ms, 'layer_count': len(rows), 'layers': list(rows.values()),
            'snapshot_bytes': sum(t.numel() * t.element_size() for t in snapshots.values()),
            'peak_workspace_bytes': peak_workspace_bytes, 'cpu_factor_cache_bytes': store.bytes,
            'factor_pairs_loaded': store.loads - loads_before, 'factor_cache_hits': store.hits - hits_before,
            'audit_norm_cache_hits': norm_hits, 'audit_norms_computed': len(norms),
            'loaded_adapters': [names[i] for i, _, _ in plans],
            'lazy_loading': True, 'disk_writes': 0, 'adapter_forward_branches': 0,
            'equation': 'W_base + sum(w_i * scale_i * (B_i @ A_i))', 'matrix_sample': sample,
        }
        return model
    except BaseException:
        restore_weights(model)
        raise
