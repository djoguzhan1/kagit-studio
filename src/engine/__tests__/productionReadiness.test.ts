import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXPORT_QUALITY_PROFILE,
  isSoftwareGpuRendererString,
  loadPerformancePref,
  resetAdaptiveTierForTests,
  resolveDeviceRuntimeProfile,
  savePerformancePref,
} from '../deviceTierEngine';
import {
  detectVideoExportSupport,
  ensureEvenDimensions,
  pickBestMediaRecorderFormat,
} from '../videoExportEngine';
import { decodeSharedStage, encodeSharedStage } from '../shareCodec';
import { translate, type TranslationKey } from '../../i18n/translations';

const PRODUCTION_I18N_KEYS: TranslationKey[] = [
  'loadingDesk',
  'loadingDraw',
  'loadingPaper',
  'loadingPuppet',
  'loadingFilm',
  'legalFooterBtn',
  'legalModalTitle',
  'legalTabPrivacy',
  'legalTabTerms',
  'legalTabStorage',
  'legalTabPerf',
  'legalZeroCloudBadge',
  'legalPrivacyIntro',
  'legalPrivacyPoint1Title',
  'legalPrivacyPoint1Body',
  'legalPrivacyPoint2Title',
  'legalPrivacyPoint2Body',
  'legalPrivacyPoint3Title',
  'legalPrivacyPoint3Body',
  'legalPrivacyPoint4Title',
  'legalPrivacyPoint4Body',
  'legalTermsTitle1',
  'legalTermsBody1',
  'legalTermsTitle2',
  'legalTermsBody2',
  'legalTermsTitle3',
  'legalTermsBody3',
  'legalTermsTitle4',
  'legalTermsBody4',
  'legalStorageUsageLabel',
  'legalStoragePersisted',
  'legalStorageStandard',
  'legalStorageSafariTip',
  'legalClearAllTitle',
  'legalClearAllDesc',
  'legalClearAllBtn',
  'legalClearAllConfirm',
  'legalClearAllCancel',
  'perfTitle',
  'perfSubtitle',
  'perfAutoLabel',
  'perfAutoDesc',
  'perfHighLabel',
  'perfHighDesc',
  'perfEcoLabel',
  'perfEcoDesc',
  'perfExportGuarantee',
  'perfActiveStatusLabel',
  'perfTier2Name',
  'perfTier1Name',
  'perfTier0Name',
  'paperTabCamera',
  'paperTabScan',
  'paperPickPhotos',
  'paperCameraStarting',
  'paperRetryCamera',
  'paperUploadPhoto',
  'paperTrySampleA4',
  'paperTrySampleA4Long',
  'paperOnionLabel',
  'paperClapLabel',
  'paperClapTitle',
  'paperFlipCamTitle',
  'paperMirrorTitle',
  'paperTimerInstant',
  'paperCaptureBusy',
  'paperCaptureBtn',
  'paperDropTitle',
  'paperDropDesc',
  'paperStep1Corners',
  'paperAutoFind',
  'paperReset',
  'paperStep2Wipe',
  'paperBeforeCanvas',
  'paperAfterCanvas',
  'paperGridTitle',
  'paperReadyCount',
  'paperProcessing',
  'paperCommitFrames',
  'paperProfileTitle',
  'paperProfileSub',
  'paperProfPencil',
  'paperProfInk',
  'paperProfColor',
  'paperAutoAlign',
  'paperOn',
  'paperOff',
  'paperFineTune',
  'paperBlueStripShort',
  'paperNaturalShort',
  'paperTransparentCel',
  'paperKeepColor',
  'paperStripBlue',
  'paperStripRed',
  'paperSensitivity',
  'paperInkDarkness',
  'paperReturnDraw',
  'paperAddedSuffix',
  'exportPreparing',
  'exportDownloadedPrefix',
  'exportFailed',
  'exportVideoDescAudio',
  'exportVideoDescSilent',
  'exportFlipbookDescPages',
  'exportGifDesc',
  'exportReelDesc',
  'exportTimelapseDesc',
  'exportTimelapseMin',
  'exportPngZipDesc',
  'exportSpriteDesc',
  'exportBackupDesc',
  'exportActiveOnly',
  'exportExposureWord',
  'exportCloseAria',
  'exportWebViewFallbackToast',
  'xsheetAudioAdded',
  'xsheetAudioError',
  'xsheetVoiceSaved',
  'xsheetVoiceError',
  'xsheetMicStarted',
  'xsheetMicDenied',
  'xsheetAudioMuteTitle',
  'xsheetAudioScrubTitle',
  'xsheetAudioRemoveTitle',
  'xsheetAudioScrubOn',
];

describe('Production Readiness — Adaptive GPU-Free Tier, Universal MP4, Security & i18n', () => {
  beforeEach(() => {
    resetAdaptiveTierForTests();
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => store.clear(),
      },
    });
  });

  it('detects GPU-free software renderers and low-spec devices cleanly without lowering export quality', () => {
    expect(isSoftwareGpuRendererString('Google SwiftShader')).toBe(true);
    expect(isSoftwareGpuRendererString('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareGpuRendererString('Microsoft Basic Render Driver')).toBe(true);
    expect(isSoftwareGpuRendererString('NVIDIA GeForce RTX 4070')).toBe(false);

    const gpuFree = resolveDeviceRuntimeProfile({
      pref: 'auto',
      reducedMotion: false,
      softwareRenderer: true,
      cores: 8,
      memoryGb: 16,
    });
    expect(gpuFree.tier).toBe(0);
    // V3 Zero-Compromise: GPU-free uses Zero-GC CPU Scanline @ 30 FPS & full 1.0x sharpness!
    expect(gpuFree.renderBackend).toBe('cpu-scanline');
    expect(gpuFree.targetFps).toBe(30);
    expect(gpuFree.previewScale).toBe(1);
    expect(gpuFree.characterQualityLocked).toBe(true);
    expect(gpuFree.universeAnimated).toBe(false);
    expect(gpuFree.reason).toBe('software-gpu');

    const mobileMid = resolveDeviceRuntimeProfile({
      pref: 'auto',
      reducedMotion: false,
      softwareRenderer: false,
      cores: 6,
      memoryGb: 4,
      mobileUa: true,
    });
    expect(mobileMid.tier).toBe(1);
    // V3 Zero-Compromise: Phones with hardware GPU run WebGL2 GPU Vertex Skinning @ 60 FPS & 1.0x!
    expect(mobileMid.renderBackend).toBe('webgl-gpu-skinning');
    expect(mobileMid.targetFps).toBe(60);
    expect(mobileMid.previewScale).toBe(1);
    expect(mobileMid.meshGrid).toBe(10);
    expect(mobileMid.characterQualityLocked).toBe(true);

    const desktopGpu = resolveDeviceRuntimeProfile({
      pref: 'auto',
      reducedMotion: false,
      softwareRenderer: false,
      cores: 12,
      memoryGb: 16,
      mobileUa: false,
    });
    expect(desktopGpu.tier).toBe(2);
    expect(desktopGpu.renderBackend).toBe('webgl-gpu-skinning');
    expect(desktopGpu.targetFps).toBe(60);
    expect(desktopGpu.meshGrid).toBe(10);

    // Reduced-motion always enforces Tier 0 static backdrop & calm 12 FPS
    const reduced = resolveDeviceRuntimeProfile({
      pref: 'high',
      reducedMotion: true,
      softwareRenderer: false,
    });
    expect(reduced.tier).toBe(0);
    expect(reduced.targetFps).toBe(12);
    expect(reduced.universeAnimated).toBe(false);

    // Export parity guarantee: ALWAYS full HD 10x10 mesh regardless of device tier!
    expect(EXPORT_QUALITY_PROFILE).toEqual({ meshGrid: 10, scale: 1, particleScale: 1 });
  });

  it('persists performance preference cleanly in localStorage', () => {
    expect(loadPerformancePref()).toBe('auto');
    savePerformancePref('eco');
    expect(loadPerformancePref()).toBe('eco');
    savePerformancePref('high');
    expect(loadPerformancePref()).toBe('high');
  });

  it('enforces even H.264 dimensions and prioritizes MP4 over WebM safely', () => {
    expect(ensureEvenDimensions(1281, 721)).toEqual({ width: 1280, height: 720 });
    expect(ensureEvenDimensions(541, 305)).toEqual({ width: 540, height: 304 });

    const origMR = (globalThis as Record<string, unknown>).MediaRecorder;
    try {
      // Simulate restricted In-App WebView without MediaRecorder
      delete (globalThis as Record<string, unknown>).MediaRecorder;
      expect(pickBestMediaRecorderFormat()).toBeNull();
      const webViewSupport = detectVideoExportSupport();
      expect(webViewSupport.nativeMp4Mime).toBeNull();

      // Simulate modern Safari / Chrome supporting both MP4 and WebM -> MP4 MUST win!
      (globalThis as Record<string, unknown>).MediaRecorder = {
        isTypeSupported: (mime: string) =>
          mime === 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' || mime === 'video/webm',
      };
      expect(pickBestMediaRecorderFormat()).toEqual({
        mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        ext: 'mp4',
      });
    } finally {
      if (origMR !== undefined) {
        (globalThis as Record<string, unknown>).MediaRecorder = origMR;
      } else {
        delete (globalThis as Record<string, unknown>).MediaRecorder;
      }
    }
  });

  it('clamps oversized shareCodec stroke payloads safely against DoS tokens', () => {
    const token = encodeSharedStage({
      strokes: Array.from({ length: 40 }, () => ({
        color: '#1C1917',
        width: 8,
        points: [
          { x: 100, y: 100 },
          { x: 200, y: 200 },
        ],
      })),
      toy: 'dance',
      world: 'rainy',
      mood: 'joy',
      prop: 'none',
      voiceFx: 'natural',
    });
    const decoded = decodeSharedStage(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.strokes.length).toBeLessThanOrEqual(64);
    expect(decodeSharedStage('a'.repeat(30000))).toBeNull();
  });

  it('provides 100% non-empty TR & EN parity across all legal, performance, paper & export strings', () => {
    for (const key of PRODUCTION_I18N_KEYS) {
      const tr = translate('tr', key);
      const en = translate('en', key);
      expect(tr.trim().length, `Missing TR key ${key}`).toBeGreaterThan(0);
      expect(en.trim().length, `Missing EN key ${key}`).toBeGreaterThan(0);
    }
  });
});
