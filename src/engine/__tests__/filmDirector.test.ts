import { describe, expect, it } from 'vitest';
import {
  applyCinemaLookPostProcess,
  compileDirectorPromptToFilmGraph,
  computeFilmCameraState,
  DIRECTOR_PRESETS,
  evaluateCharacterPose25D,
  projectWorldToScreen,
  unprojectScreenToWorld,
} from '../film25dEngine';
import {
  analyzePCMToLipSyncTrack,
  synthesizeCartoonDialogueWav,
} from '../filmMocapLipSync';
import { TRANSLATIONS, type TranslationKey } from '../../i18n/translations';
import type { CinemaLookId } from '../../types/film';

function createMockCanvasCtx() {
  const calls: string[] = [];
  const grad = { addColorStop: () => {} };
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    fillRect: () => calls.push('fillRect'),
    strokeRect: () => calls.push('strokeRect'),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => calls.push('stroke'),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('Mini Film Director Studio — Legendary Overhaul Regression Suite', () => {
  it('1. smart closeup camera tracks a running hero near the left edge so they NEVER crop off-screen', () => {
    const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[1].prompt); // Golden Hill Run
    const shot = {
      ...graph.shots[0],
      framing: 'closeup' as const,
      action: 'run' as const,
      motionPath: [
        { x: 0.14, y: 0.8 },
        { x: 0.52, y: 0.8 },
      ],
      camera: {
        ...graph.shots[0].camera,
        fromZoom: 1.72,
        toZoom: 1.96,
        tiltDeg: -1.5,
      },
    };
    const pose = evaluateCharacterPose25D(shot, 0.1, graph.world.horizonY);
    const cam = computeFilmCameraState(graph, shot, pose, 0.1);

    // Project hero's feet & head center into 1280x720 screen space
    const footScreen = projectWorldToScreen(pose.groundX, pose.groundY, cam, 1280, 720);
    const headScreen = projectWorldToScreen(pose.groundX, pose.groundY - 0.3, cam, 1280, 720);

    // Hero MUST remain well inside frame horizontally & vertically (previously cropped off at x < 0!)
    expect(footScreen.x).toBeGreaterThan(220);
    expect(footScreen.x).toBeLessThan(1060);
    expect(headScreen.y).toBeGreaterThan(120);
    expect(headScreen.y).toBeLessThan(540);
  });

  it('2. projectWorldToScreen and unprojectScreenToWorld round-trip accurately under 1.98x zoom and dutch tilt', () => {
    const cam = {
      camX: -0.22,
      camY: 0.14,
      camZoom: 1.98,
      tiltRad: (-6.5 * Math.PI) / 180,
      dofStrength: 0.75,
    };

    const samples = [
      { x: 0.18, y: 0.8 },
      { x: 0.52, y: 0.44 },
      { x: 0.78, y: 0.82 },
    ];
    for (const pt of samples) {
      const screen = projectWorldToScreen(pt.x, pt.y, cam, 1280, 720);
      const back = unprojectScreenToWorld(screen.x, screen.y, cam, 1280, 720);
      expect(back.x).toBeCloseTo(pt.x, 4);
      expect(back.y).toBeCloseTo(pt.y, 4);
    }
  });

  it('3. switches cleanly to preset worlds even when a customBgBlobKey exists, and preserves decomposedBg when staying custom', () => {
    const fakeDecomposedBg = {
      planes: [{ zLayer: 'z0' as const, label: 'Sky', parallax: 0.1, blobKey: 'bg_z0' }],
      depthBlobKey: 'bg_depth',
      horizonY: 0.56,
      lightAngleDeg: 15,
      sourceEngine: 'local-cv' as const,
      createdAt: '2026-01-01T00:00:00Z',
    };

    // Switching to Golden Hill preset (without setId: 'custom') MUST switch to golden-hill!
    const presetGraph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[1].prompt, undefined, {
      customBgBlobKey: 'my_custom_bg',
      decomposedBg: fakeDecomposedBg,
    });
    expect(presetGraph.world.setId).toBe('golden-hill');
    expect(presetGraph.world.customBgBlobKey).toBe('my_custom_bg');
    expect(presetGraph.world.decomposedBg?.depthBlobKey).toBe('bg_depth');

    // Staying on custom background explicitly preserves both setId === 'custom' and decomposedBg!
    const customGraph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt, undefined, {
      setId: 'custom',
      customBgBlobKey: 'my_custom_bg',
      decomposedBg: fakeDecomposedBg,
      cinemaLook: 'cinema-35mm',
    });
    expect(customGraph.world.setId).toBe('custom');
    expect(customGraph.world.decomposedBg?.planes.length).toBe(1);
    expect(customGraph.world.cinemaLook).toBe('cinema-35mm');
  });

  it('4. executes all 5 live $0 Cinema Looks cleanly on Canvas2D without runtime errors', () => {
    const looks: CinemaLookId[] = [
      'natural',
      'watercolor',
      'cinema-35mm',
      'vibrant-anime',
      'vintage-ink',
    ];
    for (const look of looks) {
      const { ctx, calls } = createMockCanvasCtx();
      applyCinemaLookPostProcess(ctx, 1280, 720, look, 0.5, 1.25, true);
      expect(calls[0]).toBe('save');
      expect(calls[calls.length - 1]).toBe('restore');
      expect(calls).toContain('fillRect');
    }
  });

  it('5. synthesizes valid $0 offline cartoon dialogue WAV and produces distinct lip-sync visemes', async () => {
    const synth = synthesizeCartoonDialogueWav('Sonunda buldum! Harika!', 'happy', 'Puck');
    expect(synth.blob.type).toBe('audio/wav');
    expect(synth.blob.size).toBeGreaterThan(4000);
    expect(synth.durationSec).toBeGreaterThanOrEqual(0.7);

    // Check RIFF/WAVE binary signature
    const head = new Uint8Array(await synth.blob.slice(0, 12).arrayBuffer());
    const riff = String.fromCharCode(head[0], head[1], head[2], head[3]);
    const wave = String.fromCharCode(head[8], head[9], head[10], head[11]);
    expect(riff).toBe('RIFF');
    expect(wave).toBe('WAVE');

    // Analyze into 6-viseme lip-sync track
    const track = analyzePCMToLipSyncTrack(synth.pcm, synth.sampleRate, {
      audioBlobKey: 'wav_test_1',
      label: 'Hero Line',
      source: 'file',
    });
    expect(track.waveform.length).toBe(48);
    expect(track.frames.some((f) => f.viseme !== 'closed')).toBe(true);
  });

  it('6. enforces 100% TR/EN parity and zero forbidden internal/engineering jargon across all film & mocap keys', () => {
    const keys = Object.keys(TRANSLATIONS.tr).filter(
      (k) => k.startsWith('film') || k.startsWith('mocap')
    ) as TranslationKey[];
    expect(keys.length).toBeGreaterThan(90);

    const forbidden = [/faz\s*4/i, /12\s*on\s*2s/i, /\bprop\)/i, /\bpişir/i, /\byaw\b/i];
    for (const key of keys) {
      const trVal = TRANSLATIONS.tr[key];
      const enVal = TRANSLATIONS.en[key];
      expect(trVal.trim().length).toBeGreaterThan(0);
      expect(enVal.trim().length).toBeGreaterThan(0);
      for (const re of forbidden) {
        expect(trVal).not.toMatch(re);
        expect(enVal).not.toMatch(re);
      }
    }
  });

  it('7. flips character facing to -1 when travelling right-to-left (zero moonwalk) and lifts feet during walk Passing Pose', () => {
    const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    const leftWalkShot = {
      ...graph.shots[0],
      action: 'walk-hero' as const,
      motionPath: [
        { x: 0.82, y: 0.8 },
        { x: 0.22, y: 0.8 },
      ],
    };

    let sawLeftLift = false;
    let sawRightLift = false;
    for (let i = 0; i < 24; i++) {
      const p = evaluateCharacterPose25D(leftWalkShot, i * 0.08, graph.world.horizonY);
      expect(p.facing).toBe(-1);
      if (p.leftFootLift > 0.2) sawLeftLift = true;
      if (p.rightFootLift > 0.2) sawRightLift = true;
    }
    expect(sawLeftLift).toBe(true);
    expect(sawRightLift).toBe(true);
  });

  it('8. drives genuinely distinct posture & acting kinematics across all 6 emotion modes (zero dead buttons!)', () => {
    const graph = compileDirectorPromptToFilmGraph(DIRECTOR_PRESETS[0].prompt);
    const baseShot = { ...graph.shots[0], action: 'idle-breathe' as const };
    const neutral = evaluateCharacterPose25D({ ...baseShot, emotion: 'neutral' }, 0.6, graph.world.horizonY);
    const tired = evaluateCharacterPose25D({ ...baseShot, emotion: 'tired' }, 0.6, graph.world.horizonY);
    const happy = evaluateCharacterPose25D({ ...baseShot, emotion: 'happy' }, 0.6, graph.world.horizonY);
    const angry = evaluateCharacterPose25D({ ...baseShot, emotion: 'angry' }, 0.6, graph.world.horizonY);
    const determined = evaluateCharacterPose25D({ ...baseShot, emotion: 'determined' }, 0.6, graph.world.horizonY);
    const surprised = evaluateCharacterPose25D({ ...baseShot, emotion: 'surprised' }, 0.6, graph.world.horizonY);

    // Tired slumps forward & lowers squash; Angry leans aggressively forward with opposing arm tension;
    // Happy & Surprised lift posture upward; Determined steadies head tilt!
    expect(tired.headTiltRad).toBeGreaterThan(neutral.headTiltRad + 0.04);
    expect(tired.squashY).toBeLessThan(neutral.squashY);
    expect(angry.bodyLeanRad).toBeGreaterThan(neutral.bodyLeanRad + 0.05);
    expect(happy.headTiltRad).toBeLessThan(neutral.headTiltRad);
    expect(surprised.leftArmSwing).toBeGreaterThan(neutral.leftArmSwing + 0.15);
    expect(Math.abs(determined.headTiltRad)).toBeLessThanOrEqual(Math.abs(neutral.headTiltRad) + 0.01);
  });
});
