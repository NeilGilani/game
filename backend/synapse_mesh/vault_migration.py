"""Publish verified adapters to an already mounted shared-volume directory."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from safetensors import safe_open

from .catalog import CloudCatalog, validate_config
from .intent import EXPERTS


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def migrate(source, destination, base_model):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not destination.is_dir():
        raise FileNotFoundError(f'Mount the shared volume first: {destination}')
    catalog = CloudCatalog(source, base_model)
    paths = catalog.adapter_paths(EXPERTS)
    if (source / 'generalist/adapter_config.json').is_file():
        paths['generalist'] = str(source / 'generalist')
    revision = json.loads((source / 'coding/adapter_config.json').read_text()).get('revision')
    old_manifest = destination / 'vault.json'
    if old_manifest.exists():
        existing = json.loads(old_manifest.read_text())
        if existing['base_model'] != base_model or existing.get('base_revision') != revision:
            raise ValueError('Destination already contains a vault for another base checkpoint')
    entries = {}
    for name, path in paths.items():
        if not re.fullmatch(r'[\w.-]+', name):
            raise ValueError('Adapter names must be safe directory names')
        path = Path(path)
        config = json.loads((path / 'adapter_config.json').read_text())
        validate_config(config, base_model, revision)
        with safe_open(path / 'adapter_model.safetensors', framework='pt', device='cpu') as reader:
            keys = set(reader.keys())
            a_keys = {key for key in keys if re.fullmatch(r'.*\.lora_A(?:\.[^.]+)?\.weight', key)}
            if not a_keys or keys != a_keys | {key.replace('.lora_A', '.lora_B') for key in a_keys}:
                raise ValueError(f'{name}: incomplete or unsupported LoRA factors')
        hashes = {file: sha256(path / file) for file in ('adapter_config.json', 'adapter_model.safetensors')}
        identity = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
        target = destination / 'adapters' / name / identity
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary = Path(tempfile.mkdtemp(prefix='.upload-', dir=target.parent))
            try:
                for file in (*hashes, 'training.json'):
                    if (path / file).is_file():
                        shutil.copyfile(path / file, temporary / file)
                if any(sha256(temporary / file) != expected for file, expected in hashes.items()):
                    raise RuntimeError('Source changed during migration')
                try:
                    temporary.rename(target)
                except FileExistsError:
                    pass  # Another publisher already installed the same content.
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        if any(sha256(target / file) != expected for file, expected in hashes.items()):
            raise RuntimeError(f'{name}: destination checksum verification failed')
        entries[name] = {'path': str(target.relative_to(destination)), 'sha256': hashes,
                         'rank': config['r'], 'expertise': catalog.installed().get(name, {}).get('expertise', '')}
    manifest = {'base_model': base_model, 'base_revision': revision, 'adapters': entries}
    with tempfile.NamedTemporaryFile(mode='w', dir=destination, prefix='.vault-', delete=False) as output:
        json.dump(manifest, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
        temporary_manifest = Path(output.name)
    temporary_manifest.replace(destination / 'vault.json')
    return manifest
