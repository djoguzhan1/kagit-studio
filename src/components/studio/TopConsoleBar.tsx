import { useState } from 'react';
import { ArrowLeft, Clapperboard, Maximize2, Minimize2, Moon, Sun, Volume2, VolumeX } from 'lucide-react';
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
import { useT } from '../../i18n/translations';
import { GuideLauncherButton } from '../guide/GuideLauncherButton';
import { AccountButton } from '../account/AccountButton';

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
  } = useStudioStore();
  const t = useT();

  const project = projects.find((p) => p.id === activeProjectId);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftName, setDraftName] = useState('');

  if (!project) return null;

  const filmShots = project.filmGraph?.shots ?? [];
  const filmTotalSec = filmShots.reduce((s, sh) => s + Math.max(0.5, sh.durationSec), 0);
  const firstMeshRig = project.meshRigs?.[0] ?? null;

  const commitTitle = () => {
    if (draftName.trim()) renameProject(project.id, draftName);
    setEditingTitle(false);
  };

  return (
    <header className="h-14 px-3 border-b border-desk-border bg-desk-surface flex items-center justify-between gap-2 shrink-0 select-none z-30">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={() => {
            soundEngine.paperFlip();
            setMode('desk');
          }}
          className="px-2.5 py-1.5 rounded-lg console-well border border-desk-border text-xs font-semibold text-desk-muted hover:text-desk-text inline-flex items-center gap-1.5 transition-colors shrink-0"
          title={t('backToDeskTitle')}
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('backToDesk')}</span>
        </button>

        <div className="hidden lg:block min-w-0">
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
              className="px-2 py-0.5 rounded-md console-well border border-ink-vermilion text-xs font-bold text-desk-text w-44 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraftName(project.name);
                setEditingTitle(true);
              }}
              className="text-left group flex items-center gap-2 min-w-0"
              title="Adı değiştirmek için tıkla"
            >
              <span className="font-bold text-sm text-desk-text truncate max-w-[160px] xl:max-w-[210px] group-hover:text-ink-vermilion transition-colors">
                {project.name}
              </span>
              <span className="font-mono text-[10px] px-1.5 py-0.5 rounded console-well border border-desk-border text-desk-muted hidden xl:inline whitespace-nowrap">
                {mode === 'film' && filmShots.length > 0
                  ? `${filmShots.length} ${locale === 'en' ? 'Shots' : 'Plan'} · ${filmTotalSec.toFixed(1)}s`
                  : mode === 'puppet' && firstMeshRig
                    ? `${firstMeshRig.pins.length} ${locale === 'en' ? 'Pins' : 'Pim'} · ${firstMeshRig.totalFrames} ${locale === 'en' ? 'Frames' : 'Kare'}`
                    : `${project.fps} FPS · ${project.aspect}`}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Clean Recessed 3-Way Studio Mode Switcher */}
      <nav
        aria-label={t('brandSub')}
        className="flex items-center gap-1 p-1 rounded-xl console-well border border-desk-border"
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
              className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold inline-flex items-center gap-1.5 whitespace-nowrap transition-all ${
                active
                  ? 'bg-desk-panel text-desk-text border border-desk-border shadow-md'
                  : 'text-desk-muted hover:text-desk-text border border-transparent'
              }`}
            >
              <span
                className="hardware-led"
                data-on={active ? dot : undefined}
                data-pulse={active ? 'true' : undefined}
              />
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Right Hardware Controls: Brass Rotary Lightbox Dimmer + Lever Theme + Primary 3D Export */}
      <div className="flex items-center gap-2.5">
        {mode === 'draw' && (
          <div
            className="hidden xl:flex items-center gap-2 px-2.5 py-1 rounded-xl console-well border border-desk-border"
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
            <span className="font-mono text-[10px] text-desk-muted w-8 text-right">
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
            className={`hidden md:inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg border font-mono text-[10px] font-bold transition-colors ${
              zenMode
                ? 'bg-ink-brass/20 border-ink-brass text-ink-brass'
                : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
            }`}
            title={t('zenModeTitle')}
          >
            {zenMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            <span>{t('zenMode')}</span>
          </button>
        )}

        <AccountButton compact />

        <GuideLauncherButton compact />

        <button
          type="button"
          onClick={() => {
            soundEngine.click(1.06);
            setLocale(locale === 'tr' ? 'en' : 'tr');
          }}
          className="hidden sm:inline-flex px-2 py-1.5 rounded-lg console-well border border-desk-border font-mono text-[10px] font-bold uppercase text-desk-muted hover:text-ink-brass transition-colors"
          title="Türkçe / English"
        >
          {locale}
        </button>

        <button
          type="button"
          onClick={toggleSound}
          className="p-1.5 rounded-lg console-well border border-desk-border text-desk-muted hover:text-desk-text transition-colors"
          title={soundEnabled ? t('soundToggleTitleOn') : t('soundToggleTitleOff')}
          aria-label={soundEnabled ? t('soundToggleTitleOn') : t('soundToggleTitleOff')}
        >
          {soundEnabled ? (
            <Volume2 className="w-3.5 h-3.5 text-ink-emerald" />
          ) : (
            <VolumeX className="w-3.5 h-3.5 opacity-55" />
          )}
        </button>

        <div className="hidden md:flex items-center gap-1">
          <Moon className="w-3 h-3 text-desk-muted" />
          <ToggleLeverSwitch
            checked={theme === 'day'}
            onChange={(isDay) => setTheme(isDay ? 'day' : 'night')}
            title={theme === 'night' ? t('themeToDay') : t('themeToNight')}
          />
          <Sun className="w-3 h-3 text-ink-brass" />
        </div>

        <button
          type="button"
          onClick={() => {
            soundEngine.toggle(theme === 'night');
            setTheme(theme === 'night' ? 'day' : 'night');
          }}
          className="md:hidden p-1.5 rounded-lg console-well border border-desk-border text-desk-muted"
          aria-label="Tema"
        >
          {theme === 'night' ? <Sun className="w-3.5 h-3.5 text-ink-brass" /> : <Moon className="w-3.5 h-3.5" />}
        </button>

        <KeycapButton
          size="sm"
          variant="vermilion"
          sheenPulse
          sheenDelay={1.2}
          onClick={() =>
            mode === 'film'
              ? setFilmExportOpen(true)
              : mode === 'puppet'
                ? setPuppetExportOpen(true)
                : setExportOpen(true)
          }
          className="whitespace-nowrap shrink-0"
        >
          <TrayExportIcon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{t('exportCta')}</span>
        </KeycapButton>
      </div>
    </header>
  );
}
