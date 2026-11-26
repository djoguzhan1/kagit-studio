/**
 * Living Kinetic Multi-Part Vector Icons crafted for KÂĞIT 3D Hardware Switches.
 * Pure GPU SVG transforms triggered continuously on hero switches (`data-sheen`)
 * and responsively on `.k3d:hover` / `.k3d:active` / `[data-pressed='true']`.
 */

export function IrisCameraIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2.2" y="6" width="19.6" height="14.2" rx="3.2" />
      <path d="M8 6L9.8 3.4h4.4L16 6" />
      {/* Tiny REC status dot on camera body */}
      <circle cx="18.3" cy="9.2" r="1.15" fill="#E54D2E" stroke="none" />
      <g className="studio-icon-iris">
        <circle cx="12" cy="13.2" r="4.5" />
        <path
          d="M12 8.7l2.2 3.7M15.9 11h-4.4M15.9 15.4l-2.2-3.7M12 17.7l-2.2-3.7M8.1 15.4h4.4M8.1 11l2.2 3.7"
          strokeWidth="1.25"
          opacity="0.88"
        />
        <circle cx="12" cy="13.2" r="1.5" fill="currentColor" fillOpacity="0.3" strokeWidth="1.2" />
      </g>
    </svg>
  );
}

export function SketchNibIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <g className="studio-icon-nib">
        <path d="M14.5 4.2l5.2 5.2-9.8 9.8-5.6 1.1 1.1-5.6 9.1-10.5z" />
        <path d="M12.5 6.4l5.1 5.1" />
      </g>
      <path d="M3.5 21.3c3.8-.8 8.2.3 13.5-.5" strokeWidth="1.9" className="studio-icon-trail" />
    </svg>
  );
}

export function OnionLayersIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="9.8" cy="12" r="5.5" stroke="#E11D48" opacity="0.6" className="studio-icon-onion-prev" />
      <circle cx="14.2" cy="12" r="5.5" stroke="#2563EB" opacity="0.6" className="studio-icon-onion-next" />
      <circle cx="12" cy="12" r="5.5" />
    </svg>
  );
}

export function FlipPageIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {/* Back paper sheet in the stack */}
      <rect x="4" y="4.5" width="13.5" height="16" rx="2" opacity="0.45" />
      {/* Front 3D flipping flipbook sheet */}
      <g className="studio-icon-flip-sheet">
        <path d="M6.5 3.5h9.5l4 4V19a1.8 1.8 0 0 1-1.8 1.8H6.5A1.8 1.8 0 0 1 4.7 19V5.3A1.8 1.8 0 0 1 6.5 3.5z" fill="currentColor" fillOpacity="0.12" />
        <path d="M15.5 3.5V8H20" className="studio-icon-page-curl" />
        <path d="M12.3 11.2v5.4M9.6 13.9h5.4" strokeWidth="2" />
      </g>
    </svg>
  );
}

export function JointBoneIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="5.2" cy="18.2" r="2.3" />
      <path d="M7.1 16.3l3.1-3.1" strokeWidth="2.2" />
      {/* Brass articulated joint hinge */}
      <circle cx="11.5" cy="11.5" r="2.4" fill="currentColor" fillOpacity="0.28" />
      <g className="studio-icon-bone-arm">
        <path d="M13.5 10l4.6-3.7" strokeWidth="2.2" />
        <circle cx="19.5" cy="5.2" r="2.2" />
      </g>
    </svg>
  );
}

export function MotionPlayIcon({ playing, className = 'w-4 h-4' }: { playing: boolean; className?: string }) {
  if (playing) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
        <rect x="6" y="5" width="4.4" height="14" rx="1.5" />
        <rect x="13.6" y="5" width="4.4" height="14" rx="1.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M7 5.2c0-.9 1-1.5 1.8-1l10.6 6.8c.7.45.7 1.55 0 2l-10.6 6.8c-.8.5-1.8-.1-1.8-1V5.2z" className="studio-icon-play-tri" />
    </svg>
  );
}

export function TrayExportIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.95" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <g className="studio-icon-export-arrow">
        <path d="M12 4v10.5" />
        <path d="M8 11l4 4 4-4" />
      </g>
      <path d="M4.5 16.5v2A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-2" />
    </svg>
  );
}
