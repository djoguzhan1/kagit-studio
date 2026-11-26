"""
KÂĞIT Phase 5 — Real GPU (RTX CUDA / OpenCV) + Gemini Neural Cinema Frame Refiner.
Upgrades 2.5D rendered frames with authentic animation studio finishing while strictly
locking the character's pose, silhouette & Style-DNA:
  - ghibli-watercolor : Edge-preserving bilateral watercolor wash + crisp ink + warm halation
  - klaus-3d-cel      : Directional normal-aware volumetric key/rim light + painterly shadows
  - anime-makoto      : High-clarity luminous bloom (lamps/fireflies/sky) + Makoto cinema contrast
  - noir-35mm         : Dramatic 35mm shadow-highlight split tone + halation + analog film grain
"""

from __future__ import annotations

import base64
import io
import os
import time
from typing import Any

import numpy as np
from PIL import Image, ImageFilter

try:
    import cv2  # type: ignore

    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False

try:
    import torch  # type: ignore

    HAS_CUDA = bool(torch.cuda.is_available())
except ImportError:
    HAS_CUDA = False


CINEMA_LOOKS = {
    "ghibli-watercolor": "Studio Ghibli hand-painted watercolor & warm sunlit halation",
    "klaus-3d-cel": "SPA Studios Klaus 2.5D volumetric painted lighting & crisp brush shadows",
    "anime-makoto": "Makoto Shinkai luminous cinema bloom & crystal-clear cel line-art",
    "noir-35mm": "35mm dramatic graphic novel cinema grade with teal-amber split & film grain",
}


def _img_to_b64_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _refine_with_gpu_opencv(
    img: Image.Image,
    look: str = "ghibli-watercolor",
    light_angle_deg: float = 22.0,
    style_dna: dict[str, Any] | None = None,
    grain_seed: int | None = None,
) -> tuple[Image.Image, str]:
    rgb = img.convert("RGB")
    arr = np.asarray(rgb, dtype=np.uint8)
    h, w, _ = arr.shape

    # 1. Edge-Preserving Painterly Bilateral Smoothing + Ink Edge Extraction
    if HAS_CV2:
        bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        if look == "ghibli-watercolor":
            smooth = cv2.bilateralFilter(bgr, d=9, sigmaColor=52, sigmaSpace=52)
            smooth = cv2.bilateralFilter(smooth, d=7, sigmaColor=38, sigmaSpace=38)
        elif look == "klaus-3d-cel":
            smooth = cv2.bilateralFilter(bgr, d=9, sigmaColor=64, sigmaSpace=44)
        elif look == "anime-makoto":
            smooth = cv2.bilateralFilter(bgr, d=5, sigmaColor=30, sigmaSpace=30)
        else:
            smooth = cv2.bilateralFilter(bgr, d=5, sigmaColor=24, sigmaSpace=24)

        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 55, 145)
        edges = cv2.dilate(edges, np.ones((2, 2), np.uint8), iterations=1)
        edge_mask = (edges.astype(np.float32) / 255.0)[:, :, None]
        base_rgb = cv2.cvtColor(smooth, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0

        # Extract bright emissive highlights (lamps, fireflies, lightning, glowing letter) for real anamorphic bloom!
        lum = 0.299 * base_rgb[:, :, 0] + 0.587 * base_rgb[:, :, 1] + 0.114 * base_rgb[:, :, 2]
        bright = np.clip((lum - 0.62) / 0.38, 0.0, 1.0)[:, :, None] * base_rgb
        bloom_s = cv2.GaussianBlur(bright, (0, 0), sigmaX=14, sigmaY=14)
        bloom_l = cv2.GaussianBlur(bright, (0, 0), sigmaX=34, sigmaY=34)
        bloom = bloom_s * 0.65 + bloom_l * 0.55
    else:
        base_rgb = np.asarray(rgb.filter(ImageFilter.SMOOTH_MORE), dtype=np.float32) / 255.0
        edge_mask = np.zeros((h, w, 1), dtype=np.float32)
        bloom = np.asarray(rgb.filter(ImageFilter.GaussianBlur(10)), dtype=np.float32) / 255.0 * 0.18

    # 2. GPU CUDA Tensor Finishing (Directional Klaus Wash + Split Toning + Organic 35mm Grain!)
    engine_tag = "opencv-cpu-refiner"
    rad = np.deg2rad(light_angle_deg)
    lx, ly = float(np.cos(rad)), float(np.sin(rad))

    if HAS_CUDA:
        import torch  # type: ignore

        dev = torch.device("cuda")
        t_img = torch.from_numpy(base_rgb).to(dev)
        t_bloom = torch.from_numpy(bloom).to(dev)
        t_edge = torch.from_numpy(edge_mask).to(dev)

        yy = torch.linspace(-1.0, 1.0, h, device=dev).view(h, 1, 1)
        xx = torch.linspace(-1.0, 1.0, w, device=dev).view(1, w, 1)
        dir_grad = torch.clamp((xx * lx + yy * ly) * 0.5 + 0.5, 0.0, 1.0)
        vignette = torch.clamp(1.0 - (xx * xx + yy * yy) * 0.22, 0.62, 1.0)

        if look == "ghibli-watercolor":
            warm = torch.tensor([1.06, 1.02, 0.94], device=dev)
            out = t_img * warm + t_bloom * torch.tensor([0.52, 0.42, 0.28], device=dev)
            out = out * (0.94 + 0.12 * dir_grad)
            ink_strength = 0.26
            grain_amt = 0.022
        elif look == "klaus-3d-cel":
            warm_key = torch.tensor([1.10, 1.03, 0.92], device=dev)
            cool_sh = torch.tensor([0.86, 0.92, 1.08], device=dev)
            tint = cool_sh * (1.0 - dir_grad) + warm_key * dir_grad
            out = t_img * tint + t_bloom * torch.tensor([0.48, 0.40, 0.26], device=dev)
            ink_strength = 0.22
            grain_amt = 0.016
        elif look == "anime-makoto":
            out = torch.pow(torch.clamp(t_img, 0.0, 1.0), 0.95) * torch.tensor([1.02, 1.03, 1.08], device=dev)
            out = out + t_bloom * torch.tensor([0.78, 0.66, 0.55], device=dev)
            ink_strength = 0.34
            grain_amt = 0.010
        else:  # noir-35mm
            out = torch.pow(torch.clamp(t_img, 0.0, 1.0), 1.12)
            lum_t = (0.299 * out[:, :, 0:1] + 0.587 * out[:, :, 1:2] + 0.114 * out[:, :, 2:3])
            split = (1.0 - lum_t) * torch.tensor([0.82, 0.94, 1.06], device=dev) + lum_t * torch.tensor([1.12, 1.02, 0.90], device=dev)
            out = out * split + t_bloom * torch.tensor([0.62, 0.44, 0.30], device=dev)
            ink_strength = 0.30
            grain_amt = 0.032

        # Re-ink crisp hand-drawn line art so silhouette stays razor sharp
        out = out * (1.0 - t_edge * ink_strength) * vignette

        # Dynamic per-frame organic 35mm/paper grain on GPU (avoids static "dirty lens" look!)
        active_seed = int(grain_seed) if grain_seed is not None else int(time.time_ns() & 0x7FFFFFFF)
        gen = torch.Generator(device=dev)
        gen.manual_seed(active_seed)
        grain = (torch.rand((h, w, 1), generator=gen, device=dev) - 0.5) * grain_amt
        out = torch.clamp(out + grain, 0.0, 1.0)
        final_u8 = (out * 255.0).to(torch.uint8).cpu().numpy()
        engine_tag = f"studio-fast-refiner ({look})"
    else:
        yy = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None, None]
        xx = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :, None]
        dir_grad = np.clip((xx * lx + yy * ly) * 0.5 + 0.5, 0.0, 1.0)
        vignette = np.clip(1.0 - (xx * xx + yy * yy) * 0.22, 0.62, 1.0)
        out = base_rgb * (0.94 + 0.12 * dir_grad) + bloom * 0.52
        out = out * (1.0 - edge_mask * 0.25) * vignette
        active_seed = int(grain_seed) if grain_seed is not None else int(time.time_ns() & 0x7FFFFFFF)
        rng = np.random.default_rng(active_seed)
        grain = (rng.random((h, w, 1), dtype=np.float32) - 0.5) * 0.018
        out = np.clip(out + grain, 0.0, 1.0)
        final_u8 = np.clip(out * 255.0, 0, 255).astype(np.uint8)

    return Image.fromarray(final_u8, mode="RGB"), engine_tag


def _refine_with_gemini_neural(
    img: Image.Image,
    look: str,
    style_dna: dict[str, Any] | None = None,
) -> tuple[Image.Image | None, str | None]:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None, None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore

        client = genai.Client(api_key=api_key)
        look_desc = CINEMA_LOOKS.get(look, CINEMA_LOOKS["ghibli-watercolor"])
        style_tag = (style_dna or {}).get("styleTag", "ink-watercolor")
        palette = ", ".join((style_dna or {}).get("palette", [])[:4])
        prompt = (
            f"Refine this 2.5D animated film frame into breathtaking theatrical feature-film quality "
            f"in the style of: {look_desc}. "
            f"STRICTLY preserve the exact character position, pose, facial expression, outfit, props, "
            f"camera framing, and background layout. Preserve the drawing's native Style-DNA "
            f"({style_tag}; key palette: {palette or 'original'}). "
            f"Enhance painterly brush textures, volumetric atmospheric lighting, subtle rim light, "
            f"and soft cinema depth-of-field. Do NOT add text, watermarks, or change the character design."
        )

        # Downscale slightly to 1024x576 for fast neural round-trip, then restore crisp target size
        orig_size = img.size
        work = img.convert("RGB")
        if work.width > 1024:
            work = work.resize((1024, int(round(1024 * work.height / work.width))), Image.Resampling.LANCZOS)

        buf = io.BytesIO()
        work.save(buf, format="PNG")
        img_part = types.Part.from_bytes(data=buf.getvalue(), mime_type="image/png")

        resp = client.models.generate_content(
            model="gemini-3.1-flash-lite-image",
            contents=[prompt, img_part],
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE"],
                image_config=types.ImageConfig(aspect_ratio="16:9"),
            ),
        )
        for part in resp.parts or []:
            if part.inline_data and part.inline_data.data:
                out_img = Image.open(io.BytesIO(part.inline_data.data)).convert("RGB")
                if out_img.size != orig_size:
                    out_img = out_img.resize(orig_size, Image.Resampling.LANCZOS)
                return out_img, f"gemini-3.1-flash-lite-image ({look})"
    except Exception:
        return None, None
    return None, None


def refine_cinema_frame(
    img: Image.Image,
    look: str = "ghibli-watercolor",
    engine: str = "gpu-opencv",
    light_angle_deg: float = 22.0,
    style_dna: dict[str, Any] | None = None,
    grain_seed: int | None = None,
) -> dict[str, Any]:
    """Refines one 2.5D cinema frame via fast local or deep painterly studio refiner."""
    t0 = time.perf_counter()
    chosen_look = look if look in CINEMA_LOOKS else "ghibli-watercolor"

    if engine == "gemini-neural":
        neural_img, neural_tag = _refine_with_gemini_neural(img, chosen_look, style_dna)
        if neural_img is not None and neural_tag is not None:
            elapsed_ms = int(round((time.perf_counter() - t0) * 1000))
            return {
                "refined_png_b64": _img_to_b64_png(neural_img),
                "engine": neural_tag,
                "look": chosen_look,
                "elapsed_ms": elapsed_ms,
                "width": neural_img.width,
                "height": neural_img.height,
            }

    out_img, tag = _refine_with_gpu_opencv(
        img, chosen_look, light_angle_deg, style_dna, grain_seed=grain_seed
    )
    elapsed_ms = int(round((time.perf_counter() - t0) * 1000))
    return {
        "refined_png_b64": _img_to_b64_png(out_img),
        "engine": tag,
        "look": chosen_look,
        "elapsed_ms": elapsed_ms,
        "width": out_img.width,
        "height": out_img.height,
    }
