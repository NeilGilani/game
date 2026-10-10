"""One-time pinned download; classifier inference itself never uses the network."""
from huggingface_hub import snapshot_download
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from synapse_mesh.intent import MODEL_ID, MODEL_REVISION


if __name__ == '__main__':
    print(snapshot_download(MODEL_ID, revision=MODEL_REVISION, allow_patterns=[
        'config.json', 'model.safetensors', 'tokenizer.json', 'tokenizer_config.json',
        'special_tokens_map.json', 'vocab.txt',
    ]))
