"""Prepare a real mixed-domain fallback once; inference never trains/downloads."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
source = json.loads((ROOT / 'data/train.json').read_text())
data = ROOT / 'data/train-generalist.json'
data.write_text(json.dumps({'generalist': [row for name in ('coding', 'medical', 'legal') for row in source[name]]}, indent=2) + '\n')
subprocess.run([sys.executable, '-m', 'synapse_mesh.train', '--domains', 'generalist',
                '--data', str(data), '--vault', str(ROOT / 'vault-1.5b'), *sys.argv[1:]],
               cwd=ROOT / 'backend', check=True)
