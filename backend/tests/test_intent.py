"""Numerical contract tests plus real, offline MiniLM semantic smoke cases."""
import math
from concurrent.futures import ThreadPoolExecutor

import pytest
import torch

from synapse_mesh.intent import IntentClassifier, LocalSentenceEncoder, PROTOTYPES


class Encoder:
    def __init__(self):
        self.calls = []
        self.vectors = {'mixed': [0.7, 0.2, 0.1], 'unknown': [-1, -1, -1],
                        'accounting': [0, 1, 0], 'Chinese correction': [0, 0, 1]}
        for i, name in enumerate(PROTOTYPES):
            for text in PROTOTYPES[name]:
                self.vectors[text] = torch.eye(3)[i].tolist()

    def encode(self, texts):
        self.calls.append(tuple(texts))
        return torch.tensor([self.vectors[text] for text in texts], dtype=torch.float32)


def test_exact_softmax_order_tensor_and_json_contract():
    classifier = IntentClassifier(encoder=Encoder(), temperature=0.2, min_similarity=-1)
    names = ['legal', 'coding', 'medical']
    vector = classifier.classify_tensor('mixed', names)
    expected = torch.softmax(torch.nn.functional.normalize(torch.tensor([.1, .7, .2]), dim=0) / .2, dim=0)
    torch.testing.assert_close(vector, expected)
    assert vector.dtype == torch.float32 and vector.shape == (3,)
    assert vector.is_contiguous() and not vector.requires_grad
    assert torch.isfinite(vector).all() and (vector >= 0).all()
    assert vector.sum().item() == pytest.approx(1, abs=1e-6)
    result = classifier.classify('mixed', names)
    assert result['adapter_order'] == names
    assert result['weight_vector'] == vector.tolist()
    assert list(result['weights'].values()) == vector.tolist()
    # A downstream linear combination uses the exact coefficients and order.
    deltas = torch.arange(12, dtype=torch.float32).reshape(3, 2, 2)
    torch.testing.assert_close(torch.einsum('i,ijk->jk', vector, deltas),
                               sum(vector[i] * deltas[i] for i in range(3)))


def test_custom_descriptions_masks_budget_and_fallback():
    classifier = IntentClassifier(encoder=Encoder(), max_active=2)
    result = classifier.classify('mixed', ['coding', 'finance', 'chinese'],
                                 {'finance': 'accounting', 'chinese': 'Chinese correction'})
    assert result['weight_vector'][2] == 0
    assert result['active_experts'] == ['coding', 'finance']
    result = classifier.classify('unknown')
    assert result['fallback']
    assert result['weight_vector'] == [.5, .5, 0]
    assert 'legal' in result['excluded']
    with pytest.raises(ValueError, match='No eligible'):
        classifier.classify('mixed', ['chinese'], {'chinese': 'Chinese correction'})


def test_cache_recomputes_prompts_and_handles_concurrent_calls():
    encoder = Encoder()
    classifier = IntentClassifier(encoder=encoder)
    first = classifier.classify_tensor('mixed')
    second = classifier.classify_tensor('unknown')
    assert not torch.equal(first, second)
    assert len(encoder.calls) == 5  # two prompts, three cached prototype sets
    with ThreadPoolExecutor(max_workers=4) as pool:
        outputs = list(pool.map(classifier.classify_tensor, ['mixed'] * 8))
    for vector in outputs:
        torch.testing.assert_close(vector, first, rtol=0, atol=0)


@pytest.mark.parametrize('prompt,names,descriptions', [
    ('', None, None), ('   ', None, None), ('x' * 8001, None, None),
    ('mixed', [], None), ('mixed', ['coding', 'coding'], None),
    ('mixed', [''], None), ('mixed', ['new'], None),
    ('mixed', ['coding'], {'coding': 1}),
    ('mixed', 'coding', None), ('mixed', ['coding'], []),
])
def test_invalid_inputs(prompt, names, descriptions):
    with pytest.raises(ValueError):
        IntentClassifier(encoder=Encoder()).classify_tensor(prompt, names, descriptions)


@pytest.mark.parametrize('temperature', [0, -1, math.inf, math.nan])
def test_invalid_temperature(temperature):
    with pytest.raises(ValueError):
        IntentClassifier(temperature=temperature)


def test_nonfinite_encoder_is_rejected():
    encoder = Encoder()
    encoder.vectors['mixed'] = [math.nan, 0, 1]
    with pytest.raises(ValueError, match='non-finite'):
        IntentClassifier(encoder=encoder).classify_tensor('mixed')


@pytest.fixture(scope='module')
def local_classifier():
    encoder = LocalSentenceEncoder()
    try:
        encoder._load()
    except RuntimeError:
        pytest.skip('Run scripts/setup_intent_model.py for offline semantic smoke tests')
    return IntentClassifier(encoder=encoder)


@pytest.mark.parametrize('prompt,expected', [
    ('Fix a broken loop and sort a collection efficiently', 'coding'),
    ('Explain why someone is wheezing and how inhalers help', 'medical'),
    ('Draft terms governing ownership and dispute resolution', 'legal'),
])
def test_real_semantic_routing_without_keyword_overlap(local_classifier, prompt, expected):
    result = local_classifier.classify(prompt)
    assert result['evidence'][expected] == []
    assert max(result['weights'], key=result['weights'].get) == expected
    assert not result['fallback']


def test_real_encoder_retains_trailing_chunks(local_classifier):
    encoder = local_classifier.encoder
    prefix = 'A simple repeated sentence. ' * 70
    one = encoder.encode([prefix])[0]
    two = encoder.encode([prefix + 'Explain symptoms and medication treatment of patients. ' * 70])[0]
    assert not torch.allclose(one, two, atol=1e-3)
    assert two.norm().item() == pytest.approx(1, abs=1e-6)
    assert not encoder.model.training
    assert all(not p.requires_grad for p in encoder.model.parameters())


def test_real_model_load_and_inference_make_no_network_calls(local_classifier, monkeypatch):
    def deny(*args, **kwargs):
        pytest.fail('Intent inference attempted a network request')
    monkeypatch.setattr('requests.sessions.Session.request', deny)
    classifier = IntentClassifier()
    assert classifier.classify_tensor('Write Python code').sum().item() == pytest.approx(1, abs=1e-6)
