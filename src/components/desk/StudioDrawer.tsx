import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Camera,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clapperboard,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import type { StudioProject } from '../../types/studio';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { PocketFlipbook3DPreview } from '../ui/PocketFlipbook3DPreview';
import {
  IrisCameraIcon,
  JointBoneIcon,
  SketchNibIcon,
} from '../ui/AnimatedStudioIcons';
import { soundEngine } from '../../engine/soundEngine';
import { useT } from '../../i18n/translations';

/** 3D Page-Flipping Physical Flipbook Notebook Card */
function Flipbook3DCard({
  project,
  onAfterOpen,
}: {
  project: StudioProject;
  onAfterOpen: () => void;
}) {
  const { openProject, deleteProject, notify } = useStudioStore();
  const t = useT();
  const [hoverIdx, setHoverIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totalExposures = project.frames.reduce((s, f) => s + Math.max(1, f.hold), 0);
  const durationSec = (totalExposures / project.fps).toFixed(1);
  const sceneCount = project.scenes?.length ?? 1;

  const startFlipPreview = () => {
    if (project.frames.length <= 1) return;
    let idx = 0;
    timerRef.current = setInterval(() => {
      idx = (idx + 1) % project.frames.length;
      setHoverIdx(idx);
    }, Math.max(70, Math.round(1000 / project.fps)));
  };

  const stopFlipPreview = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setHoverIdx(0);
  };

  useEffect(() => () => stopFlipPreview(), []);

  const previewFrame = project.frames[hoverIdx] ?? project.frames[0];

  const launch = (target: 'draw' | 'paper' | 'puppet' | 'film') => {
    onAfterOpen();
    openProject(project.id, target);
  };

  return (
    <div
      onMouseEnter={startFlipPreview}
      onMouseLeave={stopFlipPreview}
      className="flipbook-3d pb-2 pr-2"
    >
      <div className="flipbook-3d-back2" aria-hidden="true" />
      <div className="flipbook-3d-back1" aria-hidden="true" />

      <div className="flipbook-3d-cover flex flex-col">
        <div className="px-3.5 py-1.5 bg-desk-well/85 border-b border-desk-border flex items-center justify-between font-mono text-[11px] text-desk-muted">
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-brass" />
            {t('notebookTag')} · {project.aspect} · {project.fps} FPS
          </span>
          <span>
            {sceneCount > 1 ? `${sceneCount} ${t('scenesWord')} · ` : ''}
            {durationSec}s
          </span>
        </div>

        <div
          onClick={() => {
            soundEngine.paperFlip();
            launch('draw');
          }}
          className="relative aspect-video cursor-pointer overflow-hidden border-b border-desk-border"
          style={{ backgroundColor: project.paperColor || '#F7F3E9' }}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-4 bg-black/10 border-r border-dashed border-black/15 flex flex-col items-center justify-evenly pointer-events-none z-10"
            aria-hidden="true"
          >
            <span className="w-1.5 h-3 rounded-full bg-neutral-700/60" />
            <span className="w-1.5 h-3 rounded-full bg-neutral-700/60" />
          </div>

          {previewFrame?.thumbKey ? (
            <BlobImage
              blobKey={previewFrame.thumbKey}
              alt={project.name}
              className="w-full h-full object-contain pl-3"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-neutral-500 font-mono text-xs">
              {t('blankPaper')}
            </div>
          )}

          <div className="absolute bottom-2 left-6 px-2 py-0.5 rounded-md bg-neutral-950/85 text-[#F7F3E9] font-mono text-[11px] flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-vermilion" />
            <span>
              {project.frames.length} {t('framesWord')}
            </span>
            {project.audio && <span className="text-ink-brass">· {t('withAudio')}</span>}
          </div>
        </div>

        <div className="p-3 flex-1 flex flex-col justify-between gap-2.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-bold text-sm text-desk-text truncate">{project.name}</h3>
              <p className="font-mono text-[11px] text-desk-muted mt-0.5">
                {project.width}×{project.height} · {(project.meshRigs?.length ?? 0) + project.rigs.length}{' '}
                {t('puppetsWord')}
              </p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                soundEngine.click(0.8);
                if (window.confirm(`"${project.name}" ${t('deleteProjectConfirm')}`)) {
                  void deleteProject(project.id);
                  notify(t('projectDeleted'), 'info');
                }
              }}
              className="p-1.5 rounded-lg text-desk-muted hover:text-ink-vermilion hover:bg-desk-well transition-colors"
              title="Sil"
              aria-label="Projeyi Sil"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1">
            <KeycapButton
              variant="ivory"
              size="sm"
              onClick={() => launch('draw')}
              className="flex-1 whitespace-nowrap"
            >
              <SketchNibIcon className="w-3.5 h-3.5 shrink-0" />
              <span>{t('openOnDesk')}</span>
            </KeycapButton>
            <button
              type="button"
              onClick={() => launch('paper')}
              className="px-1.5 py-1.5 rounded-lg border border-desk-border bg-desk-well/60 text-[11px] font-semibold text-desk-muted hover:text-desk-text hover:border-desk-muted/60 inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              title={t('paperCardTitle')}
            >
              <IrisCameraIcon className="w-3 h-3 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => launch('puppet')}
              className="px-1.5 py-1.5 rounded-lg border border-desk-border bg-desk-well/60 text-[11px] font-semibold text-desk-muted hover:text-desk-text hover:border-desk-muted/60 inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              title={t('puppetCardTitle')}
            >
              <JointBoneIcon className="w-3 h-3 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => launch('film')}
              className="px-1.5 py-1.5 rounded-lg border border-desk-border bg-desk-well/60 text-[11px] font-semibold text-ink-blue hover:border-ink-blue/70 inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              title={t('projectorTitle')}
            >
              <Clapperboard className="w-3 h-3 shrink-0" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Starter Experience Template 3D Card */
function StarterTemplateCard({
  badge,
  title,
  subtitle,
  accent,
  icon,
  previewVisual,
  ctaLabel,
  onLaunch,
}: {
  badge: string;
  title: string;
  subtitle: string;
  accent: 'vermilion' | 'brass' | 'blue';
  icon: React.ReactNode;
  previewVisual: React.ReactNode;
  ctaLabel: string;
  onLaunch: () => void;
}) {
  const accentDot =
    accent === 'vermilion'
      ? 'bg-ink-vermilion'
      : accent === 'brass'
        ? 'bg-ink-brass'
        : 'bg-ink-blue';
  const accentBorder =
    accent === 'vermilion'
      ? 'hover:border-ink-vermilion/70'
      : accent === 'brass'
        ? 'hover:border-ink-brass/70'
        : 'hover:border-ink-blue/70';

  return (
    <div className="flipbook-3d pb-2 pr-2">
      <div className="flipbook-3d-back2" aria-hidden="true" />
      <div className="flipbook-3d-back1" aria-hidden="true" />
      <button
        type="button"
        onClick={onLaunch}
        className={`flipbook-3d-cover w-full text-left flex flex-col transition-colors ${accentBorder}`}
      >
        <div className="px-3.5 py-1.5 bg-desk-well/85 border-b border-desk-border flex items-center justify-between font-mono text-[11px] text-desk-muted">
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${accentDot}`} />
            {badge}
          </span>
          {icon}
        </div>

        <div className="relative aspect-video overflow-hidden border-b border-desk-border bg-[#F7F3E9] flex items-center justify-center">
          {previewVisual}
        </div>

        <div className="p-3 flex-1 flex flex-col justify-between gap-2">
          <div>
            <h3 className="font-bold text-sm text-desk-text">{title}</h3>
            <p className="text-[11px] text-desk-muted mt-0.5 leading-snug">{subtitle}</p>
          </div>
          <div className="font-mono text-[11px] font-bold text-ink-brass flex items-center justify-between pt-1 border-t border-desk-border/60">
            <span>{ctaLabel}</span>
            <span className={`w-2 h-2 rounded-full ${accentDot}`} />
          </div>
        </div>
      </button>
    </div>
  );
}

interface StudioDrawerProps {
  open: boolean;
  onToggle: (next: boolean) => void;
  onCreateFirst: () => void;
}

/**
 * Brass-Handle Pull-Up Wooden Studio Drawer
 * Keeps the Studio Desk Hub 100% calm & single-screen while giving 1-click access
 * to user notebooks, 3 starter templates, backup import, and instant Resume!
 */
export function StudioDrawer({ open, onToggle, onCreateFirst }: StudioDrawerProps) {
  const {
    projects,
    locale,
    openProject,
    importProject,
    openSamplePaperDemo,
    openSampleMeshPuppetDemo,
    openBounceExerciseTemplate,
    openLegal,
    notify,
  } = useStudioStore();
  const t = useT();

  const [shelfFilter, setShelfFilter] = useState<'all' | 'projects' | 'templates'>('all');
  const [flipPreviewOpen, setFlipPreviewOpen] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const latestProject = projects[0] ?? null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        soundEngine.drawerSlide(false);
        onToggle(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onToggle]);

  const setOpenWithSound = (next: boolean) => {
    soundEngine.drawerSlide(next);
    onToggle(next);
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { importPortableBackupZip } = await import('../../engine/exportEngine');
      const restored = await importPortableBackupZip(file);
      importProject(restored);
      notify(locale === 'en' ? `"${restored.name}" restored!` : `"${restored.name}" geri yüklendi!`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Yedek okunamadı', 'error');
    } finally {
      if (backupInputRef.current) backupInputRef.current.value = '';
    }
  };

  return (
    <>
      {/* Sleek Bottom Pinned Brass-Handle Dock Strip (44px — Exact 3-Column Symmetric Center!) */}
      <div className="relative z-30 border-t border-desk-border bg-desk-surface/92 backdrop-blur-md shrink-0">
        <div className="w-full px-4 sm:px-6 h-11 grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 min-w-0 justify-self-start max-w-full overflow-hidden">
            <button
              type="button"
              onClick={() => {
                soundEngine.click(1.04);
                openLegal('privacy');
              }}
              className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-desk-muted hover:text-ink-brass transition-colors shrink-0"
              title={t('legalFooterBtn')}
            >
              <ShieldCheck className="w-3.5 h-3.5 text-ink-emerald shrink-0" />
              <span className="truncate max-w-[160px] lg:max-w-[220px]">{t('legalFooterBtn')}</span>
            </button>
            <span className="hidden 2xl:inline font-mono text-[11px] text-desk-muted truncate">
              · {t('shelfMeta')}
            </span>
          </div>

          {/* Tactile Brass Drawer Pull Handle — Locked to Viewport Center (0.0px deviation!) */}
          <button
            type="button"
            onClick={() => setOpenWithSound(!open)}
            aria-expanded={open}
            className="justify-self-center group inline-flex items-center gap-2.5 px-4 py-1.5 rounded-full console-well border border-ink-brass/50 hover:border-ink-brass text-xs font-bold text-desk-text transition-all shadow-sm cursor-pointer whitespace-nowrap"
          >
            <span
              className="w-6 h-1.5 rounded-full bg-gradient-to-r from-[#8f671e] via-[#f2c86b] to-[#8f671e] shadow-inner group-hover:scale-x-110 transition-transform"
              aria-hidden="true"
            />
            <BookOpen className="w-3.5 h-3.5 text-ink-brass shrink-0" />
            <span>{t('drawerHandle')}</span>
            <span className="px-1.5 py-0.5 rounded-md bg-desk-panel border border-desk-border font-mono text-[11px] text-desk-muted">
              {locale === 'en' ? `${projects.length} Books · 3 Demos` : `${projects.length} Defter · 3 Sahne`}
            </span>
            {open ? (
              <ChevronDown className="w-3.5 h-3.5 text-ink-brass shrink-0" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5 text-ink-brass shrink-0" />
            )}
          </button>

          {/* 1-Click Resume Latest Notebook */}
          {latestProject ? (
            <button
              type="button"
              onClick={() => {
                soundEngine.paperFlip();
                openProject(latestProject.id, 'draw');
              }}
              className="hidden sm:inline-flex justify-self-end items-center gap-1.5 px-2.5 py-1 rounded-lg border border-desk-border bg-desk-well/75 hover:border-ink-brass text-[11px] font-semibold text-desk-text transition-colors max-w-[230px]"
            >
              <span className="font-mono text-[11px] uppercase text-ink-brass font-bold shrink-0">
                {t('drawerContinue')}:
              </span>
              <span className="truncate">{latestProject.name}</span>
              <ArrowRight className="w-3 h-3 text-ink-brass shrink-0" />
            </button>
          ) : (
            <span className="hidden sm:block justify-self-end w-16" />
          )}
        </div>
      </div>

      {/* Expanded Pull-Up Studio Drawer Overlay */}
      {open && (
        <div
          onClick={() => setOpenWithSound(false)}
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] flex flex-col justify-end"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t('shelfHeading')}
            onClick={(e) => e.stopPropagation()}
            className="studio-drawer-sheet w-full max-h-[80vh] flex flex-col rounded-t-[28px] border-t-2 border-ink-brass/60 bg-desk-surface shadow-[0_-24px_64px_rgba(0,0,0,0.65)]"
          >
            {/* Top Brass Handle & Filter Bar */}
            <div className="px-4 sm:px-6 pt-3 pb-3 border-b border-desk-border shrink-0 space-y-2.5">
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setOpenWithSound(false)}
                  aria-label="Çekmeceyi Kapat"
                  className="w-14 h-1.5 rounded-full bg-gradient-to-r from-[#8f671e] via-[#f2c86b] to-[#8f671e] opacity-80 hover:opacity-100 transition-opacity"
                />
              </div>

              <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <BookOpen className="w-4 h-4 text-ink-brass" />
                  <h2 className="text-base font-extrabold text-desk-text">{t('shelfHeading')}</h2>

                  <div className="flex items-center gap-1 p-0.5 rounded-lg console-well border border-desk-border font-mono text-[11px]">
                    {(
                      [
                        { id: 'all', label: `${t('shelfTabAll')} (${projects.length + 3})` },
                        { id: 'projects', label: `${t('shelfTabProjects')} (${projects.length})` },
                        { id: 'templates', label: `${t('shelfTabTemplates')} (3)` },
                      ] as const
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          soundEngine.click(1.04);
                          setShelfFilter(tab.id);
                        }}
                        className={`px-2 py-0.5 rounded-md transition-colors ${
                          shelfFilter === tab.id
                            ? 'bg-desk-panel text-desk-text font-bold border border-desk-border'
                            : 'text-desk-muted hover:text-desk-text border border-transparent'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {latestProject && (
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.paperFlip();
                        void useStudioStore.getState().ensureStarterProjectHydrated();
                        setFlipPreviewOpen((v) => !v);
                      }}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-bold inline-flex items-center gap-1.5 transition-colors ${
                        flipPreviewOpen
                          ? 'bg-ink-brass/20 border-ink-brass text-desk-text'
                          : 'border-desk-border bg-desk-well/70 text-ink-brass hover:border-ink-brass'
                      }`}
                    >
                      <span>{locale === 'en' ? '3D Pocket Flipbook' : '3B Cep Flipbook'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => backupInputRef.current?.click()}
                    className="px-2.5 py-1.5 rounded-lg border border-desk-border bg-desk-well/70 text-xs font-semibold text-desk-muted hover:text-desk-text hover:border-ink-brass inline-flex items-center gap-1.5 transition-colors"
                    title={t('importBackupTitle')}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{t('importBackup')}</span>
                  </button>
                  <input
                    ref={backupInputRef}
                    type="file"
                    accept=".inktrope.zip,.kagit.zip,.zip"
                    className="hidden"
                    onChange={handleImportBackup}
                  />

                  <button
                    type="button"
                    onClick={() => setOpenWithSound(false)}
                    className="p-1.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text"
                    aria-label="Kapat"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Scrollable Drawer Body */}
            <div className="overflow-y-auto px-4 sm:px-6 py-5 space-y-4">
              {flipPreviewOpen && latestProject && (
                <div className="max-w-2xl mx-auto">
                  <PocketFlipbook3DPreview
                    frames={latestProject.frames}
                    fps={latestProject.fps}
                    paperColor={latestProject.paperColor}
                    projectName={latestProject.name}
                    onClose={() => setFlipPreviewOpen(false)}
                  />
                </div>
              )}
              <div className="max-w-7xl mx-auto">
                {shelfFilter === 'projects' && projects.length === 0 ? (
                  <div className="rounded-3xl console-well border border-dashed border-desk-border p-10 text-center space-y-3">
                    <p className="text-sm text-desk-muted">{t('shelfEmpty')}</p>
                    <KeycapButton
                      variant="vermilion"
                      onClick={() => {
                        onToggle(false);
                        onCreateFirst();
                      }}
                    >
                      {t('shelfFirstScene')}
                    </KeycapButton>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {shelfFilter !== 'templates' &&
                      projects.map((p) => (
                        <Flipbook3DCard
                          key={p.id}
                          project={p}
                          onAfterOpen={() => onToggle(false)}
                        />
                      ))}

                    {shelfFilter !== 'projects' && (
                      <>
                        <StarterTemplateCard
                          badge={t('tplA4Badge')}
                          title={t('tplA4Title')}
                          subtitle={t('tplA4Sub')}
                          accent="vermilion"
                          icon={<Camera className="w-3.5 h-3.5 text-ink-vermilion" />}
                          ctaLabel={t('tplLaunch')}
                          onLaunch={() => {
                            soundEngine.shutter();
                            onToggle(false);
                            openSamplePaperDemo();
                          }}
                          previewVisual={
                            <svg viewBox="0 0 240 135" className="w-full h-full" aria-hidden="true">
                              <rect width="240" height="135" fill="#EDE3CE" />
                              <rect x="120" y="0" width="120" height="135" fill="#FAF6EE" />
                              <line x1="120" y1="0" x2="120" y2="135" stroke="#E54D2E" strokeWidth="2.5" />
                              <line x1="20" y1="67" x2="220" y2="67" stroke="#9E9382" strokeWidth="1" strokeDasharray="4 4" />
                              <circle cx="65" cy="40" r="14" fill="none" stroke="#2563EB" strokeWidth="1.5" opacity="0.6" />
                              <circle cx="65" cy="40" r="11" fill="none" stroke="#1C1917" strokeWidth="2.5" />
                              <circle cx="175" cy="34" r="11" fill="#FFFDF8" stroke="#1C1917" strokeWidth="2.5" />
                              <path d="M164 25 Q175 8 186 22 Z" fill="#E54D2E" stroke="#1C1917" strokeWidth="1.8" />
                              <circle cx="65" cy="100" r="11" fill="none" stroke="#1C1917" strokeWidth="2.5" />
                              <ellipse cx="175" cy="102" rx="14" ry="9" fill="#FFFDF8" stroke="#1C1917" strokeWidth="2.5" />
                            </svg>
                          }
                        />

                        <StarterTemplateCard
                          badge={t('tplPuppetBadge')}
                          title={t('tplPuppetTitle')}
                          subtitle={t('tplPuppetSub')}
                          accent="brass"
                          icon={<Sparkles className="w-3.5 h-3.5 text-ink-brass" />}
                          ctaLabel={t('tplLaunch')}
                          onLaunch={() => {
                            soundEngine.click(1.12);
                            onToggle(false);
                            void openSampleMeshPuppetDemo();
                          }}
                          previewVisual={
                            <svg viewBox="0 0 240 135" className="w-full h-full" aria-hidden="true">
                              <rect width="240" height="135" fill="#F7F3E9" />
                              <ellipse cx="120" cy="118" rx="40" ry="7" fill="rgba(28,25,23,0.12)" />
                              <line x1="120" y1="42" x2="120" y2="78" stroke="#D99B26" strokeWidth="1.5" strokeDasharray="3 3" />
                              <line x1="88" y1="64" x2="152" y2="64" stroke="#D99B26" strokeWidth="1.5" strokeDasharray="3 3" />
                              <path d="M104 62 Q98 94 104 106 L136 106 Q142 94 136 62 Z" fill="#2B2622" stroke="#1C1917" strokeWidth="2" />
                              <rect x="103" y="55" width="34" height="9" rx="4" fill="#E54D2E" stroke="#1C1917" strokeWidth="1.6" />
                              <circle cx="120" cy="40" r="17" fill="#FAF3E4" stroke="#1C1917" strokeWidth="2.2" />
                              <ellipse cx="118" cy="24" rx="20" ry="6.5" fill="#D99B26" stroke="#1C1917" strokeWidth="1.8" transform="rotate(-8 118 24)" />
                              {[
                                [120, 40, '#2563EB'],
                                [120, 74, '#D99B26'],
                                [86, 62, '#2563EB'],
                                [154, 62, '#2563EB'],
                              ].map(([x, y, fill], i) => (
                                <circle key={i} cx={x as number} cy={y as number} r="4" fill={fill as string} stroke="#FFFDF8" strokeWidth="1.5" />
                              ))}
                            </svg>
                          }
                        />

                        <StarterTemplateCard
                          badge={t('tplBounceBadge')}
                          title={t('tplBounceTitle')}
                          subtitle={t('tplBounceSub')}
                          accent="blue"
                          icon={<CircleDot className="w-3.5 h-3.5 text-ink-blue" />}
                          ctaLabel={t('tplLaunch')}
                          onLaunch={() => {
                            soundEngine.paperFlip();
                            onToggle(false);
                            void openBounceExerciseTemplate();
                          }}
                          previewVisual={
                            <svg viewBox="0 0 240 135" className="w-full h-full" aria-hidden="true">
                              <rect width="240" height="135" fill="#F7F3E9" />
                              <line x1="24" y1="108" x2="216" y2="108" stroke="#2563EB" strokeWidth="1.4" strokeDasharray="4 4" opacity="0.55" />
                              <path d="M36 98 Q120 4 204 98" fill="none" stroke="#2563EB" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.55" />
                              {[
                                [36, 100, 13, 8.5, true],
                                [66, 62, 8.5, 12.5, false],
                                [102, 34, 10, 10, false],
                                [138, 34, 10, 10, false],
                                [174, 62, 8.5, 12.5, false],
                                [204, 100, 13, 8.5, false],
                              ].map(([cx, cy, rx, ry, filled], idx) => (
                                <ellipse
                                  key={idx}
                                  cx={cx as number}
                                  cy={cy as number}
                                  rx={rx as number}
                                  ry={ry as number}
                                  fill={filled ? '#E54D2E' : 'none'}
                                  stroke={filled ? '#1C1917' : '#2563EB'}
                                  strokeWidth={filled ? 2.2 : 1.4}
                                  opacity={filled ? 1 : 0.65}
                                />
                              ))}
                            </svg>
                          }
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
