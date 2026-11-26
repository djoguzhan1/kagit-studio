import type {
  AutoCornerParams,
  FloodFillParams,
  GifEncodeParams,
  GridSliceParams,
  PaperProcessParams,
  QuadCorners,
} from './paperWorker';

let workerInstance: Worker | null = null;
let seq = 1;
const pending = new Map<
  number,
  { resolve: (val: unknown) => void; reject: (err: Error) => void }
>();

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(new URL('./paperWorker.ts', import.meta.url), {
      type: 'module',
    });
    workerInstance.onmessage = (e: MessageEvent) => {
      const { id, ok, result, error } = e.data as {
        id: number;
        ok: boolean;
        result?: unknown;
        error?: string;
      };
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error ?? 'İşlem başarısız'));
    };
    workerInstance.onerror = (err) => {
      for (const [, p] of pending) {
        p.reject(new Error(err.message || 'Worker hatası'));
      }
      pending.clear();
    };
  }
  return workerInstance;
}

function callWorker<T>(
  type: 'paper' | 'auto-corners' | 'fill' | 'grid-slice' | 'gif',
  payload: unknown,
  transfers: Transferable[] = []
): Promise<T> {
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
    });
    getWorker().postMessage({ id, type, payload }, transfers);
  });
}

export async function runPaperProcess(params: PaperProcessParams): Promise<{
  rgba: Uint8ClampedArray;
  warpedOriginalRgba: Uint8ClampedArray;
  width: number;
  height: number;
  centroidX: number;
  centroidY: number;
}> {
  const copy = new Uint8ClampedArray(params.rgba);
  return callWorker('paper', { ...params, rgba: copy }, [copy.buffer]);
}

export async function runAutoDetectCorners(params: AutoCornerParams): Promise<QuadCorners> {
  const copy = new Uint8ClampedArray(params.rgba);
  const res = await callWorker<{ corners: QuadCorners }>(
    'auto-corners',
    { ...params, rgba: copy },
    [copy.buffer]
  );
  return res.corners;
}

export async function runSmartFloodFill(params: FloodFillParams): Promise<Uint8ClampedArray> {
  const targetCopy = new Uint8ClampedArray(params.targetRgba);
  const barrierCopy = params.barrierRgba ? new Uint8ClampedArray(params.barrierRgba) : undefined;
  const transfers: Transferable[] = [targetCopy.buffer];
  if (barrierCopy) transfers.push(barrierCopy.buffer);

  const res = await callWorker<{ rgba: Uint8ClampedArray }>(
    'fill',
    { ...params, targetRgba: targetCopy, barrierRgba: barrierCopy },
    transfers
  );
  return res.rgba;
}

export async function runGridSlice(params: GridSliceParams): Promise<Uint8ClampedArray[]> {
  const copy = new Uint8ClampedArray(params.rgba);
  const res = await callWorker<{ cells: Uint8ClampedArray[] }>(
    'grid-slice',
    { ...params, rgba: copy },
    [copy.buffer]
  );
  return res.cells;
}

export async function runGifEncode(params: GifEncodeParams): Promise<Blob> {
  const clonedFrames = params.frames.map((f) => ({
    rgba: new Uint8ClampedArray(f.rgba),
    hold: f.hold,
  }));
  const transfers = clonedFrames.map((f) => f.rgba.buffer);
  const res = await callWorker<{ bytes: Uint8Array }>(
    'gif',
    { ...params, frames: clonedFrames },
    transfers
  );
  return new Blob([res.bytes.buffer as ArrayBuffer], { type: 'image/gif' });
}
