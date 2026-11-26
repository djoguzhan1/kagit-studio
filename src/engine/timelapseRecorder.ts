/**
 * Ultra-lightweight 480p Drawing Process Timelapse Recorder.
 * Keeps up to 120 compressed WebP/JPEG stroke snapshots (~3-4 MB RAM max)
 * and encodes a smooth shareable WebM/MP4 process video on demand!
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
    this.targetH = Math.max(240, Math.round(this.targetW * aspect));
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
      // Subsample every 2nd older frame so full session arc stays intact!
      this.snapshots = this.snapshots.filter((_, idx) => idx % 2 === 0 || idx > MAX_SNAPSHOTS - 16);
    }
    this.snapshots.push(blob);
  }

  public async exportVideo(
    projectName: string,
    onProgress?: (label: string, pct: number) => void
  ): Promise<string> {
    if (this.snapshots.length < 2) {
      throw new Error('Timelapse için tuvalde en az 2 çizim adımı gerekiyor.');
    }

    const c = document.createElement('canvas');
    c.width = this.targetW;
    c.height = this.targetH;
    const ctx = c.getContext('2d')!;

    const mimeCandidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const stream = c.captureStream(24);
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 2_800_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    });

    recorder.start(100);
    const stepMs = Math.max(45, Math.min(180, Math.round(7000 / this.snapshots.length)));

    for (let i = 0; i < this.snapshots.length; i++) {
      onProgress?.(`Timelapse kare ${i + 1}/${this.snapshots.length}`, Math.round(((i + 1) / this.snapshots.length) * 90));
      const bmp = await createImageBitmap(this.snapshots[i]);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      await new Promise((r) => setTimeout(r, stepMs));
    }
    // Hold final drawing for 1 second
    await new Promise((r) => setTimeout(r, 900));
    recorder.stop();
    const outBlob = await done;
    onProgress?.('İndiriliyor…', 100);

    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const filename = `${projectName.replace(/[^\w\u00C0-\u024F-]+/g, '_')}_timelapse.${ext}`;
    const url = URL.createObjectURL(outBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return filename;
  }
}

export const timelapseRecorder = new DrawingTimelapseRecorder();
