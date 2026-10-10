"""Standalone CUDA service: uvicorn synapse_mesh.cloud_api:app --workers 1.

The receiving machine hosts and runs the model. This API does not call another
inference API. One process owns one GPU; adapter factors stay resident in VRAM.
"""
import asyncio
from collections import OrderedDict
from concurrent.futures import TimeoutError as FutureTimeout
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hmac
import json
import os
import time
from pathlib import Path
from threading import Event
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
import torch

from .kernel import CloudKernel


@dataclass(frozen=True)
class CloudConfig:
    base_model: str
    adapters: dict[str, Path]
    api_key: str
    base_revision: str | None = None
    device: str = 'cuda:0'
    dtype: str = 'auto'
    local_files_only: bool = False
    adapter_cache_bytes: int = 512 * 1024 * 1024
    generation_reserve_bytes: int = 1024 * 1024 * 1024
    max_input_tokens: int = 4096
    max_new_tokens: int = 512
    max_pending_requests: int = 8
    vault_root: Path | None = None
    vault_mode: str = 'shared'

    def __post_init__(self):
        if not self.api_key:
            raise ValueError('CLOUD_API_KEY is required for the cloud inference service')
        if self.vault_mode not in ('shared', 'resident'):
            raise ValueError('CLOUD_VAULT_MODE must be shared or resident')
        if self.dtype not in ('auto', 'float16', 'bfloat16'):
            raise ValueError('CLOUD_DTYPE must be auto, float16, or bfloat16')
        if not self.adapters or any(not isinstance(n, str) or not n for n in self.adapters):
            raise ValueError('A named adapter vault is required')
        if min(self.max_input_tokens, self.max_new_tokens, self.max_pending_requests) < 1:
            raise ValueError('Context, output, and admission limits must be positive')

    @classmethod
    def from_env(cls):
        manifest = Path(os.environ.get('CLOUD_VAULT_MANIFEST', '/mnt/synapse_vault/vault.json')).resolve()
        data = json.loads(manifest.read_text())
        adapters = {name: (manifest.parent / (entry['path'] if isinstance(entry, dict) else entry)).resolve()
                    for name, entry in data['adapters'].items()}
        return cls(base_model=os.environ.get('CLOUD_BASE_MODEL', data['base_model']),
                   base_revision=os.environ.get('CLOUD_BASE_REVISION') or data.get('base_revision'),
                   adapters=adapters, api_key=os.environ.get('CLOUD_API_KEY', ''),
                   device=os.environ.get('CLOUD_DEVICE', 'cuda:0'),
                   dtype=os.environ.get('CLOUD_DTYPE', 'auto'),
                   local_files_only=os.environ.get('CLOUD_LOCAL_FILES_ONLY', 'false').lower() == 'true',
                   adapter_cache_bytes=int(os.environ.get('CLOUD_ADAPTER_CACHE_MB', '512')) * 1024 * 1024,
                   generation_reserve_bytes=int(os.environ.get('CLOUD_GENERATION_RESERVE_MB', '1024')) * 1024 * 1024,
                   max_input_tokens=int(os.environ.get('CLOUD_MAX_INPUT_TOKENS', '4096')),
                   max_new_tokens=int(os.environ.get('CLOUD_MAX_NEW_TOKENS', '512')),
                   max_pending_requests=int(os.environ.get('CLOUD_MAX_PENDING_REQUESTS', '8')),
                   vault_root=manifest.parent,
                   vault_mode=os.environ.get('CLOUD_VAULT_MODE', 'shared'))


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=65536)
    weight_vector: list[float] | dict[str, float]
    max_new_tokens: int = Field(default=192, ge=1, le=4096, strict=True)
    stream: bool = True


class RpcParams(BaseModel):
    prompt: str = Field(min_length=1, max_length=65536)
    weights: list[float]
    adapter_order: list[str]
    max_new_tokens: int = Field(default=192, ge=1, le=4096, strict=True)
    network_cap: float = Field(default=1, ge=0, le=1, allow_inf_nan=False)
    compare: bool = False
    request_id: str = Field(min_length=1, max_length=128)
    resume_from: int = Field(default=0, ge=0, strict=True)


class RpcRequest(BaseModel):
    jsonrpc: Literal['2.0']
    id: str | int
    method: Literal['fuse_and_generate']
    params: RpcParams


async def kernel_events(kernel, body, coefficients, *, prefix_token_ids=None):
    """Bounded thread-to-async stream; stop and restore on disconnect.

    All generator advances occur on ONE worker thread, including close(), so
    PyTorch's thread-local inference context cannot leak to the event loop.
    """
    loop = asyncio.get_running_loop()
    queue = asyncio.Queue(maxsize=8)
    stop = Event()

    def send(kind, value):
        future = asyncio.run_coroutine_threadsafe(queue.put((kind, value)), loop)
        while not stop.is_set():
            try:
                future.result(timeout=.05)
                return True
            except FutureTimeout:
                continue
        future.cancel()
        return False

    def work():
        events = kernel.events(body.prompt, coefficients, body.max_new_tokens,
                               stop=stop, prefix_token_ids=prefix_token_ids)
        try:
            while not stop.is_set():
                try:
                    event = next(events)
                except StopIteration:
                    break
                if not send('event', event):
                    break
        except Exception as error:
            if not stop.is_set():
                send('error', error)
        finally:
            try:
                events.close()
            finally:
                if not stop.is_set():
                    send('done', None)

    worker = asyncio.create_task(asyncio.to_thread(work))
    try:
        while True:
            kind, value = await queue.get()
            if kind == 'done':
                break
            if kind == 'error':
                raise value
            yield value
    finally:
        stop.set()
        await asyncio.shield(worker)


def create_app(config=None, kernel=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.config = config if config is not None else CloudConfig.from_env()
        app.state.kernel = kernel if kernel is not None else await asyncio.to_thread(CloudKernel.load, app.state.config)
        app.state.pending = 0
        app.state.rpc_records = OrderedDict()
        app.state.ready = True
        try:
            yield
        finally:
            app.state.ready = False
            if hasattr(app.state.kernel.vault, 'close'):
                await asyncio.to_thread(app.state.kernel.vault.close)

    app = FastAPI(title='Synapse-Mesh Cloud Tensor Kernel', lifespan=lifespan)

    async def authorize(authorization: str | None = Header(default=None)):
        expected = f'Bearer {app.state.config.api_key}'
        if not authorization or not hmac.compare_digest(authorization.encode(), expected.encode()):
            raise HTTPException(401, 'Valid bearer token required', headers={'WWW-Authenticate': 'Bearer'})

    @app.get('/health')
    async def health():
        return {'status': 'ok', 'ready': app.state.ready, 'service': 'cloud-tensor-kernel'}

    @app.get('/adapters', dependencies=[Depends(authorize)])
    async def adapters():
        vault = app.state.kernel.vault
        result = {'base_model': app.state.config.base_model, 'base_revision': app.state.config.base_revision,
                  'adapter_order': list(vault.names), 'resident_adapters': list(vault.factors),
                  'device': str(vault.device), 'compute_dtype': str(vault.dtype).removeprefix('torch.'),
                  'resident_adapter_bytes': vault.resident_bytes,
                  'adapter_loads': vault.loads, 'cache_hits': vault.hits,
                  'pending_requests': app.state.pending, 'execution_location': 'cloud'}
        if hasattr(vault, 'manager'):
            result['storage_backend'] = 'shared-volume'
            result['vault_manager'] = vault.manager.status()
        if vault.device.type == 'cuda':
            result['cuda_memory_allocated_bytes'] = torch.cuda.memory_allocated(vault.device)
            result['cuda_memory_reserved_bytes'] = torch.cuda.memory_reserved(vault.device)
        return result

    @app.post('/generate', dependencies=[Depends(authorize)])
    @app.post('/v1/generate', dependencies=[Depends(authorize)])
    async def generate(body: GenerateRequest):
        service = app.state.kernel
        vector = body.weight_vector
        if isinstance(vector, dict):
            if set(vector) != set(service.vault.names):
                raise HTTPException(422, 'Named coefficients must match the configured adapter order')
            vector = [vector[name] for name in service.vault.names]
        try:
            vector = service.validate(body.prompt, vector, body.max_new_tokens)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        # This counter is accessed only on the event loop, before any await.
        if app.state.pending >= app.state.config.max_pending_requests:
            raise HTTPException(503, 'GPU request queue is full', headers={'Retry-After': '1'})
        app.state.pending += 1
        released = False

        def release():
            nonlocal released
            if not released:
                app.state.pending -= 1
                released = True

        async def stream():
            events = kernel_events(service, body, vector)
            try:
                async for event in events:
                    yield json.dumps(event, allow_nan=False) + '\n'
            except Exception as error:
                code = 'cuda_out_of_memory' if isinstance(error, torch.cuda.OutOfMemoryError) else 'generation_failed'
                yield json.dumps({'event': 'error', 'code': code, 'detail': str(error)}) + '\n'
            finally:
                await events.aclose()
                release()

        if body.stream:
            return StreamingResponse(stream(), media_type='application/x-ndjson',
                                     headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'},
                                     background=BackgroundTask(release))
        events = kernel_events(service, body, vector)
        try:
            result = None
            async for event in events:
                if event['event'] == 'complete':
                    result = event
            if result is None:
                raise HTTPException(500, 'Generation ended without a completed result')
            return result
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        except torch.cuda.OutOfMemoryError as error:
            raise HTTPException(503, 'GPU generation memory exhausted; reduce context/output limits') from error
        finally:
            await events.aclose()
            release()

    @app.post('/rpc', dependencies=[Depends(authorize)])
    async def rpc(body: RpcRequest):
        """Edge protocol: resumable 1-based text chunks backed by real token IDs.

        Prefixes stay in a bounded process-local journal, not model tensors. A
        retry conditions on those exact IDs; changed coefficients apply only to
        its continuation. Restarts/expired records fail explicitly, never replay
        a newly generated and potentially conflicting prefix.
        """
        params, service = body.params, app.state.kernel
        if str(body.id) != params.request_id:
            raise HTTPException(422, 'RPC id must match request_id')
        if (not params.adapter_order or len(set(params.adapter_order)) != len(params.adapter_order)
                or len(params.adapter_order) != len(params.weights)
                or not set(params.adapter_order).issubset(service.vault.names)):
            raise HTTPException(422, 'RPC adapter_order must name distinct configured adapters')
        named = dict(zip(params.adapter_order, params.weights))
        vector = [named.get(name, 0) for name in service.vault.names]
        try:
            vector = service.validate(params.prompt, vector, params.max_new_tokens)
            if sum(vector) > params.network_cap + 1e-5:
                raise ValueError('Weights exceed the supplied network cap')
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        records, now = app.state.rpc_records, time.monotonic()
        for key in list(records):
            if not records[key]['active'] and now - records[key]['updated'] > 300:
                del records[key]
        fingerprint = (params.prompt, tuple(params.adapter_order), params.max_new_tokens, params.compare)
        record = records.get(params.request_id)
        if record is not None:
            if record['fingerprint'] != fingerprint:
                raise HTTPException(409, 'request_id already belongs to a different generation')
            if record['active']:
                raise HTTPException(503, 'Previous request is still restoring the model', headers={'Retry-After': '1'})
        else:
            if params.resume_from:
                raise HTTPException(409, 'Generation prefix expired or service restarted')
            while len(records) >= 32:
                victim = next((key for key, entry in records.items() if not entry['active']), None)
                if victim is None:
                    raise HTTPException(503, 'Resume journal is full')
                del records[victim]
            record = {'fingerprint': fingerprint, 'chunks': [], 'token_ids': [], 'text': '',
                      'baseline': None, 'fusion': None, 'done': None, 'active': False, 'updated': now}
            records[params.request_id] = record
        if params.resume_from > len(record['chunks']):
            raise HTTPException(409, 'resume_from exceeds the recorded stream')
        if app.state.pending >= app.state.config.max_pending_requests:
            raise HTTPException(503, 'GPU request queue is full', headers={'Retry-After': '1'})
        record['active'] = True
        records.move_to_end(params.request_id)
        app.state.pending += 1
        released = False
        started = time.perf_counter()

        def release():
            nonlocal released
            if not released:
                app.state.pending -= 1
                record['active'] = False
                record['updated'] = time.monotonic()
                released = True

        async def frames():
            events = None
            try:
                if params.compare:
                    if record['baseline'] is None:
                        request = GenerateRequest(prompt=params.prompt, weight_vector=vector,
                                                  max_new_tokens=params.max_new_tokens)
                        events = kernel_events(service, request, [0] * len(vector))
                        async for event in events:
                            if event['event'] == 'complete':
                                timing = event['timing']
                                record['baseline'] = {'event': 'baseline', 'text': event['text'],
                                    'tokens': event['output_tokens'], 'generation_ms': timing['generation_ms'],
                                    'total_ms': timing['total_ms'],
                                    'tokens_per_second': event['output_tokens'] * 1000 / max(timing['generation_ms'], .001),
                                    'execution': {'location': 'cloud', 'device': str(service.vault.device)}}
                        await events.aclose()
                        events = None
                    yield record['baseline']
                if record['done'] is not None and record['fusion'] is not None:
                    yield record['fusion']
                for frame in record['chunks'][params.resume_from:]:
                    yield frame
                if record['done'] is not None:
                    yield record['done']
                    return
                request = GenerateRequest(prompt=params.prompt, weight_vector=vector,
                                          max_new_tokens=params.max_new_tokens)
                events = kernel_events(service, request, vector, prefix_token_ids=record['token_ids'])
                async for event in events:
                    if event['event'] == 'fusion':
                        record['fusion'] = event
                        yield event
                    elif event['event'] == 'token':
                        record['token_ids'].append(event['token_id'])
                        text = event['text']
                        # Hold partial UTF-8 characters until the tokenizer has
                        # enough tokens to decode them without replacement.
                        if text.endswith('\ufffd'):
                            continue
                        if not text.startswith(record['text']):
                            raise RuntimeError('Tokenizer revised already published text')
                        delta = text[len(record['text']):]
                        if delta:
                            frame = {'token': delta, 'index': len(record['chunks']) + 1, 'done': False}
                            record['text'] = text
                            record['chunks'].append(frame)
                            yield frame
                    elif event['event'] == 'complete':
                        if event['text'] != record['text']:
                            if not event['text'].startswith(record['text']):
                                raise RuntimeError('Tokenizer revised already published text')
                            delta = event['text'][len(record['text']):]
                            frame = {'token': delta, 'index': len(record['chunks']) + 1, 'done': False}
                            record['text'] = event['text']
                            record['chunks'].append(frame)
                            yield frame
                        timing = event['timing']
                        baseline_ms = record['baseline']['total_ms'] if record['baseline'] else 0
                        # Repeat the last indexed chunk as the completion
                        # marker. The edge deduplicates it by index; no text is
                        # appended twice. Empty generations finish at index 0.
                        record['done'] = {'token': record['chunks'][-1]['token'] if record['chunks'] else '',
                            'index': len(record['chunks']), 'done': True,
                            'base_restored': True, 'usage': {'input_tokens': event['input_tokens'],
                                                           'output_tokens': event['output_tokens']},
                            'timing': {**timing, 'baseline_total_ms': baseline_ms,
                                       'fused_total_ms': timing['total_ms'],
                                       'fused_generation_ms': timing['generation_ms'],
                                       'comparison_wall_ms': (time.perf_counter() - started) * 1000}}
                        yield record['done']
            except Exception as error:
                yield {'jsonrpc': '2.0', 'id': body.id,
                       'error': {'code': -32603, 'message': str(error)}}
            finally:
                if events is not None:
                    await events.aclose()
                release()

        async def stream_rpc():
            events = frames()
            try:
                async for frame in events:
                    yield json.dumps(frame, allow_nan=False) + '\n'
            finally:
                await events.aclose()

        return StreamingResponse(stream_rpc(), media_type='application/x-ndjson',
                                 headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'},
                                 background=BackgroundTask(release))

    return app


app = create_app()
