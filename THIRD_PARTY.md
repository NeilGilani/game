# Third-party components

| Component | Where | License |
|---|---|---|
| MediaPipe Tasks Vision (`@mediapipe/tasks-vision` 0.10.35), including its WebAssembly runtime | `frontend/node_modules`, copied to `frontend/public/mediapipe/wasm` at build time | Apache License 2.0 |
| MediaPipe Face Landmarker model (`face_landmarker.task`, float16, v1) | `frontend/public/models/face_landmarker.task` (downloaded from `storage.googleapis.com/mediapipe-models`, SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`) | Apache License 2.0 |
| Atkinson Hyperlegible font (`@fontsource/atkinson-hyperlegible`) | bundled into the interface | SIL Open Font License 1.1 |
| React, Vite, FastAPI, Pydantic, Uvicorn, Anthropic Python SDK and other dependencies | `package.json`, `backend/requirements*.txt` | Their respective open-source licenses |

The end-to-end camera test downloads MediaPipe's public sample image
(`storage.googleapis.com/mediapipe-assets/portrait.jpg`) into an ignored cache at test time.
It is not committed to this repository and is not shown in the product.
