import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Compass,
  Eye,
  EyeOff,
  Film,
  Grid,
  Image as ImageIcon,
  Layers,
  Lock,
  Plus,
  Trash2,
  Unlock,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import type {
  LayerRole,
  PaperStyleId,
  SceneAtmosphereId,
  UnderlayGuideId,
} from '../../types/studio';
import { BlobImage, KeycapButton } from '../ui/KeycapButton';
import { ToggleLeverSwitch } from '../ui/Studio3DControls';
import { OnionLayersIcon } from '../ui/AnimatedStudioIcons';
import { makeId, saveBlob } from '../../engine/db';
import { localizeLayerName, useT, type TranslationKey } from '../../i18n/translations';
import { useModalA11y } from '../../hooks/useModalA11y';

const PAPER_STYLES: { id: PaperStyleId; labelKey: TranslationKey }[] = [
  { id: 'bristol', labelKey: 'railPaperBristol' },
  { id: 'grid', labelKey: 'railPaperGrid' },
  { id: 'lined', labelKey: 'railPaperLined' },
  { id: 'kraft', labelKey: 'railPaperKraft' },
  { id: 'acme12', labelKey: 'railPaperAcme' },
];

const UNDERLAY_GUIDES: { id: UnderlayGuideId; labelKey: TranslationKey }[] = [
  { id: 'none', labelKey: 'railGuideNone' },
  { id: 'bounce', labelKey: 'railGuideBounce' },
  { id: 'walk', labelKey: 'railGuideWalk' },
  { id: 'head-turn', labelKey: 'railGuideHead' },
  { id: 'wave', labelKey: 'railGuideWave' },
  { id: 'persp1', labelKey: 'railGuidePersp1' },
  { id: 'persp2', labelKey: 'railGuidePersp2' },
];

const ATMOSPHERES: { id: SceneAtmosphereId; labelKey: TranslationKey }[] = [
  { id: 'none', labelKey: 'railAtmoNone' },
  { id: 'sunset', labelKey: 'railAtmoSunset' },
  { id: 'night-lamp', labelKey: 'railAtmoNight' },
  { id: 'vintage-1970', labelKey: 'railAtmoVintage' },
];

/** Samples 6 dominant usable ink/color swatches from an uploaded character model sheet */
async function extractSwatchesFromFile(file: File): Promise<string[]> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    const buckets = new Map<string, number>();

    for (let i = 0; i < data.length; i += 16) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 180) continue;
      if (r > 235 && g > 235 && b > 235) continue;
      const qr = Math.round(r / 32) * 32;
      const qg = Math.round(g / 32) * 32;
      const qb = Math.round(b / 32) * 32;
      const hex =
        '#' +
        [qr, qg, qb]
          .map((v) => Math.min(255, v).toString(16).padStart(2, '0'))
          .join('');
      buckets.set(hex, (buckets.get(hex) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([hex]) => hex);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function LayerReferenceRail({
  mobileOpen = false,
  onCloseMobile,
}: {
  mobileOpen?: boolean;
  onCloseMobile?: () => void;
}) {
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    activeLayerId,
    onion,
    guides,
    rightRailTab,
    setRightRailTab,
    selectLayer,
    updateOnion,
    updateGuides,
    updateProjectSettings,
    setSceneBackground,
    setBackgroundParallax,
    upsertCameraKeyframe,
    clearCameraKeyframes,
    setFrameCameraShake,
    setSceneAtmosphere,
    addLayerToCurrentFrame,
    updateLayerInCurrentFrame,
    moveLayerInCurrentFrame,
    deleteLayerInCurrentFrame,
    addReference,
    deleteReference,
    updateBrush,
    notify,
  } = useStudioStore();
  const t = useT();
  const locale = useStudioStore((st) => st.locale);
  const mobileRailRef = useModalA11y<HTMLElement>({
    open: Boolean(mobileOpen),
    onClose: onCloseMobile,
    modal: true,
  });

  const [addLayerOpen, setAddLayerOpen] = useState(false);
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const refInput = useRef<HTMLInputElement>(null);
  const bgInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mobileOpen || !onCloseMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onCloseMobile]);

  const project = projects.find((p) => p.id === activeProjectId);
  const frame = project?.frames[activeFrameIndex];
  if (!project || !frame) return null;

  const camKeyframes = project.cameraKeyframes ?? [];
  const activeCamKf =
    camKeyframes.find((k) => k.frame === activeFrameIndex) ?? {
      frame: activeFrameIndex,
      zoom: 1,
      panX: 0,
      panY: 0,
      tiltDeg: 0,
    };

  const handleUploadReference = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const blobKey = await saveBlob(file);
      const swatches = await extractSwatchesFromFile(file);
      addReference({
        id: makeId('ref'),
        name: file.name.replace(/\.[^.]+$/, ''),
        blobKey,
        swatches,
      });
      notify(t('refAddedToast'));
    } catch {
      notify(t('refErrorToast'), 'error');
    } finally {
      if (refInput.current) refInput.current.value = '';
    }
  };

  const handleUploadBg = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const key = await saveBlob(file);
      setSceneBackground(key);
      notify(t('bgAddedToast'));
    } catch {
      notify(t('bgErrorToast'), 'error');
    } finally {
      if (bgInput.current) bgInput.current.value = '';
    }
  };

  const roleAccent: Record<LayerRole, string> = {
    ink: 'bg-desk-text',
    color: 'bg-ink-brass',
    rough: 'bg-ink-blue',
    paper: 'bg-ink-vermilion',
  };

  const commitRename = (layerId: string) => {
    const trimmed = renameDraft.trim();
    if (trimmed) {
      updateLayerInCurrentFrame(layerId, { name: trimmed });
    }
    setRenamingLayerId(null);
  };

  const addRoleLayer = (role: LayerRole) => {
    const idx = frame.layers.length + 1;
    const baseName =
      role === 'ink'
        ? t('railAddInk').replace(/^\+\s*/, '')
        : role === 'rough'
          ? t('railAddRough').replace(/^\+\s*/, '')
          : t('railAddColor').replace(/^\+\s*/, '');
    addLayerToCurrentFrame(`${baseName} ${idx}`, role);
    setAddLayerOpen(false);
  };

  return (
    <>
      {mobileOpen && (
        <div onClick={onCloseMobile} className="fixed inset-0 z-40 bg-black/60 lg:hidden" />
      )}
      <aside
        ref={mobileRailRef}
        role={mobileOpen ? 'dialog' : undefined}
        aria-modal={mobileOpen ? 'true' : undefined}
        aria-label={mobileOpen ? t('railTabLayers') : undefined}
        className={`${
          mobileOpen ? 'fixed right-0 top-14 bottom-0 z-50 flex shadow-2xl max-w-[calc(100vw-1rem)]' : 'hidden'
        } lg:static lg:flex w-[256px] shrink-0 border-l border-desk-border bg-desk-surface flex-col select-none`}
      >
        {/* Clean 3-Tab Rail Header: Layers | Paper & Guides | Camera */}
        <div className="p-2 border-b border-desk-border flex items-center gap-1">
          {(
            [
              { id: 'layers', label: t('railTabLayers'), Icon: Layers },
              { id: 'table', label: t('railTabPaper'), Icon: Compass },
              { id: 'camera', label: t('railTabCamera'), Icon: Film },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setRightRailTab(id)}
              className={`flex-1 py-1.5 px-1.5 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 border transition-colors ${
                rightRailTab === id
                  ? 'bg-desk-panel border-desk-border text-desk-text shadow-sm'
                  : 'border-transparent text-desk-muted hover:text-desk-text'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
          {mobileOpen && onCloseMobile && (
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label={t('radialClose')}
              title={`${t('radialClose')} (Esc)`}
              className="lg:hidden p-1.5 rounded-lg border border-desk-border text-desk-muted hover:text-desk-text shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* TAB 1: PURE CEL LAYER STACK + FIXED BACKGROUND */}
        {rightRailTab === 'layers' && (
          <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
            {/* Cel Layer Stack */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="font-mono text-[11px] uppercase tracking-widest text-desk-muted">
                  {t('stageFrameLabel')} #{activeFrameIndex + 1} · {t('railFrameLayers')}
                </span>
                <button
                  type="button"
                  onClick={() => setAddLayerOpen((v) => !v)}
                  className={`p-1 rounded-lg border transition-colors ${
                    addLayerOpen
                      ? 'bg-ink-brass/20 border-ink-brass text-ink-brass'
                      : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
                  }`}
                  title={t('railAddLayer')}
                  aria-label={t('railAddLayer')}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>

              {addLayerOpen && (
                <div className="grid grid-cols-3 gap-1 p-1.5 rounded-xl console-well border border-ink-brass/50">
                  <button
                    type="button"
                    onClick={() => addRoleLayer('color')}
                    className="py-1 px-1 rounded-lg bg-desk-panel hover:border-ink-brass border border-desk-border font-mono text-[11px] font-bold text-ink-brass"
                  >
                    {t('railAddColor')}
                  </button>
                  <button
                    type="button"
                    onClick={() => addRoleLayer('ink')}
                    className="py-1 px-1 rounded-lg bg-desk-panel hover:border-desk-text border border-desk-border font-mono text-[11px] font-bold text-desk-text"
                  >
                    {t('railAddInk')}
                  </button>
                  <button
                    type="button"
                    onClick={() => addRoleLayer('rough')}
                    className="py-1 px-1 rounded-lg bg-desk-panel hover:border-ink-blue border border-desk-border font-mono text-[11px] font-bold text-ink-blue"
                  >
                    {t('railAddRough')}
                  </button>
                </div>
              )}

              <div className="space-y-1.5">
                {[...frame.layers].reverse().map((layer, revIdx) => {
                  const isActive = layer.id === activeLayerId;
                  const canMoveUp = revIdx > 0;
                  const canMoveDown = revIdx < frame.layers.length - 1;
                  const isRenaming = renamingLayerId === layer.id;
                  return (
                    <div
                      key={layer.id}
                      onClick={() => selectLayer(layer.id)}
                      className={`rounded-xl p-2 border cursor-pointer transition-colors ${
                        isActive
                          ? 'bg-desk-panel border-ink-brass shadow-sm'
                          : 'console-well border-desk-border hover:border-desk-muted/50'
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-1 h-4 rounded-full shrink-0 ${roleAccent[layer.role]}`}
                          aria-hidden="true"
                        />
                        <span
                          className="hardware-led"
                          data-on={isActive ? 'amber' : undefined}
                        />
                        {isRenaming ? (
                          <input
                            type="text"
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => commitRename(layer.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename(layer.id);
                              else if (e.key === 'Escape') setRenamingLayerId(null);
                            }}
                            className="flex-1 min-w-0 bg-desk-surface border border-ink-brass rounded px-1.5 py-0.5 text-xs font-semibold text-desk-text focus:outline-none"
                          />
                        ) : (
                          <span
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              setRenamingLayerId(layer.id);
                              setRenameDraft(layer.name);
                            }}
                            title={t('railRenameHint')}
                            className="text-xs font-semibold text-desk-text truncate flex-1 flex items-center gap-1.5"
                          >
                            <span className="truncate">{localizeLayerName(layer.name, locale)}</span>
                            {layer.blobKey && (
                              <span
                                className="w-1.5 h-1.5 rounded-full bg-ink-emerald shrink-0"
                                aria-hidden="true"
                              />
                            )}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            updateLayerInCurrentFrame(layer.id, { visible: !layer.visible });
                          }}
                          className="p-1 rounded hover:bg-desk-surface text-desk-muted hover:text-desk-text"
                          title={t('railToggleVis')}
                        >
                          {layer.visible ? (
                            <Eye className="w-3.5 h-3.5" />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5 opacity-45" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            updateLayerInCurrentFrame(layer.id, { locked: !layer.locked });
                          }}
                          className="p-1 rounded hover:bg-desk-surface text-desk-muted hover:text-desk-text"
                          title={t('railToggleLock')}
                        >
                          {layer.locked ? (
                            <Lock className="w-3 h-3 text-ink-vermilion" />
                          ) : (
                            <Unlock className="w-3 h-3 opacity-55" />
                          )}
                        </button>
                        {frame.layers.length > 1 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteLayerInCurrentFrame(layer.id);
                            }}
                            className="p-1 rounded hover:bg-desk-surface text-desk-muted hover:text-ink-vermilion"
                            title={t('railDeleteLayer')}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>

                      {isActive && (
                        <div className="mt-2 pt-2 border-t border-desk-border flex items-center gap-1.5">
                          <div className="flex items-center gap-0.5 shrink-0">
                            <button
                              type="button"
                              disabled={!canMoveUp}
                              onClick={(e) => {
                                e.stopPropagation();
                                moveLayerInCurrentFrame(layer.id, 'up');
                              }}
                              className="p-0.5 rounded border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-30"
                              title={t('railMoveUp')}
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={!canMoveDown}
                              onClick={(e) => {
                                e.stopPropagation();
                                moveLayerInCurrentFrame(layer.id, 'down');
                              }}
                              className="p-0.5 rounded border border-desk-border text-desk-muted hover:text-desk-text disabled:opacity-30"
                              title={t('railMoveDown')}
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                          <input
                            type="range"
                            min={0.1}
                            max={1}
                            step={0.05}
                            value={layer.opacity}
                            onChange={(e) =>
                              updateLayerInCurrentFrame(layer.id, {
                                opacity: Number(e.target.value),
                              })
                            }
                            onClick={(e) => e.stopPropagation()}
                            className="studio-fader flex-1 min-w-0"
                          />
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateLayerInCurrentFrame(layer.id, {
                                blendMode:
                                  layer.blendMode === 'multiply' ? 'source-over' : 'multiply',
                              });
                            }}
                            className={`font-mono text-[11px] px-1.5 py-0.5 rounded border shrink-0 ${
                              layer.blendMode === 'multiply'
                                ? 'border-ink-brass text-ink-brass'
                                : 'border-desk-border text-desk-muted'
                            }`}
                          >
                            {layer.blendMode === 'multiply' ? 'MULTIPLY' : 'NORMAL'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Fixed Scene Background Plane (1 Background across all frames + Parallax!) */}
            <div className="rounded-2xl console-well border border-desk-border p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-widest text-desk-muted flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5 text-ink-emerald" />
                  {t('railFixedBg')}
                </span>
                {project.backgroundBlobKey && (
                  <button
                    type="button"
                    onClick={() => setSceneBackground(null)}
                    className="font-mono text-[11px] text-ink-vermilion hover:underline"
                  >
                    {t('railRemoveBg')}
                  </button>
                )}
              </div>

              {project.backgroundBlobKey ? (
                <div className="space-y-2">
                  <div className="aspect-video rounded-lg overflow-hidden border border-desk-border bg-black/20">
                    <BlobImage
                      blobKey={project.backgroundBlobKey}
                      alt={t('railFixedBg')}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-0.5">
                      <span className="uppercase">{t('railParallax')}</span>
                      <span>{Math.round((project.backgroundParallax ?? 0.35) * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={project.backgroundParallax ?? 0.35}
                      onChange={(e) => setBackgroundParallax(Number(e.target.value))}
                      className="studio-fader w-full"
                    />
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => bgInput.current?.click()}
                  className="w-full py-2 px-2 rounded-xl border border-dashed border-desk-border hover:border-ink-emerald text-[11px] font-semibold text-desk-muted hover:text-desk-text flex items-center justify-center gap-1.5 transition-colors text-center"
                >
                  <Upload className="w-3.5 h-3.5 shrink-0" />
                  <span>{t('railUploadBg')}</span>
                </button>
              )}
              <input
                ref={bgInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleUploadBg}
              />
            </div>
          </div>
        )}

        {/* TAB 2: PAPER, ONION SKIN & ANIMATOR GUIDES */}
        {rightRailTab === 'table' && (
          <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
            {/* Onion Skin Block with 3D Toggle Lever */}
            <div className="rounded-2xl console-well border border-desk-border p-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-widest text-desk-muted flex items-center gap-1.5">
                  <OnionLayersIcon className="w-4 h-4 text-desk-text" />
                  {t('railOnionTitle')}
                </span>
                <ToggleLeverSwitch
                  checked={onion.enabled}
                  onChange={(enabled) => updateOnion({ enabled })}
                  title={t('railOnionTitle')}
                />
              </div>

              {onion.enabled && (
                <>
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <div>
                      <div className="font-mono text-[11px] text-ink-rose mb-1">
                        {t('railOnionPrev')} ({onion.prevCount})
                      </div>
                      <div className="flex gap-1">
                        {([1, 2, 3] as const).map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => updateOnion({ prevCount: n })}
                            className={`flex-1 py-0.5 rounded font-mono text-[11px] border ${
                              onion.prevCount === n
                                ? 'bg-ink-rose/20 border-ink-rose text-desk-text font-bold'
                                : 'border-desk-border text-desk-muted'
                            }`}
                          >
                            -{n}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="font-mono text-[11px] text-ink-blue mb-1">
                        {t('railOnionNext')} ({onion.nextCount})
                      </div>
                      <div className="flex gap-1">
                        {([1, 2, 3] as const).map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={() => updateOnion({ nextCount: n })}
                            className={`flex-1 py-0.5 rounded font-mono text-[11px] border ${
                              onion.nextCount === n
                                ? 'bg-ink-blue/20 border-ink-blue text-desk-text font-bold'
                                : 'border-desk-border text-desk-muted'
                            }`}
                          >
                            +{n}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted mb-1">
                      <span className="uppercase">{t('railOnionOpacity')}</span>
                      <span>{Math.round(onion.opacity * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={0.1}
                      max={0.75}
                      step={0.05}
                      value={onion.opacity}
                      onChange={(e) => updateOnion({ opacity: Number(e.target.value) })}
                      className="studio-fader w-full"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Physical Paper Surface Picker */}
            <div className="rounded-2xl console-well border border-desk-border p-2.5 space-y-2">
              <span className="font-mono text-[11px] uppercase tracking-widest text-desk-muted">
                {t('railPaperTitle')}
              </span>
              <div className="grid grid-cols-3 gap-1">
                {PAPER_STYLES.map((ps) => {
                  const active = (project.paperStyle ?? 'bristol') === ps.id;
                  return (
                    <button
                      key={ps.id}
                      type="button"
                      onClick={() => updateProjectSettings({ paperStyle: ps.id })}
                      className={`py-1 px-1.5 rounded-lg font-mono text-[11px] border transition-colors ${
                        active
                          ? 'bg-desk-panel border-ink-brass text-desk-text font-bold'
                          : 'border-desk-border text-desk-muted hover:text-desk-text'
                      }`}
                    >
                      {t(ps.labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Field Guides Toggle */}
            <div className="flex items-center justify-between px-1">
              <span className="font-mono text-[11px] uppercase tracking-widest text-desk-muted flex items-center gap-1.5">
                <Grid className="w-3.5 h-3.5" />
                {t('railFieldGuides')}
              </span>
              <ToggleLeverSwitch
                checked={guides.enabled}
                onChange={(enabled) => updateGuides({ enabled })}
              />
            </div>

            {/* Animator's Underlay Motion Guides (Non-Exporting Blue Sheets!) */}
            <div className="rounded-2xl console-well border border-desk-border p-2.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-widest text-ink-blue">
                  {t('railGuidesTitle')}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                {UNDERLAY_GUIDES.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => updateGuides({ underlay: g.id })}
                    className={`py-1.5 px-2 rounded-lg font-mono text-[11px] border text-left transition-colors ${
                      guides.underlay === g.id
                        ? 'bg-ink-blue/20 border-ink-blue text-desk-text font-bold'
                        : 'border-desk-border text-desk-muted hover:text-desk-text'
                    }`}
                  >
                    {t(g.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: 2D CINEMATIC CAMERA, ATMOSPHERE & CHARACTER REFERENCE BOARD */}
        {rightRailTab === 'camera' && (
          <div className="flex-1 overflow-y-auto p-2.5 space-y-3">
            {/* 2D Cinematic Camera Rig & Impact Shake */}
            <div className="rounded-2xl console-well border border-desk-border p-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] uppercase tracking-widest text-ink-vermilion flex items-center gap-1.5">
                  <Film className="w-3.5 h-3.5" />
                  {t('railCamTitle')}
                </span>
                {camKeyframes.length > 0 && (
                  <button
                    type="button"
                    onClick={clearCameraKeyframes}
                    className="font-mono text-[11px] text-desk-muted hover:text-ink-vermilion"
                  >
                    {t('railCamReset')}
                  </button>
                )}
              </div>

              <div className="space-y-2">
                <div>
                  <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                    <span>
                      {t('stageFrameLabel')} #{activeFrameIndex + 1} {t('railCamZoom')}
                    </span>
                    <span>{Math.round(activeCamKf.zoom * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.85}
                    max={2.2}
                    step={0.05}
                    value={activeCamKf.zoom}
                    onChange={(e) =>
                      upsertCameraKeyframe({
                        ...activeCamKf,
                        frame: activeFrameIndex,
                        zoom: Number(e.target.value),
                      })
                    }
                    className="studio-fader w-full"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                      <span>{t('railCamPanX')}</span>
                      <span>{Math.round(activeCamKf.panX * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={-0.35}
                      max={0.35}
                      step={0.02}
                      value={activeCamKf.panX}
                      onChange={(e) =>
                        upsertCameraKeyframe({
                          ...activeCamKf,
                          frame: activeFrameIndex,
                          panX: Number(e.target.value),
                        })
                      }
                      className="studio-fader w-full"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between font-mono text-[11px] text-desk-muted">
                      <span>{t('railCamPanY')}</span>
                      <span>{Math.round(activeCamKf.panY * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min={-0.35}
                      max={0.35}
                      step={0.02}
                      value={activeCamKf.panY}
                      onChange={(e) =>
                        upsertCameraKeyframe({
                          ...activeCamKf,
                          frame: activeFrameIndex,
                          panY: Number(e.target.value),
                        })
                      }
                      className="studio-fader w-full"
                    />
                  </div>
                </div>
                <p className="text-[11px] text-desk-muted leading-snug">{t('railCamHint')}</p>
              </div>

              {/* 1-Click Impact Camera Shake on Active Frame */}
              <div className="pt-2 border-t border-desk-border flex items-center justify-between">
                <span className="font-mono text-[11px] text-desk-muted flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5 text-ink-brass" />
                  {t('railShakeTitle')}
                </span>
                <div className="flex gap-1">
                  {[0, 1, 2, 3].map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => setFrameCameraShake(activeFrameIndex, lvl)}
                      className={`w-6 h-6 rounded font-mono text-[11px] border ${
                        (frame.cameraShake ?? 0) === lvl
                          ? 'bg-ink-vermilion text-white border-ink-vermilion font-bold'
                          : 'border-desk-border text-desk-muted'
                      }`}
                    >
                      {lvl === 0 ? '—' : lvl}
                    </button>
                  ))}
                </div>
              </div>

              {/* Scene Lighting Atmosphere */}
              <div className="pt-2 border-t border-desk-border space-y-1.5">
                <span className="font-mono text-[11px] uppercase text-desk-muted">
                  {t('railAtmoTitle')}
                </span>
                <div className="grid grid-cols-2 gap-1">
                  {ATMOSPHERES.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setSceneAtmosphere(a.id)}
                      className={`py-1 px-1.5 rounded-lg font-mono text-[11px] border ${
                        (project.atmosphere ?? 'none') === a.id
                          ? 'bg-desk-panel border-ink-brass text-desk-text font-bold'
                          : 'border-desk-border text-desk-muted'
                      }`}
                    >
                      {t(a.labelKey)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Character Model Sheet & Reference Drawer */}
            <div className="space-y-2">
              <div className="font-mono text-[11px] uppercase tracking-widest text-desk-muted flex items-center gap-1.5 px-1">
                <BookOpen className="w-3.5 h-3.5 text-ink-brass" />
                {t('railRefsTitle')}
              </div>
              <KeycapButton
                size="sm"
                variant="ivory"
                onClick={() => refInput.current?.click()}
                className="w-full"
              >
                <Upload className="w-3.5 h-3.5" />
                {t('railAddRef')}
              </KeycapButton>
              <input
                ref={refInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleUploadReference}
              />

              {project.references.length > 0 && (
                <div className="space-y-2.5">
                  {project.references.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-2xl console-well border border-desk-border overflow-hidden"
                    >
                      <div className="bg-[#F7F3E9] p-1">
                        <BlobImage
                          blobKey={item.blobKey}
                          alt={item.name}
                          className="w-full max-h-40 object-contain rounded-lg"
                        />
                      </div>
                      <div className="p-2 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-desk-text truncate">
                            {item.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => deleteReference(item.id)}
                            className="text-desk-muted hover:text-ink-vermilion"
                            title={t('railRemoveBg')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {item.swatches.length > 0 && (
                          <div className="flex gap-1.5">
                            {item.swatches.map((hex) => (
                              <button
                                key={hex}
                                type="button"
                                onClick={() => {
                                  updateBrush({ color: hex });
                                  notify(`${t('stageColorPicked')}: ${hex}`, 'info');
                                }}
                                style={{ backgroundColor: hex }}
                                className="flex-1 h-5 rounded border border-desk-border hover:scale-105 transition-transform"
                                title={hex}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
