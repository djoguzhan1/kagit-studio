import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerCanvasFlusher,
  shiftCameraKeyframesOnDelete,
  shiftCameraKeyframesOnInsert,
  shiftCameraKeyframesOnMove,
  useStudioStore,
} from '../../store/useStudioStore';
import { timelapseRecorder } from '../timelapseRecorder';
import { getContrastTextColor } from '../../components/studio/ColorWheelPopover';
import type { CameraKeyframe } from '../../types/studio';

describe('DrawWorkspace — Camera Keyframe Sync Helpers', () => {
  const base: CameraKeyframe[] = [
    { frame: 0, zoom: 1, panX: 0, panY: 0, tiltDeg: 0 },
    { frame: 2, zoom: 1.5, panX: 0.1, panY: 0, tiltDeg: 0 },
    { frame: 4, zoom: 2.0, panX: -0.1, panY: 0.05, tiltDeg: 5 },
  ];

  it('shifts keyframes >= insertAt forward by 1 on frame insert', () => {
    const out = shiftCameraKeyframesOnInsert(base, 2);
    expect(out.map((k) => k.frame)).toEqual([0, 3, 5]);
    expect(out[1].zoom).toBe(1.5);
  });

  it('drops deleted frame keyframe and shifts trailing keyframes back by 1', () => {
    const out = shiftCameraKeyframesOnDelete(base, 2);
    expect(out.map((k) => k.frame)).toEqual([0, 3]);
    expect(out[1].zoom).toBe(2.0);
  });

  it('remaps keyframe indices accurately on drag-and-drop moveFrame', () => {
    // Move frame 2 -> 4: frame 2 becomes 4, frames 3 & 4 shift left to 2 & 3
    const forward = shiftCameraKeyframesOnMove(base, 2, 4);
    expect(forward.map((k) => ({ f: k.frame, z: k.zoom }))).toEqual([
      { f: 0, z: 1 },
      { f: 3, z: 2.0 },
      { f: 4, z: 1.5 },
    ]);

    // Move frame 4 -> 1: frame 4 becomes 1, frames 1..3 shift right (2 -> 3)
    const backward = shiftCameraKeyframesOnMove(base, 4, 1);
    expect(backward.map((k) => ({ f: k.frame, z: k.zoom }))).toEqual([
      { f: 0, z: 1 },
      { f: 1, z: 2.0 },
      { f: 3, z: 1.5 },
    ]);
  });
});

describe('DrawWorkspace — Color Contrast & Timelapse Isolation', () => {
  it('chooses legible contrast text on both dark and light colors', () => {
    expect(getContrastTextColor('#1C1917')).toBe('#FAF6EE');
    expect(getContrastTextColor('#4A433D')).toBe('#FAF6EE'); // dark warm highlight for #1C1917
    expect(getContrastTextColor('#FFFFFF')).toBe('#181614');
    expect(getContrastTextColor('#FEF08A')).toBe('#181614');
  });

  it('isolates timelapse project tracking cleanly', () => {
    timelapseRecorder.setProject('prj-a');
    expect(timelapseRecorder.getProjectId()).toBe('prj-a');
    timelapseRecorder.setProject('prj-b');
    expect(timelapseRecorder.getProjectId()).toBe('prj-b');
    expect(timelapseRecorder.getCount()).toBe(0);
  });
});

describe('DrawWorkspace — Store State Integrity & Smart Workflows', () => {
  beforeEach(() => {
    registerCanvasFlusher(null);
    useStudioStore.setState({
      projects: [],
      activeProjectId: null,
      activeFrameIndex: 0,
      activeLayerId: null,
      autoSwitchedLayer: null,
      mode: 'draw',
      isPlaying: false,
      playbackFrameIndex: null,
      locale: 'tr',
    });
  });

  it('reuses untouched default blank project instead of stacking ghost projects', () => {
    const store = useStudioStore.getState();
    const p1 = store.openOrCreateBlankProject('', '16:9', 12);
    const p2 = useStudioStore.getState().openOrCreateBlankProject('', '16:9', 12);
    expect(p2.id).toBe(p1.id);
    expect(useStudioStore.getState().projects.length).toBe(1);

    // Custom title or different FPS creates a fresh project
    const p3 = useStudioStore.getState().openOrCreateBlankProject('Özel Sahne', '16:9', 12);
    expect(p3.id).not.toBe(p1.id);
    expect(useStudioStore.getState().projects.length).toBe(2);
  });

  it('re-binds activeLayerId cleanly after deleting a scene so drawing never locks up', () => {
    const p = useStudioStore.getState().createProject('Sahne Testi', '16:9', 12);
    useStudioStore.getState().addScene('Sahne 2');
    const sc2Id = useStudioStore.getState().projects.find((x) => x.id === p.id)!.activeSceneId!;
    useStudioStore.getState().deleteScene(sc2Id);

    const st = useStudioStore.getState();
    const proj = st.projects.find((x) => x.id === p.id)!;
    const validLayerIds = proj.frames[0].layers.map((l) => l.id);
    expect(st.activeLayerId).toBeTruthy();
    expect(validLayerIds).toContain(st.activeLayerId);
  });

  it('preserves active layer role, shifts camera keyframes, and awaits canvas flush on addFrameAfterCurrent', async () => {
    const flushed = vi.fn().mockResolvedValue(undefined);
    registerCanvasFlusher(flushed);

    const p = useStudioStore.getState().createProject('Rol Testi', '16:9', 12);
    const colorLayer = p.frames[0].layers.find((l) => l.role === 'color')!;
    useStudioStore.getState().selectLayer(colorLayer.id);
    await useStudioStore.getState().addFrameAfterCurrent(false);
    useStudioStore.getState().upsertCameraKeyframe({
      frame: 1,
      zoom: 1.4,
      panX: 0.1,
      panY: 0,
      tiltDeg: 0,
    });
    // Jump back to frame 0 and insert a frame at index 1 -> keyframe at 1 must shift to 2!
    useStudioStore.getState().selectFrame(0);
    flushed.mockClear();

    await useStudioStore.getState().addFrameAfterCurrent(false);
    expect(flushed).toHaveBeenCalledTimes(1);

    const st = useStudioStore.getState();
    const updated = st.projects.find((x) => x.id === p.id)!;
    const newFrame = updated.frames[1];
    const activeLyr = newFrame.layers.find((l) => l.id === st.activeLayerId);
    expect(activeLyr?.role).toBe('color');
    expect(updated.cameraKeyframes?.[0]?.frame).toBe(2);
  });

  it('auto-routes Bucket -> Color and Blue Rough -> Rough, then restores Ink on G-Pen while respecting manual picks', () => {
    const p = useStudioStore.getState().createProject('Akıllı Katman', '16:9', 12);
    const ink = p.frames[0].layers.find((l) => l.role === 'ink')!;
    const color = p.frames[0].layers.find((l) => l.role === 'color')!;
    const rough = p.frames[0].layers.find((l) => l.role === 'rough')!;

    expect(useStudioStore.getState().activeLayerId).toBe(ink.id);

    // Picking bucket while on ink routes smoothly to color
    useStudioStore.getState().updateBrush({ tool: 'bucket' });
    expect(useStudioStore.getState().activeLayerId).toBe(color.id);

    // Picking gpen restores original ink layer
    useStudioStore.getState().updateBrush({ tool: 'gpen' });
    expect(useStudioStore.getState().activeLayerId).toBe(ink.id);

    // Picking blue-rough routes to rough
    useStudioStore.getState().updateBrush({ tool: 'blue-rough' });
    expect(useStudioStore.getState().activeLayerId).toBe(rough.id);

    // Manual layer selection clears auto-routing origin and is respected
    useStudioStore.getState().selectLayer(color.id);
    useStudioStore.getState().updateBrush({ tool: 'gpen' });
    expect(useStudioStore.getState().activeLayerId).toBe(color.id);
  });

  it('reorders layers visually up and down inside the active frame', () => {
    const p = useStudioStore.getState().createProject('Sıralama', '16:9', 12);
    const roughId = p.frames[0].layers[0].id;
    const colorId = p.frames[0].layers[1].id;
    const inkId = p.frames[0].layers[2].id;

    // Move rough visually 'up' (index 0 -> 1)
    useStudioStore.getState().moveLayerInCurrentFrame(roughId, 'up');
    let ids = useStudioStore.getState().projects[0].frames[0].layers.map((l) => l.id);
    expect(ids).toEqual([colorId, roughId, inkId]);

    // Move ink visually 'down' (index 2 -> 1)
    useStudioStore.getState().moveLayerInCurrentFrame(inkId, 'down');
    ids = useStudioStore.getState().projects[0].frames[0].layers.map((l) => l.id);
    expect(ids).toEqual([colorId, inkId, roughId]);
  });
});
