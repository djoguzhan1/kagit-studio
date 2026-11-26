import { useEffect } from 'react';
import {
  ChevronRight,
  Eraser,
  Feather,
  Lasso,
  PaintBucket,
  Undo2,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { OnionLayersIcon, SketchNibIcon } from '../ui/AnimatedStudioIcons';
import { soundEngine } from '../../engine/soundEngine';
import { useT } from '../../i18n/translations';

interface RadialQuickWheelProps {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  onUndo: () => void;
}

/**
 * 8-Slice Radial Animator's Quick Wheel (Press `Q` or Right-Click on Drawing Stage)
 * Lets animators switch tools, toggle onion skin, undo, or step frame without looking away from paper!
 */
export function RadialQuickWheel({ open, x, y, onClose, onUndo }: RadialQuickWheelProps) {
  const {
    projects,
    activeProjectId,
    activeFrameIndex,
    brush,
    onion,
    updateBrush,
    updateOnion,
    selectFrame,
    addFrameAfterCurrent,
  } = useStudioStore();
  const t = useT();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key.toLowerCase() === 'q') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const project = projects.find((p) => p.id === activeProjectId);
  const frameCount = project?.frames.length ?? 1;

  // Clamp center position cleanly inside the viewport so none of the 8 slices ever clip!
  const cx = Math.max(128, Math.min(window.innerWidth - 128, x));
  const cy = Math.max(128, Math.min(window.innerHeight - 128, y));
  const R = 82;

  const actions = [
    {
      id: 'gpen',
      label: t('toolGpen'),
      active: brush.tool === 'gpen',
      accent: 'amber',
      icon: <SketchNibIcon className="w-4 h-4" />,
      run: () => updateBrush({ tool: 'gpen' }),
    },
    {
      id: 'blue-rough',
      label: t('radialBlue'),
      active: brush.tool === 'blue-rough',
      accent: 'blue',
      icon: <Feather className="w-4 h-4" />,
      run: () => updateBrush({ tool: 'blue-rough' }),
    },
    {
      id: 'bucket',
      label: t('toolBucket'),
      active: brush.tool === 'bucket',
      accent: 'amber',
      icon: <PaintBucket className="w-4 h-4" />,
      run: () => updateBrush({ tool: 'bucket' }),
    },
    {
      id: 'lasso',
      label: t('toolLasso'),
      active: brush.tool === 'lasso',
      accent: 'vermilion',
      icon: <Lasso className="w-4 h-4" />,
      run: () => updateBrush({ tool: 'lasso' }),
    },
    {
      id: 'eraser',
      label: t('toolEraser'),
      active: brush.tool === 'eraser',
      accent: 'vermilion',
      icon: <Eraser className="w-4 h-4" />,
      run: () => updateBrush({ tool: 'eraser' }),
    },
    {
      id: 'onion',
      label: t('radialOnion'),
      active: onion.enabled,
      accent: 'emerald',
      icon: <OnionLayersIcon className="w-4 h-4" />,
      run: () => updateOnion({ enabled: !onion.enabled }),
    },
    {
      id: 'undo',
      label: t('undoShort'),
      active: false,
      accent: 'amber',
      icon: <Undo2 className="w-4 h-4" />,
      run: () => onUndo(),
    },
    {
      id: 'next',
      label: activeFrameIndex + 1 >= frameCount ? t('radialNewFrame') : t('railOnionNext'),
      active: false,
      accent: 'brass',
      icon: <ChevronRight className="w-4 h-4" />,
      run: () => {
        soundEngine.paperFlip();
        if (activeFrameIndex + 1 >= frameCount) {
          void addFrameAfterCurrent(false);
        } else {
          selectFrame(activeFrameIndex + 1);
        }
      },
    },
  ];

  return (
    <div
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 z-50"
    >
      <div
        role="menu"
        aria-label={t('radialTitle')}
        onClick={(e) => e.stopPropagation()}
        className="radial-wheel-pop fixed w-[228px] h-[228px] rounded-full border border-ink-brass/55 bg-desk-surface/95 backdrop-blur-md shadow-[0_18px_52px_rgba(0,0,0,0.68)]"
        style={{ left: cx, top: cy }}
      >
        {/* Center Hub */}
        <button
          type="button"
          onClick={onClose}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-14 h-14 rounded-full console-well border border-ink-brass/55 flex flex-col items-center justify-center font-mono text-[9px] font-bold text-ink-brass hover:border-ink-vermilion transition-colors cursor-pointer"
          title={`${t('radialClose')} (Q / Esc)`}
        >
          <span>Q</span>
          <span className="text-[8px] text-desk-muted">{t('radialClose')}</span>
        </button>

        {/* 8 Circular Tool Nodes */}
        {actions.map((act, idx) => {
          const angle = -Math.PI / 2 + (idx / actions.length) * Math.PI * 2;
          const bx = 114 + Math.cos(angle) * R;
          const by = 114 + Math.sin(angle) * R;
          return (
            <button
              key={act.id}
              type="button"
              role="menuitem"
              onClick={() => {
                soundEngine.click(1.08);
                act.run();
                onClose();
              }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border flex flex-col items-center justify-center gap-0.5 transition-transform hover:scale-110 cursor-pointer ${
                act.active
                  ? 'bg-ink-brass border-[#fae098] text-[#1a1407] shadow-lg'
                  : 'bg-desk-panel/95 border-desk-border text-desk-muted hover:text-desk-text hover:border-ink-brass/70'
              }`}
              style={{ left: bx, top: by }}
            >
              {act.icon}
              <span className="font-mono text-[8px] font-bold leading-none">{act.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
