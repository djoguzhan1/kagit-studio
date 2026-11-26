"""
AI Film Director (Natural-Language Script -> Deterministic Multi-Shot FilmGraph IR):
- Uses official google-genai SDK (Gemini 2.5 Flash structured JSON) when GEMINI_API_KEY is configured
- Falls back cleanly to a deterministic Turkish/English Cinematographer when offline!
"""

from __future__ import annotations

import json
import os
import re
from typing import Any


def _fallback_direct_script(prompt: str) -> dict[str, Any]:
    low = prompt.lower()
    set_id = "rainy-alley"
    weather = "rain"
    if re.search(r"orman|forest|moon|ay ışık|ateşböce", low):
        set_id, weather = "moonlit-forest", "fireflies"
    elif re.search(r"gün batım|sunset|tepe|hill|rüzgar|rüzgâr", low):
        set_id, weather = "golden-hill", "wind-leaves"

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+|\n+", prompt.strip()) if len(s.strip()) > 4]
    beats = sentences[:4] if len(sentences) >= 2 else [prompt.strip(), "Orta Plan", "Yakın Plan"]

    shots = []
    for idx, text in enumerate(beats):
        tlow = text.lower()
        framing = "wide" if idx == 0 else ("closeup" if idx == len(beats) - 1 else "medium")
        dlg_match = re.search(r"['\"“”«]([^'\"“”»]{2,90})['\"“”»]", text)
        dialogue = dlg_match.group(1).strip() if dlg_match else ""
        shots.append(
            {
                "title": f"Plan {idx + 1} · {framing.title()}",
                "durationSec": 3.2 if dialogue else 2.6,
                "framing": framing,
                "action": "talk-hero" if dialogue else ("walk-tired" if idx == 0 else "surprise"),
                "emotion": "happy" if re.search(r"gülümse|mutlu|happy|smile", tlow) else "neutral",
                "dialogue": dialogue,
                "lightningAtSec": 0.7 if re.search(r"şimşek|lightning|gök", tlow) else None,
            }
        )

    return {
        "engine": "deterministic-director",
        "world": {"setId": set_id, "weather": weather},
        "shots": shots,
    }


def direct_film_script(prompt: str, style_dna: dict[str, Any] | None = None) -> dict[str, Any]:
    """Compiles a movie description into structured multi-shot FilmGraph JSON."""
    api_key = os.getenv("GEMINI_API_KEY")
    if api_key:
        try:
            from google import genai  # type: ignore

            client = genai.Client(api_key=api_key)
            sys_prompt = (
                "You are an animated film cinematographer for KÂĞIT 2.5D Studio. "
                "Convert the user's scene description into JSON with keys: "
                "world: {setId: 'rainy-alley'|'golden-hill'|'moonlit-forest', weather: 'rain'|'wind-leaves'|'fireflies'|'snow'|'none'}, "
                "shots: array of 2-4 shots, each with {title, durationSec (1.5..5.0), framing ('wide'|'medium'|'closeup'|'low-angle'), "
                "action ('walk-tired'|'walk-hero'|'run'|'jump-joy'|'kneel-pickup'|'surprise'|'wave'|'talk-hero'|'idle-breathe'), "
                "emotion ('neutral'|'tired'|'surprised'|'happy'|'determined'|'angry'), dialogue, lightningAtSec (number|null)}. "
                f"Character Style-DNA: {json.dumps(style_dna or {})}. Return ONLY valid JSON."
            )
            resp = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[sys_prompt, prompt],
                config={"response_mime_type": "application/json"},
            )
            parsed = json.loads(resp.text or "{}")
            if "shots" in parsed and isinstance(parsed["shots"], list) and len(parsed["shots"]) > 0:
                parsed["engine"] = "gemini-2.5-flash"
                return parsed
        except Exception:
            pass

    return _fallback_direct_script(prompt)
