import json
import os
from pathlib import Path
from threading import Lock, RLock
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from .intent import EXPERTS, IntentClassifier
from .catalog import CloudCatalog
from .tensor_utils import synchronize, validate_weights, validate_coefficients
from .tensor_fusion import AdapterTensorStore, fuse_weights, restore_weights
from .tensor_fusion import Pair
from .catalog import validate_config
from safetensors import safe_open

ROOT = Path(__file__).resolve().parents[2]
BASE_MODEL = 'Qwen/Qwen2.5-1.5B-Instruct'
DEFAULT_VAULT = ROOT / 'vault-1.5b'


def select_device(requested='auto'):
    if requested == 'auto':
        return 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
    if requested == 'cuda' and not torch.cuda.is_available(): raise ValueError('CUDA is unavailable')
    if requested == 'mps' and not torch.backends.mps.is_available(): raise ValueError('Metal GPU is unavailable')
    if requested not in ('cpu', 'mps', 'cuda'): raise ValueError('device must be auto, cpu, mps, or cuda')
    return requested


class Runtime:
    def __init__(self, vault=None, base_model=None, device='auto'):
        self.vault = Path(vault or os.getenv('SYNAPSE_VAULT', DEFAULT_VAULT)).expanduser().resolve()
        self.base_model = base_model or os.getenv('SYNAPSE_BASE_MODEL', BASE_MODEL)
        self.device = select_device(device)
        self.classifier = IntentClassifier()
        self.catalog = CloudCatalog(self.vault, self.base_model)
        self.lock = Lock()
        self.model = self.tokenizer = None
        self.tensor_store = AdapterTensorStore()
        self.loaded_experts = ()
        self.last_audit = None
        self.revision = None
        self.generalist_path = Path(os.getenv('SYNAPSE_GENERALIST_PATH', self.vault / 'generalist')).expanduser().resolve()
        self.generalist_ready = False
        self._generalist_lock = RLock()
        self._generalist_factors = ()

    def adapter_paths(self):
        return {**self.catalog.adapter_paths(EXPERTS), 'generalist': str(self.generalist_path)}

    def base_adapter_config(self):
        for path in (self.vault / 'coding/adapter_config.json', self.generalist_path / 'adapter_config.json'):
            if path.is_file():
                return json.loads(path.read_text())
        raise RuntimeError('A local adapter configuration is required to identify the pinned base checkpoint')

    def pre_cache_generalist(self):
        """Pin real generalist factors in local RAM without a model/API download."""
        with self._generalist_lock:
            if self.generalist_ready:
                return
            status = self.catalog.file_status(self.generalist_path)
            if not status['available']:
                raise RuntimeError('Safe-Mode needs a local generalist adapter; run scripts/train_generalist.py')
            config = json.loads(Path(status['config_path']).read_text())
            base_config = self.base_adapter_config()
            validate_config(config, self.base_model, base_config.get('revision'))
            filename = status['weights_path']
            dtype = torch.bfloat16 if self.device == 'cuda' and torch.cuda.is_bf16_supported() else torch.float16
            factors, consumed = [], set()
            with safe_open(filename, framework='pt', device='cpu') as reader:
                keys = set(reader.keys())
                for key in sorted(keys):
                    if not key.endswith('.lora_A.weight'):
                        continue
                    b_key = key.replace('.lora_A.', '.lora_B.')
                    if b_key not in keys:
                        raise RuntimeError('Generalist is missing a B factor')
                    pair = Pair(key.removesuffix('.lora_A.weight').removeprefix('base_model.model.'), key, b_key, 1)
                    a, b = self.tensor_store.factors(reader, filename, pair, dtype, 'cpu')
                    if a.ndim != 2 or b.ndim != 2 or a.shape[0] != b.shape[1]:
                        raise RuntimeError('Generalist has invalid factor shapes')
                    factors.append((a, b)); consumed.update((key, b_key))
                if not factors or consumed != keys or not any(torch.count_nonzero(b) for _, b in factors):
                    raise RuntimeError('Generalist must contain complete, trained, nonzero LoRA factor pairs')
            self._generalist_factors = tuple(factors)
            self.generalist_ready = True

    def vault_status(self):
        paths = self.adapter_paths()
        local = []
        for name in EXPERTS:
            status = self.catalog.file_status(paths[name])
            metadata = None
            config = Path(status['config_path'])
            training = Path(status['path']) / 'training.json'
            if config.is_file():
                metadata = {'rank': json.loads(config.read_text()).get('r')}
            if training.is_file():
                metadata = {**(metadata or {}), **json.loads(training.read_text())}
            local.append({'name': name, 'label': {'coding': 'Code', 'medical': 'Clinical', 'legal': 'Legal'}[name],
                          'source': 'local', **status, 'loaded': name in self.loaded_experts,
                          'metadata': metadata})
        generalist = {'name': 'generalist', 'label': 'Generalist', 'source': 'local',
                      **self.catalog.file_status(self.generalist_path), 'loaded': self.generalist_ready,
                      'reserved_for_safe_mode': True, 'expertise': 'Locally trained mixed Code / Clinical / Legal fallback',
                      'metadata': json.loads((self.generalist_path / 'training.json').read_text()) if (self.generalist_path / 'training.json').is_file() else None}
        return local + [{'name': name, 'label': item['label'], 'source': 'huggingface',
                         'repo_id': item['repo_id'], 'expertise': item['expertise'],
                         **self.catalog.file_status(paths[name]),
                         'loaded': name in self.loaded_experts, 'metadata': item}
                        for name, item in self.catalog.installed().items()] + [generalist]

    def selected_experts(self, experts=None):
        selected = tuple(experts if experts is not None else (name for name in self.adapter_paths() if name != 'generalist'))
        if len(selected) < 1 or len(set(selected)) != len(selected) or (experts is not None and len(selected) > 8):
            raise ValueError('Select 1–8 distinct adapters')
        if not set(selected) <= self.adapter_paths().keys():
            raise ValueError('Unknown adapter; install it from the cloud library first')
        return selected

    def classify(self, prompt, experts=None):
        selected = self.selected_experts(experts)
        if 'generalist' in selected:
            raise ValueError('Generalist is reserved for network-controlled Safe-Mode')
        descriptions = {name: item['expertise'] for name, item in self.catalog.installed().items()}
        return self.classifier.classify(prompt, selected, descriptions)

    def resolve_intent(self, prompt, weights=None, experts=None):
        """Use manual coefficients without loading or invoking the Sifter."""
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
            raise ValueError('Use a nonempty prompt of at most 8000 characters')
        if weights is None:
            return self.classify(prompt, experts)
        selected = self.selected_experts(experts)
        values = validate_weights(weights, selected)
        return {'weights': values, 'evidence': {},
                'active_experts': [name for name, value in values.items() if value > 0],
                'excluded': {name: 'Zero manual coefficient' for name, value in values.items() if value == 0},
                'method': 'manual tensor coefficients', 'adapter_order': list(selected),
                'weight_vector': [values[name] for name in selected],
                'tensor_dtype': 'float32', 'tensor_shape': [len(selected)]}

    def load(self, experts=None):
        if self.model is not None: return
        config = self.base_adapter_config()
        self.revision = config.get('revision')
        tokenizer = AutoTokenizer.from_pretrained(self.base_model, revision=self.revision, local_files_only=True)
        if tokenizer.pad_token_id is None: tokenizer.pad_token = tokenizer.eos_token
        dtype = torch.bfloat16 if self.device == 'cuda' and torch.cuda.is_bf16_supported() else torch.float16
        # CPU fallback keeps the base in FP32, but delta products remain FP16.
        base_dtype = torch.float32 if self.device == 'cpu' else dtype
        model = AutoModelForCausalLM.from_pretrained(self.base_model, revision=self.revision, dtype=base_dtype, local_files_only=True).to(self.device)
        model.eval().requires_grad_(False)
        model.generation_config.temperature = 1.0
        model.generation_config.top_p = 1.0
        model.generation_config.top_k = 50
        self.tokenizer, self.model = tokenizer, model

    @torch.inference_mode()
    def generate(self, prompt, max_new_tokens=192):
        synchronize(torch.device(self.device))
        phase_start = time.perf_counter()
        inputs = self.tokenizer.apply_chat_template(
            [{'role': 'user', 'content': prompt}], tokenize=True,
            add_generation_prompt=True, return_tensors='pt', return_dict=True).to(self.device)
        if inputs['input_ids'].shape[-1] > 2048: raise ValueError('Prompt exceeds the 2048-token demo limit')
        synchronize(torch.device(self.device))
        started = time.perf_counter()
        output = self.model.generate(**inputs, max_new_tokens=max_new_tokens,
                                     do_sample=False, pad_token_id=self.tokenizer.pad_token_id)
        synchronize(torch.device(self.device))
        generation_ms = (time.perf_counter() - started) * 1000
        generated = output[0, inputs['input_ids'].shape[-1]:]
        text = self.tokenizer.decode(generated, skip_special_tokens=True)
        phase_ms = (time.perf_counter() - phase_start) * 1000
        return {'text': text, 'tokens': len(generated), 'generation_ms': generation_ms,
                'phase_ms': phase_ms, 'tokens_per_second': len(generated) / (generation_ms / 1000)}

    def compare_events(self, prompt, max_new_tokens=192, weights=None, experts=None, *, execution_plan=None, token_planner=None):
        yield from self._execution_events(prompt, max_new_tokens, weights, experts, baseline=True, execution_plan=execution_plan, token_planner=token_planner)

    def response_events(self, prompt, max_new_tokens=192, weights=None, experts=None, *, execution_plan=None, token_planner=None):
        """Classify, resolve vault factors, fuse, generate, and restore."""
        yield from self._execution_events(prompt, max_new_tokens, weights, experts, baseline=False, execution_plan=execution_plan, token_planner=token_planner)

    def token_events(self, prompt, max_new_tokens, planner):
        """Real greedy decoding, with a fresh budget and dense weights per step.

        A changed weight vector INVALIDATES past_key_values. Recompute the full
        prefix under the new weights rather than mixing old and new attention
        states. Identical vectors reuse both the fusion and the valid KV cache.
        The caller owns the model lock and restores all weights in finally.
        """
        inputs = self.tokenizer.apply_chat_template(
            [{'role': 'user', 'content': prompt}], tokenize=True,
            add_generation_prompt=True, return_tensors='pt', return_dict=True).to(self.device)
        ids = inputs['input_ids']
        prompt_length = ids.shape[-1]
        if prompt_length > 2048:
            raise ValueError('Prompt exceeds the 2048-token demo limit')
        mask = inputs.get('attention_mask', torch.ones_like(ids))
        eos = self.model.generation_config.eos_token_id
        eos_ids = set(eos if isinstance(eos, (list, tuple)) else [eos]) if eos is not None else set()
        paths = self.adapter_paths()
        previous_vector, past, text = None, None, ''
        generation_ms = fusion_ms = reason_ms = 0.0
        cache_rebuilds = cache_reuses = kernel_updates = 0
        schedule = []
        phase_start = time.perf_counter()
        for index in range(max_new_tokens):
            plan = planner(text)
            reason_ms += plan['reason_ms']
            order = tuple(plan['adapter_order'])
            validate_coefficients(plan['weights'], order, plan['network_cap'])
            if not set(order) <= paths.keys() or len(plan['active_experts']) > 8:
                raise ValueError('Token plan has unknown adapters or more than eight active experts')
            # Include zero entries/order: the audit and kernel receive exactly
            # the same named vector that is streamed to the dashboard.
            vector = tuple((name, plan['weights'][name]) for name in order)
            changed = vector != previous_vector
            if changed:
                fused_model = fuse_weights(self.model, [paths[name] for name in order],
                                           plan['weight_vector'], adapter_names=order,
                                           base_model_id=self.base_model, base_revision=self.revision,
                                           tensor_store=self.tensor_store)
                audit = fused_model._synapse_fusion_audit
                fusion_ms += audit['fusion_ms']
                kernel_updates += 1
                previous_vector, past = vector, None
            # The active coefficients can stay identical while telemetry or
            # ideal weights change; attach the current step to the audit anyway.
            audit = self.model._synapse_fusion_audit
            audit.update(network=plan['network'], fusion_mode=plan['fusion_mode'],
                         intent_weights=plan['ideal_weights'], ideal_weights=plan['ideal_weights'],
                         network_cap=plan['network_cap'], budget_spent=plan['budget_spent'],
                         token_index=index, token_level=True)
            self.last_audit = audit
            self.loaded_experts = tuple(audit['loaded_adapters'])
            if changed:
                yield {'event': 'fusion', **audit}
            cache_action = 'rebuild' if past is None else 'reuse'
            step = {'token_index': index, 'weights': plan['weights'], 'ideal_weights': plan['ideal_weights'],
                    'network_cap': plan['network_cap'], 'budget_spent': plan['budget_spent'],
                    'network': plan['network'], 'fusion_mode': plan['fusion_mode'],
                    'active_experts': plan['active_experts'], 'adapter_order': list(order),
                    'excluded': plan['excluded'], 'evidence': plan['evidence'], 'intent_context': plan['intent_context'],
                    'kernel_updated': changed, 'cache_action': cache_action}
            schedule.append(step)
            yield {'event': 'token_fusion', **step}
            synchronize(torch.device(self.device))
            forward_start = time.perf_counter()
            with torch.inference_mode():
                # Full attention mask includes the cached prefix on a reuse.
                output = self.model(input_ids=ids if past is None else ids[:, -1:],
                                    attention_mask=mask, past_key_values=past, use_cache=True)
                next_id = output.logits[:, -1].argmax(dim=-1, keepdim=True)
                past = output.past_key_values
                ids = torch.cat((ids, next_id), dim=-1)
                mask = torch.cat((mask, torch.ones_like(next_id)), dim=-1)
            cache_rebuilds += cache_action == 'rebuild'
            cache_reuses += cache_action == 'reuse'
            text = self.tokenizer.decode(ids[0, prompt_length:], skip_special_tokens=True)
            synchronize(torch.device(self.device))
            generation_ms += (time.perf_counter() - forward_start) * 1000
            del output
            yield {'event': 'token', 'token_index': index, 'text': text, 'tokens': index + 1,
                   'generation_ms': generation_ms}
            if int(next_id[0, 0]) in eos_ids:
                break
        phase_ms = (time.perf_counter() - phase_start) * 1000
        return {'text': text, 'tokens': len(schedule), 'generation_ms': generation_ms,
                'phase_ms': phase_ms, 'tokens_per_second': len(schedule) / max(phase_ms / 1000, 1e-9),
                'fusion_ms': fusion_ms, 'reason_ms': reason_ms, 'kernel_updates': kernel_updates,
                'cache_rebuilds': cache_rebuilds, 'cache_reuses': cache_reuses,
                'token_schedule': schedule, 'token_level': True,
                'final_audit': dict(self.last_audit)}

    def _execution_events(self, prompt, max_new_tokens, weights, experts, *, baseline, execution_plan=None, token_planner=None):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
            raise ValueError('Use a nonempty prompt of at most 8000 characters')
        if isinstance(max_new_tokens, bool) or not isinstance(max_new_tokens, int) or not 16 <= max_new_tokens <= 512:
            raise ValueError('Use between 16 and 512 new tokens')
        reason_ms = execution_plan.get('reason_ms', 0) if execution_plan else 0
        request_start = time.perf_counter() - reason_ms / 1000
        intent_start = time.perf_counter()
        intent = execution_plan if execution_plan is not None else self.resolve_intent(prompt, weights, experts)
        selected = tuple(intent['adapter_order'])
        if not set(selected) <= self.adapter_paths().keys():
            raise ValueError('Execution plan contains an unknown adapter')
        validate_coefficients(intent['weights'], selected, intent.get('network_cap', 1.0))
        if not 1 <= len(intent['active_experts']) <= 8:
            raise ValueError('A fusion needs 1–8 active experts')
        intent_ms = reason_ms + (time.perf_counter() - intent_start) * 1000
        if 'network' in intent:
            yield {'event': 'network', 'network': intent['network'], 'fusion_mode': intent['fusion_mode']}
        yield {'event': 'intent', **intent}
        queue_start = time.perf_counter()
        with self.lock:
            queue_wait_ms = (time.perf_counter() - queue_start) * 1000
            yield {'event': 'loading', 'device': self.device, 'base_cold': self.model is None}
            load_start = time.perf_counter()
            self.load()
            restore_weights(self.model)
            synchronize(torch.device(self.device))
            shared_setup_ms = (time.perf_counter() - load_start) * 1000
            baseline_result = self.generate(prompt, max_new_tokens) if baseline else None
            if baseline_result is not None:
                yield {'event': 'baseline', **baseline_result, 'total_ms': baseline_result['phase_ms'],
                       'ready_after_ms': (time.perf_counter() - request_start) * 1000}
            fused_start = time.perf_counter()
            paths = self.adapter_paths()
            try:
                if token_planner is not None:
                    fused = yield from self.token_events(prompt, max_new_tokens, token_planner)
                    audit = self.last_audit
                    intent_ms += fused['reason_ms']
                    total_fusion_ms = fused['fusion_ms']
                else:
                    fused_model = fuse_weights(self.model, [paths[name] for name in selected],
                                           torch.tensor(intent['weight_vector'], dtype=torch.float32),
                                           adapter_names=selected, base_model_id=self.base_model,
                                           base_revision=self.revision, tensor_store=self.tensor_store)
                    audit = fused_model._synapse_fusion_audit
                    if 'network' in intent:
                        audit.update(network=intent['network'], fusion_mode=intent['fusion_mode'], intent_weights=intent['intent_weights'])
                    self.last_audit = audit
                    self.loaded_experts = tuple(audit['loaded_adapters'])
                    yield {'event': 'fusion', **audit}
                    fused = self.generate(prompt, max_new_tokens)
                    total_fusion_ms = audit['fusion_ms']
                yield {'event': 'fused' if baseline else 'response', **fused}
            finally:
                restore_start = time.perf_counter()
                restore_weights(self.model)
                synchronize(torch.device(self.device))
                restore_ms = (time.perf_counter() - restore_start) * 1000
            # Token reasoning already occurs inside fused_start → now; avoid
            # counting it twice in the end-to-end fused pipeline duration.
            initial_intent_ms = intent_ms - fused.get('reason_ms', 0)
            fused_total_ms = initial_intent_ms + (time.perf_counter() - fused_start) * 1000
            yield {'event': 'complete', 'base_restored': True,
                   'timing': {'baseline_total_ms': baseline_result['phase_ms'] if baseline_result else 0, 'fused_total_ms': fused_total_ms,
                              'intent_ms': intent_ms, 'fusion_ms': total_fusion_ms,
                              'fused_generation_ms': fused['generation_ms'], 'restore_ms': restore_ms,
                              'shared_setup_ms': shared_setup_ms, 'queue_wait_ms': queue_wait_ms,
                              'comparison_wall_ms': (time.perf_counter() - request_start) * 1000,
                              'baseline_wait_ms': baseline_result['phase_ms'] if baseline_result else 0,
                              'timing_note': 'Fused totals include token intent, adapter reads/transfers, every fusion, cache rebuilds, generation, and restore. Smaller coefficients alone do not reduce dense compute. Shared base loading and queue wait are shown separately.'}}
