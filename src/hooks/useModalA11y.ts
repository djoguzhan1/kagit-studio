import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

export interface UseModalA11yOptions {
  open: boolean;
  onClose?: () => void;
  /** Disable Escape closing while a critical export/delete operation is running */
  closeDisabled?: boolean;
  /** True for full modal dialogs (sets background siblings inert); false for non-modal popovers/tour overlays */
  modal?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}

/**
 * W3C WAI-ARIA APG Dialog (Modal) Pattern compliance hook:
 * 1. Moves initial focus inside the dialog when opened.
 * 2. Traps Tab / Shift+Tab strictly inside focusable dialog descendants.
 * 3. Handles Escape key cleanly (capture phase, isolated from canvas/timeline shortcuts).
 * 4. Marks background siblings inert when modal=true and restores previous focus on close.
 */
export function useModalA11y<T extends HTMLElement = HTMLDivElement>({
  open,
  onClose,
  closeDisabled = false,
  modal = true,
  initialFocusRef,
}: UseModalA11yOptions): RefObject<T> {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = dialogRef.current;

    // Mark background siblings under #root (or body) inert while modal is open
    const inertAdjusted: HTMLElement[] = [];
    if (modal && container) {
      const rootEl = document.getElementById('root') ?? document.body;
      for (const child of Array.from(rootEl.children)) {
        const htmlChild = child as HTMLElement;
        if (!htmlChild.contains(container) && !htmlChild.hasAttribute('inert')) {
          htmlChild.setAttribute('inert', '');
          inertAdjusted.push(htmlChild);
        }
      }
      // Also handle portals rendered directly under document.body outside #root
      if (rootEl !== document.body && document.body.contains(container) && !rootEl.contains(container)) {
        if (!rootEl.hasAttribute('inert')) {
          rootEl.setAttribute('inert', '');
          inertAdjusted.push(rootEl);
        }
      }
    }

    // Focus initial element inside dialog
    const focusTimer = window.setTimeout(() => {
      const dlg = dialogRef.current;
      if (!dlg) return;
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus({ preventScroll: true });
        return;
      }
      if (dlg.contains(document.activeElement)) return;
      const focusables = getFocusableElements(dlg);
      if (focusables.length > 0) {
        focusables[0].focus({ preventScroll: true });
      } else {
        if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
        dlg.focus({ preventScroll: true });
      }
    }, 16);

    const handleKeyDown = (e: KeyboardEvent) => {
      const dlg = dialogRef.current;
      if (!dlg) return;

      if (e.key === 'Escape') {
        if (!closeDisabledRef.current && onCloseRef.current) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          onCloseRef.current();
        }
        return;
      }

      if (e.key === 'Tab') {
        const focusables = getFocusableElements(dlg);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (e.shiftKey) {
          if (!active || !dlg.contains(active) || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (!active || !dlg.contains(active) || active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown, true);
      for (const el of inertAdjusted) {
        el.removeAttribute('inert');
      }
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
        try {
          previouslyFocused.focus({ preventScroll: true });
        } catch {
          // ignore focus restore failure
        }
      }
    };
  }, [open, modal, initialFocusRef]);

  return dialogRef;
}
