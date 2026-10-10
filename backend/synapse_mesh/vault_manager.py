"""Async shared-volume adapter loading with one resident copy per kernel/device."""
import asyncio
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
import json
import math
from pathlib import Path
from threading import RLock, Lock

from safetensors import safe_open
import torch

from .tensor_fusion import AdapterTensorStore, _adapter_plan, _weights, fuse_weights, restore_weights
from .tensor_utils import synchronize
from .vault_migration import sha256

DEFAULT_SHARED_ROOT = '/mnt/synapse_vault'


@dataclass(frozen=True)
class ResidentAdapter:
    path: Path
    filename: str
    factors: dict
    bytes: int


class ResidentTensorStore(AdapterTensorStore):
    """Fusion adapter: return leased device tensors without reading/copying them."""
    def __init__(self, manager):
        super().__init__()
        self.manager = manager

    def factors(self, reader, filename, pair, dtype, device):
        if filename not in {str(path / 'adapter_model.safetensors') for path in self.manager.paths.values()}:
            return super().factors(reader, filename, pair, dtype, device)
        a, b = self.manager.factors(filename, pair, dtype, device)
        self.hits += 1
        return a, b

    def norm_key(self, filename, pair, dtype):
        return filename, self.manager._stamp(Path(filename).parent), pair.a_key, dtype


class VaultManager:
    """A kernel owns one manager and one GPU. Share it across its requests.

    In-flight futures coalesce concurrent loads, including across event loops.
    LRU eviction only drops unleased adapters. Failures are retryable; cancelled
    async callers finish their shared load before releasing their lease. File
    stamps invalidate replaced shared-volume artifacts. Deploy immutable adapter
    directories and publish changes by replacing the manifest between workers.
    This cache is per process; separate GPU workers own separate device copies.
    """
    def __init__(self, root=DEFAULT_SHARED_ROOT, *, base_model_id, base_revision=None,
                 device='cuda:0', dtype=torch.float16, cache_bytes=512 * 1024 * 1024,
                 max_adapter_bytes=256 * 1024 * 1024, workers=4, adapter_paths=None, reserve_bytes=0):
        if cache_bytes < 1 or max_adapter_bytes < 1 or workers < 1:
            raise ValueError('Memory budgets and worker count must be positive')
        if reserve_bytes < 0:
            raise ValueError('Generation memory reserve must be nonnegative')
        if dtype not in (torch.float16, torch.bfloat16):
            raise ValueError('Adapter dtype must be FP16 or BF16')
        self.root = Path(root).expanduser().resolve()
        if not self.root.is_dir():
            raise FileNotFoundError(f'Shared vault is not mounted: {self.root}')
        self.base_model_id, self.base_revision = base_model_id, base_revision
        self.device = torch.device(device)
        if self.device.type == 'cuda':
            if not torch.cuda.is_available():
                raise RuntimeError('CUDA is unavailable; select CPU only for verification')
            self.device = torch.device('cuda', self.device.index if self.device.index is not None else torch.cuda.current_device())
        self.dtype, self.limit, self.max_adapter_bytes = dtype, cache_bytes, max_adapter_bytes
        self.reserve_bytes = reserve_bytes
        self._lock, self._transfer_lock = RLock(), Lock()
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix='cloud-vault')
        self._cache, self._inflight, self._refs = OrderedDict(), {}, {}
        self._reserved = 0
        self._closed = False
        self._model = None
        self.loads = self.hits = self.evictions = 0
        manifest = self.root / 'vault.json'
        if manifest.is_file():
            data = json.loads(manifest.read_text())
            if data['base_model'] != base_model_id or data.get('base_revision') != base_revision:
                raise ValueError('Shared vault manifest belongs to another base model/revision')
            entries = {name: {'path': entry} if isinstance(entry, str) else entry
                       for name, entry in data['adapters'].items()}
            self.paths = {name: self._path(entry['path']) for name, entry in entries.items()}
            self.metadata = entries
        else:
            self.paths = {name: self.root / name for name in ('coding', 'medical', 'legal')}
            self.metadata = {}
        if adapter_paths is not None:
            self.paths = {name: self._path(str(path)) for name, path in adapter_paths.items()}
        self.tensor_store = ResidentTensorStore(self)

    def _path(self, value):
        path = (self.root / value).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError('Adapter paths must stay inside the shared-volume root')
        return path

    @staticmethod
    def _stamp(path):
        stamps = []
        for file in (path / 'adapter_config.json', path / 'adapter_model.safetensors'):
            stat = file.stat()
            stamps.append((stat.st_mtime_ns, stat.st_size, stat.st_ino))
        return tuple(stamps)

    def config(self, name):
        return json.loads((self.paths[name] / 'adapter_config.json').read_text())

    @property
    def resident_bytes(self):
        with self._lock:
            return sum(entry.bytes for entry in self._cache.values())

    def _done(self, key, future):
        with self._lock:
            if self._inflight.get(key) is future:
                self._inflight.pop(key)

    def _load(self, key, path, model):
        for name, candidate in self.paths.items():
            if candidate == path:
                hashes = self.metadata.get(name, {}).get('sha256', {})
                for file, expected in hashes.items():
                    if file not in ('adapter_config.json', 'adapter_model.safetensors') or sha256(path / file) != expected:
                        raise ValueError('Shared adapter checksum does not match its manifest')
        filename, pairs = _adapter_plan(path, model, self.base_model_id, self.base_revision)
        with safe_open(filename, framework='pt', device='cpu') as reader:
            keys = [name for pair in pairs for name in (pair.a_key, pair.b_key)]
            required = sum(math.prod(reader.get_slice(name).get_shape()) * 2 for name in keys)
            if required > min(self.limit, self.max_adapter_bytes):
                raise MemoryError('Adapter exceeds the configured device factor budget')
            tensors = {name: reader.get_tensor(name) for name in keys}
            tensors = {name: tensor.to(dtype=self.dtype) for name, tensor in tensors.items()}
            if any(not torch.isfinite(t).all() for t in tensors.values()):
                raise ValueError('Adapter factors must be finite in compute precision')
            if self._stamp(path) != key[1]:
                raise RuntimeError('Shared adapter changed while loading; retry against an immutable version')
        with self._transfer_lock:
            with self._lock:
                while self.resident_bytes + self._reserved + required > self.limit:
                    victim = next((k for k in self._cache if not self._refs.get(k)), None)
                    if victim is None:
                        raise MemoryError('Device budget is occupied by leased adapters')
                    self._cache.pop(victim)
                    self.evictions += 1
                if self.device.type == 'cuda':
                    free, _ = torch.cuda.mem_get_info(self.device)
                    if required + self.reserve_bytes > free * .8:
                        raise MemoryError('Insufficient free GPU memory for adapter factors')
                self._reserved += required
            try:
                with torch.inference_mode():
                    factors = {name: tensor.to(device=self.device).detach() for name, tensor in tensors.items()}
                    synchronize(self.device)  # Publish only after uploads complete.
                entry = ResidentAdapter(path, filename, factors, required)
                with self._lock:
                    self._cache[key] = entry
                    self.loads += 1
                return entry
            finally:
                with self._lock:
                    self._reserved -= required

    def _acquire(self, name, model):
        path = self.paths[name]
        key = (str(path), self._stamp(path), self.dtype, str(self.device))
        with self._lock:
            if self._closed:
                raise RuntimeError('VaultManager is closed')
            if self._model is None:
                self._model = model
            elif self._model is not model:
                raise ValueError('Each VaultManager belongs to one Cloud-Kernel model')
            self._refs[key] = self._refs.get(key, 0) + 1
            if key in self._cache:
                self._cache.move_to_end(key)
                self.hits += 1
                return key, self._cache[key]
            future = self._inflight.get(key)
            if future is None:
                future = self._pool.submit(self._load, key, path, model)
                self._inflight[key] = future
                future.add_done_callback(lambda done: self._done(key, done))
            else:
                self.hits += 1
        try:
            entry = future.result()
            self._done(key, future)
            return key, entry
        except BaseException:
            self._done(key, future)
            self._release(key)
            raise

    def _release(self, key):
        with self._lock:
            self._refs[key] -= 1
            if not self._refs[key]:
                self._refs.pop(key)

    @contextmanager
    def lease_sync(self, name, model):
        key, entry = self._acquire(name, model)
        try:
            yield entry
        finally:
            self._release(key)

    @asynccontextmanager
    async def lease(self, name, model):
        task = asyncio.create_task(asyncio.to_thread(self._acquire, name, model))
        try:
            key, entry = await asyncio.shield(task)
        except asyncio.CancelledError:
            # The upload is shared with other callers and cannot be cancelled.
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            try:
                key, _ = task.result()
            except Exception:
                pass  # _acquire already released its reference on failure.
            else:
                self._release(key)
            raise
        try:
            yield entry
        finally:
            self._release(key)

    def factors(self, filename, pair, dtype, device):
        if dtype != self.dtype or torch.device(device) != self.device:
            raise ValueError('Fusion precision/device must match VaultManager')
        with self._lock:
            for key, entry in self._cache.items():
                if entry.filename == filename and self._refs.get(key) and self._stamp(entry.path) == key[1]:
                    return entry.factors[pair.a_key], entry.factors[pair.b_key]
        raise RuntimeError('Fusion factors require a live lease for this adapter version')

    def status(self):
        with self._lock:
            return {'root': str(self.root), 'device': str(self.device), 'resident_bytes': self.resident_bytes,
                    'budget_bytes': self.limit, 'loads': self.loads, 'cache_hits': self.hits,
                    'evictions': self.evictions, 'inflight': len(self._inflight),
                    'leases': sum(self._refs.values())}

    async def prefetch(self, names, model):
        async def load(name):
            async with self.lease(name, model):
                pass
        await asyncio.gather(*(load(name) for name in names))
        return self.status()

    def close(self):
        with self._lock:
            if self._refs or self._inflight:
                raise RuntimeError('Release all leases and finish loads before closing the vault')
            self._closed = True
            self._cache.clear()
            self._model = None
        self._pool.shutdown(wait=True)


class SharedVolumeFusion:
    """CloudKernel's fusion interface backed by leased VaultManager tensors."""
    def __init__(self, model, manager):
        self.model, self.manager = model, manager
        self.names = tuple(manager.paths)
        self.device, self.dtype = manager.device, manager.dtype

    @property
    def factors(self):
        with self.manager._lock:
            return {name: True for name, path in self.manager.paths.items()
                    if any(entry.path == path for entry in self.manager._cache.values())}

    @property
    def resident_bytes(self):
        return self.manager.resident_bytes

    @property
    def loads(self):
        return self.manager.loads

    @property
    def hits(self):
        return self.manager.hits

    def warm(self):
        # Startup validates headers/shapes only. GPU allocation stays lazy.
        for path in self.manager.paths.values():
            _adapter_plan(path, self.model, self.manager.base_model_id, self.manager.base_revision)

    @contextmanager
    def fused(self, weight_vector):
        from contextlib import ExitStack
        coefficients = _weights(self.names, weight_vector)
        with ExitStack() as leases:
            for name, weight in zip(self.names, coefficients):
                if weight > 0:
                    leases.enter_context(self.manager.lease_sync(name, self.model))
            try:
                fused = fuse_weights(self.model, list(self.manager.paths.values()), coefficients,
                                     adapter_names=self.names, base_model_id=self.manager.base_model_id,
                                     base_revision=self.manager.base_revision, compute_dtype=self.dtype,
                                     tensor_store=self.manager.tensor_store)
                audit = fused._synapse_fusion_audit
                audit.update(shared_vault=self.manager.status(), execution_location='cloud',
                             resident_adapter_bytes=self.resident_bytes,
                             gpu_resident_factors=self.device.type == 'cuda')
                yield audit
            finally:
                restore_weights(self.model)

    def close(self):
        self.manager.close()
