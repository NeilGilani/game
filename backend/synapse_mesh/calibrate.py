"""Align separately trained experts under prompt-dependent mixtures.

During optimization, PEFT evaluates sum_i w_i * x @ A_i.T @ B_i.T,
which is algebraically identical to the dense inference kernel (dropout=0).
The comparison prompts and outputs are never training inputs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import torch
from peft.tuners.lora.layer import LoraLayer

from .intent import EXPERTS
from .runtime import DEFAULT_VAULT, ROOT, Runtime


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-vault', type=Path, default=DEFAULT_VAULT)
    parser.add_argument('--target-vault', type=Path, default=ROOT / 'vault-calibrated')
    parser.add_argument('--base-model', default=None)
    parser.add_argument('--device', default='auto')
    parser.add_argument('--steps', type=int, default=160)
    parser.add_argument('--lr', type=float, default=0.0001)
    args = parser.parse_args()
    if args.source_vault.resolve() == args.target_vault.resolve():
        parser.error('Use a separate target vault to preserve the original experts')
    runtime = Runtime(args.source_vault, args.base_model, args.device)
    runtime.load()
    model, tokenizer = runtime.model, runtime.tokenizer
    model.base_model.set_adapter(list(EXPERTS))
    model.train()
    model.config.use_cache = False
    layers = [layer for layer in model.modules() if isinstance(layer, LoraLayer)]
    scales = {id(layer): dict(layer.scaling) for layer in layers}
    path = ROOT / 'data/train.json'
    data = json.loads(path.read_text())
    examples = []
    for domain in EXPERTS:
        for row in data[domain]:
            user = [{'role': 'user', 'content': row['prompt']}]
            prefix = tokenizer.apply_chat_template(user, tokenize=True, add_generation_prompt=True)
            ids = tokenizer.apply_chat_template(user + [{'role': 'assistant', 'content': row['answer']}], tokenize=True)
            if len(ids) > 384:
                raise ValueError('Calibration example exceeds 384 tokens')
            examples.append((ids, [-100]*len(prefix) + ids[len(prefix):], runtime.classifier.classify(row['prompt'])['weights']))
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=args.lr)
    torch.manual_seed(73)
    start = time.perf_counter()
    losses = []
    try:
        for step in range(args.steps):
            ids, labels, weights = examples[int(torch.randint(len(examples), (1,)).item())]
            for layer in layers:
                for expert in EXPERTS:
                    layer.scaling[expert] = scales[id(layer)][expert] * weights[expert]
            optimizer.zero_grad(set_to_none=True)
            inputs = torch.tensor([ids], device=runtime.device)
            loss = model(input_ids=inputs, labels=torch.tensor([labels], device=runtime.device), attention_mask=torch.ones_like(inputs)).loss
            if not torch.isfinite(loss):
                raise ValueError('Nonfinite calibration loss')
            loss.backward()
            torch.nn.utils.clip_grad_norm_((p for p in model.parameters() if p.requires_grad), 1.0)
            optimizer.step()
            losses.append(loss.item())
            if step % 20 == 0 or step == args.steps-1:
                print(json.dumps({'phase':'mixture-calibration', 'step':step+1, 'steps':args.steps,
                                  'loss':losses[-1], 'elapsed_s':time.perf_counter()-start}), flush=True)
    finally:
        for layer in layers:
            layer.scaling.update(scales[id(layer)])
    for domain in EXPERTS:
        model.peft_config[domain].revision = model.config._commit_hash
    model.save_pretrained(args.target_vault, selected_adapters=list(EXPERTS))
    for domain in EXPERTS:
        meta_path = args.source_vault / domain / 'training.json'
        metadata = json.loads(meta_path.read_text()) if meta_path.exists() else {'base_model': runtime.base_model}
        metadata['base_revision'] = model.config._commit_hash
        metadata['calibration'] = {'steps':args.steps, 'learning_rate':args.lr, 'seed':73,
                                   'data_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                                   'examples':len(examples), 'final_loss':losses[-1],
                                   'seconds':time.perf_counter()-start,
                                   'method':'joint LoRA training under local classifier mixtures; no proof examples'}
        (args.target_vault / domain / 'training.json').write_text(json.dumps(metadata,indent=2)+'\n')


if __name__ == '__main__':
    main()
