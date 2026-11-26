import type { CartoonMoodId, StorybookWorldId } from './cartoonMotionEngine';
import type { VoiceEffectId } from './liveAudioStudio';

export type StagePropId = 'none' | 'umbrella' | 'cape' | 'ball';

export interface ShareStrokeRecord {
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

export interface SharedStagePayload {
  v: 1;
  strokes: ShareStrokeRecord[];
  buddyStrokes?: ShareStrokeRecord[];
  toy: 'dance' | 'talk' | 'film' | 'pull';
  world: StorybookWorldId;
  mood: CartoonMoodId;
  prop: StagePropId;
  voiceFx: VoiceEffectId;
}

const VALID_TOYS = new Set(['dance', 'talk', 'film', 'pull']);
const VALID_WORLDS = new Set(['rainy', 'meadow', 'space', 'concert', 'escape']);
const VALID_MOODS = new Set(['natural', 'joy', 'cool', 'sneak', 'sprint']);
const VALID_PROPS = new Set(['none', 'umbrella', 'cape', 'ball']);
const VALID_VOICES = new Set(['natural', 'chipmunk', 'giant', 'robot']);

/** Fast perpendicular-distance polyline simplification to keep share links super compact */
function simplifyPoints(pts: { x: number; y: number }[], tolerance = 5.5): { x: number; y: number }[] {
  if (pts.length <= 2) return pts;
  const out: { x: number; y: number }[] = [pts[0]];
  let last = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= tolerance) {
      out.push(p);
      last = p;
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function packStrokes(strokes: ShareStrokeRecord[], maxStrokes = 32, maxPtsPerStroke = 36): [string, number, number[]][] {
  return strokes
    .slice(0, maxStrokes)
    .filter((s) => s.points.length > 0)
    .map((s) => {
      let pts = simplifyPoints(s.points, 6.5);
      if (pts.length > maxPtsPerStroke) {
        const stride = (pts.length - 1) / (maxPtsPerStroke - 1);
        const sampled: { x: number; y: number }[] = [];
        for (let i = 0; i < maxPtsPerStroke; i++) {
          sampled.push(pts[Math.round(i * stride)]);
        }
        pts = sampled;
      }
      const flat: number[] = [];
      for (const p of pts) {
        flat.push(Math.max(0, Math.min(1280, Math.round(p.x))));
        flat.push(Math.max(0, Math.min(720, Math.round(p.y))));
      }
      return [s.color.slice(0, 12), Math.max(2, Math.min(36, Math.round(s.width))), flat];
    });
}

const MAX_DECODED_STROKES = 64;
const MAX_DECODED_POINTS_PER_STROKE = 96;

function unpackStrokes(raw: unknown): ShareStrokeRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: ShareStrokeRecord[] = [];
  for (const item of raw.slice(0, MAX_DECODED_STROKES)) {
    if (!Array.isArray(item) || item.length < 3) continue;
    const color = typeof item[0] === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(item[0]) ? item[0] : '#1C1917';
    const width = typeof item[1] === 'number' && Number.isFinite(item[1]) ? Math.max(2, Math.min(36, item[1])) : 9;
    const flat = item[2];
    if (!Array.isArray(flat) || flat.length < 2) continue;
    const points: { x: number; y: number }[] = [];
    const maxFlat = Math.min(flat.length, MAX_DECODED_POINTS_PER_STROKE * 2);
    for (let i = 0; i + 1 < maxFlat; i += 2) {
      const x = Number(flat[i]);
      const y = Number(flat[i + 1]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        points.push({ x: Math.max(0, Math.min(1280, x)), y: Math.max(0, Math.min(720, y)) });
      }
    }
    if (points.length > 0) out.push({ color, width, points });
  }
  return out;
}

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(b64: string): string {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encodes a live character scene (+ optional 2nd buddy!) into a compact URL-safe token ($0 serverless!). */
export function encodeSharedStage(payload: Omit<SharedStagePayload, 'v'>): string {
  const compact = {
    v: 1,
    s: packStrokes(payload.strokes),
    b: payload.buddyStrokes && payload.buddyStrokes.length > 0 ? packStrokes(payload.buddyStrokes, 20, 28) : undefined,
    t: payload.toy,
    w: payload.world,
    m: payload.mood,
    p: payload.prop,
    f: payload.voiceFx,
  };
  return toBase64Url(JSON.stringify(compact));
}

/** Safely decodes a `#kagit=...` share token; returns null on malformed or tampered strings. */
export function decodeSharedStage(token: string): SharedStagePayload | null {
  try {
    let raw = token.trim();
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // keep raw if already unencoded
    }
    const clean = raw.replace(/^#?kagit=/, '');
    if (!clean || clean.length > 24000) return null;
    const parsed = JSON.parse(fromBase64Url(clean)) as Record<string, unknown>;
    if (!parsed || parsed.v !== 1) return null;
    const strokes = unpackStrokes(parsed.s);
    if (strokes.length === 0) return null;
    const buddyStrokes = unpackStrokes(parsed.b);
    return {
      v: 1,
      strokes,
      buddyStrokes: buddyStrokes.length > 0 ? buddyStrokes : undefined,
      toy: VALID_TOYS.has(String(parsed.t)) ? (parsed.t as SharedStagePayload['toy']) : 'film',
      world: VALID_WORLDS.has(String(parsed.w)) ? (parsed.w as StorybookWorldId) : 'rainy',
      mood: VALID_MOODS.has(String(parsed.m)) ? (parsed.m as CartoonMoodId) : 'joy',
      prop: VALID_PROPS.has(String(parsed.p)) ? (parsed.p as StagePropId) : 'none',
      voiceFx: VALID_VOICES.has(String(parsed.f)) ? (parsed.f as VoiceEffectId) : 'natural',
    };
  } catch {
    return null;
  }
}
