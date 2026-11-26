/**
 * Safely captures pointer events without throwing NotFoundError / InvalidStateError
 * on synthetic, interrupted, or multi-touch pointer sequences across mobile & desktop browsers.
 */
export function safeSetPointerCapture(target: Element | null | undefined, pointerId: number): void {
  if (!target || typeof target.setPointerCapture !== 'function') return;
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Ignore NotFoundError / InvalidStateError on synthetic or already-released pointers
  }
}

export function safeReleasePointerCapture(target: Element | null | undefined, pointerId: number): void {
  if (!target || typeof target.releasePointerCapture !== 'function') return;
  try {
    if (typeof target.hasPointerCapture !== 'function' || target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore release errors
  }
}
