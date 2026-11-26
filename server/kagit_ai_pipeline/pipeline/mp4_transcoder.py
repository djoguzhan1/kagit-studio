"""
KÂĞIT Phase 5 — Real FFmpeg Broadcast H.264 / AAC MP4 Transcoder & Cinema Grade Filtergraph.
Converts browser MediaRecorder WebM/MP4 streams into universal, iPhone/YouTube/Instagram-ready
H.264 (yuv420p, faststart) + AAC 192k MP4 files using the host's physical FFmpeg binary!
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import tempfile

FFMPEG_LOOK_FILTERS = {
    "none": "",
    "ghibli-watercolor": "eq=contrast=1.05:saturation=1.14:brightness=0.02,unsharp=3:3:0.55:3:3:0.0,vignette=PI/6",
    "klaus-3d-cel": "eq=contrast=1.10:saturation=1.10:gamma=0.97,unsharp=5:5:0.7:5:5:0.0,vignette=PI/5.5",
    "anime-makoto": "eq=contrast=1.12:saturation=1.22:brightness=0.01,unsharp=3:3:0.85:3:3:0.0",
    "noir-35mm": "eq=contrast=1.18:saturation=0.86:gamma=0.94,vignette=PI/4.5,noise=alls=8:allf=t+u",
}


def find_ffmpeg_binary() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    # Check common Windows WinGet installation path
    winget_glob = os.path.expandvars(
        r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\*FFmpeg*\*\bin\ffmpeg.exe"
    )
    matches = glob.glob(winget_glob)
    return matches[0] if matches else None


def transcode_to_broadcast_mp4(
    input_bytes: bytes,
    input_ext: str = "webm",
    cinema_look: str = "none",
) -> bytes:
    """Transcodes video+audio bytes into universal broadcast-ready H.264 + AAC MP4."""
    ffmpeg = find_ffmpeg_binary()
    if not ffmpeg:
        raise RuntimeError("FFmpeg binary not found on host system")

    safe_ext = "".join(ch for ch in input_ext.lower() if ch.isalnum()) or "webm"
    vf = FFMPEG_LOOK_FILTERS.get(cinema_look, "")

    with tempfile.TemporaryDirectory(prefix="kagit_mp4_") as tmp:
        in_path = os.path.join(tmp, f"input.{safe_ext}")
        out_path = os.path.join(tmp, "output.mp4")
        with open(in_path, "wb") as f:
            f.write(input_bytes)

        cmd = [
            ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            in_path,
        ]
        # Ensure even dimensions required by yuv420p + optional cinema look filter
        scale_fix = "scale=trunc(iw/2)*2:trunc(ih/2)*2"
        cmd.extend(["-vf", f"{scale_fix},{vf}" if vf else scale_fix])
        cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                out_path,
            ]
        )

        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not os.path.exists(out_path):
            raise RuntimeError(f"FFmpeg transcode failed: {proc.stderr.strip() or proc.returncode}")

        with open(out_path, "rb") as f:
            return f.read()
