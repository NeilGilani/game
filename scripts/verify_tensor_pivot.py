"""Verify current direct tensor fusion evidence, coefficients, precision, and timing."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    comparison = json.loads((ROOT / 'artifacts/tensor-pivot-comparison.json').read_text())
    browser = json.loads((ROOT / 'artifacts/tensor-pivot-browser-check.json').read_text())
    events = {e['event']: e for e in comparison['events']}
    audit = events['fusion']; timing = events['complete']['timing']
    assert browser['passed'] and browser['prompt'] == comparison['prompt']
    assert 'surgical robot' in comparison['prompt'] and 'legal enforceability' in comparison['prompt']
    assert audit['device'].startswith('mps') and audit['compute_dtype'] == audit['base_dtype'] == 'float16'
    assert audit['disk_writes'] == audit['adapter_forward_branches'] == 0 and audit['lazy_loading']
    assert len(audit['loaded_adapters']) >= 3 and audit['layer_count'] == 196
    weights = events['intent']['weights']
    assert weights['legal'] > weights['medical'] > weights['coding'] > 0
    assert abs(sum(weights.values()) - 1) < 1e-8
    registry = json.loads((ROOT / 'vault-1.5b/cloud.json').read_text())
    chinese = next(name for name, adapter in registry.items() if 'chinese' in adapter['label'].lower())
    assert weights[chinese] == 0 and chinese not in audit['loaded_adapters']
    sample = audit['matrix_sample']; max_error = 0
    for i in range(6):
        for j in range(6):
            expected = sample['base'][i][j] + sum(c[i][j] for c in sample['contributions'].values())
            max_error = max(max_error, abs(expected - sample['fused'][i][j]))
    assert max_error < .002, 'Sample exceeds half-precision rounding tolerance'
    assert timing['fused_total_ms'] >= timing['fusion_ms'] + timing['fused_generation_ms'] + timing['restore_ms']
    assert timing['comparison_wall_ms'] >= timing['baseline_total_ms'] + timing['fused_total_ms']
    assert events['complete']['base_restored']
    assert events['baseline']['ready_after_ms'] >= events['baseline']['total_ms']
    assert browser['dynamicPromptChanges'] and not browser['mobileOverflow'] and not browser['javascriptErrors']
    source = (ROOT / 'backend/synapse_mesh/tensor_fusion.py').read_text()
    runtime = (ROOT / 'backend/synapse_mesh/runtime.py').read_text()
    assert 'delta = torch.matmul(b, a)' in source and 'target.add_(delta, alpha=scale)' in source
    assert '@torch.no_grad()' in source and 'model.eval()' in source
    assert 'PeftModel' not in runtime and 'fuse_weights(self.model' in runtime
    assert "[{'role': 'user', 'content': prompt}]" in runtime
    report = {'passed': True, 'engine': 'raw-tensor-fusion', 'precision': 'float16',
              'chinese_not_loaded': True, 'sample_max_rounding_error': max_error,
              'timing_includes_fusion_and_restore': True, 'base_restored': True,
              'quality_claim': 'Execution verified; legal enforceability/superiority not established',
              'source_sha256': {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in [ROOT/'backend/synapse_mesh/tensor_fusion.py', ROOT/'backend/synapse_mesh/runtime.py',
                                             ROOT/'backend/synapse_mesh/intent.py', ROOT/'frontend/app/page.tsx']}}
    (ROOT / 'artifacts/tensor-pivot-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == '__main__': main()
