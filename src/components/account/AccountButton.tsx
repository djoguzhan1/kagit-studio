import { Cloud, CloudOff, Loader2, User } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { soundEngine } from '../../engine/soundEngine';

export function AccountButton({ compact = false }: { compact?: boolean }) {
  const { cloudUser, cloudSyncStatus, locale, openAccountModal } = useStudioStore();
  const isEn = locale === 'en';

  const handleOpen = () => {
    soundEngine.click(1.06);
    openAccountModal();
  };

  if (!cloudUser) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className={`inline-flex items-center gap-1.5 rounded-xl border border-desk-border bg-desk-well/80 hover:border-ink-brass/70 text-desk-text transition-colors font-semibold whitespace-nowrap ${
          compact ? 'px-2 py-1.5 text-[11px]' : 'px-3 py-1.5 text-xs'
        }`}
        title={
          isEn
            ? 'Optional Cloud Vault — Sign in with Google or Email to sync across devices'
            : 'İsteğe Bağlı Bulut Kasa — Çizimlerini kaydetmek için Google veya E-posta ile giriş yap'
        }
      >
        <User className="w-3.5 h-3.5 text-ink-brass shrink-0" />
        <span className={compact ? 'hidden md:inline' : 'inline'}>
          {isEn ? 'Sign In' : 'Giriş Yap'}
        </span>
      </button>
    );
  }

  const firstName = (cloudUser.name || cloudUser.email.split('@')[0] || 'Üye').split(' ')[0].slice(0, 14);
  const initials = firstName.slice(0, 2).toUpperCase();
  const ledTone =
    cloudSyncStatus === 'synced'
      ? 'emerald'
      : cloudSyncStatus === 'syncing'
        ? 'amber'
        : cloudSyncStatus === 'offline' || cloudSyncStatus === 'error'
          ? 'vermilion'
          : 'emerald';

  return (
    <button
      type="button"
      onClick={handleOpen}
      className={`inline-flex items-center gap-2 rounded-xl border border-ink-brass/50 bg-desk-panel/90 hover:border-ink-brass text-desk-text transition-colors shadow-sm whitespace-nowrap ${
        compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-xs'
      }`}
      title={`${cloudUser.name} (${cloudUser.email}) — ${
        cloudSyncStatus === 'synced'
          ? isEn
            ? 'Cloud vault up to date'
            : 'Bulut kasası güncel'
          : cloudSyncStatus === 'syncing'
            ? isEn
              ? 'Syncing…'
              : 'Senkronize ediliyor…'
            : isEn
              ? 'Saved locally'
              : 'Yerelde güvende'
      }`}
    >
      <span
        className="hardware-led"
        data-on={ledTone}
        data-pulse={cloudSyncStatus === 'syncing' ? 'true' : undefined}
      />
      {cloudUser.avatarUrl ? (
        <img
          src={cloudUser.avatarUrl}
          alt={firstName}
          referrerPolicy="no-referrer"
          className="w-5 h-5 rounded-full object-cover border border-desk-border shrink-0"
        />
      ) : (
        <span className="w-5 h-5 rounded-full bg-ink-brass/25 border border-ink-brass/60 text-ink-brass font-mono text-[10px] font-bold inline-flex items-center justify-center shrink-0">
          {initials}
        </span>
      )}
      <span className="font-bold hidden sm:inline max-w-[92px] truncate">{firstName}</span>
      {cloudSyncStatus === 'syncing' ? (
        <Loader2 className="w-3 h-3 text-ink-brass animate-spin shrink-0" />
      ) : cloudSyncStatus === 'offline' || cloudSyncStatus === 'error' ? (
        <CloudOff className="w-3 h-3 text-ink-vermilion shrink-0" />
      ) : (
        <Cloud className="w-3 h-3 text-ink-emerald shrink-0" />
      )}
    </button>
  );
}
