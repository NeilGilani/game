"""Local semantic intent routing and ordered, normalized fusion tensors."""
import math
import os
import re
from collections import OrderedDict
from threading import RLock
from pathlib import Path

import torch
import torch.nn.functional as F
from huggingface_hub import snapshot_download
from transformers import AutoModel, AutoTokenizer

MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2'
MODEL_REVISION = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41'

EXPERTS = ('coding', 'medical', 'legal')
FEATURES = {
 'coding': 'python code coding software function algorithm api json sql database program script encryption bug test audit log hardware technical firmware robot robotics constraints sensor latency safety interlock',
 'medical': 'medical patient prescription medication clinical health dosage dose treatment hospital diagnosis symptom consent trial blood insulin surgical surgery surgeon anatomy operating device clinical terminology',
 'legal': 'legal legally binding enforceability enforceable contract license liability privacy consent agreement clause compliance gdpr hipaa copyright rights breach retention indemnity obligation warranty jurisdiction termination',
}
SALIENCE = {
 'coding': {'python': 5, 'function': 5, 'json': 4, 'sql': 4, 'pseudocode': 5, 'code': 3},
 'medical': {'dosage': 3, 'dose': 3, 'diagnosis': 3, 'prescription': 3, 'surgical': 2, 'surgeon': 2},
 'legal': {'contract': 4, 'agreement': 4, 'clause': 3, 'license': 3, 'binding': 3, 'enforceability': 3, 'enforceable': 3, 'liability': 2},
}
STOP = set('qwen instruct lora model finetuned fine tuned text language expert assistant general driven new write draft style the for and with that using this in of a an to it but as by'.split())


def tokens(text):
    words = set(re.findall(r'[a-z]+', text.lower()))
    return words | {w[:-1] for w in words if len(w) > 4 and w.endswith('s')}


class KeywordIntentClassifier:
    """Transparent vocabulary coefficients with zero mass for irrelevant experts.

    A new prompt recomputes the whole vector. Unknown intent falls back to a
    mixture of the built-in experts. Language specialists require an explicit
    matching language; a generic word like "text" cannot activate Chinese LoRA.
    """
    def classify(self, prompt, experts=None, descriptions=None):
        experts = tuple(experts or EXPERTS)
        descriptions = descriptions or {}
        prompt_tokens = tokens(prompt)
        evidence, excluded, scores = {}, {}, {}
        for name in experts:
            description = descriptions.get(name, '').lower()
            vocabulary = tokens(FEATURES.get(name, description)) - STOP
            hits = sorted(prompt_tokens & vocabulary)
            language_gate = None
            for language, script in [('chinese', r'[\u4e00-\u9fff]'), ('japanese', r'[\u3040-\u30ff]'), ('korean', r'[\uac00-\ud7af]')]:
                if language in tokens(description) and language not in prompt_tokens and not re.search(script, prompt):
                    language_gate = f'{language.title()} expertise is not requested'
                    break
            if language_gate:
                evidence[name], excluded[name], scores[name] = [], language_gate, 0.0
            else:
                evidence[name] = hits
                scores[name] = float(sum(SALIENCE.get(name, {}).get(hit, 1) for hit in hits))
                if not hits: excluded[name] = 'No matching expertise signals'
        if not any(scores.values()):
            fallback = [name for name in experts if name in EXPERTS] or list(experts[:2])
            for name in fallback:
                scores[name] = .5
                excluded.pop(name, None)
        # Preserve a genuine multi-expert mixture if a single domain dominates.
        positive = [name for name in experts if scores[name] > 0]
        if len(positive) == 1:
            secondary = next((name for name in EXPERTS if name in experts and name != positive[0]), None)
            if secondary:
                scores[secondary] = .25
                excluded.pop(secondary, None)
        # Resource bound applies to participating adapters, not cloud inventory.
        active = sorted((name for name in experts if scores[name] > 0), key=lambda n: scores[n], reverse=True)
        for name in active[8:]:
            scores[name] = 0
            excluded[name] = 'Outside the eight-expert device budget'
        total = math.fsum(scores.values())
        return {'weights': {name: scores[name] / total for name in experts},
                'evidence': evidence, 'excluded': excluded,
                'active_experts': [name for name in experts if scores[name] > 0],
                'method': 'local intent-to-coefficient classifier; irrelevant adapters receive zero weight'}


# Several short prototypes avoid diluting an adapter's specialization in a long
# keyword list. Cloud experts use their own description, without retraining.
PROTOTYPES = {
    'coding': (
        'Write a Python function, implement an algorithm, debug code and test software.',
        'Build an API, SQL database, JSON validator or automated computer program.',
        'Design firmware, robotics software and technical systems.',
        'Debug a broken loop, sort collections, fix errors and optimize an algorithm.',
        'Write a Python function that validates records and checks rules.',
    ),
    'medical': (
        'Explain symptoms, diagnosis, medication doses and treatment of a patient.',
        'Discuss clinical trials, hospital care, surgery and informed patient consent.',
        'Explain anatomy, health conditions and medical terminology.',
    ),
    'legal': (
        'Draft a legally binding contract, software license or agreement with liability clauses.',
        'Analyze privacy laws, compliance obligations, rights and enforceability.',
        'Explain jurisdiction, indemnity, copyright, warranties and termination of a contract.',
    ),
}


class LocalSentenceEncoder:
    """Frozen MiniLM with masked mean pooling, loaded only from local files.

    Long prompts are encoded in 254-wordpiece chunks and pooled by token count
    so trailing intent is not silently truncated. Each forward is bounded.
    """
    def __init__(self, model_path=None, device='cpu'):
        self.model_path = model_path or os.getenv('SYNAPSE_INTENT_MODEL', MODEL_ID)
        self.device = torch.device(device)
        self.tokenizer = self.model = None

    def _load(self):
        if self.model is not None:
            return
        kwargs = {'local_files_only': True, 'trust_remote_code': False}
        try:
            # Resolve Hub IDs to a filesystem path first. Transformers' PEFT
            # detection can otherwise attempt an adapter lookup on the network.
            local_path = self.model_path
            if not Path(local_path).is_dir():
                local_path = snapshot_download(local_path, local_files_only=True,
                                               revision=MODEL_REVISION if local_path == MODEL_ID else None)
            tokenizer = AutoTokenizer.from_pretrained(local_path, **kwargs)
            model = AutoModel.from_pretrained(local_path, use_safetensors=True, **kwargs)
        except OSError as error:
            raise RuntimeError('Local intent model is unavailable. Run .venv/bin/python '
                               'scripts/setup_intent_model.py from the project root, or set '
                               'SYNAPSE_INTENT_MODEL to a local MiniLM snapshot.') from error
        self.tokenizer = tokenizer
        self.model = model.to(self.device).eval().requires_grad_(False)

    @torch.inference_mode()
    def encode(self, texts):
        self._load()
        vectors = []
        for text in texts:
            ids = self.tokenizer.encode(text, add_special_tokens=False)
            chunk_size = 256 - self.tokenizer.num_special_tokens_to_add(pair=False)
            chunks = [ids[i:i + chunk_size] for i in range(0, len(ids), chunk_size)] or [[]]
            pooled, counts = [], []
            for start in range(0, len(chunks), 16):
                group = chunks[start:start + 16]
                features = [{'input_ids': self.tokenizer.build_inputs_with_special_tokens(chunk)} for chunk in group]
                batch = self.tokenizer.pad(features, padding=True, return_tensors='pt').to(self.device)
                hidden = self.model(**batch).last_hidden_state.float()
                mask = batch['attention_mask'].unsqueeze(-1).float()
                pooled.append((hidden * mask).sum(1) / mask.sum(1).clamp_min(1))
                counts.extend(max(len(chunk), 1) for chunk in group)
            weights = torch.tensor(counts, dtype=torch.float32, device=self.device)
            vector = (torch.cat(pooled) * weights[:, None]).sum(0) / weights.sum()
            vectors.append(F.normalize(vector, dim=0))
        return torch.stack(vectors).cpu()


class IntentClassifier:
    """Cosine prototype scores -> masked softmax -> float32 simplex tensor.

    These are routing coefficients, not calibrated probabilities of expertise.
    Keyword overlap is diagnostic evidence only; it does not set the scores.
    A lock protects lazy initialization and a bounded prototype embedding cache.
    """
    def __init__(self, *, encoder=None, temperature=0.1, min_similarity=0.2,
                 max_active=8):
        if not math.isfinite(temperature) or temperature <= 0:
            raise ValueError('temperature must be finite and positive')
        if not math.isfinite(min_similarity) or not -1 <= min_similarity <= 1:
            raise ValueError('min_similarity must be in [-1, 1]')
        if not isinstance(max_active, int) or isinstance(max_active, bool) or max_active < 1:
            raise ValueError('max_active must be a positive integer')
        self.encoder = encoder if encoder is not None else LocalSentenceEncoder()
        self.temperature, self.min_similarity, self.max_active = temperature, min_similarity, max_active
        self._cache = OrderedDict()
        self._lock = RLock()

    def _classify(self, prompt, experts, descriptions):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
            raise ValueError('prompt must contain 1–8000 characters and non-whitespace text')
        if isinstance(experts, str):
            raise ValueError('experts must be an ordered sequence of adapter names')
        experts = tuple(EXPERTS if experts is None else experts)
        if not experts or any(not isinstance(name, str) or not name.strip() for name in experts):
            raise ValueError('experts must contain nonempty adapter names')
        if len(set(experts)) != len(experts):
            raise ValueError('experts must be distinct and ordered')
        descriptions = {} if descriptions is None else descriptions
        if not isinstance(descriptions, dict):
            raise ValueError('descriptions must map adapter names to expertise strings')
        prompt_tokens = tokens(prompt)
        evidence, excluded, prototypes = {}, {}, []
        for name in experts:
            description = descriptions.get(name, '')
            if not isinstance(description, str):
                raise ValueError('adapter descriptions must be strings')
            texts = (description.strip(),) if description.strip() else PROTOTYPES.get(name)
            if not texts:
                raise ValueError(f'Provide an expertise description for adapter {name!r}')
            prototypes.append(texts)
            vocabulary = tokens(FEATURES.get(name, description)) - STOP
            evidence[name] = sorted(prompt_tokens & vocabulary)
            for language, script in [('chinese', r'[\u4e00-\u9fff]'), ('japanese', r'[\u3040-\u30ff]'), ('korean', r'[\uac00-\ud7af]')]:
                if language in tokens(description) and language not in prompt_tokens and not re.search(script, prompt):
                    excluded[name] = f'{language.title()} expertise is not requested'
                    break
        if len(excluded) == len(experts):
            raise ValueError('No eligible adapters for the requested language')
        with self._lock, torch.inference_mode():
            query = F.normalize(self.encoder.encode([prompt]).float(), dim=-1)[0]
            scores = []
            for texts in prototypes:
                if texts not in self._cache:
                    self._cache[texts] = F.normalize(self.encoder.encode(list(texts)).float(), dim=-1)
                self._cache.move_to_end(texts)
                scores.append((self._cache[texts] @ query).max())
                while len(self._cache) > 128:
                    self._cache.popitem(last=False)
            scores = torch.stack(scores)
            if not torch.isfinite(scores).all():
                raise ValueError('encoder returned non-finite similarity scores')
            eligible = torch.tensor([name not in excluded for name in experts])
            fallback = scores[eligible].max().item() < self.min_similarity
            if not fallback:
                for index, name in enumerate(experts):
                    if eligible[index] and scores[index].item() < self.min_similarity:
                        eligible[index] = False
                        excluded[name] = 'Below the semantic similarity threshold'
            logits = torch.zeros_like(scores) if fallback else scores / self.temperature
            logits = logits.masked_fill(~eligible, -torch.inf)
            # Stable sorting resolves equal-score budget ties in caller order.
            ranked = torch.argsort(logits, descending=True, stable=True)
            for index in ranked[self.max_active:].tolist():
                if eligible[index]:
                    excluded[experts[index]] = 'Outside the eight-expert device budget' if self.max_active == 8 else 'Outside the active-adapter budget'
                    logits[index] = -torch.inf
            vector = torch.softmax(logits, dim=0).to(torch.float32).contiguous()
        return experts, vector, scores, evidence, excluded, fallback

    def classify_tensor(self, prompt, experts=None, descriptions=None, *, device='cpu'):
        """Return shape [N], ordered exactly as experts, with no rounded values."""
        return self._classify(prompt, experts, descriptions)[1].to(device)

    def classify(self, prompt, experts=None, descriptions=None):
        experts, vector, scores, evidence, excluded, fallback = self._classify(prompt, experts, descriptions)
        values = vector.tolist()
        return {'weights': dict(zip(experts, values)), 'adapter_order': list(experts),
                'weight_vector': values, 'tensor_dtype': 'float32', 'tensor_shape': [len(experts)],
                'scores': dict(zip(experts, scores.tolist())), 'temperature': self.temperature,
                'fallback': fallback, 'evidence': evidence, 'excluded': excluded,
                'active_experts': [name for name, value in zip(experts, values) if value > 0],
                'method': 'local MiniLM semantic prototypes + masked softmax'}


def main():
    """Classify without loading the generation model or adapter factor files."""
    import argparse
    import json

    parser = argparse.ArgumentParser(description='Local semantic intent -> normalized adapter weights')
    parser.add_argument('prompt')
    parser.add_argument('--experts', nargs='+', default=list(EXPERTS))
    parser.add_argument('--descriptions', type=json.loads, default={},
                        help='JSON object mapping custom adapter names to expertise descriptions')
    parser.add_argument('--temperature', type=float, default=0.1)
    args = parser.parse_args()
    try:
        result = IntentClassifier(temperature=args.temperature).classify(args.prompt, args.experts, args.descriptions)
    except (ValueError, RuntimeError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
