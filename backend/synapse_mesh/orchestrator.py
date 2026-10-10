"""Edge controller: local Sifter -> Cloud-Kernel JSON-RPC -> live UI tokens.

The only local model is the Sifter. No local fusion or generation is called.
See README for indexed token framing, resume support, and Lean-Fusion timeouts.
"""
import asyncio
from contextlib import aclosing
import json
import math
import os
import time
from uuid import uuid4

import httpx


class CloudKernelError(RuntimeError):
    """Cloud configuration, transport, or protocol failure."""


class CloudKernelClient:
    def __init__(self, endpoint=None, *, api_key=None, client=None,
                 read_timeout=None, total_timeout=300, max_reconnects=2,
                 reconnect_delay=.25, lean_cap=.4, max_frame_bytes=1024 * 1024):
        self.endpoint = endpoint or os.getenv('SYNAPSE_CLOUD_KERNEL_URL', '')
        self.api_key = api_key if api_key is not None else os.getenv('SYNAPSE_CLOUD_KERNEL_API_KEY')
        self.read_timeout = float(read_timeout if read_timeout is not None else
                                  os.getenv('SYNAPSE_CLOUD_LEAN_TIMEOUT', '10'))
        if not math.isfinite(self.read_timeout) or self.read_timeout <= 0:
            raise ValueError('Cloud read timeout must be positive and finite')
        if not math.isfinite(total_timeout) or total_timeout <= 0:
            raise ValueError('Cloud total timeout must be positive and finite')
        if not 0 <= lean_cap <= 1 or max_reconnects < 0 or reconnect_delay < 0:
            raise ValueError('Invalid cloud reconnect or Lean-Fusion configuration')
        self.total_timeout, self.max_reconnects = total_timeout, max_reconnects
        self.reconnect_delay, self.lean_cap = reconnect_delay, lean_cap
        self.max_frame_bytes = max_frame_bytes
        self._client, self._owns_client = client, client is None

    def _connection(self):
        if not self.endpoint or '[YOUR_CLUSTER_IP]' in self.endpoint:
            raise CloudKernelError('Set SYNAPSE_CLOUD_KERNEL_URL to the real Cloud-Kernel endpoint')
        url = httpx.URL(self.endpoint)
        if url.scheme not in ('http', 'https') or not url.host or url.userinfo:
            raise CloudKernelError('Cloud-Kernel URL must be HTTP(S), without embedded credentials')
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self.read_timeout, connect=5, pool=5),
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
                follow_redirects=False)
        return self._client

    async def aclose(self):
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _chunks(self, response):
        # Bound frames even if the peer never sends a delimiter. Incremental byte
        # decoding preserves multibyte tokens split across network packets.
        pending = bytearray()
        async for chunk in response.aiter_bytes():
            for part in chunk.splitlines(keepends=True):
                pending.extend(part)
                if len(pending) > self.max_frame_bytes:
                    raise CloudKernelError('Cloud-Kernel frame exceeds the size limit')
                if pending.endswith(b'\n'):
                    raw = bytes(pending).strip()
                    pending.clear()
                    frame = self._decode(raw)
                    if frame is not None:
                        yield frame
        if pending:
            frame = self._decode(bytes(pending).strip())
            if frame is not None:
                yield frame

    @staticmethod
    def _decode(raw):
        # NDJSON is the primary framing. Single-line SSE data also works.
        if not raw or raw.startswith((b':', b'event:', b'id:', b'retry:')):
            return None
        if raw.startswith(b'data:'):
            raw = raw[5:].strip()
        try:
            frame = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as error:
            raise CloudKernelError('Cloud-Kernel sent invalid JSON or UTF-8') from error
        if not isinstance(frame, dict):
            raise CloudKernelError('Cloud-Kernel chunk must be a JSON object')
        return frame

    async def events(self, params):
        client = self._connection()
        request_id = uuid4().hex
        current = dict(params)
        seen, last_index, lean = {}, 0, False
        headers = {'Accept': 'application/x-ndjson, text/event-stream',
                   'Content-Type': 'application/json'}
        if self.api_key:
            headers['Authorization'] = f'Bearer {self.api_key}'
        try:
            async with asyncio.timeout(self.total_timeout):
                for attempt in range(self.max_reconnects + 1):
                    body = {'jsonrpc': '2.0', 'id': request_id, 'method': 'fuse_and_generate',
                            'params': {**current, 'request_id': request_id, 'resume_from': last_index}}
                    try:
                        async with client.stream('POST', self.endpoint, headers=headers,
                                timeout=httpx.Timeout(self.read_timeout, connect=5, pool=5),
                                content=json.dumps(body, separators=(',', ':'), allow_nan=False).encode()) as response:
                            if response.status_code in (502, 503, 504):
                                raise httpx.ConnectError('Temporary Cloud-Kernel failure')
                            if response.status_code != 200:
                                raise CloudKernelError(f'Cloud-Kernel returned HTTP {response.status_code}')
                            async for frame in self._chunks(response):
                                if 'error' in frame or frame.get('event') == 'error':
                                    raise CloudKernelError('Cloud-Kernel reported an RPC or inference failure')
                                # Optional kernel audits retain the dashboard event contract.
                                if 'event' in frame:
                                    if frame['event'] in ('intent', 'complete', 'token', 'response', 'fused'):
                                        raise CloudKernelError('Reserved Cloud-Kernel event; use indexed token chunks')
                                    yield frame
                                    continue
                                index, token, done = frame.get('index'), frame.get('token'), frame.get('done')
                                if (isinstance(index, bool) or not isinstance(index, int) or index < 0
                                        or not isinstance(token, str) or not isinstance(done, bool)):
                                    raise CloudKernelError('Expected token, nonnegative integer index, and boolean done')
                                if index in seen:
                                    if seen[index] != token:
                                        raise CloudKernelError('Cloud-Kernel replay conflicts with previously streamed text')
                                elif token:
                                    if index != last_index + 1:
                                        raise CloudKernelError('Cloud-Kernel token indices must be contiguous and start at 1')
                                    seen[index] = token
                                    last_index = index
                                    if last_index > params['max_new_tokens']:
                                        raise CloudKernelError('Cloud-Kernel exceeded the requested token limit')
                                    yield {'event': 'token_delta', 'token': token, 'index': index}
                                elif not done or index != last_index:
                                    raise CloudKernelError('Empty token requires done=true and the last token index')
                                if done:
                                    if index != last_index:
                                        raise CloudKernelError('Cloud-Kernel completion index does not match the last token')
                                    yield {'event': 'cloud_complete', **frame}
                                    return
                            raise httpx.RemoteProtocolError('Stream ended without done=true')
                    except (httpx.TransportError, httpx.TimeoutException) as error:
                        if attempt == self.max_reconnects:
                            raise CloudKernelError('Cloud-Kernel reconnect attempts exhausted') from error
                        if isinstance(error, httpx.TimeoutException) and not lean:
                            lean = True
                            cap = min(math.fsum(current['weights']), self.lean_cap)
                            total = math.fsum(current['weights'])
                            current['weights'] = [value / total * cap if total else 0.0 for value in current['weights']]
                            current.update(fusion_mode='Lean-Fusion', network_cap=cap)
                        yield {'event': 'cloud_status', 'state': 'reconnecting',
                               'attempt': attempt + 1, 'resume_from': last_index,
                               'fusion_mode': current.get('fusion_mode', 'Ultra-Fusion'),
                               'weights': dict(zip(current['adapter_order'], current['weights'])),
                               'network_cap': current.get('network_cap', math.fsum(current['weights'])),
                               'reason': 'read timeout' if isinstance(error, httpx.TimeoutException) else 'connection interrupted'}
                        await asyncio.sleep(self.reconnect_delay * 2 ** attempt)
        except TimeoutError as error:
            raise CloudKernelError('Cloud-Kernel total request deadline exceeded') from error


class Orchestrator:
    def __init__(self, runtime=None, *, intent_orchestrator=None, cloud_client=None, endpoint=None):
        # A legacy runtime may provide Sifter/catalog metadata ONLY.
        self.runtime, self.intent_orchestrator = runtime, intent_orchestrator
        self.cloud = cloud_client if cloud_client is not None else CloudKernelClient(endpoint)
        self._classifier = None

    def _plan(self, prompt, weights, experts):
        if self.intent_orchestrator is not None:
            return self.intent_orchestrator.plan(prompt, weights, experts)
        if self.runtime is not None:
            return self.runtime.resolve_intent(prompt, weights, experts)
        from .intent import EXPERTS, IntentClassifier
        order = list(EXPERTS if experts is None else experts)
        if not order or any(not isinstance(name, str) or not name for name in order) or len(set(order)) != len(order):
            raise ValueError('Provide distinct nonempty adapter names')
        if weights is not None:
            if set(weights) != set(order):
                raise ValueError('Weights must contain exactly the selected adapters')
            values = [float(weights[name]) for name in order]
            return {'weights': dict(zip(order, values)), 'adapter_order': order,
                    'weight_vector': values, 'evidence': {}, 'excluded': {},
                    'active_experts': [name for name, value in zip(order, values) if value > 0],
                    'method': 'manual tensor coefficients'}
        if self._classifier is None:
            self._classifier = IntentClassifier()
        return self._classifier.classify(prompt, order)

    async def events(self, prompt, max_new_tokens=192, weights=None, experts=None, *, compare=False):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
            raise ValueError('Use a nonempty prompt of at most 8000 characters')
        if isinstance(max_new_tokens, bool) or not isinstance(max_new_tokens, int) or not 16 <= max_new_tokens <= 512:
            raise ValueError('Use between 16 and 512 new tokens')
        started = time.perf_counter()
        plan = await asyncio.to_thread(self._plan, prompt, weights, experts)
        order, vector = plan['adapter_order'], plan['weight_vector']
        if (not order or len(order) != len(vector) or len(set(order)) != len(order)
                or any(not math.isfinite(value) or value < 0 for value in vector)
                or math.fsum(vector) > 1 + 1e-5):
            raise ValueError('The Sifter must return a finite nonnegative ordered vector with total at most one')
        yield {'event': 'intent', **plan}
        params = {'prompt': prompt, 'weights': vector, 'adapter_order': order,
                  'max_new_tokens': max_new_tokens, 'stream': True, 'compare': compare}
        for key in ('network_cap', 'fusion_mode', 'network', 'ideal_weights'):
            if key in plan:
                params[key] = plan[key]
        text, tokens = '', 0
        async with aclosing(self.cloud.events(params)) as events:
            async for event in events:
                if event['event'] == 'token_delta':
                    text += event['token']; tokens = event['index']
                    yield {'event': 'token', 'text': text, 'delta': event['token'],
                           'token_index': tokens - 1, 'tokens': tokens,
                           'execution': {'location': 'cloud', 'transport': 'json-rpc'},
                           'generation_ms': (time.perf_counter() - started) * 1000,
                           'measurement': 'edge elapsed including intent, network, and cloud execution'}
                elif event['event'] == 'cloud_complete':
                    elapsed = (time.perf_counter() - started) * 1000
                    summary = {'event': 'fused' if compare else 'response', 'text': text,
                               'tokens': tokens, 'generation_ms': elapsed,
                               'execution': {'location': 'cloud', 'transport': 'json-rpc'},
                               'measurement': 'edge elapsed including intent, network, and cloud execution'}
                    if isinstance(event.get('usage'), dict):
                        summary['usage'] = event['usage']
                    yield summary
                    yield {'event': 'complete', 'execution': {'location': 'cloud', 'transport': 'json-rpc'}, 'edge_total_ms': elapsed,
                           'base_restored': event.get('base_restored', False),
                           'timing': event.get('timing')}
                else:
                    yield event

    async def aclose(self):
        await self.cloud.aclose()

    async def run(self, prompt, max_new_tokens=192, weights=None, experts=None):
        result = {}
        async with aclosing(self.events(prompt, max_new_tokens, weights, experts)) as events:
            async for event in events:
                result[event['event']] = {key: value for key, value in event.items() if key != 'event'}
        return {'text': result['response']['text'], **result}
