import { useEffect, useState } from 'react';
import {
  Archive,
  BookOpen,
  Check,
  Clock,
  Copy,
  FileArchive,
  Film,
  Grid,
  Image as ImageIcon,
  Link2,
  Share2,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react';
import type { StudioProject } from '../../types/studio';
import { flushActiveCanvasNow, useStudioStore } from '../../store/useStudioStore';
import {
  createProjectShareLink,
  exportAnimatedGif,
  exportBeforeAfterReel,
  exportPngSequenceZip,
  exportPortableBackupZip,
  exportPrintableFlipbookPdf,
  exportSpriteSheetZip,
  exportVideoWithAudio,
} from '../../engine/exportEngine';
import {
  resolveExportDimensions,
  shareFileOnMobileIfSupported,
  type ExportAspectPreset,
} from '../../engine/videoExportEngine';
import { timelapseRecorder } from '../../engine/timelapseRecorder';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { ToggleLeverSwitch } from '../ui/Studio3DControls';
import { TrayExportIcon } from '../ui/AnimatedStudioIcons';
import { PocketFlipbook3DPreview } from '../ui/PocketFlipbook3DPreview';
import { localizeProjectName, useT } from '../../i18n/translations';
import { useModalA11y } from '../../hooks/useModalA11y';

interface LastExportedArtifact {
  filename: string;
  blob: Blob;
  mimeType: string;
}

export default function ExportModal() {
  const { projects, activeProjectId, exportOpen, setExportOpen, notify } = useStudioStore();
  const t = useT();
  const locale = useStudioStore((st) => st.locale);
  const project = projects.find((p) => p.id === activeProjectId);

  const [hideRoughBlue, setHideRoughBlue] = useState(true);
  const [transparentPng, setTransparentPng] = useState(false);
  const [includeSeal, setIncludeSeal] = useState(true);
  const [show3DFlipbook, setShow3DFlipbook] = useState(false);
  const [allScenes, setAllScenes] = useState(true);
  const [videoScale, setVideoScale] = useState<1 | 0.75 | 0.5>(1);
  const [aspectPreset, setAspectPreset] = useState<ExportAspectPreset>('native');
  const [busy, setBusy] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareCopiedOk, setShareCopiedOk] = useState(false);
  const [lastExported, setLastExported] = useState<LastExportedArtifact | null>(null);

  const dialogRef = useModalA11y<HTMLDivElement>({
    open: exportOpen,
    onClose: () => setExportOpen(false),
    closeDisabled: busy || shareBusy,
    modal: true,
  });
  const [progressLabel, setProgressLabel] = useState('');
  const [progressPct, setProgressPct] = useState(0);

  useEffect(() => {
    if (!exportOpen) {
      setShareUrl(null);
      setShareCopiedOk(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !shareBusy) setExportOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exportOpen, busy, shareBusy, setExportOpen]);

  if (!exportOpen || !project) return null;

  const sceneCount = project.scenes?.length ?? 1;
  const activeFramesList =
    allScenes && project.scenes && project.scenes.length > 0
      ? project.scenes.flatMap((s) => s.frames)
      : project.frames;

  const totalExposures = activeFramesList.reduce((s, f) => s + Math.max(1, f.hold), 0);
  const durationSec = (totalExposures / project.fps).toFixed(2);
  const cardsPerA4 = project.width / Math.max(1, project.height) >= 1.3 ? 10 : 8;
  const a4Pages = Math.max(1, Math.ceil(totalExposures / cardsPerA4));
  const resolvedDims = resolveExportDimensions(
    project.width,
    project.height,
    videoScale,
    aspectPreset
  );
  const outW = resolvedDims.width;
  const outH = resolvedDims.height;
  const timelapseSteps = timelapseRecorder.getCount();
  const canWebShareUrl =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const getFreshProject = (): StudioProject => {
    const st = useStudioStore.getState();
    return st.projects.find((p) => p.id === st.activeProjectId) ?? project;
  };

  const runExport = async (
    task: (
      freshProject: StudioProject
    ) => Promise<string | { filename: string; blob?: Blob; mimeType?: string }>
  ) => {
    if (busy) return;
    setBusy(true);
    setProgressPct(5);
    setProgressLabel(t('exportPreparing'));
    try {
      await flushActiveCanvasNow();
      const fresh = getFreshProject();
      const res = await task(fresh);
      const name = typeof res === 'string' ? res : res.filename;
      if (typeof res !== 'string' && res.blob) {
        setLastExported({
          filename: res.filename,
          blob: res.blob,
          mimeType: res.mimeType ?? (res.blob.type || 'application/octet-stream'),
        });
      }
      notify(`${t('exportDownloadedPrefix')} ${name}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : t('exportFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copyUrlSafely = async (url: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('clipboard_unavailable');
      }
      await navigator.clipboard.writeText(url);
      setShareCopiedOk(true);
      notify(t('shareCopied'));
      setTimeout(() => setShareCopiedOk(false), 2000);
    } catch {
      setShareCopiedOk(false);
      notify(t('shareManualCopyToast'), 'info');
    }
  };

  const handleCreateShareLink = async () => {
    if (shareBusy || busy) return;
    setShareBusy(true);
    try {
      await flushActiveCanvasNow();
      const fresh = getFreshProject();
      const link = await createProjectShareLink(fresh);
      setShareUrl(link);
      await copyUrlSafely(link);
    } catch (err) {
      notify(err instanceof Error ? err.message : t('exportFailed'), 'error');
    } finally {
      setShareBusy(false);
    }
  };

  const handleNativeUrlShare = async () => {
    if (!shareUrl || !canWebShareUrl) return;
    try {
      await navigator.share({
        title: localizeProjectName(project.name, locale),
        url: shareUrl,
      });
    } catch {
      // User dismissed OS share sheet
    }
  };

  const handleMobileFileShare = async () => {
    if (!lastExported) return;
    const ok = await shareFileOnMobileIfSupported(
      lastExported.blob,
      lastExported.filename,
      lastExported.mimeType
    );
    if (!ok) {
      notify(t('shareManualCopyToast'), 'info');
    }
  };

  const onProgress = (label: string, pct: number) => {
    setProgressLabel(label);
    setProgressPct(pct);
  };

  return (
    <div
      onClick={() => !busy && !shareBusy && setExportOpen(false)}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-console-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-3xl bg-desk-surface border border-desk-border shadow-2xl"
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-desk-border flex items-center justify-between">
          <div>
            <h2 id="export-console-title" className="text-lg font-extrabold text-desk-text">
              {t('exportTitle')}
            </h2>
            <p className="font-mono text-[11px] text-desk-muted">
              {localizeProjectName(project.name, locale)} · {activeFramesList.length}{' '}
              {t('framesWord')} ({totalExposures} {t('exportExposureWord')} · {durationSec}s) ·{' '}
              {project.fps} FPS · {outW}×{outH}
              {sceneCount > 1
                ? ` · ${allScenes ? `${sceneCount} ${t('scenesWord')}` : t('exportActiveOnly')}`
                : ''}
            </p>
          </div>
          <button
            type="button"
            disabled={busy || shareBusy}
            onClick={() => setExportOpen(false)}
            className="min-w-[44px] min-h-[44px] p-2 rounded-xl inline-flex items-center justify-center console-well border border-desk-border text-desk-muted hover:text-desk-text"
            aria-label={t('exportCloseAria')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Dedicated 1-Click Project Share Link & Mobile Send Strip */}
        <div className="px-6 py-3.5 bg-desk-panel/55 border-b border-desk-border space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-bold text-desk-text">
                <Link2 className="w-4 h-4 text-ink-brass shrink-0" />
                <span>{t('exportShareSectionTitle')}</span>
              </div>
              <p className="text-xs text-desk-muted mt-0.5">{t('exportShareSectionDesc')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {lastExported && (
                <button
                  type="button"
                  onClick={() => void handleMobileFileShare()}
                  className="min-h-[44px] px-3 rounded-xl console-well border border-ink-emerald/60 hover:border-ink-emerald text-xs font-bold text-desk-text inline-flex items-center gap-1.5 transition-colors"
                >
                  <Smartphone className="w-3.5 h-3.5 text-ink-emerald" />
                  <span>{t('exportShareMobileFileBtn')}</span>
                </button>
              )}

              <KeycapButton
                variant="brass"
                size="sm"
                disabled={shareBusy || busy}
                onClick={() => void handleCreateShareLink()}
                className="min-h-[44px]"
              >
                <Share2 className="w-3.5 h-3.5" />
                <span>{shareBusy ? t('exportShareCreating') : t('exportShareCreateBtn')}</span>
              </KeycapButton>
            </div>
          </div>

          {shareUrl && (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <input
                type="text"
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                aria-label={t('exportShareSectionTitle')}
                className="flex-1 min-w-[200px] min-h-[40px] px-3 rounded-xl console-well border border-desk-border font-mono text-[11px] text-desk-text focus:outline-none focus:border-ink-brass"
              />
              <button
                type="button"
                onClick={() => void copyUrlSafely(shareUrl)}
                className="min-h-[44px] px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text inline-flex items-center gap-1.5"
              >
                {shareCopiedOk ? (
                  <Check className="w-3.5 h-3.5 text-ink-emerald" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-ink-brass" />
                )}
                <span>{t('exportShareCopyBtn')}</span>
              </button>
              {canWebShareUrl && (
                <button
                  type="button"
                  onClick={() => void handleNativeUrlShare()}
                  className="min-h-[44px] px-3 rounded-xl bg-ink-vermilion text-white text-xs font-bold inline-flex items-center gap-1.5"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>{t('exportShareNativeBtn')}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Common Hardware Lever Switches + Aspect & Scale Selectors */}
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

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-desk-muted">
                {t('exportAspectLabel')}
              </span>
              {(
                [
                  { id: 'native', label: t('exportAspectNative') },
                  { id: '9:16', label: t('exportAspect916') },
                  { id: '1:1', label: t('exportAspect1x1') },
                ] as const
              ).map((ap) => (
                <button
                  key={ap.id}
                  type="button"
                  onClick={() => setAspectPreset(ap.id)}
                  className={`px-2 py-1 rounded font-mono text-[11px] border ${
                    aspectPreset === ap.id
                      ? 'border-ink-vermilion text-ink-vermilion font-bold'
                      : 'border-desk-border text-desk-muted hover:text-desk-text'
                  }`}
                >
                  {ap.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <span className="font-mono text-[11px] text-desk-muted">{t('exportScale')}</span>
              {([1, 0.75, 0.5] as const).map((sc) => (
                <button
                  key={sc}
                  type="button"
                  onClick={() => setVideoScale(sc)}
                  className={`px-2 py-1 rounded font-mono text-[11px] border ${
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
                void runExport((fresh) =>
                  exportVideoWithAudio(fresh, {
                    hideRoughBlue,
                    scale: videoScale,
                    aspectPreset,
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
                title={t('exportFlipbookIframeTitle')}
                aria-hidden="true"
              >
                {activeFramesList.slice(0, 8).map((f) => (
                  <div
                    key={f.id}
                    className="h-4 rounded-[1px] border border-dashed border-neutral-400 flex overflow-hidden bg-white"
                  >
                    <span className="w-2 bg-neutral-200 border-r border-neutral-300" />
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
                  void runExport((fresh) =>
                    exportPrintableFlipbookPdf(fresh, {
                      hideRoughBlue,
                      allScenes,
                      locale,
                      onProgress,
                    })
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
                void runExport((fresh) =>
                  exportAnimatedGif(fresh, {
                    hideRoughBlue,
                    aspectPreset,
                    allScenes,
                    onProgress,
                  })
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
              onClick={() =>
                void runExport((fresh) =>
                  exportBeforeAfterReel(fresh, onProgress, includeSeal, aspectPreset)
                )
              }
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-vermilion text-xs font-bold text-desk-text transition-colors"
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
                void runExport((fresh) => timelapseRecorder.exportVideo(fresh.name, onProgress))
              }
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text disabled:opacity-40 transition-colors"
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
                void runExport((fresh) =>
                  exportPngSequenceZip(fresh, {
                    hideRoughBlue,
                    transparentBg: transparentPng,
                    allScenes,
                    onProgress,
                  })
                )
              }
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-emerald text-xs font-bold text-desk-text transition-colors"
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
                void runExport((fresh) =>
                  exportSpriteSheetZip(fresh, {
                    hideRoughBlue,
                    transparentBg: transparentPng,
                    allScenes,
                    onProgress,
                  })
                )
              }
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text transition-colors"
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
              onClick={() => void runExport((fresh) => exportPortableBackupZip(fresh, onProgress))}
              className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-desk-surface border border-desk-border hover:border-desk-muted text-xs font-bold text-desk-text transition-colors"
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
