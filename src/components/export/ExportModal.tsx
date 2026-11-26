import { useEffect, useState } from 'react';
import {
  Archive,
  BookOpen,
  Clock,
  FileArchive,
  Film,
  Grid,
  Image as ImageIcon,
  Sparkles,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import {
  exportAnimatedGif,
  exportBeforeAfterReel,
  exportPngSequenceZip,
  exportPortableBackupZip,
  exportPrintableFlipbookPdf,
  exportSpriteSheetZip,
  exportVideoWithAudio,
} from '../../engine/exportEngine';
import { timelapseRecorder } from '../../engine/timelapseRecorder';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { ToggleLeverSwitch } from '../ui/Studio3DControls';
import { TrayExportIcon } from '../ui/AnimatedStudioIcons';
import { PocketFlipbook3DPreview } from '../ui/PocketFlipbook3DPreview';
import { useT } from '../../i18n/translations';

export default function ExportModal() {
  const { projects, activeProjectId, exportOpen, setExportOpen, notify } = useStudioStore();
  const t = useT();
  const project = projects.find((p) => p.id === activeProjectId);

  const [hideRoughBlue, setHideRoughBlue] = useState(true);
  const [transparentPng, setTransparentPng] = useState(false);
  const [includeSeal, setIncludeSeal] = useState(true);
  const [show3DFlipbook, setShow3DFlipbook] = useState(false);
  const [allScenes, setAllScenes] = useState(true);
  const [videoScale, setVideoScale] = useState<1 | 0.75 | 0.5>(1);
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState('');
  const [progressPct, setProgressPct] = useState(0);

  useEffect(() => {
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setExportOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportOpen, busy, setExportOpen]);

  if (!exportOpen || !project) return null;

  const sceneCount = project.scenes?.length ?? 1;
  const activeFramesList =
    allScenes && project.scenes && project.scenes.length > 0
      ? project.scenes.flatMap((s) => s.frames)
      : project.frames;

  const totalExposures = activeFramesList.reduce((s, f) => s + Math.max(1, f.hold), 0);
  const durationSec = (totalExposures / project.fps).toFixed(2);
  const a4Pages = Math.max(1, Math.ceil(activeFramesList.length / 8));
  const outW = Math.round(project.width * videoScale);
  const outH = Math.round(project.height * videoScale);
  const timelapseSteps = timelapseRecorder.getCount();

  const runExport = async (task: () => Promise<string | { filename: string }>) => {
    if (busy) return;
    setBusy(true);
    setProgressPct(5);
    setProgressLabel(t('exportPreparing'));
    try {
      const res = await task();
      const name = typeof res === 'string' ? res : res.filename;
      notify(`${t('exportDownloadedPrefix')} ${name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : t('exportFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onProgress = (label: string, pct: number) => {
    setProgressLabel(label);
    setProgressPct(pct);
  };

  return (
    <div
      onClick={() => !busy && setExportOpen(false)}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-console-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-3xl bg-desk-surface border border-desk-border shadow-2xl"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-desk-border flex items-center justify-between">
          <div>
            <h2 id="export-console-title" className="text-lg font-extrabold text-desk-text">
              {t('exportTitle')}
            </h2>
            <p className="font-mono text-[11px] text-desk-muted">
              {project.name} · {activeFramesList.length} {t('framesWord')} ({totalExposures}{' '}
              {t('exportExposureWord')} · {durationSec}s) · {project.fps} FPS · {outW}×{outH}
              {sceneCount > 1
                ? ` · ${allScenes ? `${sceneCount} ${t('scenesWord')}` : t('exportActiveOnly')}`
                : ''}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setExportOpen(false)}
            className="p-2 rounded-xl console-well border border-desk-border text-desk-muted hover:text-desk-text"
            aria-label={t('exportCloseAria')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Common Hardware Lever Switches */}
        <div className="px-6 py-3 bg-desk-well/60 border-b border-desk-border flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <ToggleLeverSwitch
              checked={hideRoughBlue}
              onChange={setHideRoughBlue}
              label={t('exportHideBlue')}
            />
            <ToggleLeverSwitch
              checked={transparentPng}
              onChange={setTransparentPng}
              label={t('exportTransparentPng')}
            />
            <ToggleLeverSwitch
              checked={includeSeal}
              onChange={setIncludeSeal}
              label={t('exportRedSeal')}
            />
            {sceneCount > 1 && (
              <ToggleLeverSwitch
                checked={allScenes}
                onChange={setAllScenes}
                label={`${t('exportAllScenes')} (${sceneCount})`}
              />
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[11px] text-desk-muted">{t('exportScale')}</span>
            {([1, 0.75, 0.5] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                onClick={() => setVideoScale(sc)}
                className={`px-2 py-0.5 rounded font-mono text-[11px] border ${
                  videoScale === sc
                    ? 'border-ink-brass text-ink-brass font-bold'
                    : 'border-desk-border text-desk-muted'
                }`}
              >
                {Math.round(sc * 100)}%
              </button>
            ))}
          </div>
        </div>

        {/* 8 Real Export Cards */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {/* 1. Video MP4 / WebM with Audio + 2D Camera */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-ink-vermilion font-bold text-sm">
                <Film className="w-4 h-4" />
                {t('exportVideoTitle')}
              </div>
              <p className="text-xs text-desk-muted mt-1">
                {project.audio
                  ? `${t('exportVideoDescAudio')} (${outW}×${outH}, ${durationSec}s)`
                  : `${t('exportVideoDescSilent')} (${outW}×${outH})`}
              </p>
            </div>
            <KeycapButton
              variant="vermilion"
              size="md"
              sheenPulse
              disabled={busy}
              onClick={() =>
                void runExport(() =>
                  exportVideoWithAudio(project, {
                    hideRoughBlue,
                    scale: videoScale,
                    allScenes,
                    includeSeal,
                    onProgress,
                  })
                )
              }
              className="w-full"
            >
              <TrayExportIcon className="w-4 h-4" />
              {t('exportVideoBtn')}
            </KeycapButton>
          </div>

          {/* 2. Printable A4 Flipbook Card with Live 3D Pocket Flipbook Preview */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-ink-brass font-bold text-sm">
                  <BookOpen className="w-4 h-4" />
                  {t('exportFlipbookTitle')}
                </div>
                <p className="text-xs text-desk-muted mt-1">
                  {a4Pages} {t('exportFlipbookDescPages')}
                </p>
              </div>

              <div
                className="w-16 h-24 shrink-0 rounded bg-[#FAF8F2] border border-black/20 p-1 grid grid-cols-2 gap-0.5 shadow"
                title="A4 8'li cep flipbook sayfa önizlemesi"
              >
                {activeFramesList.slice(0, 8).map((f, i) => (
                  <div
                    key={f.id}
                    className="h-4 rounded-[1px] border border-dashed border-neutral-400 flex overflow-hidden bg-white"
                  >
                    <span className="w-2 bg-neutral-200 border-r border-neutral-300 text-[4px] flex items-center justify-center text-neutral-600 font-mono">
                      {i + 1}
                    </span>
                    <div className="flex-1 overflow-hidden">
                      {f.thumbKey && (
                        <BlobImage blobKey={f.thumbKey} className="w-full h-full object-contain" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {show3DFlipbook && (
              <PocketFlipbook3DPreview
                frames={activeFramesList}
                paperColor={project.paperColor}
                fps={project.fps}
              />
            )}

            <div className="flex items-center gap-2">
              <KeycapButton
                variant="graphite"
                size="md"
                onClick={() => setShow3DFlipbook((v) => !v)}
                className="shrink-0"
              >
                {show3DFlipbook ? t('exportClose3D') : t('exportPreview3D')}
              </KeycapButton>
              <KeycapButton
                variant="brass"
                size="md"
                disabled={busy}
                onClick={() =>
                  void runExport(() =>
                    exportPrintableFlipbookPdf(project, { hideRoughBlue, allScenes, onProgress })
                  )
                }
                className="flex-1"
              >
                <TrayExportIcon className="w-4 h-4" />
                {t('exportFlipbookBtn')}
              </KeycapButton>
            </div>
          </div>

          {/* 3. Shareable Animated GIF */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-desk-text font-bold text-sm">
                <ImageIcon className="w-4 h-4 text-ink-blue" />
                {t('exportGifTitle')}
              </div>
              <p className="text-xs text-desk-muted mt-1">{t('exportGifDesc')}</p>
            </div>
            <KeycapButton
              variant="ivory"
              size="sm"
              disabled={busy}
              onClick={() =>
                void runExport(() =>
                  exportAnimatedGif(project, { hideRoughBlue, allScenes, onProgress })
                )
              }
              className="w-full"
            >
              {t('exportGifBtn')}
            </KeycapButton>
          </div>

          {/* 4. Paper-to-Digital / Rough-to-Final Before/After Reels Clip */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-desk-text font-bold text-sm">
                <Sparkles className="w-4 h-4 text-ink-vermilion" />
                {t('exportReelTitle')}
              </div>
              <p className="text-xs text-desk-muted mt-1">{t('exportReelDesc')}</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runExport(() => exportBeforeAfterReel(project, onProgress, includeSeal))}
              className="w-full py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-vermilion text-xs font-bold text-desk-text transition-colors"
            >
              {t('exportReelBtn')}
            </button>
          </div>

          {/* 5. Drawing Process Timelapse Video */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-desk-text font-bold text-sm">
                <Clock className="w-4 h-4 text-ink-brass" />
                {t('exportTimelapseTitle')} ({timelapseSteps})
              </div>
              <p className="text-xs text-desk-muted mt-1">{t('exportTimelapseDesc')}</p>
            </div>
            <button
              type="button"
              disabled={busy || timelapseSteps < 2}
              onClick={() =>
                void runExport(() => timelapseRecorder.exportVideo(project.name, onProgress))
              }
              className="w-full py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text disabled:opacity-40 transition-colors"
            >
              {timelapseSteps < 2 ? t('exportTimelapseMin') : t('exportTimelapseBtn')}
            </button>
          </div>

          {/* 6. PNG Sequence ZIP */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-desk-text font-bold text-sm">
                <FileArchive className="w-4 h-4 text-ink-emerald" />
                {t('exportPngZipTitle')}
              </div>
              <p className="text-xs text-desk-muted mt-1">{t('exportPngZipDesc')}</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runExport(() =>
                  exportPngSequenceZip(project, {
                    hideRoughBlue,
                    transparentBg: transparentPng,
                    allScenes,
                    onProgress,
                  })
                )
              }
              className="w-full py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-emerald text-xs font-bold text-desk-text transition-colors"
            >
              {t('exportPngZipBtn')}
            </button>
          </div>

          {/* 7. Game Engine Sprite Sheet ZIP */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-desk-text font-bold text-sm">
                <Grid className="w-4 h-4 text-ink-brass" />
                {t('exportSpriteTitle')}
              </div>
              <p className="text-xs text-desk-muted mt-1">{t('exportSpriteDesc')}</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runExport(() =>
                  exportSpriteSheetZip(project, {
                    hideRoughBlue,
                    transparentBg: transparentPng,
                    allScenes,
                    onProgress,
                  })
                )
              }
              className="w-full py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text transition-colors"
            >
              {t('exportSpriteBtn')}
            </button>
          </div>

          {/* 8. Portable Project Backup */}
          <div className="rounded-2xl console-well border border-desk-border p-4 flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-desk-text font-bold text-sm">
                <Archive className="w-4 h-4 text-desk-muted" />
                {t('exportBackupTitle')}
              </div>
              <p className="text-xs text-desk-muted mt-1">{t('exportBackupDesc')}</p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runExport(() => exportPortableBackupZip(project, onProgress))
              }
              className="w-full py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-desk-muted text-xs font-bold text-desk-text transition-colors"
            >
              {t('exportBackupBtn')}
            </button>
          </div>
        </div>

        {(busy || progressPct > 0) && (
          <div className="px-6 pb-5 space-y-1.5">
            <div className="flex justify-between font-mono text-[11px] text-desk-muted">
              <span>{progressLabel}</span>
              <span>{progressPct}%</span>
            </div>
            <div className="h-2 rounded-full console-well overflow-hidden border border-desk-border">
              <div
                className="h-full bg-ink-vermilion transition-all duration-150"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
