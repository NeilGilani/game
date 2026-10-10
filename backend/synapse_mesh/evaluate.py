"""Persist actual generations and matrix audits for blind human rubric review."""
import argparse
import json
from pathlib import Path

from .runtime import ROOT, Runtime
from .behavior import check_consent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="auto")
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/comparison.json")
    args = parser.parse_args()
    runtime = Runtime(device=args.device)
    results = []
    for case in json.loads((ROOT / "data/proof.json").read_text()):
        events = list(runtime.compare_events(case["prompt"], args.max_new_tokens))
        behavior = {e['event']: check_consent(e['text']) for e in events if e['event'] in ('baseline', 'fused')} if case['id'] == 'consent-validator' else None
        results.append({**case, "events": events, "behavioral_checks": behavior})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({"base_model": runtime.base_model, "device": runtime.device,
                                          "quality_verdict": "pending blind human rubric review",
                                          "results": results}, indent=2) + "\n")
        print(json.dumps({"completed": case["id"], "count": len(results)}), flush=True)


if __name__ == "__main__":
    main()
