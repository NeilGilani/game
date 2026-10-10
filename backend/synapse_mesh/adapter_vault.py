"""Llama-3-8B NF4 base + lazy PEFT factor library, without adapter routing.

The base is loaded through Transformers' bitsandbytes integration. LoRA
factors remain FP16/BF16 and are retrieved as ordinary tensors on one device.
This module manages weights; it does not pretend packed NF4 can use add_ fusion.
"""
from collections import OrderedDict
from dataclasses import dataclass
import importlib.util
import json
import math
from pathlib import Path
import re
from threading import RLock

from huggingface_hub import HfApi, snapshot_download
from peft import PeftConfig
from safetensors import safe_open
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

from .tensor_fusion import _adapter_plan

LLAMA_3_8B = 'meta-llama/Meta-Llama-3-8B'


@dataclass(frozen=True)
class LoRAMatrices:
    """A:[rank,in], B:[out,rank]; the trained delta is scaling * (B @ A)."""
    A: torch.Tensor
    B: torch.Tensor
    scaling: float

    @property
    def bytes(self):
        return (self.A.numel() + self.B.numel()) * self.A.element_size()


@dataclass(frozen=True)
class Specialist:
    name: str
    source: str
    revision: str | None = None   # Adapter Hub revision, not base revision.
    subfolder: str = ''


class AdapterVault:
    """Manage one quantized base and named specialists independently.

    Registration is metadata-only. load_base_model() and load_adapter() are
    explicit and lazy. get_pair()/get_matrices() load a specialist on demand.
    Names are case-insensitive: Medical, medical, and MEDICAL share one entry.
    LRU limits refer to vault-owned factor tensors; callers holding returned
    references must release them to actually reclaim their device memory.
    """
    def __init__(self, base_model=LLAMA_3_8B, *, base_revision=None, device='cuda:0',
                 compute_dtype=None, max_resident_adapters=3,
                 max_adapter_bytes=256 * 1024 * 1024, manifest=None, token=None):
        self.base_model_id = str(base_model)
        self.base_revision = base_revision
        self.device = torch.device(device)
        if self.device.type not in ('cuda', 'cpu'):
            raise ValueError('This vault supports bitsandbytes CUDA and explicit CPU verification; MPS is not enabled')
        if compute_dtype is not None and compute_dtype not in (torch.float16, torch.bfloat16):
            raise ValueError('LoRA factor precision must be FP16 or BF16')
        if max_resident_adapters < 1 or max_adapter_bytes < 1:
            raise ValueError('Adapter memory/count budgets must be positive')
        self.compute_dtype = compute_dtype
        self.max_resident_adapters = max_resident_adapters
        self.max_adapter_bytes = max_adapter_bytes
        self.manifest = Path(manifest) if manifest else None
        self._token = token
        self._specialists = {}
        self._resident = OrderedDict()
        self._plans = {}
        self._model = self._tokenizer = None
        self._lock = RLock()
        if self.manifest and self.manifest.exists():
            data = json.loads(self.manifest.read_text())
            if data['base_model'] != self.base_model_id or data.get('base_revision') != self.base_revision:
                raise ValueError('Vault manifest belongs to a different base model/revision')
            self._specialists = {item['name']: Specialist(**item) for item in data['specialists']}

    @staticmethod
    def _name(name):
        value = name.strip().casefold()
        if not value or not re.fullmatch(r'[\w -]+', value):
            raise ValueError('Use a nonempty specialist name with letters, numbers, spaces, or underscores')
        return value

    def _save_manifest(self):
        if self.manifest:
            self.manifest.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.manifest.with_suffix('.tmp')
            temporary.write_text(json.dumps({'base_model': self.base_model_id,
                                             'base_revision': self.base_revision,
                                             'specialists': [vars(s) for s in self._specialists.values()]}, indent=2))
            temporary.replace(self.manifest)

    def register(self, name, source, *, revision=None, subfolder=''):
        """Register a local PEFT directory or Hub repo ID; no weights are loaded."""
        key = self._name(name)
        source = str(source)
        if subfolder and (Path(subfolder).is_absolute() or '..' in Path(subfolder).parts):
            raise ValueError('Adapter subfolder must be a relative path without traversal')
        if Path(source).is_dir(): source = str(Path(source).resolve())
        with self._lock:
            if key in self._specialists: raise ValueError(f'Specialist already registered: {key}')
            self._specialists[key] = Specialist(key, source, revision, subfolder)
            self._save_manifest()
        return key

    def load_base_model(self):
        """Load an NF4 + double-quantized base on one GPU, with no CPU offload."""
        with self._lock:
            if self._model is not None: return self._model
            if self.device.type == 'cuda':
                if not torch.cuda.is_available():
                    raise RuntimeError('CUDA is unavailable. Run the VRAM vault on a CUDA machine; device="cpu" is an explicit 4-bit test mode')
                index = self.device.index if self.device.index is not None else torch.cuda.current_device()
                if index >= torch.cuda.device_count(): raise ValueError('CUDA device index is unavailable')
                self.device = torch.device('cuda', index)
                if torch.cuda.get_device_capability(self.device) < (6, 0):
                    raise RuntimeError('bitsandbytes NF4 requires CUDA compute capability 6.0 or newer')
                with torch.cuda.device(self.device):
                    bf16_supported = torch.cuda.is_bf16_supported()
                if self.compute_dtype == torch.bfloat16 and not bf16_supported:
                    raise ValueError('BF16 is unavailable on the selected CUDA device; use FP16')
                dtype = self.compute_dtype or (torch.bfloat16 if bf16_supported else torch.float16)
            else:
                dtype = self.compute_dtype or torch.float16
            if importlib.util.find_spec('bitsandbytes') is None:
                raise RuntimeError('Install requirements-vault.txt for bitsandbytes 4-bit loading')
            quantization = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4',
                                              bnb_4bit_use_double_quant=True,
                                              bnb_4bit_compute_dtype=dtype)
            model = AutoModelForCausalLM.from_pretrained(
                self.base_model_id, revision=self.base_revision, token=self._token,
                quantization_config=quantization, device_map={'': str(self.device)},
                dtype=dtype, low_cpu_mem_usage=True, trust_remote_code=False)
            if not getattr(model, 'is_loaded_in_4bit', False):
                raise RuntimeError('Loader did not return a 4-bit model; refusing a silent full-precision fallback')
            model.eval().requires_grad_(False)
            self.compute_dtype = dtype
            self._model = model
            return model

    @property
    def model(self):
        return self.load_base_model()

    @property
    def tokenizer(self):
        with self._lock:
            if self._tokenizer is None:
                self._tokenizer = AutoTokenizer.from_pretrained(self.base_model_id, revision=self.base_revision,
                                                                token=self._token, trust_remote_code=False)
                if self._tokenizer.pad_token_id is None: self._tokenizer.pad_token = self._tokenizer.eos_token
            return self._tokenizer

    def _resolve(self, spec):
        path = Path(spec.source)
        if path.is_dir(): return path / spec.subfolder
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', spec.source):
            raise FileNotFoundError(f'Adapter directory not found: {spec.source}')
        info = HfApi(token=self._token).model_info(spec.source, revision=spec.revision)
        prefix = spec.subfolder.rstrip('/') + '/' if spec.subfolder else ''
        path = Path(snapshot_download(spec.source, revision=info.sha, token=self._token,
                                      allow_patterns=[prefix + 'adapter_config.json', prefix + 'adapter_model.safetensors']))
        return path / spec.subfolder

    def _plan(self, name):
        if name not in self._specialists: raise KeyError(f'Unknown specialist: {name}')
        model = self.load_base_model()
        if name not in self._plans:
            path = self._resolve(self._specialists[name])
            config = PeftConfig.from_pretrained(str(path))
            if str(config.peft_type) not in ('PeftType.LORA', 'LORA'):
                raise ValueError('Specialist must use PEFT LoRA')
            revision = self.base_revision or getattr(model.config, '_commit_hash', None)
            # Header/shape validation works for Linear4bit using in/out_features,
            # never the packed uint8 weight.shape. No PEFT forward wrapper.
            self._plans[name] = _adapter_plan(path, model, self.base_model_id, revision)
        return self._plans[name]

    def layer_names(self, name):
        """List adapted base modules without loading factor tensors into VRAM."""
        with self._lock:
            _, pairs = self._plan(self._name(name))
            return tuple(pair.module for pair in pairs)

    @property
    def resident_bytes(self):
        with self._lock:
            return sum(pair.bytes for factors in self._resident.values() for pair in factors.values())

    def unload_adapter(self, name):
        """Drop vault-owned factor references; never alter the base model."""
        with self._lock:
            return self._resident.pop(self._name(name), None) is not None

    @torch.no_grad()
    def load_adapter(self, name):
        key = self._name(name)
        with self._lock:
            if key in self._resident:
                factors = self._resident.pop(key)
                self._resident[key] = factors
                return dict(factors)
            filename, pairs = self._plan(key)
            with safe_open(filename, framework='pt', device='cpu') as reader:
                required = sum(math.prod(reader.get_slice(p.a_key).get_shape()) +
                               math.prod(reader.get_slice(p.b_key).get_shape()) for p in pairs) * 2
                if required > self.max_adapter_bytes:
                    raise MemoryError(f'{key}: factors exceed the {self.max_adapter_bytes} byte vault budget')
                while self._resident and (len(self._resident) >= self.max_resident_adapters or
                                          self.resident_bytes + required > self.max_adapter_bytes):
                    self._resident.popitem(last=False)
                if self.device.type == 'cuda':
                    free, _ = torch.cuda.mem_get_info(self.device)
                    if required > free * .8: raise MemoryError('Not enough free VRAM for this specialist')
                factors = {}
                for pair in pairs:
                    a = reader.get_tensor(pair.a_key).to(dtype=self.compute_dtype)
                    b = reader.get_tensor(pair.b_key).to(dtype=self.compute_dtype)
                    if not torch.isfinite(a).all() or not torch.isfinite(b).all():
                        raise ValueError('LoRA factors must be finite in their compute precision')
                    factors[pair.module] = LoRAMatrices(a.to(self.device), b.to(self.device), pair.scale)
                self._resident[key] = factors
                return dict(factors)

    def get_matrices(self, name):
        """Return {base_module_name: LoRAMatrices(A, B, scaling)} on the device."""
        return self.load_adapter(name)

    def get_pair(self, name, module):
        factors = self.load_adapter(name)
        module = module.removeprefix('base_model.model.')
        if module not in factors: raise KeyError(f'{name} has no LoRA factors for {module}')
        return factors[module]

    def unregister(self, name):
        """Remove a specialist from this vault; leave its cached files intact."""
        key = self._name(name)
        with self._lock:
            if key not in self._specialists: raise KeyError(f'Unknown specialist: {key}')
            self.unload_adapter(key)
            self._plans.pop(key, None)
            del self._specialists[key]
            self._save_manifest()

    def status(self):
        with self._lock:
            return {'base_model': self.base_model_id, 'base_loaded': self._model is not None,
                    'quantization': 'bitsandbytes NF4 + double quantization', 'device': str(self.device),
                    'resident_adapter_bytes': self.resident_bytes,
                    'specialists': [{'name': name, 'loaded': name in self._resident,
                                     'layers': len(self._resident[name]) if name in self._resident else None}
                                    for name in self._specialists]}

    def close(self):
        with self._lock:
            self._resident.clear(); self._plans.clear()
            self._model = self._tokenizer = None

    def __enter__(self): return self
    def __exit__(self, *_): self.close()

