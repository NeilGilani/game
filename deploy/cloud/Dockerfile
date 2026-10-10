FROM python:3.12-slim-bookworm

ARG TORCH_VERSION=2.10.0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HF_HOME=/cache/huggingface \
    CLOUD_VAULT_MANIFEST=/adapters/vault.json CLOUD_DEVICE=cuda:0

RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN python -m pip install --no-cache-dir "torch==${TORCH_VERSION}" --index-url "${TORCH_INDEX_URL}"
COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/synapse_mesh /app/backend/synapse_mesh
RUN python -m pip install --no-cache-dir /app/backend \
    && useradd --create-home --uid 10001 kernel \
    && mkdir -p /cache/huggingface && chown -R kernel:kernel /cache
USER kernel
EXPOSE 8001
HEALTHCHECK --interval=10s --timeout=3s --start-period=300s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=2)"
CMD ["python", "-m", "uvicorn", "synapse_mesh.cloud_api:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
