import { useEffect, useRef } from 'react';
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
 * 8-Slice Radial Animator's Quick Wheel (`Q`, Right-Click on Stage, or Toolbar Quick Wheel button on Mobile/Desktop)
 * Fully keyboard-navigable (Arrow keys + Escape) with explicit accessible names on all 8 slices.
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
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      itemRefs.current[0]?.focus({ preventScroll: true });
    }, 16);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key.toLowerCase() === 'q') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const cur = itemRefs.current.findIndex((el) => el === document.activeElement);
        const next = (cur + 1) % 8;
        itemRefs.current[next]?.focus();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const cur = itemRefs.current.findIndex((el) => el === document.activeElement);
        const prev = (cur <= 0 ? 7 : cur - 1) % 8;
        itemRefs.current[prev]?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  const project = projects.find((p) => p.id === activeProjectId);
  const frameCount = project?.frames.length ?? 1;

  const cx = Math.max(124, Math.min(window.innerWidth - 124, x));
  const cy = Math.max(124, Math.min(window.innerHeight - 124, y));
  const R = 82;

  const actions = [
    {
      id: 'gpen',
      label: t('toolGpen'),
      active: brush.tool === 'gpen',
      icon: <SketchNibIcon className="w-4 h-4 shrink-0" />,
      run: () => updateBrush({ tool: 'gpen' }),
    },
    {
      id: 'blue-rough',
      label: t('radialBlue'),
      active: brush.tool === 'blue-rough',
      icon: <Feather className="w-4 h-4 shrink-0" />,
      run: () => updateBrush({ tool: 'blue-rough' }),
    },
    {
      id: 'bucket',
      label: t('toolBucket'),
      active: brush.tool === 'bucket',
      icon: <PaintBucket className="w-4 h-4 shrink-0" />,
      run: () => updateBrush({ tool: 'bucket' }),
    },
    {
      id: 'lasso',
      label: t('toolLasso'),
      active: brush.tool === 'lasso',
      icon: <Lasso className="w-4 h-4 shrink-0" />,
      run: () => updateBrush({ tool: 'lasso' }),
    },
    {
      id: 'eraser',
      label: t('toolEraser'),
      active: brush.tool === 'eraser',
      icon: <Eraser className="w-4 h-4 shrink-0" />,
      run: () => updateBrush({ tool: 'eraser' }),
    },
    {
      id: 'onion',
      label: t('radialOnion'),
      active: onion.enabled,
      icon: <OnionLayersIcon className="w-4 h-4 shrink-0" />,
      run: () => updateOnion({ enabled: !onion.enabled }),
    },
    {
      id: 'undo',
      label: t('undoShort'),
      active: false,
      icon: <Undo2 className="w-4 h-4 shrink-0" />,
      run: () => onUndo(),
    },
    {
      id: 'next',
      label: activeFrameIndex + 1 >= frameCount ? t('radialNewFrame') : t('railOnionNext'),
      active: false,
      icon: <ChevronRight className="w-4 h-4 shrink-0" />,
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
        className="radial-wheel-pop fixed -translate-x-1/2 -translate-y-1/2 w-[228px] h-[228px] rounded-full border border-ink-brass/55 bg-desk-surface/95 backdrop-blur-md shadow-[0_18px_52px_rgba(0,0,0,0.68)]"
        style={{ left: cx, top: cy }}
      >
        {/* Center Hub */}
        <button
          type="button"
          onClick={onClose}
          aria-label={`${t('radialClose')} (Q)`}
          title={`${t('radialClose')} (Q / Esc)`}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-14 h-14 rounded-full console-well border border-ink-brass/55 flex flex-col items-center justify-center font-mono text-[11px] font-bold text-ink-brass hover:border-ink-vermilion transition-colors cursor-pointer"
        >
          <span>Q</span>
          <span className="text-[11px] text-desk-muted truncate max-w-[48px]">{t('radialClose')}</span>
        </button>

        {/* 8 Circular Tool Nodes (48x48px >= 44px with full aria-label + title + roving focus) */}
        {actions.map((act, idx) => {
          const angle = -Math.PI / 2 + (idx / actions.length) * Math.PI * 2;
          const bx = 114 + Math.cos(angle) * R;
          const by = 114 + Math.sin(angle) * R;
          return (
            <button
              key={act.id}
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              type="button"
              role="menuitem"
              aria-label={act.label}
              title={act.label}
              onClick={() => {
                soundEngine.click(1.08);
                act.run();
                onClose();
              }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full border flex flex-col items-center justify-center gap-0.5 px-0.5 transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ink-brass cursor-pointer ${
                act.active
                  ? 'bg-ink-brass border-[#fae098] text-[#1a1407] shadow-lg'
                  : 'bg-desk-panel/95 border-desk-border text-desk-muted hover:text-desk-text hover:border-ink-brass/70'
              }`}
              style={{ left: bx, top: by }}
            >
              {act.icon}
              <span className="font-mono text-[11px] font-bold leading-none truncate max-w-[44px]">
                {act.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
