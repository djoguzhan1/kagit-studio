import { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Film,
  Mic,
  MoreHorizontal,
  Plus,
  Repeat,
  RotateCcw,
  Square,
  StickyNote,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { FlipPageIcon, MotionPlayIcon, OnionLayersIcon } from '../ui/AnimatedStudioIcons';
import { analyzeAndStoreAudio, MicVoiceRecorder } from '../../engine/audioEngine';
import { soundEngine } from '../../engine/soundEngine';
import { localizeSceneOrNote, useT } from '../../i18n/translations';

export default function XSheetTimeline() {
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    playbackFrameIndex,
    onion,
    isPlaying,
    loopPlayback,
    loopRange,
    setPlaying,
    toggleLoop,
    setLoopRange,
    updateOnion,
    selectFrame,
    addFrameAfterCurrent,
    deleteFrame,
    undoDeleteFrame,
    lastDeletedFrame,
    setFrameHold,
    updateFrameNote,
    moveFrame,
    addScene,
    selectScene,
    deleteScene,
    renameScene,
    updateProjectSettings,
    setAudioTrack,
    updateAudioTrack,
    notify,
    locale,
  } = useStudioStore();
  const t = useT();

  const project = projects.find((p) => p.id === activeProjectId);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MicVoiceRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [sceneNameDraft, setSceneNameDraft] = useState('');
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!mobileMoreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMoreOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mobileMoreOpen]);

  if (!project) return null;

  const displayFrameIdx = playbackFrameIndex ?? activeFrameIndex;
  const activeFrame = project.frames[activeFrameIndex];
  const scenes = project.scenes ?? [];
  const totalExposures = project.frames.reduce((s, f) => s + Math.max(1, f.hold), 0);
  const totalSec = (totalExposures / project.fps).toFixed(2);

  const commitSceneRename = (scId: string) => {
    const trimmed = sceneNameDraft.trim();
    if (trimmed) renameScene(scId, trimmed);
    setRenamingSceneId(null);
  };

  const handleAudioFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const track = await analyzeAndStoreAudio(file, file.name, project.fps);
      setAudioTrack(track);
      notify(`${t('xsheetAudioAdded')} (${track.durationSec.toFixed(1)}s)`);
    } catch {
      notify(t('xsheetAudioError'), 'error');
    } finally {
      if (audioInputRef.current) audioInputRef.current.value = '';
    }
  };

  const toggleMicRecord = async () => {
    if (recording && recorderRef.current) {
      try {
        const blob = await recorderRef.current.stop();
        setRecording(false);
        const track = await analyzeAndStoreAudio(blob, t('xsheetRecAudio'), project.fps);
        setAudioTrack(track);
        notify(`${t('xsheetVoiceSaved')} (${track.durationSec.toFixed(1)}s)`);
      } catch {
        setRecording(false);
        notify(t('xsheetVoiceError'), 'error');
      }
      return;
    }

    try {
      const rec = new MicVoiceRecorder();
      await rec.start();
      recorderRef.current = rec;
      setRecording(true);
      notify(t('xsheetMicStarted'), 'info');
    } catch {
      notify(t('xsheetMicDenied'), 'error');
    }
  };

  const handleWaveformClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!project.frames.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetSec = project.audio ? ratio * project.audio.durationSec : ratio * (totalExposures / project.fps);
    const targetSlot = Math.floor(targetSec * project.fps);
    let acc = 0;
    for (let i = 0; i < project.frames.length; i++) {
      acc += Math.max(1, project.frames[i].hold);
      if (targetSlot < acc) {
        selectFrame(i);
        return;
      }
    }
    selectFrame(project.frames.length - 1);
  };

  return (
    <section
      aria-label="X-Sheet Timeline"
      className="border-t border-desk-border bg-desk-surface px-2 sm:px-3 py-1.5 shrink-0 select-none z-20 space-y-1.5"
    >
      {/* Hidden Audio File Input */}
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={handleAudioFile}
      />

      {/* Multi-Scene Storyboard Strip (Desktop & Tablet >=768px; on <768px accessible inside More menu) */}
      <div className="hidden md:flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-desk-border/70">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted flex items-center gap-1 pr-1 shrink-0">
            <Film className="w-3.5 h-3.5 text-ink-brass" />
            {t('xsheetScenes')}
          </span>
          {scenes.map((sc) => {
            const active = sc.id === project.activeSceneId;
            const isRenaming = renamingSceneId === sc.id;
            const localizedScName = localizeSceneOrNote(sc.name, locale);
            return (
              <div
                key={sc.id}
                className={`inline-flex items-center gap-1 min-h-[28px] px-2.5 py-0.5 rounded-lg font-mono text-[11px] border transition-colors shrink-0 ${
                  active
                    ? 'bg-desk-panel border-ink-brass text-desk-text font-bold'
                    : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
                }`}
              >
                {isRenaming ? (
                  <input
                    type="text"
                    autoFocus
                    value={sceneNameDraft}
                    onChange={(e) => setSceneNameDraft(e.target.value)}
                    onBlur={() => commitSceneRename(sc.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitSceneRename(sc.id);
                      else if (e.key === 'Escape') setRenamingSceneId(null);
                    }}
                    className="w-28 bg-desk-surface border border-ink-brass rounded px-1.5 py-0.5 text-[11px] text-desk-text focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => selectScene(sc.id)}
                    onDoubleClick={() => {
                      setRenamingSceneId(sc.id);
                      setSceneNameDraft(localizedScName);
                    }}
                    title={t('xsheetRenameSceneHint')}
                    className="min-h-[26px]"
                  >
                    {localizedScName} ({sc.frames.length})
                  </button>
                )}
                {scenes.length > 1 && (
                  <button
                    type="button"
                    onClick={() => deleteScene(sc.id)}
                    className="min-w-[24px] min-h-[24px] inline-flex items-center justify-center opacity-65 hover:opacity-100 hover:text-ink-vermilion ml-0.5"
                    title={t('xsheetDeleteScene')}
                    aria-label={t('xsheetDeleteScene')}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => {
              soundEngine.clapperSnap();
              addScene();
            }}
            className="min-h-[28px] px-2.5 py-0.5 rounded-lg font-mono text-[11px] border border-dashed border-desk-border text-desk-muted hover:text-ink-brass hover:border-ink-brass inline-flex items-center gap-1 shrink-0"
            title={`+ ${t('xsheetAddScene')}`}
          >
            <Plus className="w-3.5 h-3.5" />
            {t('xsheetAddScene')}
          </button>
        </div>

        {/* Loop In / Out Range Selector */}
        <div className="hidden lg:flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-desk-muted">{t('xsheetLoopRange')}</span>
          <button
            type="button"
            onClick={() =>
              setLoopRange({
                start: activeFrameIndex,
                end: Math.max(activeFrameIndex, loopRange?.end ?? project.frames.length - 1),
              })
            }
            className="min-h-[28px] px-2 py-0.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text"
            title="In"
          >
            In #{(loopRange?.start ?? 0) + 1}
          </button>
          <button
            type="button"
            onClick={() =>
              setLoopRange({
                start: Math.min(activeFrameIndex, loopRange?.start ?? 0),
                end: activeFrameIndex,
              })
            }
            className="min-h-[28px] px-2 py-0.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text"
            title="Out"
          >
            Out #{(loopRange?.end ?? project.frames.length - 1) + 1}
          </button>
          {loopRange && (
            <button
              type="button"
              onClick={() => setLoopRange(null)}
              className="min-h-[28px] px-2 py-0.5 rounded-lg text-ink-vermilion hover:underline"
            >
              {t('shelfTabAll')}
            </button>
          )}
        </div>
      </div>

      {/* Hardware Transport Row — Fits 360px cleanly in ONE row with 0px clipping and >=44x44px targets! */}
      <div className="flex items-center justify-between gap-1 sm:gap-2">
        <div className="flex items-center gap-1 sm:gap-1.5 min-w-0">
          <KeycapButton
            data-tour="draw-play"
            size="sm"
            variant="vermilion"
            sheenPulse={!isPlaying}
            sheenDelay={0.6}
            pressed={isPlaying}
            led={isPlaying ? 'emerald' : 'off'}
            ledPulse={isPlaying}
            onClick={() => setPlaying(!isPlaying)}
            title={`${t('playPause')} (Space / Enter)`}
            aria-label={isPlaying ? t('xsheetStop') : t('xsheetPlay')}
          >
            <MotionPlayIcon playing={isPlaying} className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">{isPlaying ? t('xsheetStop') : t('xsheetPlay')}</span>
          </KeycapButton>

          <KeycapButton
            size="sm"
            led={loopPlayback ? 'amber' : 'off'}
            pressed={loopPlayback}
            sound="toggle"
            onClick={toggleLoop}
            title={t('xsheetLoopRange')}
            aria-label={t('xsheetLoopRange')}
            className="hidden md:inline-flex"
          >
            <Repeat className="w-3.5 h-3.5" />
          </KeycapButton>

          <KeycapButton
            size="sm"
            led={onion.enabled ? 'amber' : 'off'}
            pressed={onion.enabled}
            sound="toggle"
            onClick={() => updateOnion({ enabled: !onion.enabled })}
            title={t('railOnionTitle')}
            aria-label={t('railOnionTitle')}
          >
            <OnionLayersIcon className="w-3.5 h-3.5" />
          </KeycapButton>

          <KeycapButton
            size="sm"
            sound="flip"
            onClick={() => selectFrame(Math.max(0, activeFrameIndex - 1))}
            disabled={activeFrameIndex <= 0}
            title={t('stagePrevPaper')}
            aria-label={t('stagePrevPaper')}
          >
            <ChevronLeft className="w-4 h-4" />
          </KeycapButton>

          <span className="font-mono text-[11px] font-bold text-desk-text px-0.5 whitespace-nowrap tabular-nums text-center">
            {String(displayFrameIdx + 1).padStart(2, '0')}/{String(project.frames.length).padStart(2, '0')}
          </span>

          <KeycapButton
            size="sm"
            sound="flip"
            onClick={() => selectFrame(Math.min(project.frames.length - 1, activeFrameIndex + 1))}
            disabled={activeFrameIndex >= project.frames.length - 1}
            title={t('stageNextPaper')}
            aria-label={t('stageNextPaper')}
          >
            <ChevronRight className="w-4 h-4" />
          </KeycapButton>
        </div>

        {/* Right Transport Group: + Frame + Mobile More Menu / Desktop Full Frame & Audio Tools */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <KeycapButton
            data-tour="draw-add-frame"
            size="sm"
            variant="ivory"
            sound="flip"
            onClick={() => void addFrameAfterCurrent(false)}
            title={`${t('xsheetBlankFrame')} (N)`}
            aria-label={t('xsheetBlankFrame')}
          >
            <FlipPageIcon className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden sm:inline">{t('xsheetBlankFrame')}</span>
          </KeycapButton>

          {/* Desktop / Tablet >=768px Frame & Hold & FPS & Audio Controls */}
          <div className="hidden md:flex items-center gap-1.5">
            <KeycapButton
              size="sm"
              sound="flip"
              onClick={() => void addFrameAfterCurrent(true)}
              title={t('xsheetDuplicateFrame')}
              aria-label={t('xsheetDuplicateFrame')}
            >
              <Copy className="w-3.5 h-3.5" />
              <span className="hidden xl:inline">{t('xsheetDuplicateFrame')}</span>
            </KeycapButton>

            <KeycapButton
              size="sm"
              onClick={() => deleteFrame(activeFrameIndex)}
              disabled={project.frames.length <= 1}
              title={t('xsheetDeleteFrame')}
              aria-label={t('xsheetDeleteFrame')}
            >
              <Trash2 className="w-3.5 h-3.5 text-ink-vermilion" />
            </KeycapButton>

            {lastDeletedFrame?.projectId === project.id && (
              <KeycapButton
                size="sm"
                variant="brass"
                onClick={() => undoDeleteFrame()}
                title={t('xsheetUndoDeleteBtn')}
                aria-label={t('xsheetUndoDeleteBtn')}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </KeycapButton>
            )}

            {/* Active-Frame Hold Stepper (replaces 32 tiny 16x16 per-card buttons!) */}
            {activeFrame && (
              <div className="hidden lg:inline-flex items-center gap-1 px-1.5 min-h-[38px] rounded-xl console-well border border-desk-border">
                <button
                  type="button"
                  onClick={() => setFrameHold(activeFrameIndex, activeFrame.hold - 1)}
                  disabled={activeFrame.hold <= 1}
                  title={t('xsheetHoldDecrease')}
                  aria-label={t('xsheetHoldDecrease')}
                  className="min-w-[28px] min-h-[28px] rounded-lg bg-desk-surface border border-desk-border font-mono text-xs font-bold text-desk-muted hover:text-desk-text disabled:opacity-35"
                >
                  −
                </button>
                <span className="font-mono text-[11px] font-bold text-ink-brass px-1 tabular-nums">
                  ×{activeFrame.hold}
                </span>
                <button
                  type="button"
                  onClick={() => setFrameHold(activeFrameIndex, activeFrame.hold + 1)}
                  title={t('xsheetHoldIncrease')}
                  aria-label={t('xsheetHoldIncrease')}
                  className="min-w-[28px] min-h-[28px] rounded-lg bg-desk-surface border border-desk-border font-mono text-xs font-bold text-desk-muted hover:text-desk-text"
                >
                  +
                </button>
              </div>
            )}

            {activeFrame && (
              <div className="hidden 2xl:flex items-center gap-1.5 px-2.5 min-h-[38px] rounded-xl console-well border border-desk-border">
                <StickyNote className="w-3.5 h-3.5 text-ink-brass shrink-0" />
                <input
                  type="text"
                  value={localizeSceneOrNote(activeFrame.note ?? '', locale)}
                  onChange={(e) => updateFrameNote(activeFrameIndex, e.target.value)}
                  placeholder={t('xsheetNotePlaceholder')}
                  className="bg-transparent text-[11px] font-mono text-desk-text placeholder:text-desk-muted/65 w-36 focus:outline-none"
                />
              </div>
            )}

            <div className="hidden lg:flex items-center gap-0.5 p-0.5 rounded-xl console-well border border-desk-border">
              {([8, 12, 15, 24] as const).map((fps) => (
                <button
                  key={fps}
                  type="button"
                  onClick={() => {
                    soundEngine.click(1.05);
                    updateProjectSettings({ fps });
                  }}
                  className={`min-w-[30px] min-h-[30px] px-1.5 rounded-lg font-mono text-[11px] transition-colors ${
                    project.fps === fps
                      ? 'bg-desk-panel text-ink-brass font-bold border border-desk-border'
                      : 'text-desk-muted hover:text-desk-text'
                  }`}
                >
                  {fps}
                </button>
              ))}
              <span className="font-mono text-[11px] text-desk-muted px-1">FPS</span>
            </div>

            <span className="font-mono text-[11px] text-desk-muted hidden 2xl:inline px-1">
              {totalSec}s
            </span>

            <KeycapButton
              size="sm"
              variant={recording ? 'vermilion' : 'graphite'}
              led={recording ? 'vermilion' : project.audio ? 'emerald' : 'off'}
              ledPulse={recording}
              onClick={() => void toggleMicRecord()}
              title={t('xsheetRecAudio')}
              aria-label={t('xsheetRecAudio')}
            >
              {recording ? (
                <Square className="w-3.5 h-3.5 fill-current" />
              ) : (
                <Mic className="w-3.5 h-3.5" />
              )}
              <span className="hidden xl:inline">
                {recording ? t('xsheetStopRec') : t('xsheetRecAudio')}
              </span>
            </KeycapButton>

            <KeycapButton
              size="sm"
              onClick={() => audioInputRef.current?.click()}
              title={t('xsheetUploadAudio')}
              aria-label={t('xsheetUploadAudio')}
            >
              <Upload className="w-3.5 h-3.5" />
            </KeycapButton>
          </div>

          {/* Mobile (<768px) Compact 44x44 Frame, Hold, Scene, FPS & Voice Menu */}
          <div className="relative md:hidden">
            <button
              type="button"
              onClick={() => setMobileMoreOpen((v) => !v)}
              aria-expanded={mobileMoreOpen}
              aria-label={t('xsheetMoreTools')}
              title={t('xsheetMoreTools')}
              className={`min-w-[44px] min-h-[44px] rounded-xl border flex items-center justify-center transition-colors ${
                mobileMoreOpen || recording
                  ? 'bg-ink-brass/20 border-ink-brass text-ink-brass'
                  : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
              }`}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>

            {mobileMoreOpen && (
              <>
                <div
                  onClick={() => setMobileMoreOpen(false)}
                  className="fixed inset-0 z-40 bg-black/45"
                />
                <div className="fixed left-3 right-3 bottom-28 z-50 rounded-2xl bg-desk-surface border border-desk-border shadow-2xl p-3.5 space-y-3">
                  <div className="flex items-center justify-between pb-1.5 border-b border-desk-border">
                    <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass">
                      {t('xsheetMoreTools')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setMobileMoreOpen(false)}
                      aria-label={t('acctCloseAria')}
                      className="min-w-[44px] min-h-[44px] -my-2 -mr-2 rounded-xl inline-flex items-center justify-center text-desk-muted"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void addFrameAfterCurrent(true);
                        setMobileMoreOpen(false);
                      }}
                      className="min-h-[44px] px-3 rounded-xl console-well border border-desk-border text-xs font-bold text-desk-text flex items-center justify-center gap-1.5"
                    >
                      <Copy className="w-4 h-4 text-ink-brass" />
                      <span className="truncate">{t('xsheetDuplicateFrame')}</span>
                    </button>

                    <button
                      type="button"
                      disabled={project.frames.length <= 1}
                      onClick={() => {
                        deleteFrame(activeFrameIndex);
                        setMobileMoreOpen(false);
                      }}
                      className="min-h-[44px] px-3 rounded-xl console-well border border-desk-border text-xs font-bold text-ink-vermilion disabled:opacity-35 flex items-center justify-center gap-1.5"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span className="truncate">{t('xsheetDeleteFrame')}</span>
                    </button>
                  </div>

                  {lastDeletedFrame?.projectId === project.id && (
                    <button
                      type="button"
                      onClick={() => {
                        undoDeleteFrame();
                        setMobileMoreOpen(false);
                      }}
                      className="w-full min-h-[44px] px-3 rounded-xl console-well border border-ink-brass text-xs font-bold text-ink-brass flex items-center justify-center gap-1.5"
                    >
                      <RotateCcw className="w-4 h-4" />
                      <span className="truncate">{t('xsheetUndoDeleteBtn')}</span>
                    </button>
                  )}

                  {/* Mobile Frame Hold + Loop */}
                  {activeFrame && (
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-desk-border">
                      <span className="font-mono text-[11px] text-desk-muted">
                        {t('xsheetHoldShort')}: ×{activeFrame.hold}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={activeFrame.hold <= 1}
                          onClick={() => setFrameHold(activeFrameIndex, activeFrame.hold - 1)}
                          className="min-w-[44px] min-h-[44px] rounded-xl console-well border border-desk-border font-mono text-sm font-bold text-desk-text disabled:opacity-35"
                        >
                          −
                        </button>
                        <button
                          type="button"
                          onClick={() => setFrameHold(activeFrameIndex, activeFrame.hold + 1)}
                          className="min-w-[44px] min-h-[44px] rounded-xl console-well border border-desk-border font-mono text-sm font-bold text-desk-text"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Mobile FPS Picker */}
                  <div className="grid grid-cols-4 gap-1.5 pt-1 border-t border-desk-border">
                    {([8, 12, 15, 24] as const).map((fps) => (
                      <button
                        key={fps}
                        type="button"
                        onClick={() => updateProjectSettings({ fps })}
                        className={`min-h-[44px] rounded-xl font-mono text-xs font-bold border ${
                          project.fps === fps
                            ? 'bg-desk-panel border-ink-brass text-ink-brass'
                            : 'console-well border-desk-border text-desk-muted'
                        }`}
                      >
                        {fps} FPS
                      </button>
                    ))}
                  </div>

                  {/* Mobile Mic + Audio Upload */}
                  <div className="grid grid-cols-2 gap-2 pt-1 border-t border-desk-border">
                    <button
                      type="button"
                      onClick={() => void toggleMicRecord()}
                      className={`min-h-[44px] px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 ${
                        recording
                          ? 'bg-ink-vermilion text-white border-ink-vermilion'
                          : 'console-well border-desk-border text-desk-text'
                      }`}
                    >
                      <Mic className="w-4 h-4 text-ink-vermilion" />
                      <span className="truncate">
                        {recording ? t('xsheetStopRec') : t('xsheetRecAudio')}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMobileMoreOpen(false);
                        audioInputRef.current?.click();
                      }}
                      className="min-h-[44px] px-3 rounded-xl console-well border border-desk-border text-xs font-bold text-desk-text flex items-center justify-center gap-1.5"
                    >
                      <Upload className="w-4 h-4 text-ink-brass" />
                      <span className="truncate">{t('xsheetUploadAudio')}</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Horizontal Drag-and-Drop X-Sheet Film Strip (Zero tiny 16px per-card buttons; crisp >=11px badges!) */}
      <div className="flex items-stretch gap-1.5 sm:gap-2 overflow-x-auto pb-0.5 pt-0.5">
        {project.frames.map((frame, idx) => {
          const isCurrent = idx === displayFrameIdx;
          const isDropTarget = dragOverIndex === idx && dragIndex !== null && dragIndex !== idx;
          const localizedNote = localizeSceneOrNote(frame.note ?? '', locale);
          return (
            <button
              key={frame.id}
              type="button"
              draggable
              onDragStart={() => setDragIndex(idx)}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragOverIndex !== idx) setDragOverIndex(idx);
              }}
              onDragLeave={() => {
                if (dragOverIndex === idx) setDragOverIndex(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== idx) {
                  soundEngine.paperFlip();
                  moveFrame(dragIndex, idx);
                }
                setDragIndex(null);
                setDragOverIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDragOverIndex(null);
              }}
              onClick={() => {
                if (idx !== activeFrameIndex) soundEngine.paperFlip();
                selectFrame(idx);
              }}
              className={`shrink-0 min-h-[48px] rounded-xl border text-left transition-all cursor-pointer overflow-hidden flex flex-col ${
                isDropTarget
                  ? 'border-ink-brass ring-2 ring-ink-brass/70 scale-[1.03]'
                  : isCurrent
                    ? 'border-ink-vermilion ring-2 ring-ink-vermilion/35 bg-desk-panel'
                    : 'border-desk-border bg-desk-well hover:border-desk-muted'
              }`}
              style={{ width: `${Math.min(156, 80 + (frame.hold - 1) * 18)}px` }}
              title={localizedNote ? localizedNote : `#${idx + 1}`}
              aria-label={`${t('stageFrameLabel')} ${idx + 1}${localizedNote ? ` — ${localizedNote}` : ''}`}
            >
              <div
                className="relative h-11 sm:h-12 w-full overflow-hidden"
                style={{ backgroundColor: project.paperColor || '#F7F3E9' }}
              >
                {frame.thumbKey ? (
                  <BlobImage
                    blobKey={frame.thumbKey}
                    alt={`${t('stageFrameLabel')} ${idx + 1}`}
                    className="w-full h-full object-contain pointer-events-none"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center font-mono text-[11px] text-neutral-500">
                    {t('xsheetEmptyFrame')}
                  </div>
                )}
                <span className="absolute top-0.5 left-1 px-1 rounded bg-neutral-950/75 text-[#F7F3E9] font-mono text-[11px] leading-tight">
                  #{String(idx + 1).padStart(2, '0')}
                </span>
                <div className="absolute bottom-0.5 right-1 flex items-center gap-0.5">
                  {frame.hold > 1 && (
                    <span className="px-1 rounded bg-neutral-950/80 text-amber-300 font-mono text-[11px] font-bold leading-tight">
                      ×{frame.hold}
                    </span>
                  )}
                  {(frame.cameraShake ?? 0) > 0 && (
                    <span
                      className="px-1 rounded bg-ink-vermilion text-white text-[11px] font-bold flex items-center"
                      title={`${t('railShakeTitle')}: ${frame.cameraShake}`}
                    >
                      <Zap className="w-2.5 h-2.5" />
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Clickable Audio Scrubbing Waveform Bar */}
      {project.audio && (
        <div className="rounded-xl console-well border border-desk-border px-2.5 py-1 flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => updateAudioTrack({ muted: !project.audio!.muted })}
            className="min-w-[36px] min-h-[36px] inline-flex items-center justify-center text-desk-muted hover:text-desk-text"
            title={t('xsheetAudioMuteTitle')}
            aria-label={t('xsheetAudioMuteTitle')}
          >
            {project.audio.muted ? (
              <VolumeX className="w-4 h-4 text-ink-vermilion" />
            ) : (
              <Volume2 className="w-4 h-4 text-ink-emerald" />
            )}
          </button>

          <span className="font-mono text-[11px] text-desk-text truncate max-w-[120px]">
            {project.audio.name}
          </span>

          <div
            onClick={handleWaveformClick}
            title={t('xsheetAudioScrubTitle')}
            className="flex-1 h-6 flex items-center gap-[1.5px] overflow-hidden cursor-pointer"
          >
            {project.audio.peaks.map((peak, i) => (
              <span
                key={i}
                className="flex-1 rounded-full bg-ink-brass/80 hover:bg-ink-vermilion transition-colors"
                style={{
                  height: `${Math.max(12, Math.round(peak * 100))}%`,
                  opacity: project.audio!.muted ? 0.25 : 0.92,
                }}
              />
            ))}
          </div>

          <span className="hidden sm:inline font-mono text-[11px] text-desk-muted whitespace-nowrap">
            {project.audio.durationSec.toFixed(1)}s · {t('xsheetAudioScrubOn')}
          </span>

          <button
            type="button"
            onClick={() => setAudioTrack(null)}
            className="min-w-[36px] min-h-[36px] inline-flex items-center justify-center text-desk-muted hover:text-ink-vermilion"
            title={t('xsheetAudioRemoveTitle')}
            aria-label={t('xsheetAudioRemoveTitle')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </section>
  );
}
