import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  Cloud,
  CloudOff,
  FolderInput,
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
import {
  getGoogleLoginUrl,
  loginWithEmail,
  registerWithEmail,
} from '../../engine/cloudSync';
import { soundEngine } from '../../engine/soundEngine';

function GoogleGIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.87c2.26-2.08 3.57-5.15 3.57-8.64z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3c-1.07.72-2.44 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.1A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.29a12 12 0 0 0 0 10.78l4-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.76c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.94 1.19 15.24 0 12 0A12 12 0 0 0 1.29 6.61l4 3.1c.94-2.84 3.59-4.95 6.71-4.95z"
      />
    </svg>
  );
}

export default function AccountModal() {
  const {
    accountModalOpen,
    closeAccountModal,
    cloudUser,
    googleAuthEnabled,
    cloudSyncStatus,
    cloudLastSyncedAt,
    cloudBlobBytes,
    projects,
    guestImportableCount,
    locale,
    completeCloudSignIn,
    syncCloudNow,
    importGuestProjectsToAccount,
    signOutAccount,
    permanentlyDeleteAccount,
    notify,
  } = useStudioStore();

  const isEn = locale === 'en';
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!accountModalOpen) return;
    setError(null);
    setConfirmDelete(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAccountModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accountModalOpen, closeAccountModal]);

  if (!accountModalOpen) return null;

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      setError(isEn ? 'Please enter email and password.' : 'Lütfen e-posta ve şifreni gir.');
      return;
    }
    if (tab === 'register' && password.length < 8) {
      setError(isEn ? 'Password must be at least 8 characters.' : 'Şifre en az 8 karakter olmalı.');
      return;
    }

    setBusy(true);
    try {
      const res =
        tab === 'register'
          ? await registerWithEmail({ email: cleanEmail, password, name: name.trim() || undefined })
          : await loginWithEmail({ email: cleanEmail, password });
      soundEngine.click(1.12);
      setPassword('');
      await completeCloudSignIn(res.user, res.googleEnabled);
      notify(
        tab === 'register'
          ? isEn
            ? `Welcome ${res.user.name}! Your private cloud vault is ready.`
            : `Hoş geldin ${res.user.name}! Özel bulut kasan oluşturuldu.`
          : isEn
            ? `Signed in as ${res.user.name}`
            : `Giriş yapıldı: ${res.user.name}`,
        'ok'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : isEn ? 'Action failed.' : 'İşlem başarısız oldu.');
    } finally {
      setBusy(false);
    }
  };

  const handleGoogleClick = () => {
    soundEngine.click(1.08);
    if (!googleAuthEnabled) {
      setError(
        isEn
          ? 'Google Sign-In keys are not connected yet — sign up with Email & Password below in 5 seconds.'
          : 'Google giriş anahtarı henüz bağlanmadı — aşağıdaki E-posta & Şifre ile 5 saniyede hemen üye olabilirsin.'
      );
      return;
    }
    window.location.href = getGoogleLoginUrl();
  };

  const handleSync = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await syncCloudNow(false);
    } finally {
      setBusy(false);
    }
  };

  const handleImportGuest = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await importGuestProjectsToAccount();
    } finally {
      setBusy(false);
    }
  };

  const handleSignOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await signOutAccount();
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await permanentlyDeleteAccount();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hesap silinemedi.');
    } finally {
      setBusy(false);
    }
  };

  const usedMb = (cloudBlobBytes / (1024 * 1024)).toFixed(2);
  const lastSyncLabel = cloudLastSyncedAt
    ? new Date(cloudLastSyncedAt).toLocaleTimeString(isEn ? 'en-US' : 'tr-TR', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

  return (
    <div
      onClick={closeAccountModal}
      className="fixed inset-0 z-[85] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 select-none"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEn ? 'INKTROPE Cloud Account' : 'INKTROPE Bulut Hesabı'}
        onClick={(e) => e.stopPropagation()}
        className="toast-pop-in w-full max-w-md rounded-3xl bg-desk-surface border border-desk-border shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-desk-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-extrabold text-desk-text flex items-center gap-2">
              <Cloud className="w-4 h-4 text-ink-brass shrink-0" />
              <span className="truncate">
                {cloudUser
                  ? isEn
                    ? 'Private Cloud Vault'
                    : 'Özel Bulut Kasan'
                  : isEn
                    ? 'Optional Cloud Backup'
                    : 'İsteğe Bağlı Bulut Yedekleme'}
              </span>
            </h2>
            <p className="font-mono text-[10px] text-ink-emerald mt-0.5">
              ●{' '}
              {isEn
                ? '100% private per-account vault · Zero ads'
                : 'Her hesap %100 izole · Kimse çizimlerini göremez'}
            </p>
          </div>
          <button
            type="button"
            onClick={closeAccountModal}
            className="p-2 rounded-xl console-well border border-desk-border text-desk-muted hover:text-desk-text"
            aria-label={isEn ? 'Close' : 'Kapat'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!cloudUser ? (
            <>
              {/* Reassuring Optional Guest Guarantee */}
              <div className="rounded-2xl console-well border border-desk-border p-3 flex items-start gap-2.5 text-xs text-desk-muted leading-relaxed">
                <ShieldCheck className="w-4 h-4 text-ink-emerald shrink-0 mt-0.5" />
                <span>
                  {isEn
                    ? 'Signing in is completely optional. Create a free vault to back up your flipbooks, puppets & films safely across phone and desktop — strictly private to your account.'
                    : 'Üyelik zorunlu değildir. Çizimlerini kaybetmemek ve telefon/bilgisayardan erişmek istersen ücretsiz bulut kasanı açabilirsin — tüm dosyaların yalnızca sana özeldir.'}
                </span>
              </div>

              {/* Google OAuth Button */}
              <button
                type="button"
                onClick={handleGoogleClick}
                disabled={busy}
                className={`w-full py-2.5 px-4 rounded-xl border font-bold text-xs inline-flex items-center justify-center gap-2.5 transition-all shadow-sm ${
                  googleAuthEnabled
                    ? 'bg-white text-[#1F1F1F] border-white/80 hover:bg-[#F5F5F5]'
                    : 'console-well text-desk-muted border-desk-border hover:border-ink-brass/50'
                }`}
              >
                <GoogleGIcon />
                <span>
                  {isEn ? 'Continue with Google' : 'Google ile Devam Et'}
                </span>
                {!googleAuthEnabled && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-desk-panel text-ink-brass border border-desk-border">
                    {isEn ? 'Pending key' : 'Kurulum bekliyor'}
                  </span>
                )}
              </button>

              <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider text-desk-muted">
                <span className="flex-1 h-px bg-desk-border" />
                <span>{isEn ? 'or with email' : 'veya e-posta ile'}</span>
                <span className="flex-1 h-px bg-desk-border" />
              </div>

              {/* Login / Register Mode Switch */}
              <div className="grid grid-cols-2 gap-1 p-1 rounded-xl console-well border border-desk-border">
                <button
                  type="button"
                  onClick={() => {
                    setTab('login');
                    setError(null);
                  }}
                  className={`py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    tab === 'login'
                      ? 'bg-desk-panel text-desk-text border border-ink-brass/60 shadow-sm'
                      : 'text-desk-muted hover:text-desk-text border border-transparent'
                  }`}
                >
                  {isEn ? 'Sign In' : 'Giriş Yap'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTab('register');
                    setError(null);
                  }}
                  className={`py-1.5 rounded-lg text-xs font-bold transition-colors ${
                    tab === 'register'
                      ? 'bg-desk-panel text-desk-text border border-ink-brass/60 shadow-sm'
                      : 'text-desk-muted hover:text-desk-text border border-transparent'
                  }`}
                >
                  {isEn ? 'Create Free Account' : 'Ücretsiz Üye Ol'}
                </button>
              </div>

              <form onSubmit={handleEmailSubmit} className="space-y-3 select-text">
                {tab === 'register' && (
                  <label className="block space-y-1">
                    <span className="text-[11px] font-bold text-desk-muted flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5" />
                      {isEn ? 'Display Name' : 'Adın / Sanatçı Adın'}
                    </span>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder={isEn ? 'e.g. Alex' : 'ör. Oğuzhan'}
                      maxLength={60}
                      className="w-full px-3 py-2 rounded-xl console-well border border-desk-border text-xs text-desk-text placeholder:text-desk-muted/60 focus:outline-none focus:border-ink-brass"
                    />
                  </label>
                )}

                <label className="block space-y-1">
                  <span className="text-[11px] font-bold text-desk-muted flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5" />
                    {isEn ? 'Email' : 'E-posta'}
                  </span>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="sen@ornek.com"
                    className="w-full px-3 py-2 rounded-xl console-well border border-desk-border text-xs text-desk-text placeholder:text-desk-muted/60 focus:outline-none focus:border-ink-brass"
                  />
                </label>

                <label className="block space-y-1">
                  <span className="text-[11px] font-bold text-desk-muted flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    {isEn ? 'Password (min 8 chars)' : 'Şifre (en az 8 karakter)'}
                  </span>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 rounded-xl console-well border border-desk-border text-xs text-desk-text placeholder:text-desk-muted/60 focus:outline-none focus:border-ink-brass"
                  />
                </label>

                {error && (
                  <div className="rounded-xl bg-ink-vermilion/15 border border-ink-vermilion/50 px-3 py-2 text-xs text-ink-vermilion font-semibold">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="w-full py-2.5 px-4 rounded-xl bg-ink-vermilion hover:brightness-110 disabled:opacity-60 text-white font-extrabold text-xs inline-flex items-center justify-center gap-2 shadow-lg transition-all"
                >
                  {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  <span>
                    {tab === 'register'
                      ? isEn
                        ? 'Create My Cloud Vault'
                        : 'Ücretsiz Hesap Oluştur'
                      : isEn
                        ? 'Sign In to Vault'
                        : 'Hesabıma Giriş Yap'}
                  </span>
                </button>
              </form>
            </>
          ) : (
            <>
              {/* Signed-In User Card */}
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
                    {(cloudUser.name || 'U').slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-extrabold text-desk-text truncate">{cloudUser.name}</div>
                  <div className="font-mono text-[11px] text-desk-muted truncate">{cloudUser.email}</div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] font-mono">
                    {cloudSyncStatus === 'synced' ? (
                      <span className="text-ink-emerald inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" />
                        {isEn ? `Synced · ${lastSyncLabel}` : `Bulutta Güncel · ${lastSyncLabel}`}
                      </span>
                    ) : cloudSyncStatus === 'syncing' ? (
                      <span className="text-ink-brass inline-flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {isEn ? 'Syncing…' : 'Senkronize ediliyor…'}
                      </span>
                    ) : (
                      <span className="text-ink-vermilion inline-flex items-center gap-1">
                        <CloudOff className="w-3 h-3" />
                        {isEn ? 'Offline — saved locally' : 'Çevrimdışı — yerelde güvende'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Vault Stats */}
              <div className="grid grid-cols-2 gap-2.5 text-xs">
                <div className="rounded-xl console-well border border-desk-border p-3">
                  <div className="font-mono text-[10px] uppercase text-desk-muted">
                    {isEn ? 'Cloud Notebooks' : 'Bulut Defterlerin'}
                  </div>
                  <div className="text-lg font-extrabold text-desk-text mt-0.5">{projects.length}</div>
                </div>
                <div className="rounded-xl console-well border border-desk-border p-3">
                  <div className="font-mono text-[10px] uppercase text-desk-muted">
                    {isEn ? 'Vault Storage' : 'Bulut Kullanımı'}
                  </div>
                  <div className="text-lg font-extrabold text-desk-text mt-0.5">{usedMb} MB</div>
                </div>
              </div>

              {/* Optional 1-Click Migration of Guest Notebooks */}
              {guestImportableCount > 0 && (
                <div className="rounded-2xl bg-ink-brass/12 border border-ink-brass/50 p-3 space-y-2">
                  <p className="text-xs text-desk-text font-semibold leading-snug">
                    {isEn
                      ? `Found ${guestImportableCount} local guest notebook(s) on this device.`
                      : `Bu cihazda misafir olarak çizdiğin ${guestImportableCount} defter bulundu.`}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleImportGuest}
                    className="w-full py-2 px-3 rounded-xl bg-ink-brass text-[#151412] font-extrabold text-xs inline-flex items-center justify-center gap-2 hover:brightness-110 transition-all"
                  >
                    <FolderInput className="w-3.5 h-3.5" />
                    <span>
                      {isEn
                        ? `Import ${guestImportableCount} Notebook(s) to Cloud`
                        : `${guestImportableCount} Defteri Özel Bulutuma Aktar`}
                    </span>
                  </button>
                </div>
              )}

              {error && (
                <div className="rounded-xl bg-ink-vermilion/15 border border-ink-vermilion/50 px-3 py-2 text-xs text-ink-vermilion font-semibold">
                  {error}
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSync}
                  className="w-full py-2.5 px-4 rounded-xl bg-desk-panel hover:border-ink-brass border border-desk-border text-desk-text font-bold text-xs inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-ink-brass ${busy ? 'animate-spin' : ''}`} />
                  <span>{isEn ? 'Sync Now Across Devices' : 'Cihazlar Arası Şimdi Senkronize Et'}</span>
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={handleSignOut}
                  className="w-full py-2.5 px-4 rounded-xl console-well hover:border-desk-muted border border-desk-border text-desk-text font-bold text-xs inline-flex items-center justify-center gap-2 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5 text-desk-muted" />
                  <span>
                    {isEn
                      ? 'Sign Out (Clear Copy From This Device)'
                      : 'Çıkış Yap (Bu Cihazdaki Kopyayı Temizle)'}
                  </span>
                </button>
              </div>

              {/* KVKK/GDPR Permanent Account Erasure */}
              <div className="pt-2 border-t border-desk-border">
                {!confirmDelete ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="text-[11px] font-semibold text-desk-muted hover:text-ink-vermilion inline-flex items-center gap-1.5 transition-colors"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>
                      {isEn ? 'Permanently delete account & cloud data' : 'Hesabı ve tüm bulut verilerini kalıcı sil'}
                    </span>
                  </button>
                ) : (
                  <div className="rounded-xl bg-ink-vermilion/10 border border-ink-vermilion/50 p-3 space-y-2">
                    <p className="text-[11px] text-desk-text font-semibold">
                      {isEn
                        ? 'This permanently erases your account and all cloud notebooks. This cannot be undone.'
                        : 'Bu işlem hesabını ve buluttaki tüm defterlerini kalıcı olarak siler. Geri alınamaz.'}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={handleDeleteAccount}
                        className="px-3 py-1.5 rounded-lg bg-ink-vermilion text-white text-xs font-extrabold"
                      >
                        {isEn ? 'Yes, Delete Forever' : 'Evet, Kalıcı Sil'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(false)}
                        className="px-3 py-1.5 rounded-lg console-well border border-desk-border text-xs font-bold text-desk-muted"
                      >
                        {isEn ? 'Cancel' : 'Vazgeç'}
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
