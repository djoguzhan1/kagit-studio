import { useState } from 'react';
import {
  ArrowLeft,
  Clapperboard,
  HelpCircle,
  Maximize2,
  Minimize2,
  Moon,
  Play,
  SlidersHorizontal,
  Sun,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { KeycapButton } from '../ui/KeycapButton';
import { BrassRotaryDial, ToggleLeverSwitch } from '../ui/Studio3DControls';
import {
  IrisCameraIcon,
  JointBoneIcon,
  SketchNibIcon,
  TrayExportIcon,
} from '../ui/AnimatedStudioIcons';
import { soundEngine } from '../../engine/soundEngine';
import { localizeProjectName, useT } from '../../i18n/translations';
import { GuideLauncherButton } from '../guide/GuideLauncherButton';
import { AccountButton } from '../account/AccountButton';
import { useModalA11y } from '../../hooks/useModalA11y';

export default function TopConsoleBar() {
  const {
    projects,
    activeProjectId,
    mode,
    theme,
    locale,
    soundEnabled,
    lightboxDim,
    zenMode,
    setMode,
    setTheme,
    setLocale,
    toggleSound,
    setLightboxDim,
    toggleZenMode,
    setExportOpen,
    setFilmExportOpen,
    setPuppetExportOpen,
    renameProject,
    startTour,
    setOverviewShowOpen,
  } = useStudioStore();
  const t = useT();

  const project = projects.find((p) => p.id === activeProjectId);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);

  const quickMenuRef = useModalA11y<HTMLDivElement>({
    open: quickMenuOpen,
    onClose: () => setQuickMenuOpen(false),
    modal: false,
  });

  if (!project) return null;

  const displayProjectName = localizeProjectName(project.name, locale);
  const filmShots = project.filmGraph?.shots ?? [];
  const filmTotalSec = filmShots.reduce((s, sh) => s + Math.max(0.5, sh.durationSec), 0);
  const firstMeshRig = project.meshRigs?.[0] ?? null;

  const commitTitle = () => {
    if (draftName.trim()) renameProject(project.id, draftName);
    setEditingTitle(false);
  };

  const handleExportClick = () => {
    if (mode === 'film') {
      setFilmExportOpen(true);
    } else if (mode === 'puppet') {
      setPuppetExportOpen(true);
    } else {
      setExportOpen(true);
    }
  };

  return (
    <header className="h-14 px-2 sm:px-3 border-b border-desk-border bg-desk-surface flex items-center justify-between gap-1.5 sm:gap-2 shrink-0 select-none z-30">
      {/* Zone 1: Back to Desk + Project Title (strictly shrink-0 on Back button so nav NEVER overlaps it!) */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => {
            soundEngine.paperFlip();
            setMode('desk');
          }}
          className="min-w-[44px] min-h-[44px] px-2.5 rounded-xl console-well border border-desk-border text-xs font-semibold text-desk-muted hover:text-desk-text inline-flex items-center justify-center gap-1.5 transition-colors shrink-0"
          title={t('backToDeskTitle')}
          aria-label={t('backToDeskTitle')}
        >
          <ArrowLeft className="w-4 h-4 shrink-0" />
          <span className="hidden md:inline">{t('backToDesk')}</span>
        </button>

        <div className="hidden xl:flex items-center min-w-0">
          {editingTitle ? (
            <input
              type="text"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              aria-label={t('renameProjectLabel')}
              className="px-2.5 py-1.5 min-h-[38px] rounded-lg console-well border border-ink-vermilion text-xs font-bold text-desk-text w-40 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftName(displayProjectName);
                setEditingTitle(true);
              }}
              className="min-h-[44px] px-2 rounded-xl text-left group inline-flex items-center gap-2 min-w-0 hover:bg-desk-panel/50 transition-colors"
              title={t('renameProjectTitle')}
              aria-label={`${displayProjectName} — ${t('renameProjectTitle')}`}
            >
              <span className="font-bold text-sm text-desk-text truncate max-w-[132px] 2xl:max-w-[210px] group-hover:text-ink-vermilion transition-colors">
                {displayProjectName}
              </span>
              <span className="font-mono text-[11px] px-1.5 py-0.5 rounded console-well border border-desk-border text-desk-muted hidden 2xl:inline whitespace-nowrap">
                {mode === 'film' && filmShots.length > 0
                  ? `${filmShots.length} ${t('shotsShort')} · ${filmTotalSec.toFixed(1)}s`
                  : mode === 'puppet' && firstMeshRig
                    ? `${firstMeshRig.pins.length} ${t('pinsShort')} · ${firstMeshRig.totalFrames} ${t('framesShort')}`
                    : `${project.fps} FPS · ${project.aspect}`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Zone 2: 4-Way Studio Mode Switcher (Every tab >= 44x44px with explicit aria-label + title!) */}
      <nav
        aria-label={t('brandSub')}
        className="flex items-center gap-0.5 sm:gap-1 p-0.5 rounded-xl console-well border border-desk-border shrink-0"
      >
        {(
          [
            { id: 'draw', label: t('tabDraw'), Icon: SketchNibIcon, dot: 'amber' },
            { id: 'paper', label: t('tabPaper'), Icon: IrisCameraIcon, dot: 'vermilion' },
            { id: 'puppet', label: t('tabPuppet'), Icon: JointBoneIcon, dot: 'emerald' },
            { id: 'film', label: t('tabFilm'), Icon: Clapperboard, dot: 'blue' },
          ] as const
        ).map(({ id, label, Icon, dot }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              aria-label={label}
              title={label}
              aria-current={active ? 'page' : undefined}
              onClick={() => {
                if (active) {
                  soundEngine.click(0.95);
                } else if (id === 'paper') {
                  soundEngine.shutter();
                } else if (id === 'film') {
                  soundEngine.projectorClick();
                } else if (id === 'draw') {
                  soundEngine.paperFlip();
                } else {
                  soundEngine.click(1.12);
                }
                setMode(id);
              }}
              className={`relative min-w-[44px] min-h-[44px] px-2 sm:px-3 rounded-lg text-xs font-bold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-all ${
                active
                  ? 'bg-desk-panel text-desk-text border border-desk-border shadow-md'
                  : 'text-desk-muted hover:text-desk-text border border-transparent'
              }`}
            >
              <span
                className="hardware-led hidden sm:inline-block"
                data-on={active ? dot : undefined}
                data-pulse={active ? 'true' : undefined}
              />
              <Icon className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline">{label}</span>
              {active && (
                <span
                  aria-hidden="true"
                  className="sm:hidden absolute bottom-1 left-2.5 right-2.5 h-0.5 rounded-full bg-ink-brass"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Right Controls — Desktop full hardware deck + <1024px unified Studio Console Menu + Always-Visible Primary Export */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {mode === 'draw' && (
          <div
            className="hidden 2xl:flex items-center gap-2 px-2.5 min-h-[44px] rounded-xl console-well border border-desk-border"
            title={t('dimmerLabel')}
          >
            <BrassRotaryDial
              value={Math.round(lightboxDim * 100)}
              min={40}
              max={100}
              step={5}
              size={28}
              label={t('dimmerLabel')}
              onChange={(pct) => setLightboxDim(pct / 100)}
            />
            <span className="font-mono text-[11px] text-desk-muted w-9 text-right">
              {Math.round(lightboxDim * 100)}%
            </span>
          </div>
        )}

        {mode === 'draw' && (
          <button
            type="button"
            onClick={() => {
              soundEngine.toggle(!zenMode);
              toggleZenMode();
            }}
            className={`hidden lg:inline-flex items-center justify-center gap-1.5 min-w-[44px] min-h-[44px] px-2.5 rounded-xl border font-mono text-[11px] font-bold transition-colors ${
              zenMode
                ? 'bg-ink-brass/20 border-ink-brass text-ink-brass'
                : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
            }`}
            title={t('zenModeTitle')}
            aria-label={t('zenModeTitle')}
          >
            {zenMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            <span>{t('zenMode')}</span>
          </button>
        )}

        {/* Desktop Account + Guide + Lang + Sound + Theme (>=1024px) */}
        <div className="hidden lg:flex items-center gap-1.5">
          <AccountButton compact />
          <GuideLauncherButton compact />

          <button
            type="button"
            onClick={() => {
              soundEngine.click(1.06);
              setLocale(locale === 'tr' ? 'en' : 'tr');
            }}
            className="min-w-[44px] min-h-[44px] px-2.5 rounded-xl console-well border border-desk-border font-mono text-[11px] font-bold uppercase text-desk-muted hover:text-ink-brass inline-flex items-center justify-center transition-colors"
            title={t('langToggleAria')}
            aria-label={t('langToggleAria')}
          >
            {locale}
          </button>

          <button
            type="button"
            onClick={toggleSound}
            className="min-w-[44px] min-h-[44px] p-2 rounded-xl console-well border border-desk-border text-desk-muted hover:text-desk-text inline-flex items-center justify-center transition-colors"
            title={soundEnabled ? t('soundToggleTitleOn') : t('soundToggleTitleOff')}
            aria-label={soundEnabled ? t('soundToggleTitleOn') : t('soundToggleTitleOff')}
          >
            {soundEnabled ? (
              <Volume2 className="w-4 h-4 text-ink-emerald" />
            ) : (
              <VolumeX className="w-4 h-4 opacity-55" />
            )}
          </button>

          <div className="flex items-center gap-1 pl-0.5">
            <Moon className="w-3.5 h-3.5 text-desk-muted" aria-hidden="true" />
            <ToggleLeverSwitch
              checked={theme === 'day'}
              onChange={(isDay) => setTheme(isDay ? 'day' : 'night')}
              title={theme === 'night' ? t('themeToDay') : t('themeToNight')}
            />
            <Sun className="w-3.5 h-3.5 text-ink-brass" aria-hidden="true" />
          </div>
        </div>

        {/* Mobile & Tablet (<1024px) Unified 44x44 Studio Settings, Language, Zen & Guide Console */}
        <div className="relative lg:hidden">
          <button
            type="button"
            data-studio-quick-menu="true"
            aria-expanded={quickMenuOpen}
            aria-haspopup="dialog"
            aria-label={t('studioQuickMenuLabel')}
            title={t('studioQuickMenuLabel')}
            onClick={() => {
              soundEngine.click(1.04);
              setQuickMenuOpen((v) => !v);
            }}
            className={`min-w-[44px] min-h-[44px] p-2 rounded-xl border inline-flex items-center justify-center transition-colors ${
              quickMenuOpen || zenMode
                ? 'bg-ink-brass/20 border-ink-brass text-ink-brass'
                : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>

          {quickMenuOpen && (
            <>
              <div
                onClick={() => setQuickMenuOpen(false)}
                className="fixed inset-0 z-[75] bg-black/45"
              />
              <div
                ref={quickMenuRef}
                role="dialog"
                aria-modal="false"
                aria-label={t('studioQuickMenuTitle')}
                className="toast-pop-in fixed left-3 right-3 sm:left-auto sm:right-3 sm:w-80 top-[60px] max-h-[calc(100dvh-72px)] overflow-y-auto overscroll-contain z-[80] rounded-2xl bg-desk-surface/98 backdrop-blur-md border border-ink-brass/55 shadow-2xl p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-desk-border">
                  <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass">
                    {t('studioQuickMenuTitle')}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQuickMenuOpen(false)}
                    aria-label={t('acctCloseAria')}
                    className="min-w-[44px] min-h-[44px] -my-2 -mr-2 rounded-xl inline-flex items-center justify-center text-desk-muted hover:text-desk-text"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Project Rename on Mobile/Tablet */}
                <label className="block space-y-1">
                  <span className="font-mono text-[11px] font-bold text-desk-muted">
                    {t('renameProjectLabel')}
                  </span>
                  <input
                    type="text"
                    defaultValue={displayProjectName}
                    onBlur={(e) => {
                      if (e.target.value.trim()) renameProject(project.id, e.target.value.trim());
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const val = (e.currentTarget as HTMLInputElement).value.trim();
                        if (val) renameProject(project.id, val);
                        setQuickMenuOpen(false);
                      }
                    }}
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl console-well border border-desk-border text-xs font-bold text-desk-text focus:outline-none focus:border-ink-brass"
                  />
                </label>

                {/* Mobile Zen Mode (Unlocked for <768px screens!) + Lightbox Dimmer */}
                {mode === 'draw' && (
                  <div className="space-y-2 pt-1 border-t border-desk-border">
                    <button
                      type="button"
                      onClick={() => {
                        soundEngine.toggle(!zenMode);
                        toggleZenMode();
                        setQuickMenuOpen(false);
                      }}
                      className={`w-full min-h-[44px] px-3 rounded-xl border text-xs font-bold flex items-center justify-between transition-colors ${
                        zenMode
                          ? 'bg-ink-brass/20 border-ink-brass text-ink-brass'
                          : 'console-well border-desk-border text-desk-text'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2">
                        {zenMode ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                        {t('zenModeTitle')}
                      </span>
                      <span className="font-mono text-[11px]">{zenMode ? 'ON' : 'OFF'}</span>
                    </button>

                    <div className="flex items-center justify-between gap-3 px-1">
                      <span className="font-mono text-[11px] text-desk-muted">{t('dimmerLabel')}</span>
                      <input
                        type="range"
                        min={40}
                        max={100}
                        step={5}
                        value={Math.round(lightboxDim * 100)}
                        onChange={(e) => setLightboxDim(Number(e.target.value) / 100)}
                        aria-label={t('dimmerLabel')}
                        className="flex-1 accent-ink-brass"
                      />
                      <span className="font-mono text-[11px] text-ink-brass w-10 text-right">
                        {Math.round(lightboxDim * 100)}%
                      </span>
                    </div>
                  </div>
                )}

                {/* Language (TR / EN) + Theme + Sound 44px Controls */}
                <div className="grid grid-cols-3 gap-2 pt-1 border-t border-desk-border">
                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.click(1.06);
                      setLocale(locale === 'tr' ? 'en' : 'tr');
                    }}
                    aria-label={t('langToggleAria')}
                    className="min-h-[44px] px-2 rounded-xl console-well border border-desk-border font-mono text-xs font-bold uppercase text-desk-text hover:border-ink-brass flex items-center justify-center gap-1"
                  >
                    <span>TR / EN</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      soundEngine.toggle(theme === 'night');
                      setTheme(theme === 'night' ? 'day' : 'night');
                    }}
                    aria-label={t('themeToggleAria')}
                    className="min-h-[44px] px-2 rounded-xl console-well border border-desk-border text-xs font-bold text-desk-text hover:border-ink-brass flex items-center justify-center gap-1.5"
                  >
                    {theme === 'night' ? (
                      <Sun className="w-4 h-4 text-ink-brass" />
                    ) : (
                      <Moon className="w-4 h-4" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={toggleSound}
                    aria-label={soundEnabled ? t('soundToggleTitleOn') : t('soundToggleTitleOff')}
                    className="min-h-[44px] px-2 rounded-xl console-well border border-desk-border text-xs font-bold text-desk-text hover:border-ink-brass flex items-center justify-center gap-1.5"
                  >
                    {soundEnabled ? (
                      <Volume2 className="w-4 h-4 text-ink-emerald" />
                    ) : (
                      <VolumeX className="w-4 h-4 opacity-55" />
                    )}
                  </button>
                </div>

                {/* Living Guide & 10s Overview */}
                <div className="grid grid-cols-2 gap-2 pt-1 border-t border-desk-border">
                  <button
                    type="button"
                    onClick={() => {
                      setQuickMenuOpen(false);
                      void startTour(mode);
                    }}
                    className="min-h-[44px] px-2.5 rounded-xl bg-ink-vermilion text-white text-xs font-bold flex items-center justify-center gap-1.5"
                  >
                    <HelpCircle className="w-4 h-4 shrink-0" />
                    <span className="truncate">{t('guideBtnLabel')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setQuickMenuOpen(false);
                      setOverviewShowOpen(true);
                    }}
                    className="min-h-[44px] px-2.5 rounded-xl console-well border border-ink-brass/50 text-xs font-bold text-desk-text flex items-center justify-center gap-1.5"
                  >
                    <Play className="w-3.5 h-3.5 text-ink-brass shrink-0" />
                    <span className="truncate">10s</span>
                  </button>
                </div>

                {/* Cloud Account Entry */}
                <div className="pt-1 border-t border-desk-border flex justify-stretch [&>*]:w-full">
                  <AccountButton />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Always-Visible Primary Export CTA across 360px..1440px! */}
        <KeycapButton
          size="sm"
          variant="vermilion"
          sheenPulse
          sheenDelay={1.2}
          onClick={handleExportClick}
          aria-label={t('exportCta')}
          title={t('exportCta')}
          className="whitespace-nowrap shrink-0"
        >
          <TrayExportIcon className="w-4 h-4 shrink-0" />
          <span className="hidden min-[420px]:inline">{t('exportCta')}</span>
        </KeycapButton>
      </div>
    </header>
  );
}
