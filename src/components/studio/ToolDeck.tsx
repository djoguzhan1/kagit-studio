import { useEffect, useState } from 'react';
import {
  Brush,
  ChevronDown,
  ChevronUp,
  Circle,
  Compass,
  Eraser,
  Feather,
  FlipHorizontal2,
  Grid,
  Hand,
  Highlighter,
  Lasso,
  Layers,
  Minus,
  PaintBucket,
  Palette,
  Pencil,
  Pipette,
  Redo2,
  Shapes,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import type { BrushToolId, ShapeKind } from '../../types/studio';
import { StudioToolSlot, ToggleLeverSwitch } from '../ui/Studio3DControls';
import { SketchNibIcon } from '../ui/AnimatedStudioIcons';
import ColorWheelPopover, { getContrastTextColor } from './ColorWheelPopover';
import { useT, type TranslationKey } from '../../i18n/translations';

const CORE_TOOL_IDS: ReadonlySet<BrushToolId> = new Set([
  'gpen',
  'pencil',
  'blue-rough',
  'bucket',
  'lasso',
  'eraser',
]);

const TOOLS: {
  id: BrushToolId;
  labelKey: TranslationKey;
  shortcut: string;
  icon: 'nib' | typeof Pencil;
  accent: 'amber' | 'blue' | 'vermilion';
}[] = [
  { id: 'gpen', labelKey: 'toolGpen', shortcut: 'B', icon: 'nib', accent: 'amber' },
  { id: 'pencil', labelKey: 'toolPencil', shortcut: 'P', icon: Pencil, accent: 'amber' },
  { id: 'blue-rough', labelKey: 'toolBlueRough', shortcut: 'M', icon: Feather, accent: 'blue' },
  { id: 'bucket', labelKey: 'toolBucket', shortcut: 'G', icon: PaintBucket, accent: 'amber' },
  { id: 'lasso', labelKey: 'toolLasso', shortcut: 'L', icon: Lasso, accent: 'vermilion' },
  { id: 'eraser', labelKey: 'toolEraser', shortcut: 'E', icon: Eraser, accent: 'vermilion' },
  { id: 'marker', labelKey: 'toolMarker', shortcut: 'K', icon: Highlighter, accent: 'amber' },
  { id: 'dry-brush', labelKey: 'toolDryBrush', shortcut: 'D', icon: Brush, accent: 'amber' },
  { id: 'screentone', labelKey: 'toolScreentone', shortcut: 'T', icon: Grid, accent: 'amber' },
  { id: 'shape', labelKey: 'toolShape', shortcut: 'S', icon: Shapes, accent: 'amber' },
  { id: 'eyedropper', labelKey: 'toolEyedropper', shortcut: 'I', icon: Pipette, accent: 'blue' },
];

interface ToolDeckProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClearLayer: () => void;
  onToggleMobileLayers?: () => void;
  onOpenQuickWheel?: () => void;
}

export default function ToolDeck({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClearLayer,
  onToggleMobileLayers,
  onOpenQuickWheel,
}: ToolDeckProps) {
  const { projects, activeProjectId, brush, updateBrush, updateProjectSettings, notify } =
    useStudioStore();
  const t = useT();
  const [mobileBrushOpen, setMobileBrushOpen] = useState(false);
  const [mobileColorOpen, setMobileColorOpen] = useState(false);
  const [colorWheelOpen, setColorWheelOpen] = useState(false);
  const [showMoreBrushes, setShowMoreBrushes] = useState(false);

  useEffect(() => {
    if (!mobileBrushOpen && !mobileColorOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileBrushOpen(false);
        setMobileColorOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mobileBrushOpen, mobileColorOpen]);

  const project = projects.find((p) => p.id === activeProjectId);
  const palette = project?.palette ?? [
    '#1C1917',
    '#E54D2E',
    '#2563EB',
    '#D99B26',
    '#16A34A',
    '#8B5E3C',
    '#EFE6D5',
  ];

  const activeToolDef = TOOLS.find((tl) => tl.id === brush.tool) ?? TOOLS[0];
  const isExtraToolActive = !CORE_TOOL_IDS.has(brush.tool);
  const visibleDesktopTools =
    showMoreBrushes || isExtraToolActive ? TOOLS : TOOLS.filter((tl) => CORE_TOOL_IDS.has(tl.id));

  const handleAddSwatch = () => {
    if (!project) return;
    if (palette.includes(brush.color)) return;
    updateProjectSettings({ palette: [...palette.slice(-10), brush.color] });
    notify(t('colorPaletteAdded'), 'info');
  };

  const renderFaders = () => (
    <div className="space-y-2">
      <div>
        <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
          <span className="uppercase">{t('sliderSize')}</span>
          <span className="text-desk-text">{brush.size} px</span>
        </div>
        <input
          type="range"
          min={1}
          max={48}
          value={brush.size}
          onChange={(e) => updateBrush({ size: Number(e.target.value) })}
          aria-label={t('sliderSize')}
          className="studio-fader w-full"
        />
      </div>

      <div>
        <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
          <span className="uppercase">{t('sliderOpacity')}</span>
          <span className="text-desk-text">{Math.round(brush.opacity * 100)}%</span>
        </div>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={brush.opacity}
          onChange={(e) => updateBrush({ opacity: Number(e.target.value) })}
          aria-label={t('sliderOpacity')}
          className="studio-fader w-full"
        />
      </div>

      <div>
        <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
          <span className="uppercase">{t('sliderStabilizer')}</span>
          <span className="text-desk-text">{Math.round(brush.stabilizer * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={0.85}
          step={0.05}
          value={brush.stabilizer}
          onChange={(e) => updateBrush({ stabilizer: Number(e.target.value) })}
          aria-label={t('sliderStabilizer')}
          className="studio-fader w-full"
        />
      </div>
    </div>
  );

  return (
    <aside
      data-tour="draw-tools"
      className={`relative w-full lg:w-[254px] shrink-0 border-b lg:border-b-0 lg:border-r border-desk-border bg-desk-surface px-2 py-1.5 lg:p-2 flex flex-col gap-1.5 overflow-x-hidden lg:overflow-hidden select-none ${
        mobileBrushOpen || mobileColorOpen || colorWheelOpen ? 'z-50' : 'z-30 lg:z-20'
      }`}
    >
      {/* MOBILE / TABLET (<1024px): Pinned Zero-Scroll 6-Slot Ergonomic Dock (Every button >= 44x44px!) */}
      <div className="grid grid-cols-6 gap-1.5 items-center lg:hidden">
        {/* 1. Active Pen / All Brushes Drawer */}
        <button
          type="button"
          onClick={() => {
            setMobileColorOpen(false);
            setMobileBrushOpen((v) => !v);
          }}
          aria-expanded={mobileBrushOpen}
          aria-label={`${t(activeToolDef.labelKey)} — ${t('mobileBrushDrawerTitle')}`}
          title={t(activeToolDef.labelKey)}
          className={`min-w-[44px] min-h-[44px] px-1.5 rounded-xl border text-[11px] font-bold flex items-center justify-center gap-1 transition-colors ${
            mobileBrushOpen || brush.tool !== 'eraser'
              ? 'bg-desk-panel border-ink-brass text-desk-text shadow-sm'
              : 'console-well border-desk-border text-desk-muted'
          }`}
        >
          {activeToolDef.icon === 'nib' ? (
            <SketchNibIcon className="w-4 h-4 shrink-0" />
          ) : (
            <activeToolDef.icon className="w-4 h-4 shrink-0" />
          )}
          <ChevronDown className="w-3 h-3 opacity-75 shrink-0" />
        </button>

        {/* 2. Pinned 1-Tap Eraser */}
        <button
          type="button"
          onClick={() => updateBrush({ tool: 'eraser' })}
          aria-label={t('toolEraser')}
          title={`${t('toolEraser')} (E)`}
          className={`min-w-[44px] min-h-[44px] rounded-xl border flex items-center justify-center transition-colors ${
            brush.tool === 'eraser'
              ? 'bg-ink-vermilion text-white border-ink-vermilion shadow-sm'
              : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
          }`}
        >
          <Eraser className="w-4 h-4" />
        </button>

        {/* 3. Pinned Color Swatch + Brush Size Popover */}
        <button
          type="button"
          onClick={() => {
            setMobileBrushOpen(false);
            setMobileColorOpen((v) => !v);
          }}
          aria-expanded={mobileColorOpen}
          aria-label={`${t('paletteHeading')} · ${brush.size}px`}
          title={`${t('paletteHeading')} (${brush.size}px)`}
          className={`min-w-[44px] min-h-[44px] px-1.5 rounded-xl border font-mono text-[11px] font-bold flex items-center justify-center gap-1 transition-colors ${
            mobileColorOpen
              ? 'bg-ink-brass/20 border-ink-brass text-desk-text'
              : 'console-well border-desk-border text-desk-text'
          }`}
        >
          <span
            className="w-4 h-4 rounded-full border border-white/60 shrink-0"
            style={{ backgroundColor: brush.color }}
          />
          <span>{brush.size}</span>
        </button>

        {/* 4. Pinned 1-Tap Undo */}
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={t('undoTitle')}
          title={t('undoTitle')}
          className="min-w-[44px] min-h-[44px] rounded-xl console-well border border-desk-border text-desk-text disabled:opacity-35 flex items-center justify-center transition-colors"
        >
          <Undo2 className="w-4 h-4" />
        </button>

        {/* 5. Pinned 1-Tap Radial Quick Wheel Trigger (Solves 0 Mobile Access + Discoverability!) */}
        <button
          type="button"
          data-quick-wheel-trigger="true"
          onClick={() => {
            setMobileBrushOpen(false);
            setMobileColorOpen(false);
            onOpenQuickWheel?.();
          }}
          aria-label={t('quickWheelTitle')}
          title={t('quickWheelTitle')}
          className="min-w-[44px] min-h-[44px] rounded-xl console-well border border-ink-brass/50 text-ink-brass hover:bg-ink-brass/15 flex items-center justify-center transition-colors"
        >
          <Compass className="w-4 h-4" />
        </button>

        {/* 6. Pinned Mobile Layers & Guides Sheet */}
        <button
          type="button"
          onClick={() => {
            setMobileBrushOpen(false);
            setMobileColorOpen(false);
            onToggleMobileLayers?.();
          }}
          aria-label={t('mobileLayersTitle')}
          title={t('mobileLayersTitle')}
          className="min-w-[44px] min-h-[44px] rounded-xl bg-desk-panel border border-desk-border text-desk-text flex items-center justify-center transition-colors"
        >
          <Layers className="w-4 h-4 text-ink-brass" />
        </button>
      </div>

      {/* Mobile Brush Picker + Stylus / Redo / Clear Drawer */}
      {mobileBrushOpen && (
        <>
          <div
            onClick={() => setMobileBrushOpen(false)}
            className="fixed inset-0 z-40 bg-black/45 lg:hidden"
          />
          <div className="fixed left-3 right-3 top-[116px] max-h-[calc(100dvh-132px)] overflow-y-auto overscroll-contain z-50 lg:hidden rounded-2xl bg-desk-surface border border-desk-border p-3.5 shadow-2xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass">
                {t('mobileBrushDrawerTitle')}
              </span>
              <button
                type="button"
                onClick={() => setMobileBrushOpen(false)}
                aria-label={t('radialClose')}
                className="min-w-[44px] min-h-[44px] -my-2 -mr-2 rounded-xl inline-flex items-center justify-center text-desk-muted hover:text-desk-text"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {TOOLS.map((tool) => {
                const active = brush.tool === tool.id;
                const label = t(tool.labelKey);
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => {
                      updateBrush({ tool: tool.id });
                      if (tool.id !== 'shape' && tool.id !== 'bucket') {
                        setMobileBrushOpen(false);
                      }
                    }}
                    className={`min-h-[44px] px-2.5 py-2 rounded-xl border text-xs font-bold flex items-center gap-2 transition-colors ${
                      active
                        ? 'bg-desk-panel border-ink-brass text-desk-text shadow-sm'
                        : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
                    }`}
                  >
                    {tool.icon === 'nib' ? (
                      <SketchNibIcon className="w-4 h-4 shrink-0" />
                    ) : (
                      <tool.icon className="w-4 h-4 shrink-0" />
                    )}
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>

            {brush.tool === 'shape' && (
              <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl console-well border border-desk-border">
                {(
                  [
                    { id: 'line', label: t('shapeLine'), Icon: Minus },
                    { id: 'ellipse', label: t('shapeEllipse'), Icon: Circle },
                    { id: 'rect', label: t('shapeRect'), Icon: Square },
                  ] as { id: ShapeKind; label: string; Icon: typeof Minus }[]
                ).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => updateBrush({ shapeKind: id })}
                    className={`min-h-[44px] px-2 rounded-lg font-mono text-[11px] flex items-center justify-center gap-1.5 border ${
                      brush.shapeKind === id
                        ? 'bg-desk-panel border-ink-brass text-desk-text font-bold'
                        : 'border-transparent text-desk-muted'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between pt-1 border-t border-desk-border">
              <span className="font-mono text-[11px] uppercase text-desk-muted flex items-center gap-1.5">
                <FlipHorizontal2 className="w-4 h-4 text-ink-vermilion" />
                {t('symmetryLabel')}
              </span>
              <ToggleLeverSwitch
                checked={brush.symmetryX}
                onChange={(v) => updateBrush({ symmetryX: v })}
                title={t('symmetryTitle')}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={onRedo}
                disabled={!canRedo}
                className="min-h-[44px] px-3 rounded-xl console-well border border-desk-border text-xs font-bold text-desk-text disabled:opacity-35 flex items-center justify-center gap-1.5"
              >
                <Redo2 className="w-4 h-4" />
                <span>{t('redoTitle')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onClearLayer();
                  setMobileBrushOpen(false);
                }}
                className="min-h-[44px] px-3 rounded-xl console-well border border-desk-border text-xs font-bold text-ink-vermilion flex items-center justify-center gap-1.5"
              >
                <Trash2 className="w-4 h-4" />
                <span>{t('clearLayerTitle')}</span>
              </button>
            </div>
          </div>
        </>
      )}

      {/* Mobile Color + Brush Size & Opacity Popover */}
      {mobileColorOpen && (
        <>
          <div
            onClick={() => setMobileColorOpen(false)}
            className="fixed inset-0 z-40 bg-black/45 lg:hidden"
          />
          <div className="fixed left-3 right-3 top-[116px] max-h-[calc(100dvh-132px)] overflow-y-auto overscroll-contain z-50 lg:hidden rounded-2xl bg-desk-surface border border-desk-border p-3.5 shadow-2xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink-brass">
                {t('paletteHeading')}
              </span>
              <button
                type="button"
                onClick={() => setMobileColorOpen(false)}
                aria-label={t('radialClose')}
                className="min-w-[44px] min-h-[44px] -my-2 -mr-2 rounded-xl inline-flex items-center justify-center text-desk-muted hover:text-desk-text"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => {
                  setMobileColorOpen(false);
                  setColorWheelOpen(true);
                }}
                style={{
                  backgroundColor: brush.color,
                  color: getContrastTextColor(brush.color),
                }}
                title={t('colorWheelOpenTitle')}
                aria-label={t('colorWheelBtn')}
                className="min-h-[44px] rounded-xl border-2 border-ink-brass flex items-center justify-center shadow-inner"
              >
                <Palette className="w-4 h-4" />
              </button>
              {palette.slice(0, 7).map((hex) => {
                const selected = brush.color.toLowerCase() === hex.toLowerCase();
                return (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => updateBrush({ color: hex })}
                    style={{ backgroundColor: hex }}
                    aria-label={`${t('paletteHeading')} ${hex}`}
                    className={`min-h-[44px] rounded-xl border transition-transform ${
                      selected
                        ? 'border-ink-vermilion ring-2 ring-ink-vermilion/45 scale-95'
                        : 'border-desk-border'
                    }`}
                  />
                );
              })}
            </div>

            {renderFaders()}
          </div>
        </>
      )}

      {/* DESKTOP (>=1024px): Focused Core Artist Deck + Expandable Specialist Brushes */}
      <div className="hidden lg:flex lg:flex-col gap-2 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-0.5">
        <div className="shrink-0 space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted font-bold">
              {t('toolTrayHeading')}
            </span>
            <button
              type="button"
              data-quick-wheel-trigger="true"
          onClick={onOpenQuickWheel}
              title={t('quickWheelTitle')}
              aria-label={t('quickWheelTitle')}
              className="min-h-[28px] px-2 py-0.5 rounded-lg console-well border border-ink-brass/50 font-mono text-[11px] font-bold text-ink-brass hover:bg-ink-brass/15 inline-flex items-center gap-1 transition-colors"
            >
              <Compass className="w-3 h-3" />
              <span>{t('quickWheelBtn')}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {visibleDesktopTools.map((tool) => {
              const active = brush.tool === tool.id;
              const label = t(tool.labelKey);
              return (
                <StudioToolSlot
                  key={tool.id}
                  active={active}
                  accent={tool.accent}
                  onClick={() => updateBrush({ tool: tool.id })}
                  className="whitespace-nowrap !min-h-[36px] !py-1.5 !px-2 !text-[11px]"
                  title={`${label} (${tool.shortcut})`}
                >
                  {tool.icon === 'nib' ? (
                    <SketchNibIcon className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <tool.icon className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="truncate">{label}</span>
                </StudioToolSlot>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setShowMoreBrushes((v) => !v)}
            className="w-full min-h-[32px] px-2.5 py-1 rounded-xl console-well border border-desk-border hover:border-ink-brass/60 font-mono text-[11px] font-semibold text-desk-muted hover:text-desk-text flex items-center justify-between transition-colors"
          >
            <span>{showMoreBrushes ? t('lessBrushesBtn') : t('moreBrushesBtn')}</span>
            {showMoreBrushes ? (
              <ChevronUp className="w-3.5 h-3.5 text-ink-brass" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-ink-brass" />
            )}
          </button>

          {brush.tool === 'shape' && (
            <div className="p-1 rounded-xl console-well border border-desk-border flex gap-1">
              {(
                [
                  { id: 'line', label: t('shapeLine'), Icon: Minus },
                  { id: 'ellipse', label: t('shapeEllipse'), Icon: Circle },
                  { id: 'rect', label: t('shapeRect'), Icon: Square },
                ] as { id: ShapeKind; label: string; Icon: typeof Minus }[]
              ).map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => updateBrush({ shapeKind: id })}
                  className={`flex-1 min-h-[32px] py-1 px-1 rounded-lg font-mono text-[11px] flex items-center justify-center gap-1 border ${
                    brush.shapeKind === id
                      ? 'bg-desk-panel border-ink-brass text-desk-text font-bold'
                      : 'border-transparent text-desk-muted hover:text-desk-text'
                  }`}
                  title={label}
                >
                  <Icon className="w-3 h-3" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}

          {brush.tool === 'bucket' && (
            <div className="p-2 rounded-xl console-well border border-desk-border space-y-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[11px] text-desk-muted">
                  {t('bucketRefInk')}
                </span>
                <ToggleLeverSwitch
                  checked={brush.bucketReferenceInk}
                  onChange={(v) => updateBrush({ bucketReferenceInk: v })}
                  title={t('bucketRefInk')}
                />
              </div>
              <div>
                <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
                  <span>{t('bucketGapClose')}</span>
                  <span className="text-desk-text">{brush.bucketGapClose} px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={1}
                  value={brush.bucketGapClose}
                  onChange={(e) => updateBrush({ bucketGapClose: Number(e.target.value) })}
                  className="studio-fader w-full"
                />
              </div>
            </div>
          )}
        </div>

        {/* Desktop Brush Faders */}
        <div className="rounded-2xl console-well border border-desk-border p-2.5 space-y-2 shrink-0">
          {renderFaders()}
          {showMoreBrushes && (
            <>
              <div className="pt-1.5 border-t border-desk-border flex items-center justify-between">
                <span className="font-mono text-[11px] text-desk-muted flex items-center gap-1.5">
                  <FlipHorizontal2 className="w-3.5 h-3.5 text-ink-vermilion" />
                  {t('symmetryLabel')}
                </span>
                <ToggleLeverSwitch
                  checked={brush.symmetryX}
                  onChange={(v) => updateBrush({ symmetryX: v })}
                  title={t('symmetryTitle')}
                />
              </div>
              <div className="grid grid-cols-2 gap-1 pt-1">
                <StudioToolSlot
                  active={brush.pressureEnabled}
                  onClick={() => updateBrush({ pressureEnabled: !brush.pressureEnabled })}
                  title={t('pressureTitle')}
                  className="!min-h-[32px] !text-[11px]"
                >
                  <span>{t('pressureShort')}</span>
                </StudioToolSlot>
                <StudioToolSlot
                  active={brush.palmRejection}
                  onClick={() => updateBrush({ palmRejection: !brush.palmRejection })}
                  title={t('palmTitle')}
                  className="!min-h-[32px] !text-[11px]"
                >
                  <Hand className="w-3 h-3" />
                  <span>{t('palmShort')}</span>
                </StudioToolSlot>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Desktop Pinned Bottom Color Swatches + Undo/Redo/Clear */}
      <div className="hidden lg:flex lg:flex-col gap-2 pt-1.5 border-t border-desk-border shrink-0">
        <div className="flex items-center justify-between px-1">
          <span className="font-mono text-[11px] uppercase tracking-wider text-desk-muted">
            {t('paletteHeading')}
          </span>
          <button
            type="button"
            onClick={() => setColorWheelOpen((v) => !v)}
            className="font-mono text-[11px] text-ink-brass hover:underline min-h-[24px]"
          >
            {t('colorWheelBtn')}
          </button>
        </div>

        <div className="grid grid-cols-4 gap-1.5 items-center">
          <button
            type="button"
            onClick={() => setColorWheelOpen((v) => !v)}
            className="w-full min-h-[28px] rounded-lg border border-ink-brass/90 cursor-pointer overflow-hidden shadow-inner relative flex items-center justify-center"
            style={{
              backgroundColor: brush.color,
              color: getContrastTextColor(brush.color),
            }}
            title={t('colorWheelOpenTitle')}
            aria-label={t('colorWheelBtn')}
          >
            <Palette className="w-3.5 h-3.5 opacity-90" />
          </button>
          {palette.slice(0, 7).map((hex) => {
            const selected = brush.color.toLowerCase() === hex.toLowerCase();
            return (
              <button
                key={hex}
                type="button"
                onClick={() => updateBrush({ color: hex })}
                style={{ backgroundColor: hex }}
                className={`w-full min-h-[28px] rounded-lg border transition-transform ${
                  selected
                    ? 'border-ink-vermilion ring-2 ring-ink-vermilion/45 scale-95'
                    : 'border-desk-border hover:scale-105'
                }`}
                title={hex}
                aria-label={`${t('paletteHeading')} ${hex}`}
              />
            );
          })}
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label={t('undoTitle')}
            title={t('undoTitle')}
            className="min-h-[38px] rounded-xl console-well border border-desk-border text-desk-text disabled:opacity-35 hover:border-desk-muted flex items-center justify-center transition-colors"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            aria-label={t('redoTitle')}
            title={t('redoTitle')}
            className="min-h-[38px] rounded-xl console-well border border-desk-border text-desk-text disabled:opacity-35 hover:border-desk-muted flex items-center justify-center transition-colors"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClearLayer}
            aria-label={t('clearLayerTitle')}
            title={t('clearLayerTitle')}
            className="min-h-[38px] rounded-xl console-well border border-desk-border text-ink-vermilion hover:border-ink-vermilion flex items-center justify-center transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {colorWheelOpen && (
        <ColorWheelPopover
          color={brush.color}
          recentColors={project?.recentColors ?? []}
          onChange={(hex) => updateBrush({ color: hex })}
          onAddPalette={handleAddSwatch}
          onClose={() => setColorWheelOpen(false)}
        />
      )}
    </aside>
  );
}
