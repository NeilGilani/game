"""Audit the shipped demo evidence without downloading or running a model."""
import hashlib
import json
from pathlib import Path
import re
import statistics

ROOT = Path(__file__).resolve().parents[1]


def main():
    data = json.loads((ROOT / 'artifacts/comparison.json').read_text())
    proof = json.loads((ROOT / 'data/proof.json').read_text())
    assert len(data['results']) == len(proof) == 5
    for case, expected in zip(data['results'], proof):
        assert case['prompt'] == expected['prompt']
        assert [e['event'] for e in case['events']] == ['intent', 'loading', 'baseline', 'fusion', 'fused', 'complete']
        fusion = next(e for e in case['events'] if e['event'] == 'fusion')
        assert fusion['device'] == 'mps:0' and fusion['layer_count'] == 56
        assert all(w > 0 for w in fusion['weights'].values())
        assert abs(sum(fusion['weights'].values()) - 1) < 1e-8
        assert all(all(n > 0 for n in row['delta_norms'].values()) for row in fusion['layers'])
        sample = fusion['matrix_sample']
        for i in range(6):
            for j in range(6):
                total = sample['base'][i][j] + sum(m[i][j] for m in sample['contributions'].values())
                assert abs(total - sample['fused'][i][j]) < 1e-7
        assert case['events'][-1]['base_restored'] is True
        for output in [e for e in case['events'] if e['event'] in ('baseline', 'fused')]:
            assert output['text'] and output['tokens'] <= 512
    audit_case = next(r for r in data['results'] if r['id'] == 'health-audit')
    baseline = next(e['text'] for e in audit_case['events'] if e['event'] == 'baseline')
    fused = next(e['text'] for e in audit_case['events'] if e['event'] == 'fused')
    assert 'Only include fields like' in baseline
    assert 'Exclude personal identifiers' in fused
    assert 'only authorized personnel can view audit logs' in fused
    for text in (baseline, fused):
        json.loads(re.search(r'```json\s*(.*?)```', text, re.S).group(1))
    initial_hash = hashlib.sha256((ROOT / 'data/train-initial.json').read_bytes()).hexdigest()
    configs = []
    for name in ('coding', 'medical', 'legal'):
        path = ROOT / 'vault-1.5b' / name
        assert (path / 'adapter_model.safetensors').stat().st_size > 0
        config = json.loads((path / 'adapter_config.json').read_text())
        metadata = json.loads((path / 'training.json').read_text())
        assert metadata['data_sha256'] == initial_hash
        assert config['base_model_name_or_path'] == data['base_model']
        assert config['revision'] == metadata['base_revision']
        configs.append(config)
    assert len({c['revision'] for c in configs}) == 1
    browser = json.loads((ROOT / 'artifacts/browser-check.json').read_text())
    assert browser['status'] == 'passed' and browser['device'] == 'mps:0'
    assert browser['matrix_rows'] == 56 and browser['real_generation']
    assert not browser['javascript_errors'] and not browser['mobile_overflow']
    review = json.loads((ROOT / 'artifacts/review.json').read_text())
    assert review['demonstration_case'] == 'health-audit' and len(review['other_cases']) == 4
    report = {
        'artifact_audit': 'passed', 'proof_cases': 5, 'device': 'mps:0',
        'matrices_per_case': 56, 'samples_verified': True,
        'vault_revision': configs[0]['revision'],
        'median_fusion_ms': statistics.median(next(e['fusion_ms'] for e in r['events'] if e['event'] == 'fusion') for r in data['results']),
        'privacy_difference_verified': True, 'browser': browser,
        'quality_scope': 'Selected privacy improvement; broader superiority is not established',
        'evidence_sha256': {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                            for path in (ROOT/'artifacts/comparison.json', ROOT/'artifacts/review.json', ROOT/'artifacts/browser-check.json')},
    }
    (ROOT / 'artifacts/verification.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
