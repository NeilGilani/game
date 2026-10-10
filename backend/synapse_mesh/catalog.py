"""Live Hub discovery and pinned, validated safetensors adapter downloads."""
import hashlib
import json
from pathlib import Path
import re
from threading import Lock
from urllib.parse import parse_qs, urlparse

import requests
from huggingface_hub import HfApi, hf_hub_download

TARGETS = {'q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'}
MAX_BYTES = 256 * 1024 * 1024


def validate_config(config, base_model, base_revision):
    if config.get('base_model_name_or_path') != base_model:
        raise ValueError('This adapter requires a different base model')
    if config.get('revision') not in (None, base_revision):
        raise ValueError('Adapter requires a different base checkpoint revision')
    if config.get('peft_type') != 'LORA' or config.get('task_type') not in (None, 'CAUSAL_LM'):
        raise ValueError('Only causal language model LoRA adapters can enter this fusion kernel')
    if (config.get('bias', 'none') != 'none' or config.get('modules_to_save') or
        config.get('use_dora') or config.get('lora_bias') or config.get('fan_in_fan_out') or
        config.get('layer_replication') or config.get('target_parameters')):
        raise ValueError('This adapter uses transformations unsupported by exact Linear LoRA fusion')
    targets = config.get('target_modules')
    if not isinstance(targets, list) or not targets or not set(targets) <= TARGETS:
        raise ValueError('Adapter must target standard attention/MLP projection matrices')
    ranks = [config.get('r', 0), *config.get('rank_pattern', {}).values()]
    if any(not isinstance(r, int) or r < 1 or r > 128 for r in ranks):
        raise ValueError('Supported adapter ranks are 1–128')


class CloudCatalog:
    def __init__(self, vault, base_model):
        self.vault, self.base_model = Path(vault).expanduser().resolve(), base_model
        self.registry = self.vault / 'cloud.json'
        self.lock = Lock()

    def installed(self):
        entries = json.loads(self.registry.read_text()) if self.registry.exists() else {}
        for item in entries.values():
            path = Path(item['path']).expanduser()
            item['path'] = str((path if path.is_absolute() else self.vault / path).resolve())
        return entries

    def adapter_paths(self, local_experts):
        """One directory mapping shared by status reporting and tensor loading."""
        return {**{name: str(self.vault / name) for name in local_experts},
                **{name: item['path'] for name, item in self.installed().items()}}

    @staticmethod
    def file_status(path):
        directory = Path(path).expanduser().resolve()
        config = directory / 'adapter_config.json'
        weights = directory / 'adapter_model.safetensors'
        missing = [file.name for file in (config, weights) if not file.is_file()]
        return {'path': str(directory), 'config_path': str(config), 'weights_path': str(weights),
                'available': not missing, 'missing_files': missing}

    def search(self, query='', scope='all', cursor=None):
        params = {'limit': 24, 'full': 'true', 'cardData': 'true', 'sort': 'downloads', 'direction': -1}
        if query:
            params['search'] = query
        if scope == 'compatible':
            params['filter'] = 'base_model:adapter:' + self.base_model
        elif scope == 'adapters':
            params['filter'] = 'peft'
        if cursor:
            params['cursor'] = cursor
        response = requests.get('https://huggingface.co/api/models', params=params, timeout=25)
        response.raise_for_status()
        installed = {x['repo_id']: key for key, x in self.installed().items()}
        rows = []
        for item in response.json():
            card = item.get('cardData') or {}
            base = card.get('base_model') or []
            bases = [base] if isinstance(base, str) else base if isinstance(base, list) else []
            files = {x['rfilename'] for x in item.get('siblings', [])}
            configs = sorted(f for f in files if f.endswith('adapter_config.json') and
                             f.removesuffix('adapter_config.json') + 'adapter_model.safetensors' in files)
            config_file = 'adapter_config.json' if 'adapter_config.json' in configs else next(iter(configs), None)
            candidate = bool(config_file and self.base_model in bases and not item.get('gated'))
            reason = ('Base matches; inspect configuration to verify fusion support' if candidate else
                      'Access restricted' if item.get('gated') else
                      'Different or unspecified base model' if config_file else 'Full model / no safetensors LoRA adapter')
            rows.append({'repo_id': item['id'], 'revision': item.get('sha'), 'base_models': bases,
                         'downloads': item.get('downloads', 0), 'likes': item.get('likes', 0),
                         'tags': item.get('tags', []), 'license': card.get('license'),
                         'candidate': candidate, 'reason': reason,
                         'subfolder': config_file.removesuffix('/adapter_config.json') if config_file and '/' in config_file else '',
                         'installed_as': installed.get(item['id']), 'url': 'https://huggingface.co/' + item['id']})
        next_url = response.links.get('next', {}).get('url', '')
        next_cursor = parse_qs(urlparse(next_url).query).get('cursor', [None])[0]
        return {'source': 'Hugging Face Hub · live', 'models': rows, 'next_cursor': next_cursor,
                'base_model': self.base_model, 'scope': scope}

    def inspect(self, repo_id, subfolder='', revision=None):
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo_id):
            raise ValueError('Enter a Hugging Face repository ID: owner/model')
        if subfolder and (subfolder.startswith('/') or '..' in subfolder.split('/') or not re.fullmatch(r'[\w./-]+', subfolder)):
            raise ValueError('Invalid adapter subfolder')
        info = HfApi().model_info(repo_id, revision=revision, files_metadata=True)
        prefix = subfolder.rstrip('/') + '/' if subfolder else ''
        files = {f.rfilename: f for f in info.siblings}
        if prefix + 'adapter_config.json' not in files or prefix + 'adapter_model.safetensors' not in files:
            raise ValueError('Repository does not contain a safetensors LoRA adapter at this location')
        size = files[prefix + 'adapter_model.safetensors'].size
        if size is None or size > MAX_BYTES:
            raise ValueError('Adapter exceeds the local demo’s 256 MB per-adapter limit')
        config_path = hf_hub_download(repo_id, prefix + 'adapter_config.json', revision=info.sha)
        config = json.loads(Path(config_path).read_text())
        local_config = json.loads((self.vault / 'coding/adapter_config.json').read_text())
        validate_config(config, self.base_model, local_config.get('revision'))
        return {'repo_id': repo_id, 'revision': info.sha, 'subfolder': subfolder, 'bytes': size,
                'rank': config['r'], 'target_modules': config['target_modules'],
                'base_revision_unspecified': config.get('revision') is None,
                'license': (info.card_data or {}).get('license')}

    def install(self, repo_id, subfolder='', revision=None, expertise=''):
        details = self.inspect(repo_id, subfolder, revision)
        key = 'hub_' + hashlib.sha256((repo_id + '/' + subfolder + '@' + details['revision']).encode()).hexdigest()[:12]
        prefix = subfolder.rstrip('/') + '/' if subfolder else ''
        weight_path = hf_hub_download(repo_id, prefix + 'adapter_model.safetensors', revision=details['revision'])
        from safetensors import safe_open
        with safe_open(weight_path, framework='pt', device='cpu') as weights:
            keys = list(weights.keys())
            if not keys or any(not re.fullmatch(r'.*\.lora_[AB]\.weight', k) for k in keys):
                raise ValueError('Adapter includes weights outside the supported LoRA factors')
        details.update({'path': str(Path(weight_path).parent), 'name': key,
                        'label': repo_id.split('/')[-1], 'expertise': expertise.strip() or repo_id.split('/')[-1]})
        with self.lock:
            installed = self.installed()
            installed[key] = details
            self.vault.mkdir(parents=True, exist_ok=True)
            temporary = self.registry.with_suffix('.tmp')
            temporary.write_text(json.dumps(installed, indent=2))
            temporary.replace(self.registry)
        return details
