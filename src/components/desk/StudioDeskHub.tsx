import { useEffect, useState } from 'react';
import { Volume2, VolumeX, X } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { ASPECT_DIMENSIONS, type AspectPreset } from '../../types/studio';
import { KeycapButton } from '../ui/KeycapButton';
import { BrandEmblem } from '../ui/BrandEmblem';
import {
  Clapperboard3DButton,
  Marionette3DButton,
  Projector3DButton,
  ShutterLens3DButton,
} from '../ui/Studio3DControls';
import { AnimatedUniverseCanvas, type UniverseHoverTarget } from './AnimatedUniverseCanvas';
import { DeskLamp3D } from './DeskLamp3D';
import { InteractiveLightboxStage, type DeskPreviewMode } from './InteractiveLightboxStage';
import { StudioDrawer } from './StudioDrawer';
import { GuideLauncherButton } from '../guide/GuideLauncherButton';
import { AccountButton } from '../account/AccountButton';
import { soundEngine } from '../../engine/soundEngine';
import { useT } from '../../i18n/translations';
import { preloadStudioModule } from '../../App';

const AWAKEN_SESSION_KEY = 'kagit:desk-awakened:v3';

export default function StudioDeskHub() {
  const {
    projects,
    theme,
    locale,
    soundEnabled,
    lightboxDim,
    setTheme,
    setLocale,
    toggleSound,
    setLightboxDim,
    createProject,
    openOrCreateBlankProject,
    openProject,
    openSamplePaperDemo,
    openSampleMeshPuppetDemo,
    openFilmDirectorDemo,
    commitDeskSketchToProject,
    commitDeskSketchToStudio,
    overviewShowOpen,
    activeTourMode,
    legalOpen,
    accountModalOpen,
    exportOpen,
    notify,
  } = useStudioStore();

  const t = useT();

  const [newName, setNewName] = useState('');
  const [newAspect, setNewAspect] = useState<AspectPreset>('16:9');
  const [newFps, setNewFps] = useState<8 | 12 | 15 | 24>(12);
  const [showSpecPopover, setShowSpecPopover] = useState(false);
  const [previewMode, setPreviewMode] = useState<DeskPreviewMode>('draw');
  const [hoveredObj, setHoveredObj] = useState<UniverseHoverTarget>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Run the 1.0s non-blocking opening awakening stagger only on first visit per browser session
  const [firstAwaken] = useState(() => {
    try {
      if (sessionStorage.getItem(AWAKEN_SESSION_KEY)) return false;
      sessionStorage.setItem(AWAKEN_SESSION_KEY, '1');
      return true;
    } catch {
      return false;
    }
  });

  const showcaseProject = projects[0] ?? null;

  useEffect(() => {
    if (!showSpecPopover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowSpecPopover(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSpecPopover]);

  const handleCreate = (targetMode: 'draw' | 'paper' | 'puppet' = 'draw') => {
    const customName = newName.trim();
    const fallbackName =
      locale === 'en'
        ? targetMode === 'paper'
          ? 'Paper Flipbook'
          : 'New Animation'
        : targetMode === 'paper'
          ? 'Kağıt Flipbook'
          : 'Yeni Çizgi Film';
    const project =
      targetMode === 'draw'
        ? openOrCreateBlankProject(customName, newAspect, newFps)
        : createProject(customName || fallbackName, newAspect, newFps);
    setNewName('');
    setShowSpecPopover(false);
    if (targetMode !== 'draw') {
      openProject(project.id, targetMode);
    }
    notify(
      locale === 'en'
        ? `"${project.name}" opened on the backlit desk`
        : `"${project.name}" ışıklı masaya açıldı`
    );
  };

  const awakenStyle = (delayMs: number): React.CSSProperties | undefined =>
    firstAwaken ? { animationDelay: `${delayMs}ms` } : undefined;
  const awakenCls = firstAwaken ? 'desk-awaken' : '';
  const anyOverlayOpen =
    drawerOpen ||
    overviewShowOpen ||
    Boolean(activeTourMode) ||
    legalOpen ||
    accountModalOpen ||
    exportOpen;

  return (
    <div className="min-h-full lg:h-full desk-workbench-mat flex flex-col relative overflow-x-hidden">
      {/* 12 FPS Hand-Drawn Living Ink & Paper Universe (Halts to 0 RAF when any modal/drawer opens!) */}
      <AnimatedUniverseCanvas theme={theme} hoveredTarget={hoveredObj} active={!anyOverlayOpen} />

      {/* Minimal 4-Element Frosted Header Rail */}
      <header className="sticky top-0 z-40 border-b border-desk-border/85 bg-desk-surface/88 backdrop-blur-md shrink-0">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center justify-between gap-2 sm:gap-3">
          {/* 1. Brand Emblem */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
            <BrandEmblem className="w-8 h-8 sm:w-9 sm:h-9 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="hidden min-[460px]:block text-base font-extrabold tracking-tight text-desk-text whitespace-nowrap">
                  INKTROPE
                </h1>
                <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted hidden sm:inline truncate">
                  {t('brandSub')}
                </span>
              </div>
            </div>
          </div>

          {/* 2–5. Account Vault + Global Guide + Compact TR/EN + Sound + Signature 3D Articulated Brass Desk Lamp */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <AccountButton />
            <GuideLauncherButton />

            <div
              className="flex items-center p-0.5 rounded-lg console-well border border-desk-border font-mono text-[11px]"
              role="group"
              aria-label="Language"
            >
              {(['tr', 'en'] as const).map((lng) => (
                <button
                  key={lng}
                  type="button"
                  onClick={() => {
                    soundEngine.click(1.06);
                    setLocale(lng);
                  }}
                  className={`px-1.5 py-0.5 rounded-md font-bold uppercase transition-colors ${
                    locale === lng
                      ? 'bg-desk-panel text-ink-brass border border-desk-border'
                      : 'text-desk-muted hover:text-desk-text border border-transparent'
                  }`}
                >
                  {lng}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={toggleSound}
              className="p-2 rounded-xl border border-desk-border bg-desk-well/75 text-desk-muted hover:text-desk-text hover:border-desk-muted/60 transition-colors"
              title={soundEnabled ? t('soundToggleTitleOn') : t('soundToggleTitleOff')}
              aria-label="Ses efektleri"
            >
              {soundEnabled ? (
                <Volume2 className="w-4 h-4 text-ink-emerald" />
              ) : (
                <VolumeX className="w-4 h-4 opacity-55" />
              )}
            </button>

            <DeskLamp3D
              theme={theme}
              onToggle={() => setTheme(theme === 'night' ? 'day' : 'night')}
              title={theme === 'night' ? t('themeToDay') : t('themeToNight')}
              nightLabel={t('lampNightLabel')}
              dayLabel={t('lampDayLabel')}
            />
          </div>
        </div>
      </header>

      {/* SINGLE-SCREEN 100dvh PHYSICAL ANIMATOR'S WORKBENCH (Zero Vertical Scroll on Desktop!) */}
      <main className="relative z-10 flex-1 flex items-center max-w-7xl w-full mx-auto px-4 sm:px-6 py-4 lg:py-3">
        <section
          className="w-full grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-5 items-center"
          onMouseLeave={() => setHoveredObj(null)}
        >
          {/* Left 8 cols: Undisputed Hero — 3-Second "Draw -> ANIMATE ⚡" Backlit Lightbox */}
          <div className={`lg:col-span-8 ${awakenCls}`} style={awakenStyle(80)}>
            <InteractiveLightboxStage
              project={showcaseProject}
              theme={theme}
              lightboxDim={lightboxDim}
              onLightboxDimChange={setLightboxDim}
              previewMode={previewMode}
              hoveredDoor={hoveredObj}
              paused={anyOverlayOpen}
              onPreviewModeChange={setPreviewMode}
              onOpenDraw={() =>
                showcaseProject ? openProject(showcaseProject.id, 'draw') : handleCreate('draw')
              }
              onCommitSketch={commitDeskSketchToProject}
              onSendSketchToStudio={commitDeskSketchToStudio}
              onOpenPaperDemo={openSamplePaperDemo}
              onOpenPuppetDemo={openSampleMeshPuppetDemo}
              onOpenFilmDemo={openFilmDirectorDemo}
            />
          </div>

          {/* Right 4 cols: 4 Clean Sculptural Studio Doors (Direct entry, zero distraction!) */}
          <div data-tour="desk-modules" className="lg:col-span-4 flex flex-col gap-3">
            {/* Door 1: 3D Cinema Clapperboard -> Draw Room */}
            <div className={`relative ${awakenCls}`} style={awakenStyle(160)}>
              <Clapperboard3DButton
                title={t('clapperTitle')}
                subtitle={t('clapperSubtitle')}
                sceneStamp={`${t('clapperTake')} ${String(projects.length + 1).padStart(2, '0')} · ${newAspect} · ${newFps} FPS`}
                active={showSpecPopover}
                activeBadge={t('clapperOpen')}
                settingsTitle={t('sceneSettingsTitle')}
                onHover={() => {
                  preloadStudioModule('draw');
                  setPreviewMode('draw');
                  setHoveredObj('draw');
                }}
                onClick={() => handleCreate('draw')}
                onSettingsClick={() => setShowSpecPopover((v) => !v)}
              />

              {/* Floating Glass Scene Spec Popover (NEVER pushes layout!) */}
              {showSpecPopover && (
                <div
                  role="dialog"
                  aria-label={t('sceneSettingsTitle')}
                  className="toast-pop-in absolute left-0 right-0 top-[calc(100%+8px)] z-30 rounded-2xl bg-desk-panel/95 backdrop-blur-md border border-ink-brass/50 p-4 space-y-3 shadow-2xl"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] uppercase tracking-widest text-ink-brass font-bold">
                      {t('sceneSettingsTitle')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowSpecPopover(false)}
                      className="p-1 rounded-lg text-desk-muted hover:text-desk-text"
                      aria-label="Kapat"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <input
                    type="text"
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t('sceneNamePlaceholder')}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate('draw');
                    }}
                    className="w-full px-3 py-2 rounded-xl bg-desk-surface border border-desk-border text-xs text-desk-text placeholder:text-desk-muted focus:outline-none focus:border-ink-vermilion"
                  />

                  <div className="grid grid-cols-4 gap-1.5">
                    {(Object.keys(ASPECT_DIMENSIONS) as AspectPreset[]).map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => {
                          soundEngine.click(1.05);
                          setNewAspect(a);
                        }}
                        className={`py-1.5 rounded-lg font-mono text-[11px] border transition-colors ${
                          newAspect === a
                            ? 'bg-ink-brass/20 border-ink-brass text-desk-text font-bold'
                            : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
                        }`}
                      >
                        {a}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="flex gap-1 flex-1">
                      {([8, 12, 15, 24] as const).map((f) => (
                        <button
                          key={f}
                          type="button"
                          onClick={() => {
                            soundEngine.click(1.05);
                            setNewFps(f);
                          }}
                          className={`flex-1 py-1.5 rounded-lg font-mono text-[11px] border transition-colors ${
                            newFps === f
                              ? 'bg-desk-surface border-desk-text text-desk-text font-bold'
                              : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
                          }`}
                        >
                          {f} FPS
                        </button>
                      ))}
                    </div>
                    <KeycapButton
                      variant="vermilion"
                      size="sm"
                      onClick={() => handleCreate('draw')}
                    >
                      {t('startScene')}
                    </KeycapButton>
                  </div>
                </div>
              )}
            </div>

            {/* Objects 2 & 3: Twin Compact 3D Mechanical Workshop Modules Side-by-Side */}
            <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-stretch ${awakenCls}`} style={awakenStyle(240)}>
              <ShutterLens3DButton
                compact
                badge={t('paperCardTag')}
                title={t('paperCardTitle')}
                subtitle={t('paperCardSub')}
                onHover={() => {
                  preloadStudioModule('paper');
                  setPreviewMode('paper');
                  setHoveredObj('paper');
                }}
                onClick={() =>
                  showcaseProject
                    ? openProject(showcaseProject.id, 'paper')
                    : handleCreate('paper')
                }
              />

              <Marionette3DButton
                compact
                badge={t('puppetCardTag')}
                title={t('puppetCardTitle')}
                subtitle={t('puppetCardSub')}
                onHover={() => {
                  preloadStudioModule('puppet');
                  setPreviewMode('puppet');
                  setHoveredObj('puppet');
                }}
                onClick={() => void openSampleMeshPuppetDemo()}
              />
            </div>

            {/* Object 4: Sculptural 3D 16mm Twin-Reel Cinema Projector -> 2.5D Film Studio */}
            <div className={awakenCls} style={awakenStyle(320)}>
              <Projector3DButton
                badge={t('projectorTag')}
                title={t('projectorTitle')}
                subtitle={t('projectorSub')}
                onHover={() => {
                  preloadStudioModule('film');
                  setPreviewMode('film');
                  setHoveredObj('film');
                }}
                onClick={() => void openFilmDirectorDemo()}
              />
            </div>
          </div>
        </section>
      </main>

      {/* Bottom Brass-Handle Pull-Up Studio Drawer (Notebooks + 3 Templates + Backup Import) */}
      <StudioDrawer
        open={drawerOpen}
        onToggle={setDrawerOpen}
        onCreateFirst={() => handleCreate('draw')}
      />
    </div>
  );
}
