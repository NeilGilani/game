import json

from fastapi.testclient import TestClient

from synapse_mesh.api import app

client = TestClient(app)


def test_health_and_proof():
    health = client.get('/health').json()
    assert [v['name'] for v in health['vault'][:3]] == ['coding', 'medical', 'legal']
    assert len(client.get('/proof').json()) == 5


def test_bad_request_and_invalid_manual_mixture():
    assert client.post('/compare', json={'prompt': ''}).status_code == 422
    response = client.post('/compare', json={'prompt': 'test', 'weights': {'coding': 1}})
    events = [json.loads(line) for line in response.text.splitlines()]
    assert events[-1]['event'] == 'error'
    assert 'exactly' in events[-1]['message']


def test_intent_endpoint():
    r = client.post('/intent', json={'prompt': 'Python legal clinical trial'})
    assert r.status_code == 200
    assert {'coding', 'medical', 'legal'} <= set(r.json()['weights'])
    result = r.json()
    assert result['weight_vector'] == [result['weights'][name] for name in result['adapter_order']]
    assert result['tensor_dtype'] == 'float32'
    assert result['tensor_shape'] == [len(result['adapter_order'])]
    manual_scope = client.post('/intent', json={'prompt': 'Python legal clinical trial', 'experts': ['coding', 'medical', 'legal']})
    assert set(manual_scope.json()['weights']) == {'coding', 'medical', 'legal'}


def test_websocket_live_vectors_and_manual_updates():
    with client.websocket_connect('/ws/weights') as socket:
        assert socket.receive_json()['event'] == 'ready'
        for request_id, prompt in enumerate(['Write a Python validator', 'Explain clinical consent and legal obligations'], 1):
            socket.send_json({'prompt': prompt, 'request_id': request_id})
            result = socket.receive_json()
            assert result['event'] == 'weights'
            assert result['request_id'] == request_id
            assert result['weights'] == client.post('/intent', json={'prompt': prompt}).json()['weights']
            assert abs(sum(result['weights'].values()) - 1) < 1e-6
        socket.send_json({'prompt': 'test', 'request_id': 3, 'experts': ['coding', 'medical', 'legal'],
                          'weights': {'coding': .7, 'medical': .3, 'legal': 0}})
        result = socket.receive_json()
        assert result['active_experts'] == ['coding', 'medical']
        assert result['excluded']['legal'] == 'Zero manual coefficient'
        assert result['weight_vector'] == [.7, .3, 0]


def test_websocket_rejects_bad_vectors_and_keeps_connection():
    with client.websocket_connect('/ws/weights') as socket:
        socket.receive_json()
        for body in [{'prompt': ''}, {'prompt': 'test', 'weights': {'coding': -1}},
                     {'prompt': 'test', 'experts': ['unknown', 'coding']}]:
            socket.send_json(body)
            assert socket.receive_json()['event'] == 'error'
        socket.send_text('not json')
        assert socket.receive_json()['event'] == 'error'
        socket.send_json({'prompt': 'Python code', 'request_id': 9})
        assert socket.receive_json()['request_id'] == 9


def test_intent_unavailable_model_and_blank_prompt(monkeypatch):
    assert client.post('/intent', json={'prompt': '   '}).status_code == 422
    def unavailable(*args, **kwargs):
        raise RuntimeError('Local intent model is unavailable')
    monkeypatch.setattr('synapse_mesh.api.runtime.classifier.classify', unavailable)
    assert client.post('/intent', json={'prompt': 'Python'}).status_code == 503


def test_manual_weights_bypass_unavailable_sifter(monkeypatch):
    def unavailable(*args, **kwargs):
        raise RuntimeError('Local intent model is unavailable')
    monkeypatch.setattr('synapse_mesh.api.runtime.classifier.classify', unavailable)
    body = {'prompt': 'Python clinical consent', 'experts': ['coding', 'medical', 'legal'],
            'weights': {'coding': .6, 'medical': .4, 'legal': 0}}
    result = client.post('/intent', json=body)
    assert result.status_code == 200
    assert result.json()['weights'] == body['weights']
    assert result.json()['weight_vector'] == [.6, .4, 0]
    with client.websocket_connect('/ws/weights') as socket:
        socket.receive_json()
        socket.send_json({**body, 'request_id': 42})
        frame = socket.receive_json()
        assert frame['event'] == 'weights' and frame['request_id'] == 42
        assert frame['weights'] == body['weights']
