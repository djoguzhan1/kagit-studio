import { useEffect, useState } from 'react';
import { Cloud, CloudOff, Loader2, User } from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { soundEngine } from '../../engine/soundEngine';
import { toBcp47Locale, useT } from '../../i18n/translations';

export function AccountButton({ compact = false }: { compact?: boolean }) {
  const { cloudUser, cloudSyncStatus, locale, openAccountModal } = useStudioStore();
  const [imgFailed, setImgFailed] = useState(false);
  const t = useT();

  useEffect(() => {
    setImgFailed(false);
  }, [cloudUser?.avatarUrl]);

  const handleOpen = () => {
    soundEngine.click(1.06);
    openAccountModal();
  };

  if (!cloudUser) {
    return (
      <button
        type="button"
        onClick={handleOpen}
        className={`min-w-[44px] min-h-[44px] rounded-xl console-well border border-desk-border hover:border-ink-brass/75 text-desk-muted hover:text-desk-text inline-flex items-center justify-center gap-1.5 font-semibold transition-colors ${
          compact ? 'px-2.5 text-xs' : 'px-2.5 sm:px-3 text-xs'
        }`}
        title={t('acctVaultBtnTitle')}
        aria-label={t('acctSignIn')}
      >
        <User className="w-4 h-4 text-ink-brass shrink-0" />
        <span className={compact ? 'hidden xl:inline' : 'hidden lg:inline'}>
          {t('acctSignIn')}
        </span>
      </button>
    );
  }

  const firstName = (
    cloudUser.name ||
    cloudUser.email.split('@')[0] ||
    t('acctDefaultMember')
  )
    .split(' ')[0]
    .slice(0, 14);
  const initials = firstName.slice(0, 2).toLocaleUpperCase(toBcp47Locale(locale));
  const ledTone =
    cloudSyncStatus === 'synced'
      ? 'emerald'
      : cloudSyncStatus === 'syncing'
        ? 'amber'
        : cloudSyncStatus === 'error'
          ? 'vermilion'
          : undefined;

  const statusText =
    cloudSyncStatus === 'synced'
      ? t('acctStatusSynced')
      : cloudSyncStatus === 'syncing'
        ? t('acctStatusSyncing')
        : t('acctStatusLocal');

  return (
    <button
      type="button"
      onClick={handleOpen}
      className={`min-w-[44px] min-h-[44px] rounded-xl bg-desk-panel/90 border border-ink-brass/55 hover:border-ink-brass text-desk-text inline-flex items-center justify-center gap-1.5 font-bold transition-colors shadow-sm ${
        compact ? 'px-2 text-xs' : 'px-2.5 text-xs'
      }`}
      title={`${cloudUser.email} — ${statusText}`}
      aria-label={`${firstName} — ${statusText}`}
    >
      <span
        className="hardware-led"
        data-on={ledTone}
        data-pulse={cloudSyncStatus === 'syncing' ? 'true' : undefined}
      />
      {cloudUser.avatarUrl && !imgFailed ? (
        <img
          src={cloudUser.avatarUrl}
          alt={firstName}
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          className="w-5 h-5 rounded-full object-cover border border-desk-border shrink-0"
        />
      ) : (
        <span className="w-5 h-5 rounded-full bg-ink-brass/20 border border-ink-brass/60 text-ink-brass font-mono text-[11px] font-bold inline-flex items-center justify-center shrink-0">
          {initials}
        </span>
      )}
      <span className={`${compact ? 'hidden xl:inline' : 'hidden lg:inline'} truncate max-w-[96px]`}>
        {firstName}
      </span>
      {cloudSyncStatus === 'syncing' ? (
        <Loader2 className="w-3.5 h-3.5 text-ink-brass animate-spin shrink-0" />
      ) : cloudSyncStatus === 'error' ? (
        <CloudOff className="w-3.5 h-3.5 text-ink-vermilion shrink-0" />
      ) : (
        <Cloud className="w-3.5 h-3.5 text-ink-emerald shrink-0 hidden sm:inline" />
      )}
    </button>
  );
}
