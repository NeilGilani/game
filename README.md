# Synapse-Mesh

A local proof of concept for prompt-dependent, direct tensor-level LoRA fusion. The Python kernel mutates model matrices on the accelerator, runs inference, and restores the base. The Next.js dashboard shows the expert vault, intent mixture, actual per-layer delta norms, and baseline/fused responses.

## Run the existing demo

From `/Users/ray/Sites/synapse-mesh`:

```sh
./run-demo.sh --dev
```

This starts both services and stops both on Ctrl+C. The default is the trained 1.5B base and `vault-1.5b`. The five-case comparison and review are in `artifacts/comparison.json` and `artifacts/review.json`. Historical FP32 evidence for the hospital audit prompt showed a specific privacy improvement: the baseline recommends patient names, ages, and medical history in logs; the fused answer excludes personal identifiers and restricts log access. Other cases have failures. This is a positive demo case, not evidence of general superiority or regulatory compliance.

To start the services separately:

```sh
cd backend
../.venv/bin/python -m uvicorn synapse_mesh.api:app --host 127.0.0.1 --port 8000
```

In another terminal:

```sh
cd /Users/ray/Sites/synapse-mesh/frontend
npm run dev
```

Open <http://127.0.0.1:3000>. Select one of five proof prompts, inspect automatic weights or adjust a manual mixture, and click **Fuse & compare**. The first request loads the plain base model. Automatic intent weights apply to the installed vault, with zero coefficients for irrelevant adapters. Factor pairs are read lazily only for nonzero coefficients; subsequent requests reuse a bounded CPU factor cache and the resident base. Both arms receive exactly the same user prompt, chat template, and greedy decoding parameters. No expert instructions are injected into the prompt.

Development mode compiles the current source without requiring a production build. The launcher sets `SYNAPSE_API_URL=http://127.0.0.1:8000` and waits for the frontend's `/kernel/health` proxy to respond before reporting readiness. For production, stop the running dashboard, run `npm run build` in `frontend`, then use `./run-demo.sh` without `--dev`. Do not rebuild `.next` while a production server is serving that directory.

The initial HTML fetches real health and intent data on the Next.js server, so viewing page source already shows adapter availability and the default prompt's weight vector. Browser JavaScript then refreshes health and opens the live WebSocket for prompt edits. Initial requests are uncached and time out after ten seconds; backend failures render an error and remain eligible for browser retries. Browser API calls use the same-origin `/kernel` proxy, so local operation does not require cross-origin CORS access to port 8000.

Run `node check-landslide.mjs` from `frontend` for the actual 512-token surgical-robot prompt comparison, or add `--balanced` to test an explicitly manual equal Code/Clinical/Legal mixture. The browser check verifies animated active beams, full UI coefficients against the kernel audit, nonzero tensor deltas, FP16 sample arithmetic, and restored base weights. Range controls preserve exact coefficients; the matrix inspector shows the coefficients recorded by the kernel. Outputs, screenshots, and audits are saved in `artifacts/landslide-*`. The qualitative review in `artifacts/landslide-review.json` records improvements and failures; the balanced trial improves some cross-domain structure but does not demonstrate enforceability or general superiority.

## Network-aware Sense → Reason → Fuse

`cisco_sentinel.py` polls IOS XE using read-only HTTPS RESTCONF, Basic authentication, and `Accept: application/yang-data+json`. Its default operational endpoint is `/restconf/data/ietf-interfaces:interfaces-state`, following [Cisco's interface telemetry tutorial](https://blogs.cisco.com/developer/coding-essentials-netdevops-part-4). Counter deltas produce RX/TX bit rates; IETF interface speed is in bits per second. Management latency is the measured RESTCONF request time, **not** surgical-device or data-plane latency. A first/reset counter sample conservatively selects CONGESTED until a rate is available. Authentication errors, timeouts, unusable/down interfaces, invalid payloads, and stale samples select OFFLINE.

`intent_orchestrator.py` now plans **before every next-token forward pass**, using the local MiniLM classifier on the original task plus the generated prefix (manual ideal weights stay fixed):

| Network state | Policy | Cap | Applied tensor coefficients |
| --- | --- | --- | --- |
| OPTIMAL | Ultra-Fusion | 1.0 | Proportional normalized intent mixture |
| CONGESTED | Lean-Fusion | 0.4 | Keep the mixture, proportionally shrink its total to 0.4 |
| CRITICAL | Critical-Fusion | 0.1 | Strongest ideal adapter gets 0.1; others get zero |
| OFFLINE | Safe-Mode | 0.1 | Cached generalist gets 0.1; skip the classifier |

`budget_weights(ideal, cap)` computes `actual_i = ideal_i / sum(ideal) * cap`. This agrees with `ideal * cap` when the ideal vector already sums to one. For unnormalized Code 0.8 / Legal 0.8 / Medical 0.4 and a cap of 0.6, the result is 0.24 / 0.24 / 0.12. Critical mode spends the cap only on the deterministic maximum. The kernel validates a total **at most one**, including a zero budget, and never normalizes the cap away.

The baseline and fused generations use the same base checkpoint and unmodified user prompt; the kernel performs `delta = torch.matmul(B, A)` and `target.add_(delta, alpha=coefficient * trained_scale)` on the accelerator. No remote inference API or alternate base model is used. The base and tokenizer load only from local cache. Zero-coefficient adapters are not read during fusion. Every step streams its ideal/actual vector, cap, network revision, cache decision, and token index. Matrix audits describe the actual last applied vector; the token ledger retains the full schedule.

**Cache correctness:** changing any coefficient invalidates `past_key_values`; the next forward pass recomputes the complete prefix under the new weights. Identical vectors reuse both the fused weights and the valid attention cache. This follows from the fact that [Transformer caches contain model-computed key/value states](https://huggingface.co/docs/transformers/main/kv_cache). Keeping old states after changing the weights would mix two different parameter settings. Cancellation, failure, and normal completion restore pristine base matrices.

**Performance:** a smaller scalar coefficient changes adapter influence; it does not change matrix size, precision, or dense FLOPs. Congested mode still computes the nonzero adapters. Critical mode avoids other adapters' products; changed weights add fusion and prefix-recomputation work. Actual token reasoning, total fusion, forward time, cache rebuilds, and wall time are measured. Unweighted delta norms are cached for audits; actual dense products and additions still run when coefficients change, without storing dense deltas. This does not guarantee faster generation, shorter answers, or improved correctness. The demo defaults to 64 tokens; longer runs are available.

The demo defaults to **MOCK TELEMETRY**. Use **Trigger congestion**, **Trigger critical**, **Disconnect network**, and **Restore network**, including during an active fused generation. These simulate telemetry; they do not change router traffic. The next token boundary sees the latest snapshot; an already-running device operation finishes under its captured vector. Manual ideal mixtures survive all overrides and return when OPTIMAL.

For an actual reserved sandbox, configure the variables documented in [.env.network.example](.env.network.example), set `CISCO_MODE=restconf`, and restart both services. Use your reservation's HTTPS origin and credentials. TLS verification defaults to enabled; set `CISCO_VERIFY_TLS=false` only for a sandbox requiring a self-signed certificate. `CISCO_INTERFACES` optionally limits monitoring to named uplinks. Congestion defaults are 70% utilization or 250 ms management latency; Critical defaults are 95% or 1,000 ms. Polling uses a two-second interval. Live mode rejects mock controls. Transport/authentication behavior is tested with mocked HTTP transports; a live Cisco session has not been tested without credentials.

The included `vault-1.5b/generalist` is a **separately trained rank-8 LoRA**, using 93 mixed Code/Clinical/Legal examples for 70 steps. It is a small synthetic demonstration adapter, not a validated safety model. Its configuration, actual tensors, dataset hash, losses, and pinned base revision are recorded locally. The backend preloads its half-precision factors into the bounded RAM cache at startup. Prepare it again with `.venv/bin/python scripts/train_generalist.py`; no training or download occurs per inference. If these local files are missing, Safe-Mode raises an error instead of falling back to a different model. Cloud discovery/downloads are paused while offline.

`GET /network` returns the current snapshot and `network_cap`; `POST /network/mock` accepts `OPTIMAL`, `CONGESTED`, `CRITICAL`, or `OFFLINE`. HTTP `/intent` and `/ws/weights` return `ideal_weights`, `weights`, `network_cap`, `budget_spent`, `fusion_mode`, and `network`. `/compare` and `/generate` emit `token_fusion` before each forward, streamed `token` text afterward, matrix `fusion` audits when coefficients change, and a final result containing the complete `token_schedule` and cache/update counts.

Run `node check-token-budget.mjs` from `frontend` to switch network states during real GPU generation and verify token coefficients, caps, kernel/UI symmetry, streamed baseline/fused output, restoration, source HTML, and mobile layout. `node check-network-fusion.mjs` checks all four states individually; `node check-network-controls.mjs` checks manual-mixture preservation. Backend tests in `test_token_budget.py` independently rebuild expected matrices from safetensors at every forward across live state transitions, inspect cache reuse/rebuilds, verify the classifier sees the generated prefix, and check cancellation/failure rollback. Results are saved in `artifacts/token-budget-*` and `artifacts/network-*`.

## Neural Fusion Dashboard (Visualizer)

The Next.js + Tailwind judge view shows a grid of installed adapters with brightness and contribution bars driven by the current vector. The animated Fusion Core merges colored beams into the base model; beam thickness and intensity follow each coefficient. Zero-weight adapters remain visible without active beams. After a comparison, the core uses the actual matrix sample returned by the kernel. Standard AI and Fused AI appear side by side with pipeline timings and the existing matrix inspector. Animations respect reduced-motion preferences.

Weight updates use a persistent WebSocket at `/ws/weights`, proxied by Next at `/kernel/ws/weights`. Send `{ "request_id": 1, "prompt": "Write a Python validator" }`; the backend returns `{ "event": "weights", "request_id": 1, "weights": { ... }, "active_experts": [ ... ], "evidence": { ... }, "excluded": { ... } }`. Manual updates additionally include `experts` and nonnegative ideal `weights`; the budget function normalizes their total before applying the cap. The backend validates vectors without loading the inference model. Invalid messages emit an error and leave the connection usable. The client debounces edits, ignores obsolete responses, and reconnects with capped exponential backoff. Automatic intent falls back to HTTP while the socket is unavailable. Actual comparison events continue over the existing streamed `/compare` endpoint.

Install the updated Python lock and npm dependencies before running. Restart the backend to register the new WebSocket endpoint. `npm run build` and `npm run dev` use Next's supported Webpack compiler. `SYNAPSE_API_URL` configures the proxy (set it when building production, or when starting development); optional `NEXT_PUBLIC_SYNAPSE_WS_URL` overrides the browser socket URL (set at build time). The default remains the local backend on port 8000.

Run `node check-visualizer.mjs` from `frontend` against a running dashboard, with `SYNAPSE_UI_URL` set to its URL (the check defaults to an isolated preview on port 3015). It checks real WebSocket classification, adapter/beam changes, manual controls, comparison rendering, mobile overflow, and reduced motion. Comparison rendering replays historical inference events; it does not claim a new model-quality evaluation. Results and screenshots are written to `artifacts/visualizer-*`.

Weights start pending until the Sifter returns a vector; the dashboard does not
display a fabricated equal mixture. Editing the prompt updates the vector over
WebSocket or HTTP. Enable **Manual weights** to adjust normalized sliders, then
click **Fuse & compare** to regenerate output with that mixture. Manual preview
and generation bypass the Sifter, so a missing intent model does not block them.
Classifier errors are displayed with the option to switch to manual weights.
Run `node check-dynamic-weights.mjs` from `frontend` to verify live prompt vectors,
slider payloads, HTTP fallback, and manual controls after a routing failure.
Its comparison request is mocked; the separate real two-mixture inference
evidence is in `artifacts/dynamic-weights-inference-check.json`.

## Direct tensor API (current engine)

The exported function is in `backend/synapse_mesh/tensor_fusion.py`. A standalone script loads the base and local factor files without any API server:

```sh
.venv/bin/python scripts/demo_tensor_fusion.py --prompt "Write a Python validator for clinical consent and privacy obligations" --weights 0.5 0.2 0.3 --max-new-tokens 128
```

Run `.venv/bin/python scripts/verify_tensor_pivot.py` to audit the current GPU/browser evidence.

Direct usage:

```python
from synapse_mesh.tensor_fusion import fuse_weights, restore_weights

# `base` is an AutoModelForCausalLM loaded on CUDA or Metal, in eval mode.
# No PeftModel wrapper is created. Paths are local adapter directories.
try:
    fused_model = fuse_weights(
        base,
        adapter_paths=["vault-1.5b/coding", "vault-1.5b/medical", "vault-1.5b/legal"],
        weight_vector=[0.2, 0.3, 0.5],
        base_model_id="Qwen/Qwen2.5-1.5B-Instruct",
    )
    output = fused_model.generate(**inputs, do_sample=False)
finally:
    restore_weights(base)
```

The function validates all active factor shapes before mutation, enters `torch.no_grad()`, sets `model.eval()`, disables gradients, and changes the actual base `nn.Linear.weight` tensors in place. It returns that same model. Zero-coefficient paths are never opened. Half-precision products use the PEFT storage orientation `B @ A` (`A=[rank,in]`, `B=[out,rank]`), plus each adapter's alpha/r or rsLoRA alpha/sqrt(r) scaling. Reversing the factors would not produce the base matrix shape.

Metal uses FP16; CUDA uses BF16 when supported, otherwise FP16. The CPU debugging fallback keeps the base FP32 but still calculates deltas in FP16. Each layer streams one A/B pair and one dense delta on the device, rather than making all adapters resident. The CPU cache is capped at 128 MB. Base snapshots remain on the device and are released when their target layers become inactive. The kernel checks device memory before allocating snapshots and rolls back mutations if factor loading or arithmetic fails; the runtime restores in `finally` after generation failures too. Half precision has normal rounding error; compare against the same precision when auditing the equation.

`frontend/check-tensor-pivot.mjs` runs the user's exact surgical-license prompt through real GPU inference and checks Chinese exclusion, lazy loading, FP16 products, zero adapter forward branches, nonzero expert matrix changes, restored base weights, dynamic prompt changes, displayed pipeline totals, client wall time, and mobile layout. Current evidence is in `artifacts/tensor-pivot-comparison.json` and `artifacts/tensor-pivot-browser-check.json`. The older `comparison.json`/`review.json` are historical FP32 quality evidence, not a fresh validation of the current precision or mixtures. The surgical example verifies execution; its prose still has legal/technical gaps and is not proof of enforceability or superiority.

## Timing and interpretation

Both arms use the same unmodified user prompt and decoding settings. Baseline runs first, followed by fusion and fused generation. The UI shows **pipeline time** for each arm, **ready N seconds after Run**, generation duration, token throughput, fusion overhead, restore overhead, shared base setup, queue time, and complete comparison wall time. Fused pipeline time includes intent classification, metadata reads, factor cache misses/transfers, tensor fusion, generation, and restoration. Shared base loading and queue wait are displayed separately. Cold first-arm effects and differing output token counts mean these runs are not controlled throughput benchmarks; no speedup is claimed.

## Fusion math

For matrices already resident on a device, the direct inference API computes
`W_fused = W_base + Σ alpha_i × (A_i @ B_i)`:

```python
from synapse_mesh.tensor_fusion import dynamic_fusion_kernel

# W_base: [out, in], A_i: [out, rank_i], B_i: [rank_i, in].
# All matrices share a floating dtype and device, e.g. CUDA FP16.
W_fused = dynamic_fusion_kernel(W_base, [(A_0, B_0), (A_1, B_1)], [0.7, 0.3])
```

Coefficients can also be a floating 1-D tensor on the same device. Signed,
unnormalized mixtures and different ranks are supported. The kernel uses
`torch.matmul(..., out=delta)` and `torch.add(..., out=fused)` with one reusable
delta buffer, leaves inputs unchanged, and disables autograd. Tensor coefficients
stay on the device; checking their finiteness synchronizes once before fusion.
An empty mixture returns a base copy. For stored PEFT factors, pass `(B_i, A_i)`
and multiply each coefficient by its trained LoRA scale.

For every adapted Linear layer:

```python
target.copy_(pristine_base)
for expert, weight in weights.items():
    delta = torch.matmul(B[expert], A[expert])
    target.add_(delta, alpha=weight * scaling[expert])
```

This implements `W_final = W_base + Σ weight_i × scaling_i × B_i @ A_i`. `scaling_i` comes from PEFT, including ordinary alpha/r and rsLoRA alpha/sqrt(r). Each delta is computed separately, so mixed ranks are supported and no cross-expert `B_i @ A_j` terms appear. Experts may adapt different subsets of layers; an absent delta contributes zero.

The kernel stores immutable base snapshots only for targeted layers on the same device. It constructs one full delta at a time, adds it in place, and restores from snapshots in a `finally` block. The inference model is an ordinary Transformers base model, with no PEFT adapter modules or forward branches. PEFT is used for training and independent test references only. One model lock covers loading, baseline generation, fusion, fused generation, and restoration. Fusion never saves or reloads a merged checkpoint.

The audit reports synchronized fusion latency, matrix shapes, each weighted contribution's Frobenius norm, device, and snapshot memory. It also exposes actual upper-left 6 × 6 samples of the first base matrix, all weighted deltas, and the fused result. The inspector displays their sum, and the post-fusion heatmap uses these real values. Before fusion, the grid is a schematic. Audit measurements and small sample transfers are included in fusion latency. Full matrices remain on the accelerator. GPU residency means CUDA device memory on NVIDIA hardware and Metal unified memory on this Mac. CPU operation is available for debugging but does not demonstrate the GPU requirement.

The default intent classifier uses the frozen local [all-MiniLM-L6-v2 encoder](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), a 22.7M-parameter BERT variant, pinned to `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`. It applies attention-masked mean pooling and L2 normalization, then scores the prompt against short domain prototypes (or a cloud adapter's expertise description). Keyword overlaps remain visible as diagnostic evidence but do not determine the coefficients. The previous vocabulary implementation is retained as `KeywordIntentClassifier` for explicit baseline comparisons; it is never a silent fallback.

For normalized prompt embedding `e` and prototype embeddings `p_ij`, the score is `s_i = max_j(e · p_ij)`. Among eligible adapters, `w_i = exp(s_i / T) / Σ_k exp(s_k / T)`, implemented with numerically stable `torch.softmax`, with default temperature `T = 0.1`. Language gates, similarities below `0.2`, and the eight-active-adapter budget mask coefficients to exact zero before normalization. If all language-eligible similarities are below the threshold, the classifier returns a uniform mixture across eligible adapters within that budget and marks `fallback: true`. If all adapters are language-excluded, it reports an error. Temperature and threshold are configurable routing heuristics, not calibrated probabilities of domain expertise. MiniLM is primarily an English encoder; multilingual semantic quality needs separate evaluation.

The direct output is a contiguous `torch.float32` tensor of shape `[N]`, in exactly the supplied adapter order, with finite nonnegative entries and a sum of one within float32 rounding tolerance (`1e-6`). No displayed decimal rounding enters fusion. `/intent` also returns `adapter_order`, `weight_vector`, `tensor_dtype`, and `tensor_shape`, alongside the existing weight mapping. Long prompts up to 8000 characters are chunked into 254 wordpieces and their embeddings are pooled by token count, preserving trailing intent. Encoding runs locally on CPU; frozen weights and a bounded prototype cache are reused across requests.

Download the pinned snapshot once, then classify without loading the generation model:

```sh
.venv/bin/python scripts/setup_intent_model.py
cd backend
../.venv/bin/python -m synapse_mesh.intent 'Write a Python function for clinical trial consent and privacy'
```

Inference resolves the cached snapshot to a local filesystem path and never contacts the Hub. Missing weights produce a setup error (HTTP 503 through `/intent`), not a keyword substitute. `SYNAPSE_INTENT_MODEL=/path/to/snapshot` selects an existing local MiniLM-compatible model. For custom adapters, supply descriptive expertise text:

```python
from synapse_mesh.intent import IntentClassifier

classifier = IntentClassifier()
adapter_order = ['coding', 'medical', 'legal']
weights = classifier.classify_tensor(
    'Write a Python function for clinical trial consent and privacy', adapter_order
)
# Pass this same order to adapter_paths. weights is a real float32 tensor.
fused_model = fuse_weights(base, adapter_paths, weights, adapter_names=adapter_order)

custom_weights = classifier.classify_tensor(
    'Reconcile quarterly expenses', ['coding', 'finance'],
    descriptions={'finance': 'Bookkeeping, financial statements, accounting and tax reconciliation'},
)
```

Real-model smoke tests cover paraphrases with no keyword overlap, long prompts, and network-free loading. Numerical tests cover the softmax equation, ordering, exclusions, fallback, concurrent calls, invalid inputs and direct linear combination. These checks establish execution and tensor contracts, not broad routing accuracy or improved fused answer quality. Historical artifacts below were generated with the earlier vocabulary classifier.

## Reproduce installation and training

Python 3.11+ and Node 20.9+ are required. The current environment uses Python 3.14, PyTorch 2.14, PEFT 0.21, Transformers 4.57, and Next.js 16.4. Exact installed Python versions are in `requirements-lock.txt`; npm versions are in `frontend/package-lock.json`.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-lock.txt
.venv/bin/python scripts/setup_intent_model.py
.venv/bin/python data/build_training.py
cd backend
../.venv/bin/python -m synapse_mesh.train --device auto
cd ../frontend
npm ci
npm run build
```

Default training uses the original synthetic educational corpus `data/train-initial.json`, 24 examples per domain (eight topics with three prompt phrasings), rank-8 q/v LoRAs, 70 steps per expert at learning rate 0.0002, AdamW, answer-only loss, seed 42, and float32 on Metal. `training.json` in each adapter directory records the data hash, base revision, steps, rank, learning rate, loss, and device. This tiny corpus demonstrates specialization machinery; it does not create validated coding, clinical, or legal expertise. Checkpoint downloads and training are setup operations. Warm fusion uses local safetensors factor pairs, with an LRU CPU cache; cache misses materialize factors lazily. All default adapters use the same pinned base revision.

For another compatible base, train every adapter against that exact base and point the runtime at its vault. The original 0.5B vault remains available:

```sh
cd backend
../.venv/bin/python -m synapse_mesh.train --base-model Qwen/Qwen2.5-0.5B-Instruct --vault ../vault --device auto
SYNAPSE_BASE_MODEL=Qwen/Qwen2.5-0.5B-Instruct SYNAPSE_VAULT=../vault ../.venv/bin/python -m uvicorn synapse_mesh.api:app --host 127.0.0.1 --port 8000
```

## Live cloud library

The dashboard now searches the live Hugging Face model catalog rather than a fixed list. **All cloud models** searches the public catalog; **LoRA / PEFT adapters** narrows it to PEFT-tagged repositories; **Current base family** finds repositories declaring adapters for the current Qwen base. Results paginate from the upstream API; the library has no fixed item count. Model cards and tags are discovery metadata, not proof of compatibility. Full checkpoints and adapters for other bases are displayed with their compatibility status and a source link.

Use **Inspect LoRA**, then **Download & add to vault**. You can also enter an `owner/model` ID and optional adapter subfolder. Inspection reads the actual PEFT configuration, verifies the exact base model, checks declared base revisions, supported matrix targets, rank, transformations, and download size. Downloads use immutable Hub commit IDs and safetensors files. No remote repository code is executed. A persisted registry at `vault-1.5b/cloud.json` points to pinned Hugging Face cache snapshots; fusion still performs zero disk merges.

The vault starts with three local educational adapters and currently includes two downloaded public examples: `bharati2324/Qwen2.5-1.5B-Instruct-Code-LoRA-r16v3` and `shibing624/chinese-text-correction-1.5b-lora`. The cloud UI can install additional compatible experts; their expertise keywords feed the local intent estimator. Automatic mode recomputes contribution weights and participating adapters from the prompt. Chinese text correction remains in the installed library but receives zero weight unless Chinese expertise is requested. Manual mode enables explicit checkbox selections and normalized coefficient sliders. The graph, equation, and matrix audits support arbitrary expert names. The laptop demo keeps **1–8 active experts** per run and accepts adapters up to **256 MB** with rank **1–128**. These are local resource limits, not cloud catalog limits. Installing more experts does not establish that their combination improves output quality.

Public, ungated repositories are supported. Adapters that omit a base revision are explicitly identified as such; they run against this demo's pinned base, which does not prove their training checkpoint was identical. Quantized weights, DoRA, transposed/embedding/conv adapters, adapter biases, modules_to_save, parameter-targeted and layer-replicating adapters are rejected. Arbitrary unrelated full models cannot be added together as LoRA deltas.

Endpoints: `GET /catalog?q=...&scope=all|adapters|compatible&cursor=...`, `POST /catalog/inspect`, and `POST /catalog/install`. Inspection/install bodies accept `repo_id`, `subfolder`, optional `revision`, and `expertise`. `/intent` and `/compare` accept an optional `experts` list; omitted selections classify across the installed vault, keeping irrelevant adapters at zero weight. No different base model or inference API is selected.

The earlier `frontend/check-cloud-library.mjs` verified live pagination, search, compatibility inspection, browser-driven installation, generalized controls, real multi-expert GPU generation, nonzero cloud delta contributions, restoration, and mobile layout. Its evidence is saved separately in `artifacts/cloud-browser-check.json` and `artifacts/cloud-comparison.json`; the original three-expert quality review remains in `artifacts/review.json`.

The catalog and PEFT loading follow the [Hugging Face Hub API](https://huggingface.co/docs/hub/api) and [PEFT integration](https://huggingface.co/docs/hub/peft).


## CLI and evaluation

The async orchestrator in `backend/synapse_mesh/orchestrator.py` connects the intent
classifier, installed Adapter Vault, and tensor Fusion Kernel. Its response path
emits `intent → loading → fusion → response → complete`, with no baseline pass.
Classification, vault reads, model loading, fusion, forward generation, and
restoration run through `asyncio.to_thread`, keeping the event loop available.
The runtime's model lock serializes each weight mutation and generation transaction.
Closing a stream or cancelling a request stops at a stage boundary; in-flight
device work finishes and base restoration completes before worker cleanup.

```python
import asyncio
from synapse_mesh.orchestrator import Orchestrator

async def main():
    pipeline = Orchestrator()  # Reuse this instance for subsequent prompts.
    result = await pipeline.run("Write a Python clinical consent validator", max_new_tokens=128)
    print(result["text"])
    print(result["intent"]["weights"])

asyncio.run(main())
```

`POST /generate` accepts the same body as `/compare` and streams response-only
NDJSON events. Both API routes and the CLI use the async orchestrator. For a single
fused response from the CLI:

```sh
cd backend
../.venv/bin/python -m synapse_mesh.cli 'Write a Python clinical consent validator' --response-only
```

```sh
cd backend
../.venv/bin/python -m synapse_mesh.cli 'Draft a license for clinical software with privacy and clinician review.' --device auto
../.venv/bin/python -m synapse_mesh.evaluate --device auto --max-new-tokens 512
../.venv/bin/python -m pytest -q
```

The CLI emits NDJSON events in order: intent, loading, baseline, fusion audit, fused text, completion. The fusion event reaches the dashboard before fused generation begins. The API exposes `/health`, `/proof`, `/intent`, and `/compare`; Next.js proxies them through `/kernel`. Override the API target with `SYNAPSE_API_URL` when building the dashboard.

`artifacts/comparison.json` contains actual five-case generations, measured matrices, timings, samples, and restoration confirmations. `comparison-initial.json` preserves the failed high-learning-rate experiment; `comparison-small-base.json` preserves the subsequent smaller-update run; `comparison-1.5b.json` preserves the initial 1.5B run. The proof prompts are development cases used to inspect and tune the demo, not an independent benchmark. Each prompt has explicit review criteria; a favorable example cannot establish broad superiority. Consent function checks use a restricted pure AST evaluator; unsupported code is marked unverified, not inferred correct.

An experimental `calibrate.py` trains separately trained adapter factors jointly under the classifier's mixture weights. Training uses PEFT's mathematically equivalent sum of low-rank contributions, with dropout zero; inference still uses the dense weight kernel. The additional corpus in `data/train.json` has 93 examples and excludes the exact comparison prompts. The tested 0.5B calibration did not reliably improve output quality, so it is **not** the default. Its vault and results remain in `vault-calibrated` and `artifacts/comparison-calibrated.json`:

```sh
cd backend
../.venv/bin/python -m synapse_mesh.calibrate --base-model Qwen/Qwen2.5-0.5B-Instruct --source-vault ../vault --target-vault ../vault-calibrated --steps 160 --lr 0.0001
```

The 27 tests use real tiny Qwen models and PEFT adapters to compare dense fused logits against PEFT's reference deltas, including mixed ranks and rsLoRA. They also cover exception recovery, drift-free repeated requests, zero contributions, invalid weights, the classifier, API validation, and Metal matrices when available.

For browser checks, start both servers, install a Playwright browser if needed, and run:

```sh
cd frontend
node check-dashboard.mjs
```

`SYNAPSE_BROWSER_PATH` may point to an existing Chromium executable. The check performs real inference, validates both outputs and every reported matrix row (56 for the default base), verifies the sample addition equation, tests manual weights and prompt selection, and checks a 390px mobile viewport. Screenshots and phase evidence are saved under `artifacts/`.

The Next.js proxy allows five minutes for laptop inference, including a cold model load. No inference process runs in the browser. Run `.venv/bin/python scripts/verify_artifacts.py` from the project root to audit the shipped five-case results, on-device matrix evidence, base revision, training-data hashes, JSON examples, privacy difference, and browser evidence. It writes `artifacts/verification.json`; it does not certify model accuracy.

## Source references

The implementation follows [PEFT's LoRA scaling and merge semantics](https://huggingface.co/docs/peft/package_reference/lora), [PyTorch's Metal device support](https://docs.pytorch.org/docs/main/notes/mps.html), and [Next.js external rewrites](https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites). Bases: [Qwen2.5-1.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct) and [Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct).

## Llama-3-8B 4-bit Adapter Vault

`backend/synapse_mesh/adapter_vault.py` provides the separate `AdapterVault` class requested for base-model and adapter-file management. Its default base is `meta-llama/Meta-Llama-3-8B`. It loads the base with Transformers `BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True)` on one CUDA device. It keeps adapter factors in BF16 on supported CUDA devices, otherwise FP16, and refuses a silent full-precision base fallback. `device="cpu"` is an explicit quantized verification mode; this implementation does not enable bitsandbytes MPS loading.

Install the optional dependency into the existing environment:

```sh
.venv/bin/python -m pip install -r requirements-vault.txt
```

Llama-3 weights require access to the Meta repository and its license; use existing Hugging Face login credentials or pass `token=` to the constructor. Authentication credentials are never written to the vault manifest. Use actual adapters trained for this exact Llama base; the current demo's Qwen adapters are incompatible and are rejected.

```python
from synapse_mesh.adapter_vault import AdapterVault

with AdapterVault(
    device="cuda:0",
    manifest="vault-llama3/library.json",
    max_resident_adapters=3,
    max_adapter_bytes=256 * 1024 * 1024,
) as vault:
    vault.register("Medical", "./vault-llama3/medical")
    vault.register("Legal", "./vault-llama3/legal")
    vault.register("Coding", "./vault-llama3/coding")
    base = vault.load_base_model()  # NF4 + double quantization
    medical = vault.get_matrices("Medical")
    pair = vault.get_pair("Medical", "model.layers.0.self_attn.q_proj")
    A, B = pair.A, pair.B          # tensors on the configured GPU
    delta = pair.scaling * (B @ A)
    del A, B, pair, medical        # release borrowed tensor references
    vault.unload_adapter("Medical")
```

Registration is metadata-only; the base and adapter factors load on demand. Local adapter directories and Hub IDs are supported. Hub downloads are pinned to resolved immutable commits and fetch only PEFT config/safetensors files. `layer_names()` validates metadata and shape headers without loading factor tensors into VRAM. `load_adapter()`/`get_matrices()` return all module pairs for a specialist; `get_pair()` returns one module's pair from that lazily loaded specialist. Both include ordinary alpha/r or rsLoRA scaling. Names are case-insensitive. `status()` exposes resident factor bytes, `unload_adapter()` releases vault-owned tensors, LRU eviction enforces count/byte budgets, `unregister()` removes library metadata, and `close()` clears base/tokenizer/factor references. Caller-held references can keep device memory allocated after eviction.

This is the quantized storage/retrieval component, not a new inference router. It does not activate PEFT forward branches or fuse into packed 4-bit parameters. The existing `fuse_weights` operates on floating-point base weights; quantized fusion requires a separate dequantize/fuse/requantize or fused-matmul kernel. The local dashboard continues to use its tested direct FP16 Qwen engine.

Example inspection command (substitute real Llama-compatible adapter directories or Hub IDs):

```sh
.venv/bin/python scripts/demo_adapter_vault.py --device cuda:0 --adapter Medical=./vault-llama3/medical --adapter Legal=./vault-llama3/legal --adapter Coding=./vault-llama3/coding
```

Verification uses an actual tiny Llama NF4 base through bitsandbytes, real PEFT adapter files, exact A/B/scaling retrieval, finite forward logits, lazy registration/header listing, LRU eviction, memory limits, persistent manifests, and incompatible-base rejection. On this Mac, CPU NF4 tests run; the real CUDA/VRAM test skips because CUDA is unavailable. Full gated Llama-3-8B CUDA execution has not been verified here. See the [bitsandbytes installation guide](https://huggingface.co/docs/bitsandbytes/v0.50.2/en/installation), [Transformers quantization integration](https://huggingface.co/docs/transformers/main/en/quantization/bitsandbytes), and [Llama-3 model repository](https://huggingface.co/meta-llama/Meta-Llama-3-8B).
