import { useEffect, useState } from 'react';
import {
  Brush,
  Circle,
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
  Sliders,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import type { BrushToolId, ShapeKind } from '../../types/studio';
import { KeycapButton } from '../ui/KeycapButton';
import { StudioToolSlot, ToggleLeverSwitch } from '../ui/Studio3DControls';
import { SketchNibIcon } from '../ui/AnimatedStudioIcons';
import ColorWheelPopover, { getContrastTextColor } from './ColorWheelPopover';
import { useT, type TranslationKey } from '../../i18n/translations';

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
  { id: 'marker', labelKey: 'toolMarker', shortcut: 'K', icon: Highlighter, accent: 'amber' },
  { id: 'dry-brush', labelKey: 'toolDryBrush', shortcut: 'D', icon: Brush, accent: 'amber' },
  { id: 'screentone', labelKey: 'toolScreentone', shortcut: 'T', icon: Grid, accent: 'amber' },
  { id: 'shape', labelKey: 'toolShape', shortcut: 'S', icon: Shapes, accent: 'amber' },
  { id: 'bucket', labelKey: 'toolBucket', shortcut: 'G', icon: PaintBucket, accent: 'amber' },
  { id: 'lasso', labelKey: 'toolLasso', shortcut: 'L', icon: Lasso, accent: 'vermilion' },
  { id: 'eyedropper', labelKey: 'toolEyedropper', shortcut: 'I', icon: Pipette, accent: 'blue' },
  { id: 'eraser', labelKey: 'toolEraser', shortcut: 'E', icon: Eraser, accent: 'vermilion' },
];

interface ToolDeckProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClearLayer: () => void;
  onToggleMobileLayers?: () => void;
}

export default function ToolDeck({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClearLayer,
  onToggleMobileLayers,
}: ToolDeckProps) {
  const { projects, activeProjectId, brush, updateBrush, updateProjectSettings, notify } =
    useStudioStore();
  const t = useT();
  const [mobileBrushOpen, setMobileBrushOpen] = useState(false);
  const [colorWheelOpen, setColorWheelOpen] = useState(false);

  useEffect(() => {
    if (!mobileBrushOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileBrushOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileBrushOpen]);

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

  const handleAddSwatch = () => {
    if (!project) return;
    if (palette.includes(brush.color)) return;
    updateProjectSettings({ palette: [...palette.slice(-10), brush.color] });
    notify(t('colorPaletteAdded'), 'info');
  };

  const renderFaders = () => (
    <div className="space-y-1.5">
      <div>
        <div className="flex justify-between font-mono text-[9.5px] text-desk-muted mb-0.5">
          <span className="uppercase">{t('sliderSize')}</span>
          <span className="text-desk-text">{brush.size} px</span>
        </div>
        <input
          type="range"
          min={1}
          max={48}
          value={brush.size}
          onChange={(e) => updateBrush({ size: Number(e.target.value) })}
          className="studio-fader w-full"
        />
      </div>

      <div>
        <div className="flex justify-between font-mono text-[9.5px] text-desk-muted mb-0.5">
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
          className="studio-fader w-full"
        />
      </div>

      <div>
        <div className="flex justify-between font-mono text-[9.5px] text-desk-muted mb-0.5">
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
          className="studio-fader w-full"
        />
      </div>
    </div>
  );

  return (
    <aside
      data-tour="draw-tools"
      className={`relative w-full lg:w-[232px] shrink-0 border-b lg:border-b-0 lg:border-r border-desk-border bg-desk-surface p-1.5 flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-hidden select-none ${
        mobileBrushOpen || colorWheelOpen ? 'z-50' : 'z-30 lg:z-20'
      }`}
    >
      {/* Top Scrollable Region on Desktop: Compact Tools + Faders so Symmetry & Bottom Dock NEVER clip at 1280x800! */}
      <div className="flex lg:flex-col gap-1.5 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-0.5 shrink-0 lg:shrink">
        {/* Carved Pen-Tray Tool Slots (Clean 11-Tool Artist Deck) */}
        <div className="shrink-0">
          <div className="hidden lg:flex items-center justify-between mb-1 px-1">
            <span className="font-mono text-[9.5px] uppercase tracking-widest text-desk-muted">
              {t('toolTrayHeading')}
            </span>
            <span className="font-mono text-[8px] uppercase text-desk-muted">
              {t('toolBrushesCount')}
            </span>
          </div>

          <div className="flex lg:grid lg:grid-cols-2 gap-1">
            {TOOLS.map((tool) => {
              const active = brush.tool === tool.id;
              const isWideBar = tool.id === 'eraser';
              const label = t(tool.labelKey);
              return (
                <StudioToolSlot
                  key={tool.id}
                  active={active}
                  accent={tool.accent}
                  onClick={() => updateBrush({ tool: tool.id })}
                  className={`whitespace-nowrap lg:!py-0.5 lg:!px-1.5 lg:!text-[10.5px] ${isWideBar ? 'lg:col-span-2 lg:justify-center' : ''}`}
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

          {/* Shape Sub-Selector */}
          {brush.tool === 'shape' && (
            <div className="mt-1.5 p-1 rounded-xl console-well border border-desk-border flex gap-1">
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
                  className={`flex-1 py-1 px-1 rounded-lg font-mono text-[9.5px] flex items-center justify-center gap-1 border ${
                    brush.shapeKind === id
                      ? 'bg-desk-panel border-ink-brass text-desk-text font-bold'
                      : 'border-transparent text-desk-muted hover:text-desk-text'
                  }`}
                  title={label}
                >
                  <Icon className="w-3 h-3" />
                  <span className="hidden lg:inline">{label}</span>
                </button>
              ))}
            </div>
          )}

          {/* Smart Reference-Aware Gap-Closing Bucket Options */}
          {brush.tool === 'bucket' && (
            <div className="hidden lg:block mt-1.5 p-2 rounded-xl console-well border border-desk-border space-y-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[8.5px] uppercase text-desk-muted">
                  {t('bucketRefInk')}
                </span>
                <ToggleLeverSwitch
                  checked={brush.bucketReferenceInk}
                  onChange={(v) => updateBrush({ bucketReferenceInk: v })}
                  title={t('bucketRefInk')}
                />
              </div>
              <div>
                <div className="flex justify-between font-mono text-[8.5px] text-desk-muted mb-0.5">
                  <span className="uppercase">{t('bucketGapClose')}</span>
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
        <div className="hidden lg:block rounded-2xl console-well border border-desk-border p-2 space-y-1.5 shrink-0">
          {renderFaders()}
          <div className="pt-1 border-t border-desk-border flex items-center justify-between">
            <span className="font-mono text-[9px] uppercase text-desk-muted flex items-center gap-1.5">
              <FlipHorizontal2 className="w-3.5 h-3.5 text-ink-vermilion" />
              {t('symmetryLabel')}
            </span>
            <ToggleLeverSwitch
              checked={brush.symmetryX}
              onChange={(v) => updateBrush({ symmetryX: v })}
              title={t('symmetryTitle')}
            />
          </div>
        </div>
      </div>

      {/* Mobile / Tablet Brush Settings Toggle Button */}
      <div className="flex lg:hidden items-center shrink-0">
        <button
          type="button"
          onClick={() => setMobileBrushOpen((v) => !v)}
          className={`px-2.5 py-1.5 rounded-lg border font-mono text-[10px] flex items-center gap-1.5 ${
            mobileBrushOpen
              ? 'bg-ink-brass/20 border-ink-brass text-desk-text font-bold'
              : 'console-well border-desk-border text-desk-muted'
          }`}
          title={t('sliderSize')}
        >
          <Sliders className="w-3.5 h-3.5" />
          <span>{brush.size}px</span>
        </button>
      </div>

      {/* Mobile Floating Brush Popover */}
      {mobileBrushOpen && (
        <>
          <div
            onClick={() => setMobileBrushOpen(false)}
            className="fixed inset-0 z-40 bg-black/45 lg:hidden"
          />
          <div className="fixed left-3 right-3 top-[116px] z-50 lg:hidden rounded-2xl bg-desk-surface border border-desk-border p-4 shadow-2xl space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-desk-muted">
                {t('toolTrayHeading')}
              </span>
              <button
                type="button"
                onClick={() => setMobileBrushOpen(false)}
                className="font-mono text-[11px] text-ink-vermilion font-bold px-2 py-0.5 rounded hover:bg-desk-panel"
              >
                {t('radialClose')}
              </button>
            </div>
            {renderFaders()}
            <div className="flex items-center justify-between pt-1">
              <span className="font-mono text-[10px] uppercase text-desk-muted">
                {t('symmetryLabel')}
              </span>
              <ToggleLeverSwitch
                checked={brush.symmetryX}
                onChange={(v) => updateBrush({ symmetryX: v })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <StudioToolSlot
                active={brush.pressureEnabled}
                onClick={() => updateBrush({ pressureEnabled: !brush.pressureEnabled })}
              >
                {t('pressureFull')}
              </StudioToolSlot>
              <StudioToolSlot
                active={brush.palmRejection}
                onClick={() => updateBrush({ palmRejection: !brush.palmRejection })}
              >
                <Hand className="w-3.5 h-3.5" />
                {t('palmFull')}
              </StudioToolSlot>
            </div>
          </div>
        </>
      )}

      {/* Always-Visible Pinned Bottom Dock: Ink Swatches + Stylus Ergonomics + Undo/Redo */}
      <div className="flex lg:flex-col items-center lg:items-stretch gap-1.5 lg:pt-1.5 lg:border-t lg:border-desk-border shrink-0">
        <div className="hidden lg:flex items-center justify-between px-1">
          <span className="font-mono text-[9.5px] uppercase tracking-widest text-desk-muted">
            {t('paletteHeading')}
          </span>
          <button
            type="button"
            onClick={() => setColorWheelOpen((v) => !v)}
            className="font-mono text-[9.5px] text-ink-brass hover:underline"
          >
            {t('colorWheelBtn')}
          </button>
        </div>

        <div className="flex lg:grid lg:grid-cols-4 gap-1 items-center">
          <button
            type="button"
            onClick={() => setColorWheelOpen((v) => !v)}
            className="w-7 h-7 lg:w-full lg:h-5 rounded-lg border border-ink-brass/90 cursor-pointer overflow-hidden shadow-inner shrink-0 relative flex items-center justify-center"
            style={{
              backgroundColor: brush.color,
              color: getContrastTextColor(brush.color),
            }}
            title={t('colorWheelOpenTitle')}
            aria-label={t('colorWheelBtn')}
          >
            <Palette className="w-3 h-3 opacity-90" />
          </button>
          {palette.slice(0, 7).map((hex) => {
            const selected = brush.color.toLowerCase() === hex.toLowerCase();
            return (
              <button
                key={hex}
                type="button"
                onClick={() => updateBrush({ color: hex })}
                style={{ backgroundColor: hex }}
                className={`w-7 h-7 lg:w-full lg:h-5 rounded-lg border transition-transform shrink-0 ${
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

      {/* Stylus Ergonomics + Clean Minimal Undo/Redo */}
      <div className="flex lg:flex-col gap-1.5 shrink-0">
        <div className="hidden lg:grid grid-cols-2 gap-1">
          <StudioToolSlot
            active={brush.pressureEnabled}
            onClick={() => updateBrush({ pressureEnabled: !brush.pressureEnabled })}
            title={t('pressureTitle')}
          >
            <span className="text-[10px]">{t('pressureShort')}</span>
          </StudioToolSlot>
          <StudioToolSlot
            active={brush.palmRejection}
            onClick={() => updateBrush({ palmRejection: !brush.palmRejection })}
            title={t('palmTitle')}
          >
            <Hand className="w-3 h-3" />
            <span className="text-[10px]">{t('palmShort')}</span>
          </StudioToolSlot>
        </div>

        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            className="flex-1 py-1.5 px-2 rounded-lg console-well border border-desk-border text-desk-text disabled:opacity-35 hover:border-desk-muted flex items-center justify-center transition-colors"
            title={t('undoTitle')}
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            className="flex-1 py-1.5 px-2 rounded-lg console-well border border-desk-border text-desk-text disabled:opacity-35 hover:border-desk-muted flex items-center justify-center transition-colors"
            title={t('redoTitle')}
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClearLayer}
            className="py-1.5 px-2.5 rounded-lg console-well border border-desk-border text-ink-vermilion hover:border-ink-vermilion flex items-center justify-center transition-colors"
            title={t('clearLayerTitle')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {onToggleMobileLayers && (
            <KeycapButton
              size="sm"
              variant="ivory"
              onClick={onToggleMobileLayers}
              className="lg:hidden"
              title={t('mobileLayersTitle')}
            >
              <Layers className="w-3.5 h-3.5" />
            </KeycapButton>
          )}
        </div>
      </div>
    </aside>
  );
}
