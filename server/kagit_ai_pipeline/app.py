"""
KÂĞIT 2.5D Real Full-Stack GPU / OpenCV / Gemini / FFmpeg FastAPI Production Server.
Endpoints:
  GET  /health
  POST /api/v1/decompose-character
  POST /api/v1/decompose-background
  POST /api/v1/direct-film
  POST /api/v1/refine-frame          (Phase 5 RTX CUDA / OpenCV + Gemini Neural Cinema Refiner)
  POST /api/v1/synthesize-voice      (Phase 5 Gemini 3.8 Flash TTS Character Voice Acting)
  POST /api/v1/transcode-mp4         (Phase 5 Broadcast H.264/AAC FFmpeg MP4 Transcoder)
  GET  /                             (Serves built production dist/ automatically when present!)
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from pipeline.background_slicer import decompose_background
from pipeline.character_decomposer import decompose_character, detect_hardware_capabilities
from pipeline.cinema_refiner import refine_cinema_frame
from pipeline.director_llm import direct_film_script
from pipeline.mp4_transcoder import transcode_to_broadcast_mp4
from pipeline.voice_tts import VOICE_PRESETS, synthesize_character_voice

app = FastAPI(
    title="KÂĞIT 2.5D Film AI & Cinema Pipeline",
    version="2.0.0",
    description="RTX CUDA + OpenCV + Gemini + FFmpeg Production Backend for KÂĞIT Studio",
)

_ALLOWED_ORIGINS = [
    o.strip() for o in os.getenv("KAGIT_ALLOWED_ORIGINS", "*").split(",") if o.strip()
] or ["*"]
MAX_IMAGE_BYTES = int(os.getenv("KAGIT_MAX_IMAGE_BYTES", str(20 * 1024 * 1024)))
MAX_VIDEO_BYTES = int(os.getenv("KAGIT_MAX_VIDEO_BYTES", str(150 * 1024 * 1024)))


async def _read_bounded(upload: UploadFile, max_bytes: int, label: str) -> bytes:
    raw = await upload.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"{label} exceeds max allowed size ({max_bytes // (1024 * 1024)} MB)",
        )
    return raw


app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Voice-Engine", "X-Video-Codec", "X-Refiner-Engine"],
)


class DirectFilmRequest(BaseModel):
    prompt: str
    style_dna: dict[str, Any] | None = None


class SynthesizeVoiceRequest(BaseModel):
    text: str
    emotion: str = "neutral"
    voice_name: str = "Puck"


@app.get("/health")
def health() -> dict[str, Any]:
    caps = detect_hardware_capabilities()
    return {"status": "ok", "version": "2.0.0", "voices": VOICE_PRESETS, **caps}


@app.post("/api/v1/decompose-character")
async def api_decompose_character(file: UploadFile = File(...)) -> dict[str, Any]:
    raw = await _read_bounded(file, MAX_IMAGE_BYTES, "Character image")
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image upload: {exc}") from exc
    return decompose_character(img)


@app.post("/api/v1/decompose-background")
async def api_decompose_background(
    file: UploadFile = File(...),
    horizon_y: float = Form(0.56),
) -> dict[str, Any]:
    raw = await _read_bounded(file, MAX_IMAGE_BYTES, "Background image")
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid background image: {exc}") from exc
    return decompose_background(img, horizon_y=horizon_y)


@app.post("/api/v1/direct-film")
def api_direct_film(req: DirectFilmRequest) -> dict[str, Any]:
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt must not be empty")
    return direct_film_script(req.prompt, style_dna=req.style_dna)


@app.post("/api/v1/refine-frame")
async def api_refine_frame(
    file: UploadFile = File(...),
    look: str = Form("ghibli-watercolor"),
    engine: str = Form("gpu-opencv"),
    light_angle_deg: float = Form(22.0),
    style_dna_json: str = Form("{}"),
) -> dict[str, Any]:
    raw = await _read_bounded(file, MAX_IMAGE_BYTES, "Frame image")
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid frame image: {exc}") from exc

    try:
        style_dna = json.loads(style_dna_json) if style_dna_json else {}
    except Exception:
        style_dna = {}

    return refine_cinema_frame(
        img=img,
        look=look,
        engine=engine,
        light_angle_deg=light_angle_deg,
        style_dna=style_dna,
    )


@app.post("/api/v1/synthesize-voice")
def api_synthesize_voice(req: SynthesizeVoiceRequest) -> Response:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    try:
        wav_bytes, engine_tag = synthesize_character_voice(
            text=req.text,
            emotion=req.emotion,
            voice_name=req.voice_name,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"TTS failed: {exc}") from exc

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"X-Voice-Engine": engine_tag},
    )


@app.post("/api/v1/transcode-mp4")
async def api_transcode_mp4(
    file: UploadFile = File(...),
    cinema_look: str = Form("none"),
) -> Response:
    raw = await _read_bounded(file, MAX_VIDEO_BYTES, "Video upload")
    if len(raw) < 64:
        raise HTTPException(status_code=400, detail="Empty video upload")
    ext = "webm"
    if file.filename and "." in file.filename:
        ext = file.filename.rsplit(".", 1)[-1]
    try:
        mp4_bytes = transcode_to_broadcast_mp4(raw, input_ext=ext, cinema_look=cinema_look)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"MP4 transcode failed: {exc}") from exc

    return Response(
        content=mp4_bytes,
        media_type="video/mp4",
        headers={"X-Video-Codec": "h264-aac-yuv420p"},
    )


# Mount built Vite production dist/ if present so http://localhost:8090 serves the full app!
_DIST_DIR = Path(__file__).resolve().parents[2] / "dist"
if (_DIST_DIR / "index.html").is_file() and os.getenv("KAGIT_SERVE_STATIC", "1") == "1":
    @app.middleware("http")
    async def _no_cache_index_html(request: Any, call_next: Any) -> Any:
        response = await call_next(request)
        if request.url.path in ("/", "/index.html", "/sw.js"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

    app.mount("/", StaticFiles(directory=str(_DIST_DIR), html=True), name="kagit-web")
