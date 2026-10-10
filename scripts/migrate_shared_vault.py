"""Publish the local adapter vault to the cluster's existing shared mount."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from synapse_mesh.runtime import BASE_MODEL, DEFAULT_VAULT
from synapse_mesh.vault_manager import DEFAULT_SHARED_ROOT
from synapse_mesh.vault_migration import migrate

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=DEFAULT_VAULT)
    parser.add_argument('--destination', type=Path, default=Path(DEFAULT_SHARED_ROOT))
    parser.add_argument('--base-model', default=BASE_MODEL)
    args = parser.parse_args()
    print(json.dumps(migrate(args.source, args.destination, args.base_model), indent=2))
