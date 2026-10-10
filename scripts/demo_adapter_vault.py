"""Inspect a real NF4 base and named LoRA factors without activating/routing adapters."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from synapse_mesh.adapter_vault import AdapterVault, LLAMA_3_8B


def main():
    parser = argparse.ArgumentParser(description='Load a bitsandbytes NF4 base and inspect specialist A/B tensors')
    parser.add_argument('--base-model', default=LLAMA_3_8B)
    parser.add_argument('--base-revision')
    parser.add_argument('--device', default='cuda:0')
    parser.add_argument('--adapter', action='append', default=[], metavar='NAME=PATH_OR_REPO')
    args = parser.parse_args()
    with AdapterVault(args.base_model, base_revision=args.base_revision, device=args.device) as vault:
        for adapter in args.adapter:
            name, separator, source = adapter.partition('=')
            if not separator or not name or not source: parser.error('--adapter must be NAME=PATH_OR_REPO')
            vault.register(name, source)
        base = vault.load_base_model()
        result = {'base_is_4bit': base.is_loaded_in_4bit, 'device': str(vault.device), 'specialists': {}}
        for adapter in args.adapter:
            name = adapter.partition('=')[0]
            matrices = vault.get_matrices(name)
            result['specialists'][name] = {module: {'A': list(pair.A.shape), 'B': list(pair.B.shape),
                                                  'scaling': pair.scaling, 'device': str(pair.A.device),
                                                  'dtype': str(pair.A.dtype)} for module, pair in matrices.items()}
            del matrices
            vault.unload_adapter(name)
        print(json.dumps(result, indent=2))


if __name__ == '__main__': main()
