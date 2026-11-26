"""
2.5D Multi-Plane Background Slicer (Disney Multi-Plane Camera Z0..Z5):
Slices any background drawing/photo into 5 independent parallax PNG layers with
feathered transitions, behind-layer sky extension & key-light angle estimation!
"""

from __future__ import annotations

import base64
import io
from typing import Any

import numpy as np
from PIL import Image

from .character_decomposer import detect_hardware_capabilities


def _img_to_b64_png(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _estimate_key_light_angle(rgb: np.ndarray) -> int:
    h, w, _ = rgb.shape
    upper = rgb[: max(1, int(h * 0.55)), :, :].astype(np.float32)
    lum = (0.299 * upper[:, :, 0] + 0.587 * upper[:, :, 1] + 0.114 * upper[:, :, 2]) / 255.0
    weights = lum ** 3
    total = float(weights.sum())
    if total < 1e-5:
        return 20
    xs = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    bias_x = float((weights * xs).sum() / total)
    return int(round(np.clip(bias_x * 70.0, -75.0, 75.0)))


def decompose_background(image: Image.Image, horizon_y: float = 0.56) -> dict[str, Any]:
    """Produces 5 parallax planes (z0, z1, z2, z3, z5) + depth map + light vector."""
    caps = detect_hardware_capabilities()
    horizon_y = float(np.clip(horizon_y, 0.32, 0.76))
    w, h = 1280, 720
    src = image.convert("RGBA").resize((w, h), Image.Resampling.LANCZOS)
    arr = np.asarray(src, dtype=np.uint8)
    light_angle = _estimate_key_light_angle(arr[:, :, :3])
    h_px = int(round(horizon_y * h))

    def _vertical_band(y0: int, y1: int, fade_top: int, fade_bot: int) -> Image.Image:
        out = arr.copy()
        alpha = np.zeros((h, w), dtype=np.float32)
        y0c = max(0, min(h - 1, y0))
        y1c = max(y0c + 1, min(h, y1))
        alpha[y0c:y1c, :] = 1.0
        if fade_top > 0 and y0c + fade_top <= y1c:
            alpha[y0c : y0c + fade_top, :] = np.linspace(0.0, 1.0, fade_top, dtype=np.float32)[:, None]
        if fade_bot > 0 and y1c - fade_bot >= y0c:
            alpha[y1c - fade_bot : y1c, :] = np.linspace(1.0, 0.0, fade_bot, dtype=np.float32)[:, None]
        out[:, :, 3] = (out[:, :, 3].astype(np.float32) * alpha).astype(np.uint8)
        return Image.fromarray(out, mode="RGBA")

    # Z0: Extended Sky Backdrop (stretched cleanly behind horizon -> zero panning seams!)
    sky_crop = src.crop((0, 0, w, min(h, int(h_px * 1.15))))
    z0_img = sky_crop.resize((w, h), Image.Resampling.BILINEAR)

    # Z1: Far Horizon Band (0.24x)
    z1_img = _vertical_band(int(h_px * 0.28), int(h_px * 1.10), int(h_px * 0.22), int(h_px * 0.14))

    # Z2: Midground Architecture / Foliage Band (0.58x)
    z2_img = _vertical_band(int(h_px * 0.48), min(h, int(h_px * 0.48 + h * 0.42)), 54, 68)

    # Z3: Perspective Ground Plane (1.0x)
    z3_img = _vertical_band(max(0, h_px - 24), h, 48, 0)

    # Z5: Foreground Framing Occluders (1.38x — actor walks BEHIND these!)
    z5_arr = arr.copy()
    edge_w = int(w * 0.14)
    mask_x = np.zeros(w, dtype=np.float32)
    mask_x[:edge_w] = np.linspace(0.92, 0.0, edge_w, dtype=np.float32)
    mask_x[-edge_w:] = np.linspace(0.0, 0.92, edge_w, dtype=np.float32)
    z5_arr[:, :, 3] = (z5_arr[:, :, 3].astype(np.float32) * mask_x[None, :]).astype(np.uint8)
    z5_img = Image.fromarray(z5_arr, mode="RGBA")

    # Depth Map preview (256x144)
    dw, dh = 256, 144
    y_grad = np.linspace(0.0, 1.0, dh, dtype=np.float32)
    d_vals = np.where(
        y_grad < horizon_y,
        0.10 + (y_grad / max(0.01, horizon_y)) * 0.30,
        0.40 + ((y_grad - horizon_y) / max(0.01, 1.0 - horizon_y)) * 0.56,
    )
    d_u8 = np.clip(d_vals * 255.0, 0, 255).astype(np.uint8)[:, None]
    depth_rgb = np.repeat(np.repeat(d_u8[:, :, None], dw, axis=1), 3, axis=2)
    depth_img = Image.fromarray(depth_rgb, mode="RGB")

    planes = [
        {"z_layer": "z0", "label": "Z0 Gökyüzü", "parallax": 0.06, "png_b64": _img_to_b64_png(z0_img)},
        {"z_layer": "z1", "label": "Z1 Uzak Ufuk", "parallax": 0.24, "png_b64": _img_to_b64_png(z1_img)},
        {"z_layer": "z2", "label": "Z2 Orta Plan", "parallax": 0.58, "png_b64": _img_to_b64_png(z2_img)},
        {"z_layer": "z3", "label": "Z3 Zemin", "parallax": 1.00, "png_b64": _img_to_b64_png(z3_img)},
        {"z_layer": "z5", "label": "Z5 Ön Plan", "parallax": 1.38, "png_b64": _img_to_b64_png(z5_img)},
    ]

    return {
        "source_engine": caps["mode"],
        "device": caps["device"],
        "horizon_y": round(horizon_y, 3),
        "light_angle_deg": light_angle,
        "depth_png_b64": _img_to_b64_png(depth_img),
        "planes": planes,
    }
