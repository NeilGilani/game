"""Start and stop the two local demo services as one foreground process."""
import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from synapse_mesh.runtime import BASE_MODEL, DEFAULT_VAULT
from synapse_mesh.catalog import CloudCatalog


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-model', default=BASE_MODEL)
    parser.add_argument('--vault', type=Path, default=DEFAULT_VAULT)
    parser.add_argument('--dev', action='store_true', help='Compile the dashboard live with Next.js development mode')
    args = parser.parse_args()
    for port in (8000, 3000):
        with socket.socket() as connection:
            if connection.connect_ex(('127.0.0.1', port)) == 0:
                parser.error(f'Port {port} is already in use; stop that service or use separate server commands.')
    if not args.dev and not (ROOT / 'frontend/.next/BUILD_ID').exists():
        parser.error('Build the dashboard first: cd frontend && npm ci && npm run build')
    missing = {name: CloudCatalog.file_status(args.vault / name)['missing_files']
               for name in ('coding', 'medical', 'legal')
               if not CloudCatalog.file_status(args.vault / name)['available']}
    if missing:
        parser.error(f'Missing adapters: {missing}; see README.md for training instructions.')
    env = {**os.environ, 'SYNAPSE_BASE_MODEL': args.base_model, 'SYNAPSE_VAULT': str(args.vault.resolve()),
           'SYNAPSE_API_URL': 'http://127.0.0.1:8000'}
    children = []
    def stop(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        children.append(subprocess.Popen([sys.executable, '-m', 'uvicorn', 'synapse_mesh.api:app', '--host', '127.0.0.1', '--port', '8000'], cwd=ROOT / 'backend', env=env, start_new_session=True))
        deadline = time.monotonic()+30
        while time.monotonic() < deadline:
            if children[0].poll() is not None:
                raise RuntimeError('The kernel exited during startup')
            try:
                with urlopen('http://127.0.0.1:8000/health', timeout=1) as response:
                    json.load(response)
                break
            except OSError:
                time.sleep(.2)
        else:
            raise RuntimeError('The kernel did not become ready in 30 seconds')
        children.append(subprocess.Popen(['npm', 'run', 'dev' if args.dev else 'start'], cwd=ROOT / 'frontend', env=env, start_new_session=True))
        deadline = time.monotonic()+60
        while time.monotonic() < deadline:
            if any(child.poll() is not None for child in children):
                raise RuntimeError('A demo service exited during dashboard startup')
            try:
                with urlopen('http://127.0.0.1:3000/kernel/health', timeout=2) as response:
                    health = json.load(response)
                    if health.get('status') in ('ready', 'cold'):
                        break
            except OSError:
                time.sleep(.2)
        else:
            raise RuntimeError('The dashboard could not reach the kernel through /kernel/health')
        print('Synapse-Mesh: http://127.0.0.1:3000 — Ctrl+C stops both services.', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(.5)
        raise RuntimeError('A demo service exited')
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == '__main__':
    main()
