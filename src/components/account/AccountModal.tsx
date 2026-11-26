import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudOff,
  FolderUp,
  Loader2,
  Lock,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { getGoogleLoginUrl, loginWithEmail, registerWithEmail } from '../../engine/cloudSync';
import { soundEngine } from '../../engine/soundEngine';
import { toBcp47Locale, useT, useTFmt } from '../../i18n/translations';
import { useModalA11y } from '../../hooks/useModalA11y';

function GoogleGLogo() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.24 1.26-.97 2.33-2.06 3.05l3.33 2.58c1.94-1.79 3.06-4.43 3.06-7.55 0-.73-.07-1.43-.19-2.1H12z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.78 0 5.12-.92 6.83-2.5l-3.33-2.58c-.92.62-2.1.99-3.5.99-2.69 0-4.97-1.82-5.79-4.26H2.77v2.67C4.47 19.7 7.97 22 12 22z"
      />
      <path
        fill="#FBBC05"
        d="M6.21 13.65A6.02 6.02 0 0 1 5.89 12c0-.57.1-1.13.32-1.65V7.68H2.77A9.98 9.98 0 0 0 2 12c0 1.61.39 3.13 1.07 4.32l3.14-2.67z"
      />
      <path
        fill="#4285F4"
        d="M12 5.98c1.51 0 2.87.52 3.94 1.54l2.95-2.95C17.11 2.9 14.78 2 12 2 7.97 2 4.47 4.3 2.77 7.68l3.44 2.67c.82-2.44 3.1-4.37 5.79-4.37z"
      />
    </svg>
  );
}

export default function AccountModal() {
  const {
    cloudUser,
    cloudSyncStatus,
    cloudLastSyncedAt,
    cloudBlobBytes,
    googleAuthEnabled,
    guestImportableCount,
    projects,
    locale,
    accountModalOpen,
    closeAccountModal,
    completeCloudSignIn,
    importGuestProjectsToAccount,
    syncCloudNow,
    signOutAccount,
    permanentlyDeleteAccount,
    notify,
  } = useStudioStore();

  const t = useT();
  const tf = useTFmt();

  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dialogRef = useModalA11y<HTMLDivElement>({
    open: accountModalOpen,
    onClose: closeAccountModal,
    closeDisabled: busy,
  });

  if (!accountModalOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || !password) {
      setError(t('acctErrEmailPass'));
      return;
    }
    if (tab === 'register' && password.length < 8) {
      setError(t('acctErrPassLen'));
      return;
    }

    setBusy(true);
    try {
      const res =
        tab === 'register'
          ? await registerWithEmail({ email: cleanEmail, password, name: name.trim() || undefined })
          : await loginWithEmail({ email: cleanEmail, password });

      await completeCloudSignIn(res.user, res.googleEnabled);
      soundEngine.clapperSnap();
      notify(
        tab === 'register'
          ? tf('acctWelcomeToast', { name: res.user.name })
          : tf('acctSignedInToast', { name: res.user.name }),
        'ok'
      );
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('acctErrActionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleSignIn = () => {
    soundEngine.click(1.08);
    if (!googleAuthEnabled) {
      setError(t('acctErrGoogleUnconfigured'));
      return;
    }
    window.location.href = getGoogleLoginUrl();
  };

  const handleManualSync = async () => {
    setBusy(true);
    setError(null);
    try {
      await syncCloudNow();
    } finally {
      setBusy(false);
    }
  };

  const handleImportGuest = async () => {
    setBusy(true);
    setError(null);
    try {
      await importGuestProjectsToAccount();
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    setBusy(true);
    try {
      await signOutAccount();
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAccount = async () => {
    setBusy(true);
    try {
      await permanentlyDeleteAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('acctErrDeleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  const usedMb = (cloudBlobBytes / (1024 * 1024)).toFixed(2);
  const lastSyncLabel = cloudLastSyncedAt
    ? new Date(cloudLastSyncedAt).toLocaleTimeString(toBcp47Locale(locale), {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

  return (
    <div
      onClick={() => !busy && closeAccountModal()}
      className="fixed inset-0 z-[85] bg-black/75 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 select-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
        aria-label={t('acctModalAria')}
        onClick={(e) => e.stopPropagation()}
        className="toast-pop-in w-full max-w-md max-h-[calc(100dvh-1.5rem)] flex flex-col rounded-3xl bg-desk-surface border border-desk-border shadow-2xl overflow-hidden"
      >
        {/* Fixed Header */}
        <div className="px-5 py-3.5 border-b border-desk-border flex items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <h2
              id="account-modal-title"
              className="text-base font-extrabold text-desk-text flex items-center gap-2"
            >
              <Cloud className="w-4 h-4 text-ink-brass shrink-0" />
              <span className="truncate">
                {cloudUser ? t('acctTitlePrivate') : t('acctTitleOptional')}
              </span>
            </h2>
            <p className="font-mono text-[11px] text-ink-emerald mt-0.5">
              ● {t('acctZeroAdsBadge')}
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={closeAccountModal}
            className="min-w-[44px] min-h-[44px] p-2 rounded-xl console-well border border-desk-border text-desk-muted hover:text-desk-text inline-flex items-center justify-center"
            aria-label={t('acctCloseAria')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body — 100% keyboard & 360x500 virtual-keyboard safe! */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 space-y-4">
          {!cloudUser ? (
            <>
              <div className="rounded-2xl console-well border border-desk-border p-3 flex items-start gap-2.5 text-xs text-desk-muted leading-relaxed">
                <ShieldCheck className="w-4 h-4 text-ink-emerald shrink-0 mt-0.5" />
                <span>{t('acctGuestGuarantee')}</span>
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={handleGoogleSignIn}
                className="w-full min-h-[44px] py-2.5 px-4 rounded-2xl bg-white hover:bg-stone-100 text-stone-900 border border-stone-300 text-xs font-extrabold flex items-center justify-center gap-2.5 shadow-sm transition-colors disabled:opacity-50"
              >
                <GoogleGLogo />
                <span>{t('acctGoogleBtn')}</span>
                {!googleAuthEnabled && (
                  <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-stone-200 text-stone-700 border border-stone-300">
                    {t('acctGooglePending')}
                  </span>
                )}
              </button>

              <div className="flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-desk-muted">
                <span className="flex-1 h-px bg-desk-border" />
                <span>{t('acctOrEmail')}</span>
                <span className="flex-1 h-px bg-desk-border" />
              </div>

              <div className="grid grid-cols-2 gap-1 p-1 rounded-xl console-well border border-desk-border">
                <button
                  type="button"
                  onClick={() => {
                    setTab('login');
                    setError(null);
                  }}
                  className={`min-h-[40px] py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    tab === 'login'
                      ? 'bg-desk-panel text-desk-text border border-desk-border shadow-sm'
                      : 'text-desk-muted hover:text-desk-text'
                  }`}
                >
                  {t('acctSignIn')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab('register');
                    setError(null);
                  }}
                  className={`min-h-[40px] py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    tab === 'register'
                      ? 'bg-desk-panel text-desk-text border border-desk-border shadow-sm'
                      : 'text-desk-muted hover:text-desk-text'
                  }`}
                >
                  {t('acctCreateFreeTab')}
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                {tab === 'register' && (
                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold text-desk-muted flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5" />
                      {t('acctDisplayName')}
                    </span>
                    <input
                      type="text"
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={t('acctNamePlaceholder')}
                      maxLength={60}
                      className="w-full min-h-[44px] px-3 py-2 rounded-xl console-well border border-desk-border text-xs text-desk-text placeholder:text-desk-muted/60 focus:outline-none focus:border-ink-brass"
                    />
                  </label>
                )}

                <label className="block space-y-1">
                  <span className="text-[11px] font-bold text-desk-muted flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" />
                    {t('acctEmailLabel')}
                  </span>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t('acctEmailPlaceholder')}
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl console-well border border-desk-border text-xs text-desk-text placeholder:text-desk-muted/60 focus:outline-none focus:border-ink-brass"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-[11px] font-bold text-desk-muted flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    {t('acctPasswordLabel')}
                  </span>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl console-well border border-desk-border text-xs text-desk-text placeholder:text-desk-muted/60 focus:outline-none focus:border-ink-brass"
                  />
                </label>

                {error && (
                  <div
                    role="alert"
                    className="rounded-xl bg-ink-vermilion/15 border border-ink-vermilion/50 px-3 py-2 text-xs text-ink-vermilion flex items-start gap-2"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full min-h-[44px] py-2.5 px-4 rounded-2xl bg-ink-vermilion hover:brightness-110 text-white text-xs font-extrabold flex items-center justify-center gap-2 shadow-md transition-all disabled:opacity-50"
                >
                  {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>
                    {tab === 'register' ? t('acctCreateSubmit') : t('acctSignInSubmit')}
                  </span>
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="rounded-2xl console-well border border-desk-border p-3.5 flex items-center gap-3">
                {cloudUser.avatarUrl ? (
                  <img
                    src={cloudUser.avatarUrl}
                    alt={cloudUser.name}
                    referrerPolicy="no-referrer"
                    className="w-11 h-11 rounded-full object-cover border border-ink-brass/60 shrink-0"
                  />
                ) : (
                  <div className="w-11 h-11 rounded-full bg-ink-brass/20 border border-ink-brass/60 text-ink-brass font-mono text-sm font-extrabold flex items-center justify-center shrink-0">
                    {(cloudUser.name || cloudUser.email).slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-extrabold text-desk-text truncate">
                    {cloudUser.name}
                  </div>
                  <div className="font-mono text-[11px] text-desk-muted truncate">
                    {cloudUser.email}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px]">
                    {cloudSyncStatus === 'synced' ? (
                      <span className="text-ink-emerald inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {tf('acctSyncedAt', { time: lastSyncLabel })}
                      </span>
                    ) : cloudSyncStatus === 'syncing' ? (
                      <span className="text-ink-brass inline-flex items-center gap-1">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {t('acctStatusSyncing')}
                      </span>
                    ) : (
                      <span className="text-ink-vermilion inline-flex items-center gap-1">
                        <CloudOff className="w-3.5 h-3.5" />
                        {t('acctOfflineLocal')}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-2xl console-well border border-desk-border p-3">
                  <div className="font-mono text-[11px] uppercase text-desk-muted">
                    {t('acctNotebooksLabel')}
                  </div>
                  <div className="text-lg font-extrabold text-desk-text mt-0.5">
                    {projects.length}
                  </div>
                </div>
                <div className="rounded-2xl console-well border border-desk-border p-3">
                  <div className="font-mono text-[11px] uppercase text-desk-muted">
                    {t('acctStorageLabel')}
                  </div>
                  <div className="text-lg font-extrabold text-desk-text mt-0.5">{usedMb} MB</div>
                </div>
              </div>

              {guestImportableCount > 0 && (
                <div className="rounded-2xl bg-ink-brass/15 border border-ink-brass/55 p-3 space-y-2">
                  <p className="text-xs text-desk-text font-semibold leading-snug">
                    {tf('acctGuestFound', { count: guestImportableCount })}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleImportGuest}
                    className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-ink-brass text-neutral-950 text-xs font-extrabold inline-flex items-center justify-center gap-2 hover:brightness-105 disabled:opacity-50"
                  >
                    <FolderUp className="w-3.5 h-3.5" />
                    <span>{tf('acctImportGuestBtn', { count: guestImportableCount })}</span>
                  </button>
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="rounded-xl bg-ink-vermilion/15 border border-ink-vermilion/50 px-3 py-2 text-xs text-ink-vermilion flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleManualSync}
                  className="w-full min-h-[44px] py-2 px-3 rounded-xl console-well border border-desk-border hover:border-ink-brass text-xs font-bold text-desk-text flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-ink-brass ${busy ? 'animate-spin' : ''}`} />
                  <span>{t('acctSyncNowBtn')}</span>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSignOut}
                  className="w-full min-h-[44px] py-2 px-3 rounded-xl console-well border border-desk-border hover:border-desk-muted text-xs font-semibold text-desk-muted hover:text-desk-text flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>{t('acctSignOutBtn')}</span>
                </button>
              </div>

              <div className="pt-2 border-t border-desk-border">
                {!confirmDelete ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                    className="w-full min-h-[40px] py-1.5 text-[11px] font-mono text-desk-muted hover:text-ink-vermilion inline-flex items-center justify-center gap-1.5 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{t('acctDeleteBtn')}</span>
                  </button>
                ) : (
                  <div className="rounded-xl bg-ink-vermilion/10 border border-ink-vermilion/50 p-3 space-y-2">
                    <p className="text-[11px] text-desk-text font-semibold">
                      {t('acctDeleteWarn')}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleDeleteAccount}
                        className="flex-1 min-h-[44px] py-1.5 rounded-lg bg-ink-vermilion text-white text-xs font-extrabold hover:brightness-110"
                      >
                        {t('acctDeleteConfirm')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDelete(false)}
                        className="flex-1 min-h-[44px] py-1.5 rounded-lg console-well border border-desk-border text-xs font-semibold text-desk-muted"
                      >
                        {t('acctDeleteCancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
