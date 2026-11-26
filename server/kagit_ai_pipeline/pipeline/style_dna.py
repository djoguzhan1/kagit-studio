"""Style-DNA Extractor: extracts ink weight, palette, temperature, contrast & style tag."""

from __future__ import annotations

from collections import Counter
from typing import Any

import numpy as np
from PIL import Image


def _rgb_to_hex(r: int, g: int, b: int) -> str:
    return f"#{max(0, min(255, r)):02X}{max(0, min(255, g)):02X}{max(0, min(255, b)):02X}"


def extract_style_dna(image: Image.Image) -> dict[str, Any]:
    """Extracts StyleDNA directly matching KÂĞIT frontend StyleDNA schema."""
    small = image.convert("RGBA").resize((96, 96), Image.Resampling.BILINEAR)
    arr = np.asarray(small, dtype=np.uint8)
    r = arr[:, :, 0].astype(np.float32)
    g = arr[:, :, 1].astype(np.float32)
    b = arr[:, :, 2].astype(np.float32)
    a = arr[:, :, 3]

    # Foreground non-paper mask
    not_paper = ~((r > 240) & (g > 236) & (b > 224))
    fg = (a > 140) & not_paper
    fg_count = int(fg.sum())
    if fg_count < 8:
        return {
            "palette": ["#2B2622", "#E54D2E", "#D99B26", "#FAF3E4", "#4A5568"],
            "inkColor": "#1C1917",
            "accentColor": "#E54D2E",
            "warmTemp": 0.35,
            "contrast": 0.78,
            "lineWeightPx": 3.4,
            "styleTag": "ink-watercolor",
        }

    lum = 0.299 * r + 0.587 * g + 0.114 * b
    fg_lum = lum[fg]
    contrast = float(min(1.0, np.std(fg_lum) / 88.0))
    warm_temp = float(np.clip(np.mean((r[fg] - b[fg]) / 255.0) * 2.2, -1.0, 1.0))

    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    sat = np.where(max_c > 0, (max_c - min_c) / np.maximum(1.0, max_c), 0.0)
    sat_ratio = float(np.mean(sat[fg] > 0.45))
    ink_ratio = float(np.mean(fg_lum < 68.0))

    gx = np.abs(np.diff(lum, axis=1, prepend=lum[:, :1]))
    edge_ratio = float(np.mean(gx[fg] > 55.0))

    # Quantized palette buckets
    qr = (np.round(r[fg] / 32.0) * 32).astype(np.int32)
    qg = (np.round(g[fg] / 32.0) * 32).astype(np.int32)
    qb = (np.round(b[fg] / 32.0) * 32).astype(np.int32)
    counts = Counter(zip(qr.tolist(), qg.tolist(), qb.tolist()))
    top_colors = [c for c, _ in counts.most_common(8)]

    palette = [_rgb_to_hex(*c) for c in top_colors[:5]]
    while len(palette) < 3:
        palette.append("#1C1917")

    darkest = min(top_colors, key=lambda c: c[0] + c[1] + c[2])
    ink_color = _rgb_to_hex(*darkest) if sum(darkest) < 240 else "#1C1917"

    def _sat_score(c: tuple[int, int, int]) -> float:
        mx, mn = max(c), min(c)
        s = (mx - mn) / max(1, mx)
        return s * (counts[c] ** 0.5)

    vibrant = max(top_colors, key=_sat_score)
    accent_color = _rgb_to_hex(*vibrant) if (max(vibrant) - min(vibrant)) > 45 else "#E54D2E"

    style_tag = "ink-watercolor"
    if sat_ratio < 0.08 and ink_ratio > 0.25:
        style_tag = "sketch"
    elif sat_ratio > 0.34 and contrast > 0.55:
        style_tag = "anime-cel"
    elif warm_temp > 0.18 and contrast < 0.65:
        style_tag = "storybook"

    line_weight = float(np.clip(2.2 + edge_ratio * 9.0 + ink_ratio * 2.2, 1.8, 5.8))

    return {
        "palette": palette,
        "inkColor": ink_color,
        "accentColor": accent_color,
        "warmTemp": round(warm_temp, 2),
        "contrast": round(contrast, 2),
        "lineWeightPx": round(line_weight, 1),
        "styleTag": style_tag,
    }
