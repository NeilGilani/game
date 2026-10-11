# Synapse-Mesh (Ray's expert-fusion model)

> **Two versions.** The first Synapse-Mesh generated on the Mac. The current one is an *edge controller*: it
> classifies the request on the Mac, then sends it to a **cloud GPU kernel** (`deploy/cloud` in Ray's repo),
> with a Cisco sentinel adapting how much fusion it asks for to the network state. AGENCY reads which one is
> running from `/health`: the edge version is labelled **Synapse-Mesh (cloud GPU via this Mac)**, never
> "on-device", and private explanations never use it. The cloud kernel needs an NVIDIA GPU server that hasn't
> been provisioned yet (per Ray's README); without it the edge reports an error and AGENCY uses its own words.

AGENCY can use [Synapse-Mesh](https://github.com/RayB-007/synapse-mesh), a small model that runs entirely on
the Mac (Qwen2.5-1.5B with code, medical and legal experts blended per token), as its **offline and private
explainer**.

| Job | Who does it |
|---|---|
| Understanding a goal, adapting a plan | Gemini (or Claude) when configured, otherwise AGENCY's built-in rules and plans. Never the on-device model: 1.5B is too small to plan reliably |
| Explaining an approval in plain words | Gemini first. If Gemini can't be reached (no internet, rate limit, outage) or isn't configured, the on-device model. With `AGENCY_PRIVATE_EXPLANATIONS=1`, only the on-device model |
| If the on-device model fails too | AGENCY's own fixed explanation, as before |

The explanation is always shown next to AGENCY's own facts, labelled **"Explained on this computer by
Synapse-Mesh"**, and it can't approve, change or skip anything. If Gemini refuses a request, AGENCY doesn't
route around the refusal through the on-device model. The server address must be on this computer
(`127.0.0.1`/`localhost`), so nothing leaves the Mac.

## Set it up on your Mac (once)

You need Ray's checkout **with its model files**. The `vault-1.5b/` and `models/` folders aren't in git, so copy
them from Ray's Mac or build them with his scripts.

```sh
git clone https://github.com/RayB-007/synapse-mesh.git ~/synapse   # or: git clone -b ray/synapse-mesh <this repo> ~/synapse
cd ~/synapse
python3.11 -m venv .venv && .venv/bin/pip install -r requirements-lock.txt
cp -R /path/from/ray/vault-1.5b /path/from/ray/models .              # Ray's model files
.venv/bin/python scripts/setup_intent_model.py                       # the intent classifier, if not copied
```

PyTorch and the base model need roughly 3 to 4 GB of disk. An Apple-silicon Mac runs it on the GPU (Metal).

## Run both

```sh
cd ~/agency
make demo-local                      # or: make demo-local SYNAPSE_DIR=/path/to/synapse-mesh
```

This starts Synapse-Mesh on port 8100 and AGENCY on 8000, with `AGENCY_LOCAL_MODEL_URL` set. Open
<http://localhost:8000>.

## Try it

1. **No internet:** keep your `GEMINI_API_KEY`, turn Wi-Fi off, start a task, and choose **Explain** on an
   approval. You get "Explained on this computer by Synapse-Mesh". With no Gemini key at all, the status bar
   reads **On-device · Synapse-Mesh**.
2. **Private:** put `AGENCY_PRIVATE_EXPLANATIONS=1` in `.env` and restart. Explanations now always come
   from the Mac, even when Gemini works; plans can still use Gemini.
3. **Server down:** stop Synapse-Mesh. Explanations fall back to AGENCY's fixed wording, and
   `/api/health` reports why.

The first explanation takes longer while the model loads.

## What was tested, and where

Tested in the cloud development container with a fake Synapse-Mesh server that speaks its real protocol
(`POST /generate` streaming NDJSON events ending in `response`, `GET /health`): see
`backend/tests/test_local_model.py`. **Ray's real model hasn't been run with AGENCY yet.** Its files are on
Ray's Mac, so the first real run is yours.
