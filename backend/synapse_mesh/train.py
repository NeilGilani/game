"""Train three real LoRAs; no random adapters masquerading as experts."""
import argparse
import hashlib
import json
from pathlib import Path
import time

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

from .intent import EXPERTS
from .runtime import BASE_MODEL, DEFAULT_VAULT, ROOT, select_device


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-model", default=BASE_MODEL)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--steps", type=int, default=70)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--rank", type=int, default=8)
    parser.add_argument("--lr", type=float, default=0.0002)
    parser.add_argument("--data", type=Path, default=ROOT / "data/train-initial.json")
    parser.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    parser.add_argument('--domains', nargs='+', default=list(EXPERTS), help='Dataset keys to train, including generalist')
    parser.add_argument('--revision', help='Base checkpoint revision; defaults to the existing vault checkpoint')
    args = parser.parse_args()
    if min(args.steps, args.rank, args.batch_size) < 1:
        parser.error("steps, rank, and batch-size must be positive")
    torch.manual_seed(42)
    device = select_device(args.device)
    revision = args.revision
    reference = args.vault / 'coding/adapter_config.json'
    if revision is None and reference.is_file():
        existing = json.loads(reference.read_text())
        if existing.get('base_model_name_or_path') == args.base_model:
            revision = existing.get('revision')
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, revision=revision)
    tokenizer.pad_token = tokenizer.eos_token
    # float32 avoids Metal fp16 training instability; CUDA uses bfloat16.
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    base = AutoModelForCausalLM.from_pretrained(args.base_model, revision=revision, dtype=dtype).to(device)
    base.config.use_cache = False
    config = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0,
                        target_modules=["q_proj", "v_proj"], bias="none", task_type="CAUSAL_LM",
                        revision=base.config._commit_hash)
    data = json.loads(args.data.read_text())
    if not args.domains or len(set(args.domains)) != len(args.domains) or any(name not in data for name in args.domains):
        parser.error('domains must be distinct keys in the training dataset')
    model = get_peft_model(base, config, adapter_name=args.domains[0])
    for domain in args.domains:
        if domain != args.domains[0]:
            model.add_adapter(domain, config)
        model.set_adapter(domain)
        model.train()
        examples = []
        for row in data[domain]:
            user = [{"role": "user", "content": row["prompt"]}]
            prefix = tokenizer.apply_chat_template(user, tokenize=True, add_generation_prompt=True)
            ids = tokenizer.apply_chat_template(user + [{"role": "assistant", "content": row["answer"]}], tokenize=True)
            if len(ids) > 384:
                raise ValueError("Training example exceeds 384 tokens")
            labels = [-100] * len(prefix) + ids[len(prefix):]
            examples.append((ids, labels))
        optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=args.lr)
        start = time.perf_counter()
        losses = []
        for step in range(args.steps):
            indices = torch.randint(len(examples), (args.batch_size,)).tolist()
            batch = [examples[i] for i in indices]
            width = max(len(ids) for ids, _ in batch)
            ids = torch.tensor([x + [tokenizer.pad_token_id] * (width-len(x)) for x, _ in batch], device=device)
            labels = torch.tensor([y + [-100] * (width-len(y)) for _, y in batch], device=device)
            mask = torch.tensor([[1] * len(x) + [0] * (width-len(x)) for x, _ in batch], device=device)
            optimizer.zero_grad(set_to_none=True)
            loss = model(input_ids=ids, attention_mask=mask, labels=labels).loss
            if not torch.isfinite(loss):
                raise ValueError(f"{domain}: nonfinite loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_((p for p in model.parameters() if p.requires_grad), 1.0)
            optimizer.step()
            losses.append(float(loss.item()))
            if step % 10 == 0 or step == args.steps - 1:
                print(json.dumps({"expert": domain, "step": step + 1, "steps": args.steps,
                                  "loss": losses[-1], "elapsed_s": time.perf_counter()-start}), flush=True)
        model.save_pretrained(args.vault, selected_adapters=[domain], safe_serialization=True)
        metadata = {"base_model": args.base_model, "base_revision": base.config._commit_hash,
                    "domain": domain, "examples": len(examples),
                    "steps": args.steps, "rank": args.rank, "seed": 42, "learning_rate": args.lr,
                    "device": device, "initial_loss": losses[0], "final_loss": losses[-1],
                    "training_seconds": time.perf_counter()-start,
                    "data_sha256": hashlib.sha256(args.data.read_bytes()).hexdigest(),
                    "quality": "small synthetic educational dataset; not a validated domain expert"}
        (args.vault / domain / "training.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    main()
