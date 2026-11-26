import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Cpu,
  FileText,
  HardDrive,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useStudioStore } from '../../store/useStudioStore';
import { useT } from '../../i18n/translations';
import { useModalA11y } from '../../hooks/useModalA11y';
import {
  clearAllLocalStudioData,
  getStorageUsageEstimate,
} from '../../engine/db';
import {
  getLiveDeviceProfile,
  type PerformancePref,
} from '../../engine/deviceTierEngine';
import { soundEngine } from '../../engine/soundEngine';

export default function LegalPolicyModal() {
  const t = useT();
  const {
    legalOpen,
    legalTab,
    openLegal,
    closeLegal,
    performancePref,
    setPerformancePref,
    projects,
  } = useStudioStore();

  const [storage, setStorage] = useState<{
    usedMb: number;
    quotaMb: number | null;
    persisted: boolean;
  }>({ usedMb: 0, quotaMb: null, persisted: false });
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const dialogRef = useModalA11y<HTMLDivElement>({
    open: legalOpen,
    onClose: closeLegal,
    closeDisabled: clearing,
    modal: true,
  });

  useEffect(() => {
    if (!legalOpen) return;
    setConfirmClear(false);
    void getStorageUsageEstimate().then(setStorage);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLegal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [legalOpen, closeLegal]);

  if (!legalOpen) return null;

  const liveProfile = getLiveDeviceProfile(performancePref);
  const activeTierLabel =
    liveProfile.tier === 2
      ? t('perfTier2Name')
      : liveProfile.tier === 1
        ? t('perfTier1Name')
        : t('perfTier0Name');

  const handleClearAllData = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await clearAllLocalStudioData();
      window.location.reload();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div
      onClick={closeLegal}
      className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 select-none"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="toast-pop-in w-full max-w-2xl max-h-[calc(100dvh-1.5rem)] flex flex-col rounded-3xl bg-desk-surface border border-desk-border shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-desk-border flex items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <h2 id="legal-modal-title" className="text-base font-extrabold text-desk-text flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-ink-emerald shrink-0" />
              <span className="truncate">{t('legalModalTitle')}</span>
            </h2>
            <p className="font-mono text-[11px] text-ink-emerald mt-0.5">
              ● {t('legalZeroCloudBadge')}
            </p>
          </div>
          <button
            type="button"
            onClick={closeLegal}
            className="min-w-[44px] min-h-[44px] p-2 rounded-xl inline-flex items-center justify-center console-well border border-desk-border text-desk-muted hover:text-desk-text"
            aria-label={t('exportCloseAria')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 4 Clean Tabs */}
        <div className="px-5 pt-3 pb-2 border-b border-desk-border flex items-center gap-1.5 overflow-x-auto shrink-0">
          {(
            [
              { id: 'privacy', label: t('legalTabPrivacy'), Icon: ShieldCheck },
              { id: 'terms', label: t('legalTabTerms'), Icon: FileText },
              { id: 'storage', label: t('legalTabStorage'), Icon: HardDrive },
              { id: 'perf', label: t('legalTabPerf'), Icon: Cpu },
            ] as const
          ).map(({ id, label, Icon }) => {
            const active = legalTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  soundEngine.click(1.04);
                  openLegal(id);
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 border whitespace-nowrap transition-colors ${
                  active
                    ? 'bg-desk-panel border-ink-brass text-desk-text shadow-sm'
                    : 'console-well border-desk-border text-desk-muted hover:text-desk-text'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            );
          })}
        </div>

        {/* Scrollable Body */}
        <div className="p-5 overflow-y-auto space-y-3.5 text-xs text-desk-muted leading-relaxed select-text">
          {legalTab === 'privacy' && (
            <>
              <p className="text-desk-text font-medium">{t('legalPrivacyIntro')}</p>
              <div className="space-y-2.5">
                {[
                  [t('legalPrivacyPoint1Title'), t('legalPrivacyPoint1Body')],
                  [t('legalPrivacyPoint2Title'), t('legalPrivacyPoint2Body')],
                  [t('legalPrivacyPoint3Title'), t('legalPrivacyPoint3Body')],
                  [t('legalPrivacyPoint4Title'), t('legalPrivacyPoint4Body')],
                ].map(([heading, body]) => (
                  <div
                    key={heading}
                    className="rounded-2xl console-well border border-desk-border p-3.5 space-y-1"
                  >
                    <div className="font-bold text-desk-text">{heading}</div>
                    <p>{body}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          {legalTab === 'terms' && (
            <div className="space-y-2.5">
              {[
                [t('legalTermsTitle1'), t('legalTermsBody1')],
                [t('legalTermsTitle2'), t('legalTermsBody2')],
                [t('legalTermsTitle3'), t('legalTermsBody3')],
                [t('legalTermsTitle4'), t('legalTermsBody4')],
              ].map(([heading, body]) => (
                <div
                  key={heading}
                  className="rounded-2xl console-well border border-desk-border p-3.5 space-y-1"
                >
                  <div className="font-bold text-desk-text">{heading}</div>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          )}

          {legalTab === 'storage' && (
            <>
              <div className="rounded-2xl console-well border border-desk-border p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-desk-text">{t('legalStorageUsageLabel')}</span>
                  <span className="font-mono text-xs font-bold text-ink-brass">
                    {storage.usedMb} MB {storage.quotaMb ? `/ ${storage.quotaMb} MB` : ''} ·{' '}
                    {projects.length} {t('notebookTag').toLowerCase()}
                  </span>
                </div>
                <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-ink-emerald">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {storage.persisted ? t('legalStoragePersisted') : t('legalStorageStandard')}
                </div>
                <p className="text-[11px] text-desk-muted">{t('legalStorageSafariTip')}</p>
              </div>

              <div className="rounded-2xl bg-ink-vermilion/10 border border-ink-vermilion/40 p-4 space-y-2.5">
                <div className="font-bold text-desk-text flex items-center gap-1.5">
                  <Trash2 className="w-4 h-4 text-ink-vermilion" />
                  {t('legalClearAllTitle')}
                </div>
                <p className="text-[11.5px]">{t('legalClearAllDesc')}</p>

                {!confirmClear ? (
                  <button
                    type="button"
                    onClick={() => setConfirmClear(true)}
                    className="px-3.5 py-2 rounded-xl bg-desk-surface border border-ink-vermilion/60 text-ink-vermilion hover:bg-ink-vermilion hover:text-white text-xs font-bold transition-colors"
                  >
                    {t('legalClearAllBtn')}
                  </button>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={clearing}
                      onClick={() => void handleClearAllData()}
                      className="px-3.5 py-2 rounded-xl bg-ink-vermilion text-white text-xs font-extrabold hover:brightness-110 disabled:opacity-50"
                    >
                      {t('legalClearAllConfirm')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClear(false)}
                      className="px-3 py-2 rounded-xl console-well border border-desk-border text-xs font-bold text-desk-text"
                    >
                      {t('legalClearAllCancel')}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {legalTab === 'perf' && (
            <>
              <div>
                <h3 className="text-sm font-extrabold text-desk-text">{t('perfTitle')}</h3>
                <p className="mt-1">{t('perfSubtitle')}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(
                  [
                    { id: 'auto', title: t('perfAutoLabel'), desc: t('perfAutoDesc') },
                    { id: 'high', title: t('perfHighLabel'), desc: t('perfHighDesc') },
                    { id: 'eco', title: t('perfEcoLabel'), desc: t('perfEcoDesc') },
                  ] as { id: PerformancePref; title: string; desc: string }[]
                ).map((item) => {
                  const active = performancePref === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        soundEngine.click(1.06);
                        setPerformancePref(item.id);
                      }}
                      className={`p-3 rounded-2xl border text-left transition-all space-y-1 ${
                        active
                          ? 'bg-desk-panel border-ink-brass shadow-sm'
                          : 'console-well border-desk-border hover:border-ink-brass/50'
                      }`}
                    >
                      <div className="text-xs font-extrabold text-desk-text flex items-center justify-between">
                        <span>{item.title}</span>
                        {active && <span className="hardware-led" data-on="emerald" />}
                      </div>
                      <p className="text-[11px] text-desk-muted leading-snug">{item.desc}</p>
                    </button>
                  );
                })}
              </div>

              <div className="rounded-2xl console-well border border-ink-emerald/40 p-3.5 space-y-1">
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="text-desk-muted">{t('perfActiveStatusLabel')}:</span>
                  <span className="font-bold text-ink-emerald">{activeTierLabel}</span>
                </div>
                <p className="text-[11px] text-desk-text font-medium pt-1">
                  {t('perfExportGuarantee')}
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
