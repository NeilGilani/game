"""Standalone tensor demo: python scripts/demo_tensor_fusion.py --prompt '...'."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from synapse_mesh.intent import IntentClassifier
from synapse_mesh.runtime import BASE_MODEL, select_device
from synapse_mesh.tensor_fusion import fuse_weights, restore_weights


def main():
    parser = argparse.ArgumentParser(description='Fuse local A/B tensors into a plain base model; no inference API')
    parser.add_argument('--prompt', required=True)
    parser.add_argument('--adapter-paths', nargs='+', type=Path,
                        default=[ROOT / 'vault-1.5b' / name for name in ('coding', 'medical', 'legal')])
    parser.add_argument('--weights', nargs='+', type=float)
    parser.add_argument('--device', default='auto')
    parser.add_argument('--max-new-tokens', type=int, default=128)
    args = parser.parse_args()
    device = select_device(args.device)
    dtype = torch.bfloat16 if device == 'cuda' and torch.cuda.is_bf16_supported() else torch.float16
    config = json.loads((args.adapter_paths[0] / 'adapter_config.json').read_text())
    base_id, revision = config['base_model_name_or_path'], config.get('revision')
    base = AutoModelForCausalLM.from_pretrained(base_id, revision=revision, dtype=dtype).to(device).eval()
    tokenizer = AutoTokenizer.from_pretrained(base_id, revision=revision)
    names = [path.name for path in args.adapter_paths]
    vector = args.weights
    if vector is None:
        intent = IntentClassifier().classify(args.prompt, names)
        vector = [intent['weights'][name] for name in names]
    inputs = tokenizer.apply_chat_template([{'role': 'user', 'content': args.prompt}],
                                          tokenize=True, add_generation_prompt=True,
                                          return_dict=True, return_tensors='pt').to(device)
    with torch.no_grad():
        baseline = base.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
        try:
            fused_model = fuse_weights(base, args.adapter_paths, vector, adapter_names=names,
                                       base_model_id=base_id, base_revision=revision, compute_dtype=dtype)
            fused = fused_model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
            length = inputs['input_ids'].shape[-1]
            print(json.dumps({'weights': dict(zip(names, vector)), 'audit': fused_model._synapse_fusion_audit,
                              'baseline': tokenizer.decode(baseline[0, length:], skip_special_tokens=True),
                              'fused': tokenizer.decode(fused[0, length:], skip_special_tokens=True)}, indent=2))
        finally:
            restore_weights(base)


if __name__ == '__main__': main()
