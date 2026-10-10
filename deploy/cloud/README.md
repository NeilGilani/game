The cloud service hosts one plain base model and all configured LoRA A/B factors
on a CUDA GPU. `/generate` receives a prompt and coefficients, directly modifies
the base tensors, decodes tokens using that same model, and restores pristine
weights before the next request. It never calls an external inference API.

This deployment selects `CLOUD_VAULT_MODE=resident` for a fully warmed, immutable
GPU vault. The service also supports `shared` (the default outside this recipe),
which uses the project's `VaultManager` to lazily cache factors from a shared
volume with leases and LRU eviction. Shared mode performs metadata/stat checks
on requests, while resident mode prepares all plans and snapshots once.

`tensor_fusion.ResidentFusion` validates metadata once, lazily loads factors,
then retains them on the model's device. The service warms the entire vault at
startup before it becomes ready. Warm requests do not reopen adapter files or
copy factors from CPU. One dense delta workspace is reused for every product.
Replace adapter files only while the service is stopped, then restart to reload.

Deployment to Outshift was skipped at the user's request. No remote GPU endpoint
has been provisioned or verified. Docker is also unavailable on the development
laptop; the container recipe still needs a build and CUDA smoke test on a server.

Run on a GPU server
-------------------

The host needs an NVIDIA GPU/driver, Docker Compose, and the NVIDIA Container
Toolkit. The CUDA 12.8 wheel requires a compatible host driver. Run from a
checkout of this repository on that host. Adapter weights
are deliberately outside Git: transfer the `vault-1.5b` directory separately.
Do not copy its `cloud.json` registry; it contains laptop-specific cache paths.
The included manifest selects the three project specialists plus generalist.

```sh
cp deploy/cloud/.env.example deploy/cloud/.env
cp deploy/cloud/vault.example.json vault-1.5b/vault.json
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
# Put the generated token into CLOUD_API_KEY in deploy/cloud/.env.
docker compose -f deploy/cloud/compose.yaml up --build -d
docker compose -f deploy/cloud/compose.yaml logs -f kernel
curl http://127.0.0.1:8001/health
```

The example base is the existing project's Qwen2.5-1.5B, pinned to the revision
used to train its adapters. To use Llama-3-8B, provide adapters trained for that
exact base, update `base_model` and `base_revision`, and supply `HF_TOKEN` if
needed. Qwen adapters cannot be applied to Llama. FP16/BF16 base weights are
required: adding a dense delta to packed bitsandbytes 4-bit storage is not valid.

The Dockerfile installs PyTorch 2.10.0 from the official CUDA 12.8 wheel index;
adjust its build arguments for the server's supported CUDA runtime. Official
wheel availability is documented in the [PyTorch index](https://download.pytorch.org/whl/cu128/torch/).
Models download only at startup into the persistent model cache. Set
`CLOUD_LOCAL_FILES_ONLY=true` after populating it to require fully offline loading.

Use exactly one Uvicorn worker per GPU. Separate processes would each load their
own base model and vault; see [FastAPI's process/memory guidance](https://fastapi.tiangolo.com/deployment/concepts/).
The service serializes full fusion/generation/restoration transactions, bounds
queued requests, and returns HTTP 503 when the admission queue is full.

VRAM must fit the base, resident factors, snapshots of every adapter-targeted
matrix, one largest-layer delta workspace, and generation/KV-cache headroom.
Startup checks the configured vault cache budget and available VRAM. More
adapter targets require more snapshot memory. A generation OOM produces an error
and restores weights; lower context/output limits or use a larger GPU.

API and token stream
--------------------

The examples assume `CLOUD_API_KEY` is already set in your shell; use the token
from the server's `.env`. `/health` needs no token. Model inventory and inference
require bearer authentication. By default the port binds to the server loopback;
use `ssh -N -L 8001:127.0.0.1:8001 username@host` to access it from your laptop.

```sh
curl http://127.0.0.1:8001/adapters \
  -H "Authorization: Bearer $CLOUD_API_KEY"

curl -N http://127.0.0.1:8001/generate \
  -H "Authorization: Bearer $CLOUD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Draft a legally binding Software License Agreement for a new AI-driven surgical robot, but write it as a medical prescription that a surgeon would read, ensuring it maintains strict legal enforceability while using clinical terminology to describe the technical constraints of the hardware.","weight_vector":{"coding":0.3,"medical":0.3,"legal":0.4,"generalist":0.0},"max_new_tokens":192}'
```

`POST /generate` and `/v1/generate` accept:

- `prompt`: the unchanged user text; no additional specialist system message.
- `weight_vector`: a list in `/adapters`'s `adapter_order`, or a dictionary with
  exactly those names. Coefficients must be finite, nonnegative, and sum to at
  most 1. Network caps below 1 are preserved; they are never normalized upward.
  An all-zero vector runs the pristine base, useful for baseline comparison.
- `max_new_tokens`: bounded by `CLOUD_MAX_NEW_TOKENS`.
- `stream`: defaults to true; false returns one JSON result after restoration.

The native NDJSON stream contains `fusion`, `token`, then `complete` events. `fusion`
includes the exact applied coefficients, actual matrix samples, dtype/device,
timing, and cache-load counts. Each token contains its integer ID, complete
decoded `text`, and an incremental `delta`. Prefer replacing displayed text with
the complete `text` because tokenizers can revise whitespace/partial characters.
`complete` includes final text, token IDs, timings, and `base_restored: true`.
Errors after streaming starts are terminal `error` events, never fake completions.
Client disconnects stop decoding and restore the base before releasing the model.
The producer queue is bounded so a slow client cannot buffer unlimited tokens.

The edge controller uses the matching `POST /rpc` JSON-RPC endpoint instead.
Set `SYNAPSE_CLOUD_KERNEL_URL=http://127.0.0.1:8001/rpc` on the edge (through an
SSH tunnel), and `SYNAPSE_CLOUD_KERNEL_API_KEY` to the server's bearer token.
`fuse_and_generate` accepts the edge's `weights` and `adapter_order`; unknown
adapters are rejected and configured adapters omitted from that order receive
zero weight. `network_cap` is enforced. `compare: true` runs the pristine
baseline first, emits its actual output, then fuses and generates the other arm.

RPC text chunks use contiguous 1-based indices. The final `done: true` frame
repeats the last indexed chunk so the edge can deduplicate it; an empty
generation finishes with empty text at index 0. Fusion audits retain the
dashboard's top-level matrix fields. A bounded process-local journal keeps 32
recent requests for five minutes. Retries supply the same request ID and
`resume_from`; incomplete generations condition on their exact cached token IDs.
If retry coefficients change, the new vector applies to the continuation; the
published prefix is preserved. Completed requests replay without another forward
pass. Expired/restarted records fail explicitly when asked to resume after a
token, and active requests return 503 until their transaction finishes restoring.

The math includes the adapter's trained scaling:
`W_base + sum(weight_i * scale_i * (B_i @ A_i))`, where `scale_i` is `alpha/r`
or `alpha/sqrt(r)` for rsLoRA. Factors are never averaged separately. Reducing
nonzero coefficients changes the model but does not itself reduce the number of
matrix products; true sparse vectors skip zero-weight experts. There is no
claimed performance or quality improvement without measuring it on the GPU.

Local verification
------------------

```sh
PYTHONPATH=backend .venv/bin/python -m pytest backend/tests/test_cloud_kernel.py -q
```

Tests use tiny randomly initialized models and real PEFT safetensors, compare
every fused weight against independent PEFT math, forbid disk reads after warmup,
check factor storage reuse, exercise token streaming/JSON/authentication, and
verify restoration after cancellation and errors. The CUDA residency test runs
only when CUDA is available. CPU tests are correctness checks, not GPU benchmarks;
production loading explicitly refuses CPU and Metal fallbacks.
