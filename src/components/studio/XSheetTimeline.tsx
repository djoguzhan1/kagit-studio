import { useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Film,
  Mic,
  Plus,
  Repeat,
  Square,
  StickyNote,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { FlipPageIcon, MotionPlayIcon, OnionLayersIcon } from '../ui/AnimatedStudioIcons';
import { analyzeAndStoreAudio, MicVoiceRecorder } from '../../engine/audioEngine';
import { soundEngine } from '../../engine/soundEngine';
import { useT } from '../../i18n/translations';

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

  // Drag-and-drop frame reordering state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

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
    const targetSlot = Math.floor(ratio * totalExposures);
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
      className="border-t border-desk-border bg-desk-surface px-3 py-1.5 shrink-0 select-none z-20 space-y-1.5"
    >
      {/* Multi-Scene Storyboard Film Strip + Loop In/Out Range */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-desk-border/70">
        <div className="flex items-center gap-1 overflow-x-auto">
          <span className="font-mono text-[9px] uppercase tracking-widest text-desk-muted flex items-center gap-1 pr-1 shrink-0">
            <Film className="w-3 h-3 text-ink-brass" />
            {t('xsheetScenes')}
          </span>
          {scenes.map((sc) => {
            const active = sc.id === project.activeSceneId;
            const isRenaming = renamingSceneId === sc.id;
            return (
              <div
                key={sc.id}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[10px] border transition-colors shrink-0 ${
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
                    className="w-24 bg-desk-surface border border-ink-brass rounded px-1 text-[10px] text-desk-text focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => selectScene(sc.id)}
                    onDoubleClick={() => {
                      setRenamingSceneId(sc.id);
                      setSceneNameDraft(sc.name);
                    }}
                    title={t('xsheetRenameSceneHint')}
                  >
                    {locale === 'en' ? sc.name.replace(/^Sahne (\d+)$/, 'Scene $1') : sc.name} (
                    {sc.frames.length})
                  </button>
                )}
                {scenes.length > 1 && (
                  <button
                    type="button"
                    onClick={() => deleteScene(sc.id)}
                    className="opacity-55 hover:opacity-100 hover:text-ink-vermilion ml-0.5"
                    title={t('xsheetDeleteScene')}
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
            className="px-2 py-0.5 rounded-md font-mono text-[10px] border border-dashed border-desk-border text-desk-muted hover:text-ink-brass hover:border-ink-brass inline-flex items-center gap-0.5 shrink-0"
            title={`+ ${t('xsheetAddScene')}`}
          >
            <Plus className="w-3 h-3" />
            {t('xsheetAddScene')}
          </button>
        </div>

        {/* Loop In / Out Range Selector */}
        <div className="hidden md:flex items-center gap-1 font-mono text-[10px]">
          <span className="text-desk-muted">{t('xsheetLoopRange')}</span>
          <button
            type="button"
            onClick={() =>
              setLoopRange({
                start: activeFrameIndex,
                end: Math.max(activeFrameIndex, loopRange?.end ?? project.frames.length - 1),
              })
            }
            className="px-1.5 py-0.5 rounded console-well border border-desk-border text-desk-muted hover:text-desk-text"
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
            className="px-1.5 py-0.5 rounded console-well border border-desk-border text-desk-muted hover:text-desk-text"
            title="Out"
          >
            Out #{(loopRange?.end ?? project.frames.length - 1) + 1}
          </button>
          {loopRange && (
            <button
              type="button"
              onClick={() => setLoopRange(null)}
              className="px-1.5 py-0.5 rounded text-ink-vermilion hover:underline"
            >
              {t('shelfTabAll')}
            </button>
          )}
        </div>
      </div>

      {/* Top Hardware Transport + Quick Onion Toggle + Frame Note Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
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
          >
            <MotionPlayIcon playing={isPlaying} className="w-3.5 h-3.5" />
            <span>{isPlaying ? t('xsheetStop') : t('xsheetPlay')}</span>
          </KeycapButton>

          <KeycapButton
            size="sm"
            led={loopPlayback ? 'amber' : 'off'}
            pressed={loopPlayback}
            sound="toggle"
            onClick={toggleLoop}
            title={t('xsheetLoopRange')}
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

          <div className="w-px h-5 bg-desk-border mx-0.5" />

          <KeycapButton
            size="sm"
            sound="flip"
            onClick={() => selectFrame(Math.max(0, activeFrameIndex - 1))}
            disabled={activeFrameIndex <= 0}
            title={t('stagePrevPaper')}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </KeycapButton>
          <span className="font-mono text-xs text-desk-text px-1 min-w-[58px] text-center">
            {String(displayFrameIdx + 1).padStart(2, '0')} /{' '}
            {String(project.frames.length).padStart(2, '0')}
          </span>
          <KeycapButton
            size="sm"
            sound="flip"
            onClick={() => selectFrame(Math.min(project.frames.length - 1, activeFrameIndex + 1))}
            disabled={activeFrameIndex >= project.frames.length - 1}
            title={t('stageNextPaper')}
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </KeycapButton>
        </div>

        {/* Frame Operations + Inline Dialogue/Note Input */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <KeycapButton
            data-tour="draw-add-frame"
            size="sm"
            variant="ivory"
            sound="flip"
            onClick={() => void addFrameAfterCurrent(false)}
            title={`${t('xsheetBlankFrame')} (N)`}
          >
            <FlipPageIcon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t('xsheetBlankFrame')}</span>
          </KeycapButton>

          <KeycapButton
            size="sm"
            sound="flip"
            onClick={() => void addFrameAfterCurrent(true)}
            title={t('xsheetDuplicateFrame')}
          >
            <Copy className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{t('xsheetDuplicateFrame')}</span>
          </KeycapButton>

          <KeycapButton
            size="sm"
            onClick={() => deleteFrame(activeFrameIndex)}
            disabled={project.frames.length <= 1}
            title={t('xsheetDeleteFrame')}
          >
            <Trash2 className="w-3.5 h-3.5 text-ink-vermilion" />
          </KeycapButton>

          {activeFrame && (
            <div className="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded-lg console-well border border-desk-border">
              <StickyNote className="w-3 h-3 text-ink-brass shrink-0" />
              <input
                type="text"
                value={activeFrame.note ?? ''}
                onChange={(e) => updateFrameNote(activeFrameIndex, e.target.value)}
                placeholder={t('xsheetNotePlaceholder')}
                className="bg-transparent text-[11px] font-mono text-desk-text placeholder:text-desk-muted/65 w-36 2xl:w-52 focus:outline-none"
              />
            </div>
          )}
        </div>

        {/* FPS + Audio Controls */}
        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 p-0.5 rounded-lg console-well border border-desk-border">
            {([8, 12, 15, 24] as const).map((fps) => (
              <button
                key={fps}
                type="button"
                onClick={() => {
                  soundEngine.click(1.05);
                  updateProjectSettings({ fps });
                }}
                className={`px-1.5 py-0.5 rounded font-mono text-[10px] transition-colors ${
                  project.fps === fps
                    ? 'bg-desk-panel text-ink-brass font-bold border border-desk-border'
                    : 'text-desk-muted hover:text-desk-text'
                }`}
              >
                {fps}
              </button>
            ))}
            <span className="font-mono text-[10px] text-desk-muted px-1">FPS</span>
          </div>

          <span className="font-mono text-[11px] text-desk-muted hidden xl:inline px-1">
            {totalSec}s
          </span>

          <KeycapButton
            size="sm"
            variant={recording ? 'vermilion' : 'graphite'}
            led={recording ? 'vermilion' : project.audio ? 'emerald' : 'off'}
            ledPulse={recording}
            onClick={() => void toggleMicRecord()}
            title={t('xsheetRecAudio')}
          >
            {recording ? <Square className="w-3 h-3 fill-current" /> : <Mic className="w-3.5 h-3.5" />}
            <span className="hidden lg:inline">
              {recording ? t('xsheetStopRec') : t('xsheetRecAudio')}
            </span>
          </KeycapButton>

          <KeycapButton
            size="sm"
            onClick={() => audioInputRef.current?.click()}
            title={t('xsheetUploadAudio')}
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">{t('xsheetUploadAudio')}</span>
          </KeycapButton>
          <input
            ref={audioInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={handleAudioFile}
          />
        </div>
      </div>

      {/* Horizontal Drag-and-Drop X-Sheet Film Strip */}
      <div className="flex items-stretch gap-2 overflow-x-auto pb-0.5 pt-0.5">
        {project.frames.map((frame, idx) => {
          const isCurrent = idx === displayFrameIdx;
          const isDropTarget = dragOverIndex === idx && dragIndex !== null && dragIndex !== idx;
          return (
            <div
              key={frame.id}
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
              className={`shrink-0 rounded-xl border transition-all cursor-grab active:cursor-grabbing overflow-hidden flex flex-col ${
                isDropTarget
                  ? 'border-ink-brass ring-2 ring-ink-brass/70 scale-[1.03]'
                  : isCurrent
                    ? 'border-ink-vermilion ring-2 ring-ink-vermilion/35 bg-desk-panel'
                    : 'border-desk-border bg-desk-well hover:border-desk-muted'
              }`}
              style={{ width: `${Math.min(180, 92 + (frame.hold - 1) * 24)}px` }}
              title={frame.note ? frame.note : `#${idx + 1}`}
            >
              <div
                className="relative h-12 overflow-hidden border-b border-desk-border"
                style={{ backgroundColor: project.paperColor || '#F7F3E9' }}
              >
                {frame.thumbKey ? (
                  <BlobImage
                    blobKey={frame.thumbKey}
                    alt={`${t('stageFrameLabel')} ${idx + 1}`}
                    className="w-full h-full object-contain pointer-events-none"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center font-mono text-[9px] text-neutral-400">
                    {t('xsheetEmptyFrame')}
                  </div>
                )}
                <span className="absolute top-1 left-1 px-1 rounded bg-neutral-950/75 text-[#F7F3E9] font-mono text-[9px]">
                  #{String(idx + 1).padStart(2, '0')}
                </span>
                <div className="absolute top-1 right-1 flex items-center gap-0.5">
                  {(frame.cameraShake ?? 0) > 0 && (
                    <span
                      className="px-1 rounded bg-ink-vermilion text-white text-[8px] font-bold flex items-center"
                      title={`${t('railShakeTitle')}: ${frame.cameraShake}`}
                    >
                      <Zap className="w-2.5 h-2.5" />
                    </span>
                  )}
                  {frame.note && (
                    <span
                      className="w-2 h-2 rounded-full bg-ink-brass shadow ring-1 ring-black/30"
                      title={frame.note}
                      aria-label={frame.note}
                    />
                  )}
                </div>
              </div>

              <div
                className="px-1.5 py-0.5 flex items-center justify-center gap-1 bg-desk-surface"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => setFrameHold(idx, frame.hold - 1)}
                  disabled={frame.hold <= 1}
                  className="w-4 h-4 rounded text-[10px] font-mono bg-desk-well border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-35"
                  title={t('xsheetHoldDecrease')}
                >
                  -
                </button>
                <span className="font-mono text-[10px] font-bold text-ink-brass px-1">
                  ×{frame.hold}
                </span>
                <button
                  type="button"
                  onClick={() => setFrameHold(idx, frame.hold + 1)}
                  className="w-4 h-4 rounded text-[10px] font-mono bg-desk-well border border-desk-border text-desk-muted hover:text-desk-text"
                  title={t('xsheetHoldIncrease')}
                >
                  +
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Clickable Audio Scrubbing Waveform Bar */}
      {project.audio && (
        <div className="rounded-xl console-well border border-desk-border px-3 py-1.5 flex items-center gap-3">
          <button
            type="button"
            onClick={() => updateAudioTrack({ muted: !project.audio!.muted })}
            className="text-desk-muted hover:text-desk-text"
            title={t('xsheetAudioMuteTitle')}
          >
            {project.audio.muted ? (
              <VolumeX className="w-3.5 h-3.5 text-ink-vermilion" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 text-ink-emerald" />
            )}
          </button>

          <span className="font-mono text-[10px] text-desk-text truncate max-w-[140px]">
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

          <span className="font-mono text-[10px] text-desk-muted">
            {project.audio.durationSec.toFixed(1)}s · {t('xsheetAudioScrubOn')}
          </span>

          <button
            type="button"
            onClick={() => setAudioTrack(null)}
            className="text-desk-muted hover:text-ink-vermilion"
            title={t('xsheetAudioRemoveTitle')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}
