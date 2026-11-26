FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    KAGIT_ENABLE_GPU_MODELS=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3-pip ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt requirements-gpu.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Uncomment on GPU builds to pre-install CUDA neural adapters (SAM-2 / Depth-Anything-v2 / Diffusers / Gemini):
# RUN pip3 install --no-cache-dir -r requirements-gpu.txt

COPY . .
EXPOSE 8090
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090"]
