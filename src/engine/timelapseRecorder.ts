import {
  detectVideoExportSupport,
  encodeFramesToMp4WebCodecs,
  pickBestMediaRecorderFormat,
} from './videoExportEngine';

/**
 * Ultra-lightweight 480p Drawing Process Timelapse Recorder.
 * Keeps up to 120 compressed JPEG stroke snapshots (~3-4 MB RAM max)
 * and encodes a frame-accurate fastStart H.264 MP4 process video via WebCodecs (with MediaRecorder fallback)!
 */
const MAX_SNAPSHOTS = 120;

class DrawingTimelapseRecorder {
  private projectId: string | null = null;
  private snapshots: Blob[] = [];
  private targetW = 640;
  private targetH = 360;
  private tempCanvas: HTMLCanvasElement | null = null;

  public setProject(projectId: string | null): void {
    if (projectId !== this.projectId) {
      this.projectId = projectId;
      this.snapshots = [];
    }
  }

  public getProjectId(): string | null {
    return this.projectId;
  }

  public getCount(): number {
    return this.snapshots.length;
  }

  public clear(): void {
    this.snapshots = [];
  }

  public async captureCanvas(source: HTMLCanvasElement): Promise<void> {
    if (typeof document === 'undefined' || source.width === 0 || source.height === 0) return;
    const aspect = source.height / source.width;
    this.targetW = 640;
    this.targetH = Math.max(240, Math.floor((this.targetW * aspect) / 2) * 2);
    if (!this.tempCanvas) this.tempCanvas = document.createElement('canvas');
    this.tempCanvas.width = this.targetW;
    this.tempCanvas.height = this.targetH;
    const ctx = this.tempCanvas.getContext('2d')!;
    ctx.drawImage(source, 0, 0, this.targetW, this.targetH);

    const blob = await new Promise<Blob | null>((resolve) =>
      this.tempCanvas!.toBlob((b) => resolve(b), 'image/jpeg', 0.78)
    );
    if (!blob) return;

    if (this.snapshots.length >= MAX_SNAPSHOTS) {
      this.snapshots = this.snapshots.filter((_, idx) => idx % 2 === 0 || idx > MAX_SNAPSHOTS - 16);
    }
    this.snapshots.push(blob);
  }

  public async exportVideo(
    projectName: string,
    onProgress?: (label: string, pct: number) => void
  ): Promise<{ filename: string; blob: Blob }> {
    if (this.snapshots.length < 2) {
      throw new Error('Timelapse requires at least 2 stroke snapshots.');
    }

    const safeBase = projectName.replace(/[^\w\u00C0-\u024F-]+/g, '_') || 'inktrope';
    const support = detectVideoExportSupport();

    // Primary Path: Frame-accurate WebCodecs H.264 MP4 (`fastStart`, zero `moof` fragments!)
    if (support.webCodecsMp4) {
      const fps = 24;
      const holdPerSnap = Math.max(1, Math.min(4, Math.round(72 / this.snapshots.length)));
      const finalHold = 18; // ~0.75s hold on completed artwork
      const totalFrames = this.snapshots.length * holdPerSnap + finalHold;

      let cachedSnapIdx = -1;
      let cachedBmp: ImageBitmap | null = null;

      try {
        const mp4Blob = await encodeFramesToMp4WebCodecs({
          width: this.targetW,
          height: this.targetH,
          fps,
          totalFrames,
          onProgress: (done, total) => {
            onProgress?.(`MP4 (${done}/${total})`, Math.round((done / total) * 94));
          },
          drawFrame: async (fctx, i, fw, fh) => {
            const snapIdx = Math.min(
              this.snapshots.length - 1,
              Math.floor(i / holdPerSnap)
            );
            if (snapIdx !== cachedSnapIdx) {
              if (cachedBmp) cachedBmp.close();
              cachedBmp = await createImageBitmap(this.snapshots[snapIdx]);
              cachedSnapIdx = snapIdx;
            }
            if (cachedBmp) {
              fctx.drawImage(cachedBmp, 0, 0, fw, fh);
            }
          },
        });
        if (cachedBmp) {
          (cachedBmp as ImageBitmap).close();
          cachedBmp = null;
        }
        if (mp4Blob) {
          const filename = `${safeBase}_timelapse.mp4`;
          this.triggerBlobDownload(mp4Blob, filename);
          onProgress?.('MP4!', 100);
          return { filename, blob: mp4Blob };
        }
      } finally {
        if (cachedBmp) {
          (cachedBmp as ImageBitmap).close();
        }
      }
    }

    // Fallback Path: MediaRecorder prioritizing MP4 BEFORE WebM!
    const chosen = pickBestMediaRecorderFormat(false);
    if (!chosen) {
      throw new Error('Video recording is not supported in this browser.');
    }

    const c = document.createElement('canvas');
    c.width = this.targetW;
    c.height = this.targetH;
    const ctx = c.getContext('2d')!;

    const stream = c.captureStream(24);
    const recorder = new MediaRecorder(stream, {
      mimeType: chosen.mime,
      videoBitsPerSecond: 2_800_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: chosen.mime }));
    });

    recorder.start(100);
    const stepMs = Math.max(45, Math.min(180, Math.round(7000 / this.snapshots.length)));

    for (let i = 0; i < this.snapshots.length; i++) {
      onProgress?.(
        `${i + 1}/${this.snapshots.length}`,
        Math.round(((i + 1) / this.snapshots.length) * 90)
      );
      const bmp = await createImageBitmap(this.snapshots[i]);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      await new Promise((r) => setTimeout(r, stepMs));
    }
    await new Promise((r) => setTimeout(r, 900));
    recorder.stop();
    const outBlob = await done;
    onProgress?.('100%', 100);

    const filename = `${safeBase}_timelapse.${chosen.ext}`;
    this.triggerBlobDownload(outBlob, filename);
    return { filename, blob: outBlob };
  }

  private triggerBlobDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

export const timelapseRecorder = new DrawingTimelapseRecorder();
