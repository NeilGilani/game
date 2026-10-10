"""Remote contract, live delivery, replay safety, timeouts, and cancellation."""
import asyncio
from contextlib import aclosing
import json
import httpx
import pytest
from synapse_mesh.orchestrator import CloudKernelClient, CloudKernelError, Orchestrator


class SifterOnly:
    def resolve_intent(self, prompt, weights, experts):
        order = ['coding', 'legal']
        weights = weights or {'coding': .7, 'legal': .3}
        return {'weights': weights, 'adapter_order': order,
                'weight_vector': [weights[name] for name in order],
                'evidence': {}, 'active_experts': order, 'excluded': {}}
    def __getattr__(self, name):
        raise AssertionError(f'Edge attempted local runtime operation: {name}')


class Stream(httpx.AsyncByteStream):
    def __init__(self, frames=(), *, failure=None, entered=None, release=None):
        self.frames, self.failure = frames, failure
        self.entered, self.release, self.closed = entered, release, False
    async def __aiter__(self):
        for frame in self.frames:
            yield frame if isinstance(frame, bytes) else json.dumps(frame, ensure_ascii=False).encode() + b'\n'
        if self.entered: self.entered.set()
        if self.release: await self.release.wait()
        if self.failure: raise self.failure
    async def aclose(self): self.closed = True


def chunk(token, index, done=False):
    return {'token': token, 'index': index, 'done': done}


async def collect(stream):
    async with aclosing(stream):
        return [event async for event in stream]


def test_remote_payload_and_no_local_tensor_operations():
    async def run():
        requests = []
        def handle(request):
            requests.append(json.loads(request.content))
            return httpx.Response(200, stream=Stream([chunk('Hello', 1), chunk(' world', 2, True)]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            edge = Orchestrator(SifterOnly(), cloud_client=CloudKernelClient('https://kernel.example/rpc', client=client))
            result = await edge.run('Python license', 16)
            assert result['text'] == 'Hello world'
            assert result['response']['execution']['location'] == 'cloud'
            assert result['complete']['timing'] is None and result['complete']['base_restored'] is False
        body = requests[0]
        assert body['method'] == 'fuse_and_generate' and body['jsonrpc'] == '2.0'
        assert body['params']['prompt'] == 'Python license'
        assert body['params']['weights'] == [.7, .3]
        assert body['params']['adapter_order'] == ['coding', 'legal']
        assert body['params']['request_id'] == body['id'] and body['params']['resume_from'] == 0
    asyncio.run(run())


def test_first_token_is_live_and_early_close_cancels_read():
    async def run():
        remote = Stream([chunk('First', 1)], release=asyncio.Event())
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=remote))) as client:
            events = Orchestrator(SifterOnly(), cloud_client=CloudKernelClient('http://kernel.example', client=client)).events('license', 16)
            assert (await anext(events))['event'] == 'intent'
            async with asyncio.timeout(1): assert (await anext(events))['text'] == 'First'
            await events.aclose()
            assert remote.closed and not remote.release.is_set()
    asyncio.run(run())


@pytest.mark.parametrize('timeout', [False, True])
def test_reconnect_resume_deduplication_and_lean_trigger(timeout):
    async def run():
        requests, streams = [], []
        def handle(request):
            requests.append(json.loads(request.content))
            stream = (Stream([chunk('A', 1)], failure=httpx.ReadTimeout('slow') if timeout else httpx.ReadError('lost'))
                      if len(requests) == 1 else Stream([chunk('A', 1), chunk('B', 2, True)]))
            streams.append(stream)
            return httpx.Response(200, stream=stream)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            cloud = CloudKernelClient('http://kernel.example', client=client, reconnect_delay=0)
            events = await collect(Orchestrator(SifterOnly(), cloud_client=cloud).events('license', 16))
        assert [e['delta'] for e in events if e['event'] == 'token'] == ['A', 'B']
        assert requests[0]['id'] == requests[1]['id'] and requests[1]['params']['resume_from'] == 1
        assert all(stream.closed for stream in streams)
        if timeout:
            assert requests[1]['params']['weights'] == pytest.approx([.28, .12])
            assert requests[1]['params']['network_cap'] == .4
            assert next(e for e in events if e['event'] == 'cloud_status')['fusion_mode'] == 'Lean-Fusion'
    asyncio.run(run())


@pytest.mark.parametrize('frames,message', [
    ([chunk('bad index', 2)], 'contiguous'),
    ([{'token': 'x', 'index': True, 'done': False}], 'Expected token'),
    ([b'not json\n'], 'invalid JSON'),
    ([{'error': {'code': -32000, 'message': 'secret'}}], 'RPC or inference'),
])
def test_protocol_failures_are_not_retried(frames, message):
    async def run():
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(200, stream=Stream(frames))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            cloud = CloudKernelClient('http://kernel.example', client=client, reconnect_delay=0)
            with pytest.raises(CloudKernelError, match=message):
                await collect(Orchestrator(SifterOnly(), cloud_client=cloud).events('license', 16))
        assert len(calls) == 1
    asyncio.run(run())


def test_conflicting_replay_is_rejected():
    async def run():
        calls = []
        def handle(request):
            calls.append(request)
            return httpx.Response(200, stream=Stream([chunk('A', 1)] if len(calls) == 1 else [chunk('different', 1, True)]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            cloud = CloudKernelClient('http://kernel.example', client=client, reconnect_delay=0)
            with pytest.raises(CloudKernelError, match='replay conflicts'):
                await collect(Orchestrator(SifterOnly(), cloud_client=cloud).events('license', 16))
    asyncio.run(run())


@pytest.mark.parametrize('cancel', [False, True])
def test_deadline_and_task_cancellation_close_cloud_stream(cancel):
    async def run():
        entered = asyncio.Event()
        stream = Stream(entered=entered, release=asyncio.Event())
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, stream=stream))) as client:
            cloud = CloudKernelClient('http://kernel.example', client=client, total_timeout=.05 if not cancel else 5)
            task = asyncio.create_task(Orchestrator(SifterOnly(), cloud_client=cloud).run('license', 16))
            await entered.wait()
            if cancel: task.cancel()
            with pytest.raises(asyncio.CancelledError if cancel else CloudKernelError): await task
            assert stream.closed
    asyncio.run(run())


def test_fragmented_unicode_sse_and_auth():
    async def run():
        raw = b'data: ' + json.dumps(chunk('你好', 1, True), ensure_ascii=False).encode() + b'\n\n'
        def handle(request):
            assert request.headers['Authorization'] == 'Bearer test-key'
            return httpx.Response(200, stream=Stream([raw[i:i+1] for i in range(len(raw))]))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            result = await Orchestrator(SifterOnly(), cloud_client=CloudKernelClient('https://kernel.example', client=client, api_key='test-key')).run('license', 16)
            assert result['text'] == '你好'
    asyncio.run(run())


def test_missing_endpoint_never_falls_back_to_local_generation(monkeypatch):
    monkeypatch.delenv('SYNAPSE_CLOUD_KERNEL_URL', raising=False)
    with pytest.raises(CloudKernelError, match='SYNAPSE_CLOUD_KERNEL_URL'):
        asyncio.run(Orchestrator(SifterOnly()).run('license', 16))


def test_edge_api_streams_cloud_tokens_without_preloading_generalist(monkeypatch):
    from fastapi.testclient import TestClient
    from synapse_mesh import api
    cloud = CloudKernelClient('https://kernel.example', client=httpx.AsyncClient(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, stream=Stream([chunk('remote', 1), chunk(' answer', 2, True)])))))
    monkeypatch.setattr(api, 'orchestrator', Orchestrator(SifterOnly(), cloud_client=cloud))
    def forbidden(): raise AssertionError('Edge must not preload LoRA matrices')
    monkeypatch.setattr(api.runtime, 'pre_cache_generalist', forbidden)
    with TestClient(api.app) as client:
        result = client.post('/compare', json={'prompt': 'license', 'max_new_tokens': 16})
    events = [json.loads(line) for line in result.text.splitlines()]
    assert [e['event'] for e in events] == ['intent', 'token', 'token', 'fused', 'complete']
    assert events[-2]['text'] == 'remote answer'
    asyncio.run(cloud._client.aclose())


def test_real_tcp_stream_delivers_token_before_server_completes():
    async def run():
        release = asyncio.Event()
        received = []
        async def serve(reader, writer):
            headers = await reader.readuntil(b'\r\n\r\n')
            length = next(int(line.split(b':', 1)[1]) for line in headers.split(b'\r\n') if line.lower().startswith(b'content-length:'))
            received.append(json.loads(await reader.readexactly(length)))
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n')
            async def send(frame):
                data = json.dumps(frame).encode() + b'\n'
                writer.write(f'{len(data):x}\r\n'.encode() + data + b'\r\n')
                await writer.drain()
            await send(chunk('first', 1))
            await release.wait()
            await send(chunk(' second', 2, True))
            writer.write(b'0\r\n\r\n')
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_server(serve, '127.0.0.1', 0)
        port = server.sockets[0].getsockname()[1]
        edge = Orchestrator(SifterOnly(), endpoint=f'http://127.0.0.1:{port}')
        try:
            async with server, aclosing(edge.events('license', 16)) as events:
                assert (await anext(events))['event'] == 'intent'
                async with asyncio.timeout(2):
                    assert (await anext(events))['text'] == 'first'
                assert not release.is_set()
                release.set()
                rest = [event async for event in events]
                assert rest[-2]['text'] == 'first second'
                assert rest[-1]['event'] == 'complete'
                assert received[0]['method'] == 'fuse_and_generate'
        finally:
            release.set()
            await edge.aclose()
    asyncio.run(run())
