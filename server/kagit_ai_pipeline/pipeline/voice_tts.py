"""
KÂĞIT Phase 5 — Real AI Character Voice Acting TTS Pipeline:
  Tier 1: Gemini 3.8 Flash TTS (when GEMINI_API_KEY has active credits)
  Tier 2: Free Neural Turkish / English Human Voices via edge-tts + FFmpeg WAV (tr-TR-AhmetNeural / tr-TR-EmelNeural)
  Tier 3: Deterministic Offline Formant Speech Fallback (zero internet required)
"""

from __future__ import annotations

import asyncio
import io
import math
import os
import re
import struct
import subprocess
import tempfile
import wave

from .mp4_transcoder import find_ffmpeg_binary

VOICE_PRESETS = {
    "Puck": "Genç Kahraman (Erkek · TR)",
    "Aoede": "Sıcak Anlatıcı (Kadın · TR)",
    "Charon": "Derin Sinematik (Erkek · TR)",
    "Kore": "Yumuşak Duygusal (Kadın · TR)",
    "Fenrir": "Kararlı & Güçlü (Erkek · TR)",
}

# Emotion-calibrated prosody for free Neural Turkish/English acting via edge-tts
EDGE_VOICE_MAP = {
    "Puck": ("tr-TR-AhmetNeural", "en-US-ChristopherNeural", "+6Hz", "+4%"),
    "Aoede": ("tr-TR-EmelNeural", "en-US-AriaNeural", "+2Hz", "+0%"),
    "Charon": ("tr-TR-AhmetNeural", "en-US-GuyNeural", "-12Hz", "-8%"),
    "Kore": ("tr-TR-EmelNeural", "en-US-JennyNeural", "+8Hz", "-4%"),
    "Fenrir": ("tr-TR-AhmetNeural", "en-US-EricNeural", "-6Hz", "+2%"),
}

EMOTION_DIRECTIONS = {
    "neutral": "natural, clear animated film acting voice",
    "tired": "slightly tired, breathless, gentle storytelling voice",
    "surprised": "excited, surprised gasp and bright expressive voice",
    "happy": "warm, joyful, smiling animated film hero voice",
    "determined": "brave, confident, determined cinematic hero voice",
    "angry": "intense, urgent, passionate dramatic voice",
}

EMOTION_RATE_PITCH = {
    "neutral": ("+0%", "+0Hz"),
    "tired": ("-14%", "-6Hz"),
    "surprised": ("+10%", "+10Hz"),
    "happy": ("+6%", "+8Hz"),
    "determined": ("+2%", "-4Hz"),
    "angry": ("+12%", "+4Hz"),
}


def _looks_english(text: str) -> bool:
    if re.search(r"[ğüşıöçĞÜŞİÖÇ]", text):
        return False
    low = text.lower()
    en_hits = len(re.findall(r"\b(the|and|is|are|found|finally|hello|wait|run|look|we|you|it)\b", low))
    tr_hits = len(re.findall(r"\b(ve|bir|bu|ne|ben|sen|buldum|devam|merhaba|bak|dur|haydi|sonunda)\b", low))
    return en_hits > tr_hits and en_hits >= 1


def _wrap_pcm16_to_wav(raw_bytes: bytes, sample_rate: int = 24000) -> bytes:
    """Ensures audio bytes are a valid RIFF WAV container decodable by every browser."""
    if raw_bytes[:4] == b"RIFF" and raw_bytes[8:12] == b"WAVE":
        return raw_bytes
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(raw_bytes)
    return buf.getvalue()


def _combine_prosody(base: str, delta: str, unit: str, lo: int, hi: int) -> str:
    """Additively combines character timbre prosody with emotion delta, clamped safely."""
    def _parse(val: str) -> int:
        m = re.match(r"^([+-]?\d+)", val.strip())
        return int(m.group(1)) if m else 0

    total = max(lo, min(hi, _parse(base) + _parse(delta)))
    return f"{total:+d}{unit}"


def _synthesize_edge_neural_wav(text: str, emotion: str, voice_name: str) -> tuple[bytes, str] | None:
    """Synthesizes crystal-clear human Turkish/English neural voice using edge-tts + host FFmpeg -> 24kHz WAV."""
    try:
        import edge_tts  # type: ignore
    except ImportError:
        return None

    ffmpeg = find_ffmpeg_binary()
    if not ffmpeg:
        return None

    tr_voice, en_voice, base_pitch, base_rate = EDGE_VOICE_MAP.get(
        voice_name, EDGE_VOICE_MAP["Puck"]
    )
    neural_voice = en_voice if _looks_english(text) else tr_voice
    em_rate, em_pitch = EMOTION_RATE_PITCH.get(emotion, ("+0%", "+0Hz"))
    rate = _combine_prosody(base_rate, em_rate, "%", -30, 30)
    pitch = _combine_prosody(base_pitch, em_pitch, "Hz", -24, 24)

    async def _gen_mp3() -> bytes:
        comm = edge_tts.Communicate(text=text, voice=neural_voice, rate=rate, pitch=pitch)
        chunks: list[bytes] = []
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        return b"".join(chunks)

    try:
        try:
            mp3_bytes = asyncio.run(_gen_mp3())
        except RuntimeError:
            loop = asyncio.new_event_loop()
            try:
                mp3_bytes = loop.run_until_complete(_gen_mp3())
            finally:
                loop.close()

        if len(mp3_bytes) < 256:
            return None

        with tempfile.TemporaryDirectory(prefix="kagit_tts_") as tmp:
            mp3_path = os.path.join(tmp, "voice.mp3")
            wav_path = os.path.join(tmp, "voice.wav")
            with open(mp3_path, "wb") as f:
                f.write(mp3_bytes)
            proc = subprocess.run(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", mp3_path, "-ac", "1", "-ar", "24000", wav_path],
                capture_output=True,
                timeout=20,
            )
            if proc.returncode != 0 or not os.path.exists(wav_path):
                return None
            with open(wav_path, "rb") as f:
                return f.read(), f"neural-tts ({neural_voice})"
    except Exception:
        return None


def _fallback_formant_wav(text: str) -> bytes:
    """Deterministic syllable-formant WAV fallback if completely offline."""
    sr = 24000
    clean = [ch.lower() for ch in text.strip() if ch.isalnum() or ch == " "]
    if not clean:
        clean = list("merhaba")
    syl_dur = 0.085
    samples: list[int] = []
    for idx, ch in enumerate(clean[:42]):
        n = int(sr * syl_dur)
        if ch == " ":
            samples.extend([0] * (n // 2))
            continue
        if ch in "aâ":
            f1, f2, amp = 740.0, 1240.0, 0.55
        elif ch in "eiıî":
            f1, f2, amp = 460.0, 2250.0, 0.48
        elif ch in "oö":
            f1, f2, amp = 430.0, 820.0, 0.52
        elif ch in "uü":
            f1, f2, amp = 320.0, 680.0, 0.46
        elif ch in "fvszşçh":
            f1, f2, amp = 3400.0, 4200.0, 0.28
        else:
            f1, f2, amp = 580.0, 1480.0, 0.34
        base_pitch = 195.0 + 18.0 * math.sin(idx * 0.6)
        for i in range(n):
            t = i / sr
            env = math.sin(math.pi * i / max(1, n))
            sig = (
                0.45 * math.sin(2 * math.pi * base_pitch * t)
                + 0.35 * math.sin(2 * math.pi * f1 * t)
                + 0.20 * math.sin(2 * math.pi * f2 * t)
            ) * amp * env
            samples.append(int(max(-1.0, min(1.0, sig)) * 30000))
    raw = struct.pack("<" + "h" * len(samples), *samples)
    return _wrap_pcm16_to_wav(raw, sr)


def synthesize_character_voice(
    text: str,
    emotion: str = "neutral",
    voice_name: str = "Puck",
) -> tuple[bytes, str]:
    """Synthesizes real character speech WAV audio (Gemini TTS -> Free Neural TR/EN TTS -> Offline Fallback)."""
    clean_text = text.strip()[:220]
    if not clean_text:
        raise ValueError("Dialogue text cannot be empty")

    chosen_voice = voice_name if voice_name in VOICE_PRESETS else "Puck"
    direction = EMOTION_DIRECTIONS.get(emotion, EMOTION_DIRECTIONS["neutral"])
    api_key = os.getenv("GEMINI_API_KEY")

    # Tier 1: Gemini 3.8 Flash TTS (when key has active credits)
    if api_key:
        try:
            from google import genai  # type: ignore
            from google.genai import types  # type: ignore

            client = genai.Client(api_key=api_key)
            prompt = (
                f"Speak the following animated movie dialogue line in a {direction}. "
                f"Speak ONLY the dialogue itself, naturally and expressively:\n{clean_text}"
            )
            resp = client.models.generate_content(
                model="gemini-3.8-flash-tts",
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_modalities=["AUDIO"],
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                voice_name=chosen_voice
                            )
                        )
                    ),
                ),
            )
            for part in resp.parts or []:
                if part.inline_data and part.inline_data.data:
                    wav_bytes = _wrap_pcm16_to_wav(part.inline_data.data, sample_rate=24000)
                    return wav_bytes, f"gemini-3.8-flash-tts ({chosen_voice})"
        except Exception:
            pass

    # Tier 2: Free Broadcast-Quality Human Turkish / English Neural TTS (edge-tts + FFmpeg WAV!)
    neural = _synthesize_edge_neural_wav(clean_text, emotion, chosen_voice)
    if neural is not None:
        return neural

    # Tier 3: Deterministic Offline Formant Fallback
    return _fallback_formant_wav(clean_text), "local-formant-tts"
