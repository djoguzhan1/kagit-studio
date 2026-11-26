"""End-to-end unit tests for KÂĞIT 2.5D AI Pipeline (runs cleanly with standard unittest)."""

from __future__ import annotations

import base64
import io
import unittest

from PIL import Image, ImageDraw

from pipeline.background_slicer import decompose_background
from pipeline.character_decomposer import decompose_character, detect_hardware_capabilities
from pipeline.cinema_refiner import refine_cinema_frame
from pipeline.director_llm import direct_film_script
from pipeline.mp4_transcoder import find_ffmpeg_binary
from pipeline.style_dna import extract_style_dna
from pipeline.voice_tts import _combine_prosody, _fallback_formant_wav


def _make_sample_character() -> Image.Image:
    img = Image.new("RGBA", (320, 380), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Coat torso
    d.rounded_rectangle([110, 150, 210, 290], radius=18, fill="#26221F", outline="#1C1917", width=4)
    # Scarf
    d.rounded_rectangle([105, 138, 215, 166], radius=10, fill="#E54D2E", outline="#1C1917", width=3)
    # Head
    d.ellipse([115, 48, 205, 138], fill="#FAF3E4", outline="#1C1917", width=4)
    # Arms
    d.line([110, 175, 58, 205], fill="#1C1917", width=12)
    d.line([210, 175, 262, 205], fill="#1C1917", width=12)
    # Legs
    d.line([138, 290, 130, 355], fill="#1C1917", width=12)
    d.line([182, 290, 190, 355], fill="#1C1917", width=12)
    return img


def _make_sample_background() -> Image.Image:
    img = Image.new("RGB", (640, 360), "#1A2233")
    d = ImageDraw.Draw(img)
    # Bright sun/moon top-right
    d.ellipse([480, 30, 560, 110], fill="#FFF5D6")
    # Ground bottom half
    d.rectangle([0, 200, 640, 360], fill="#242936")
    return img


class TestKagit25DPipeline(unittest.TestCase):
    def test_style_dna_extraction(self) -> None:
        dna = extract_style_dna(_make_sample_character())
        self.assertGreaterEqual(len(dna["palette"]), 3)
        self.assertTrue(dna["inkColor"].startswith("#"))
        self.assertGreaterEqual(dna["lineWeightPx"], 1.8)
        self.assertLessEqual(dna["lineWeightPx"], 5.8)

    def test_character_amodal_decomposition_and_maps(self) -> None:
        result = decompose_character(_make_sample_character())
        self.assertEqual(len(result["parts"]), 6)
        roles = {p["role"] for p in result["parts"]}
        self.assertEqual(roles, {"head", "torso", "arm_l", "arm_r", "leg_l", "leg_r"})

        # Verify every returned base64 PNG decodes cleanly
        for part in result["parts"]:
            decoded = Image.open(io.BytesIO(base64.b64decode(part["png_b64"])))
            self.assertEqual(decoded.mode, "RGBA")
            self.assertGreater(decoded.width, 4)

        depth = Image.open(io.BytesIO(base64.b64decode(result["depth_png_b64"])))
        normal = Image.open(io.BytesIO(base64.b64decode(result["normal_png_b64"])))
        self.assertEqual(depth.size, normal.size)

    def test_background_6_layer_slicing_and_light_estimation(self) -> None:
        result = decompose_background(_make_sample_background(), horizon_y=0.56)
        self.assertEqual(len(result["planes"]), 5)
        self.assertEqual([p["z_layer"] for p in result["planes"]], ["z0", "z1", "z2", "z3", "z5"])
        # Bright moon is on the right -> positive key light angle!
        self.assertGreater(result["light_angle_deg"], 15)
        for pl in result["planes"]:
            decoded = Image.open(io.BytesIO(base64.b64decode(pl["png_b64"])))
            self.assertEqual(decoded.size, (1280, 720))

    def test_director_script_compilation(self) -> None:
        res = direct_film_script(
            "Yağmurlu sokak. Karakter soldan yürür. Şimşek çakar ve 'Başardık!' der."
        )
        self.assertEqual(res["world"]["setId"], "rainy-alley")
        self.assertGreaterEqual(len(res["shots"]), 2)
        self.assertTrue(any(s["dialogue"] == "Başardık!" for s in res["shots"]))

    def test_phase5_cinema_refiner_gpu_opencv(self) -> None:
        frame = _make_sample_background()
        res = refine_cinema_frame(frame, look="ghibli-watercolor", engine="gpu-opencv")
        self.assertEqual(res["look"], "ghibli-watercolor")
        self.assertEqual(res["width"], 640)
        self.assertEqual(res["height"], 360)
        decoded = Image.open(io.BytesIO(base64.b64decode(res["refined_png_b64"])))
        self.assertEqual(decoded.size, (640, 360))

    def test_phase5_voice_wav_and_capabilities(self) -> None:
        wav_bytes = _fallback_formant_wav("Sonunda buldum!")
        self.assertEqual(wav_bytes[:4], b"RIFF")
        self.assertEqual(wav_bytes[8:12], b"WAVE")
        self.assertGreater(len(wav_bytes), 4000)
        caps = detect_hardware_capabilities()
        self.assertIn("device", caps)
        self.assertIn("ffmpeg", caps)
        self.assertIsNotNone(find_ffmpeg_binary())

    def test_additive_voice_prosody_preserves_character_timbre(self) -> None:
        # Deep Charon (-12Hz) + Happy (+8Hz) stays deeper (-4Hz) instead of overwriting to +8Hz
        self.assertEqual(_combine_prosody("-12Hz", "+8Hz", "Hz", -24, 24), "-4Hz")
        self.assertEqual(_combine_prosody("-8%", "+6%", "%", -30, 30), "-2%")
        # Clamping prevents extreme out-of-range SSML values
        self.assertEqual(_combine_prosody("+20Hz", "+10Hz", "Hz", -24, 24), "+24Hz")

    def test_cinema_refiner_dynamic_grain_varies_between_frames(self) -> None:
        frame = _make_sample_background()
        res_a = refine_cinema_frame(frame, look="noir-35mm", engine="gpu-opencv", grain_seed=101)
        res_b = refine_cinema_frame(frame, look="noir-35mm", engine="gpu-opencv", grain_seed=202)
        self.assertNotEqual(res_a["refined_png_b64"], res_b["refined_png_b64"])


if __name__ == "__main__":
    unittest.main()
