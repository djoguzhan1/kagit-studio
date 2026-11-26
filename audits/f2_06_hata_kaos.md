# INKTROPE / Kâğıt Studio — Hata & Kaos Mühendisliği Denetim Raporu (F2-06)

- **Denetim Rolü:** Ajan 6 — Bağımsız Hata & Kaos Avcısı (QA / Chaos Engineering)
- **Hedef Proje:** `C:\Users\salat\Downloads\kagit-studio` (Lokal üretim derlemesi `dist6` → `http://127.0.0.1:4176`, canlı `https://inktrope.com` üzerinde yıkıcı test YAPILMADI)
- **Test Ortamı:** Gerçek Tarayıcı Chrome `158.0.8127.37` (Headless New + CDP Port `9226`, izole Incognito BrowserContext'ler, Donanım GPU: `NVIDIA GeForce RTX 3050 6GB Direct3D11`, Node `v24.14.0` native `WebSocket` + `fetch`)
- **Tarih:** 24.11.2026
- **Kapsam:** 7 Kaos Alanı — Her madde hem kaynak kod (`dosya:satır`) hem de gerçek tarayıcı CDP yürütmesiyle kanıtlanmıştır.

---

## 1. Yönetici Özeti & Dürüst Puan

### Dürüst Dayanıklılık Puanı: **4.5 / 10**

**Gerekçe:**
INKTROPE / Kâğıt Studio, "mutlu yol" (happy-path) kullanıcı deneyimi ve özellikle **kamera/mikrofon izni reddi** (`NotAllowedError`) konusunda beklenenden daha özenli savunmalar içeriyor (6/6 `getUserMedia` çağrı noktasının tamamı çökmeden anlamlı uyarı veriyor; 32 hızlı üst menü sekme geçişi 0 hata ile tamamlanıyor; WebGL kaybında CPU scanline fallback siyah ekranı önlüyor).

Ancak acımasız kaos senaryoları altında uygulama **üretim ortamında kabul edilemez düzeyde kritik dayanıklılık, veri bütünlüğü ve hesap izolasyonu açıkları** verdi:
1. **Kalıcı Veri Kaybı (3 ayrı vektör):**
   - `401 Unauthorized` / süresi dolmuş oturumda otomatik bulut yazımı sessizce başarısız olup UI'da **sahte yeşil `"Bulutta Güncel"`** rozeti gösteriyor; kullanıcı çıkış yaptığında yereldeki senkronize edilmemiş değişiklikler **uyarısız ve kalıcı olarak siliniyor**.
   - Çoklu oyuncu kadrosuna (`FilmProjectGraph.actors[1..5]`) eklenen karakter görselleri, `db.ts` çöp toplayıcısının (`collectAllReferencedBlobKeys`) yalnızca `fg.actor` alanına bakması yüzünden **ilk sayfa yenilemesinde IndexedDB'den kalıcı olarak siliniyor**.
   - `QuotaExceededError` dışındaki IndexedDB yazma hataları (`AbortError` vb.) sessizce yutuluyor; kare çoğaltırken oluşan `StorageQuotaError` ise yakalanmamış Promise reddi olarak çöküyor.
2. **Kalıcı Açılış Kilitlenmesi (Brick):**
   - `indexedDB.open` engellendiğinde (`SecurityError` — Firefox Gizli Mod / sıkı tarayıcı politikası) veya IndexedDB'de bozuk bir proje kaydı bulunduğunda `bootstrap()` `try/catch` içermediği için uygulama **sonsuza kadar `"Işıklı masa hazırlanıyor…"` ekranında kilitleniyor** (`StudioErrorBoundary` devreye giremiyor).
3. **Hesaplar Arası Sır Sızıntısı & Çapraz Kapsam (Cross-Scope) Yarışı:**
   - Çıkış yapıldığında `sessionStorage['inktrope:byok-gemini-key']` temizlenmediği için aynı tarayıcıda sonradan giriş yapan ikinci kullanıcı **önceki kullanıcının ücretli Gemini API anahtarını devralıyor**.
   - `schedulePersist` içindeki 180 ms'lik `persistTimer` giriş/çıkış sırasında iptal edilmediği için misafir projeleri **yeni giriş yapan hesabın IndexedDB kasasına (`kagit:u:<uid>:projects:v1`) üzerine yazılabiliyor**.
4. **Kurtarılamaz Hata Sınırı Döngüsü & WebGL Kaynak Sızıntısı:**
   - Lazy-load veya senkron render hatası veren herhangi bir modal (`AccountModal`, `LegalPolicyModal`, `ExportModal`, `StudioOverviewShow`) `StudioErrorBoundary` tarafından yakalanıyor ancak **"Ana Masaya Dön"** butonu modal bayraklarını kapatmadığı için kullanıcı **3/3 denemede sonsuz hata döngüsüne hapsoluyor**.
   - WebGL `context-lost` → `context-restored` döngüsü tek seferde **3 canlı WebGL2 bağlamı sızdırıyor**; geçici bir GPU sıfırlamasında ise `_glInitFailed = true` kalıcı kilitlenip **oturum boyunca donanım hızlandırmayı tamamen öldürüyor**.

| Kaos Alanı | Durum | Özet |
| :--- | :---: | :--- |
| 1. Bozuk / Dev Görsel Yükleme | **`[FAIL]`** | `LayerReferenceRail` 0B/bozuk/fake-SVG'ye yeşil başarı veriyor; `PaperCameraStudio` sessizce bozuk kuyruk biriktiriyor; `FilmDirectorStudio` & `CharacterMasterModal` 400 MB ham 10000×10000 canvas ayırıyor; çoklu oyuncu blobları yenilemede siliniyor. |
| 2. Kamera / Mikrofon İzni Reddi | **`[PASS]`** | 6/6 `getUserMedia` noktası gerçek CDP izni reddinde (`NotAllowedError`) çökmeden, sonsuz yüklemede kalmadan anlamlı Türkçe uyarı ve alternatif yol sunuyor (kod düzeyinde unmount yarışı uyarısı not edildi). |
| 3. Offline Modu + IndexedDB Hatası | **`[FAIL]`** | Engelli IDB (`SecurityError`) ve bozuk IDB kaydı uygulamayı sonsuz yüklemede kilitliyor; kare çoğaltmada `StorageQuotaError` yakalanmamış red üretiyor; `AbortError` sessizce yutuluyor; SW lazy chunk'ları önbelleklemiyor. |
| 4. Hızlı Mod Değişimi (Rapid Switching) | **`[FAIL]`** | Üst bardaki 32 hızlı tıklama (42 ms) hatasız `[PASS]`, ancak Masa üzerindeki asenkron `openSampleMeshPuppetDemo` vs `openFilmDirectorDemo` yarışı kullanıcının son seçimini (Film) **Kukla moduna geri kaçırıyor**. |
| 5. WebGL `context-lost` & `context-restored` | **`[FAIL]`** | `e.preventDefault()` çağrılıyor ve CPU fallback siyah ekranı önlüyor, ancak 1 kayıp/geri yükleme döngüsü **3 WebGL2 bağlamı sızdırıyor** ve geçici GPU sıfırlaması `_glInitFailed = true` ile GPU'yu oturum boyunca kalıcı öldürüyor. |
| 6. Misafir ↔ Hesap Geçişi & 401 | **`[FAIL]`** | 401'de sahte yeşil `"Bulutta Güncel"` rozeti, çıkışta senkronize edilmemiş verinin uyarısız kalıcı silinmesi, BYOK Gemini API anahtarının ikinci hesaba sızması ve 180 ms `persistTimer` çapraz kapsam üzerine yazma yarışı kanıtlandı. |
| 7. Console / Network / ErrorBoundary | **`[FAIL]`** | `StudioErrorBoundary` var ve çalışma alanı çökmelerinde WSOD'u önlüyor, ancak modal çökmelerinde **"Ana Masaya Dön" sonsuz döngüye giriyor**; tek kaba kök sınırı var; boot hataları sınırı baypas ediyor. |

---

## 2. EN AĞIR 5 SORUN (Öncelik Sıralı)

### #1 — [P0 / KRİTİK] 401 Oturum Düşmesinde Sahte `"Bulutta Güncel"` Rozeti & Çıkışta Kalıcı Sessiz Veri Kaybı

- **Ciddiyet:** **P0 — Kritik (Sessiz Kalıcı Kullanıcı Verisi Kaybı & Yanıltıcı Güvenlik/Senkronizasyon Durumu)**
- **Kaynak Kod Kanıtı:**
  - `src/engine/cloudSync.ts:348-376` — `pushLocalChangesToCloud()`, `PUT /api/cloud/blobs/:key` ve `PUT /api/cloud/projects/:id` yanıtlarında `!putRes.ok` veya `status === 401` kontrolü **yapmıyor**, hata fırlatmadan normal şekilde `resolve` oluyor.
  - `src/store/useStudioStore.ts:172-177` — `scheduleCloudPush()`, `pushLocalChangesToCloud` çözüldüğü anda (HTTP 401 dönmüş olsa bile!) `cloudSyncStatus: 'synced'` ve `cloudLastSyncedAt: Date.now()` yazıyor.
  - `src/components/account/AccountModal.tsx:415-420` — `syncCloudNow` manuel olarak 401 alıp `'error'` durumuna geçse dahi UI bunu **`"Çevrimdışı — yerelde güvende"`** diye gösteriyor ve kullanıcıyı oturumun düştüğü konusunda uyarmıyor.
  - `src/store/useStudioStore.ts:858-862` — `signOutAccount()`, `await pushLocalChangesToCloud(user.id, get().projects).catch(() => {})` diyerek başarısız push'ı yutuyor ve hemen ardından `await clearScopedStorage(user.id)` ile **kullanıcının yerel IndexedDB kasasını tamamen siliyor**.
- **Tekrarlama Adımları (Chrome CDP ile Doğrulandı):**
  1. `alice@inktrope.test` hesabıyla giriş yap (sunucuda `"Alice Gizli Filmi"` kayıtlı).
  2. Sunucu `/api/cloud/*` uç noktasını `401 Unauthorized` döndürecek şekilde oturum süresini doldur.
  3. Proje adını `"Alice 401 Edits"` olarak değiştir, 2.4 sn bekle (`schedulePersist` 180 ms + `scheduleCloudPush` 1400 ms).
  4. Hesap modalını aç → `PUT /api/cloud/projects/prj_alice_secret` HTTP **401** dönmesine rağmen modalda yeşil **`"Bulutta Güncel"`** görünüyor.
  5. `"Çıkış Yap (Bu Cihazdaki Kopyayı Temizle)"` butonuna tıkla.
- **Gerçek Tarayıcı CDP Kanıtı (`chaos-06-guest-account-transitions.mjs`):**
  ```json
  "apiLog": [
    { "method": "PUT", "path": "/api/cloud/projects/prj_alice_secret", "status": 401, "user": "alice@inktrope.test", "force401": true },
    { "method": "GET", "path": "/api/cloud/projects", "status": 401, "user": "alice@inktrope.test", "force401": true },
    { "method": "PUT", "path": "/api/cloud/projects/prj_alice_secret", "status": 401, "user": "alice@inktrope.test", "force401": true }
  ],
  "after401AutoPush": {
    "accountBtnTitle": "Alice Artist (alice@inktrope.test) — Bulut kasası güncel",
    "showsFalseSyncedGreen": true
  },
  "after401ManualSync": {
    "stillShowsSignedInAsAlice": true,
    "misleadinglySaysOffline": true,
    "toast": "Senkronizasyon başarısız — çizimlerin yerelde güvende."
  },
  "step4_signOutWhileUnsynced401": {
    "idbAfterSignOut": { "projectsByKey": { "kagit:projects:v1": ["Misafir Özel Defteri", "Kağıt Uçak & Rüzgar"] } },
    "aliceCloudServerStillHasOldName": ["Alice Gizli Filmi"]
  }
  ```
  *(Sonuç: `"Alice 401 Edits"` ne bulutta ne yerelde kaldı — sıfır uyarıyla kalıcı olarak yok oldu.)*
- **Çözüm:**
  - `cloudSync.ts` içinde özel `AuthExpiredError` (401) ve `CloudPushError` (non-2xx) sınıfları tanımla; `pushLocalChangesToCloud` içinde `!upRes.ok` / `!putRes.ok` durumunda hata fırlat (401'de hemen kes).
  - `useStudioStore` 401 yakaladığında `cloudSyncStatus: 'auth-expired'` (yeni durum) yap, kullanıcıya "Oturum süresi doldu — değişikliklerini kaybetmemek için tekrar giriş yap" uyarısı göster.
  - `signOutAccount()` içinde son bulut yüklemesi başarısız olursa yerel kasayı **ASLA sessizce silme**; kullanıcıya açık onay diyaloğu + `.kagit.zip` yedekleme seçeneği sun.

---

### #2 — [P0 / KRİTİK] Çoklu Oyuncu Kadrosu (`FilmProjectGraph.actors[1..5]`) İlk Sayfa Yenilemesinde Çöp Toplayıcı Tarafından Kalıcı Siliniyor

- **Ciddiyet:** **P0 — Kritik (Deterministik Kalıcı Kullanıcı Verisi Kaybı — %100 Tekrarlanabilir)**
- **Kaynak Kod Kanıtı:**
  - `src/types/film.ts:284-290` — `FilmProjectGraph` V4 çoklu oyuncu kadrosunu `actors?: FilmActor[]` dizisinde tutuyor (`actors[0]` ana oyuncuyla eşli, `actors[1..5]` ek oyuncular).
  - `src/engine/db.ts:409-429` — `collectAllReferencedBlobKeys(projects)` yalnızca `fg.actor.sourceBlobKey` ve `fg.actor.decomposed` alanlarını tarıyor; **`fg.actors` dizisini tamamen unutuyor!**
  - `src/store/useStudioStore.ts:603` — Her uygulama açılışında `void sweepUnreferencedBlobs(projects)` otomatik çalışıyor ve `collectAllReferencedBlobKeys` listesinde olmayan tüm blob'ları `del(k)` ile IndexedDB'den siliyor (`db.ts:441-456`). Aynı eksik liste `cloudSync.ts:263,340` ve `importGuestProjectsToAccount` (`useStudioStore.ts:815`) için de kullanıldığından ek oyuncular buluta da senkronize edilemiyor.
- **Tekrarlama Adımları (Chrome CDP ile Doğrulandı):**
  1. Mini Film Stüdyosu'na gir (`Mini Film Yönet`).
  2. Oyuncu kadrosuna 2. karakter görseli yükle (`valid_char.png` → `actors[1]`).
  3. Sayfayı yenile (`F5` / `Page.navigate`).
  4. IndexedDB `keyval-store` içindeki `kagit:blob:<actor1Key>` kaydını kontrol et.
- **Gerçek Tarayıcı CDP Kanıtı (`chaos-06b-07b-races.mjs`):**
  ```json
  "bonus_multiActorBlobDeletedOnReload": {
    "beforeReload": {
      "actorCount": 2,
      "actor1Key": "blob_33af911aa903",
      "blobExistsBeforeReload": true,
      "blobSize": 3681
    },
    "afterReload": {
      "actor1Key": "blob_33af911aa903",
      "blobExistsAfterReload": false
    }
  }
  ```
- **Çözüm:**
  - `src/engine/db.ts:409-429` içinde `fg.actors` dizisinin tüm elemanlarını (her aktörün `sourceBlobKey`, `decomposed.depthBlobKey`, `decomposed.normalBlobKey`, `decomposed.parts[].blobKey` alanlarını) `collectAllReferencedBlobKeys` içine ekle ve `db.ts` için birim regresyon testi yaz.

---

### #3 — [P0 / KRİTİK] IndexedDB Engeli (`SecurityError`) veya Bozuk Proje Kaydı Uygulamayı Sonsuz Yükleme Ekranında Kalıcı Kilitliyor (App Brick)

- **Ciddiyet:** **P0 — Kritik (Tam Servis Kesintisi / Kullanılamaz Uygulama)**
- **Kaynak Kod Kanıtı:**
  - `src/store/useStudioStore.ts:594-605` — `bootstrap()` içinde `await loadAllProjects()`, `await createStarterFlipbookProject()` ve `await saveAllProjects(projects)` çağrıları **`try/catch` ile korunmuyor**.
  - `src/store/useStudioStore.ts:247-286` — `normalizeProject(p)` içinde `p.frames.length` (`satır 267`) ve `p.palette.slice(0, 6)` (`satır 254, 277`) doğrulama yapılmadan erişiliyor; tek bir eksik/null alan tüm başlangıcı çökertiyor.
  - `src/App.tsx:43-56` — `useEffect(() => { void bootstrap(); }, [bootstrap])` Promise reddini yakalamıyor; `ready` sonsuza kadar `false` kalıyor ve `StudioErrorBoundary` asenkron Promise redlerini yakalayamadığı için kurtarma ekranı dahi açılamıyor.
- **Tekrarlama Adımları (Chrome CDP ile Doğrulandı):**
  - **Vektör A:** `Page.addScriptToEvaluateOnNewDocument` ile `indexedDB.open()` → `DOMException('SecurityError')` fırlat, uygulamayı aç, 3.5 sn bekle.
  - **Vektör B:** IndexedDB `kagit:projects:v1` içine bozuk bir kayıt (`[{ id: 'corrupt_prj', frames: null, scenes: null, palette: null }]`) yaz ve sayfayı yenile.
- **Gerçek Tarayıcı CDP Kanıtı (`chaos-03-offline-idb.mjs` & `chaos-07-errorboundary-console-audit.mjs`):**
  ```json
  "idb_blockedOnBoot_SecurityError": {
    "bootState": {
      "bodyText": "Işıklı masa hazırlanıyor…",
      "hasPulseLoader": true,
      "hasErrorBoundary": false,
      "deskRendered": false
    },
    "pageErrors": [{
      "text": "SecurityError: The operation is insecure (IDB blocked).",
      "isUnhandledRejection": true
    }]
  },
  "corruptIdbProjectRecordOnBoot": {
    "bodyText": "Işıklı masa hazırlanıyor…",
    "stuckLoading": true,
    "hitErrorBoundary": false,
    "pageErrors": [{
      "text": "TypeError: Cannot read properties of null (reading 'length')\n    at Pn (.../index-BjGFSWLz.js:10:44212)\n    at Array.map (<anonymous>)\n    at bootstrap (.../index-BjGFSWLz.js:10:46401)",
      "isUnhandledRejection": true
    }]
  }
  ```
- **Çözüm:**
  - `bootstrap()` tamamını `try/catch` ile sar; IDB erişilemezse bellek-içi (in-memory) geçici fallback depolamaya düş, `ready: true` yap ve kullanıcıya kalıcı uyarı bandı ("Tarayıcı depolaması kapalı — çizimler oturum kapanınca silinir, .kagit.zip ile indir") göster.
  - `normalizeProject` içinde her projeyi güvenli şema koruyucusuyla (defensive fallback: `Array.isArray(p?.frames)`, `Array.isArray(p?.palette)`) sanitize et; kurtarılamayan tekil bozuk kaydı karantinaya alıp geri kalan projelerle açılmaya devam et.

---

### #4 — [P1 / YÜKSEK] Hesaplar Arası BYOK Gemini API Anahtarı Sızıntısı & 180 ms `persistTimer` Çapraz Kapsam (Cross-Scope) Üzerine Yazma Yarışı

- **Ciddiyet:** **P1 — Yüksek (Gizlilik/Güvenlik Sır Sızıntısı & Hesaplar Arası Veri Kirlenmesi)**
- **Kaynak Kod Kanıtı:**
  - `src/engine/aiStudioClient.ts:15-36` — Kullanıcının ücretli BYOK Gemini anahtarı `sessionStorage['inktrope:byok-gemini-key']` altında tutuluyor.
  - `src/store/useStudioStore.ts:849-898` (`signOutAccount`), `900-941` (`permanentlyDeleteAccount`) ve `src/engine/db.ts:143-168` (`clearAllLocalStudioData`) — Hiçbiri `inktrope:byok-gemini-key` anahtarını temizlemiyor! Ayrıca `useStudioStore.ts:546` içindeki bellek içi `activeMasterRig` (kullanıcının 360° karakter görsellerini base64 `dataUrl` olarak taşıyan durum) çıkışta/hesap değişiminde sıfırlanmıyor.
  - `src/store/useStudioStore.ts:159, 188-202, 687-700, 849-864` — `schedulePersist(projects)` 180 ms'lik `persistTimer` kurup kapatma zamanında o anki `activeScope` üzerine `saveAllProjects(projects)` çağırıyor. `completeCloudSignIn()` (`satır 689`) ve `signOutAccount()` (`satır 853`) yalnızca `cloudSyncTimer`'ı iptal ediyor, **`persistTimer`'ı İPTAL ETMİYOR** (ve `satır 688` `void flushActiveCanvasNow()` çağrısını `await` etmiyor!).
- **Tekrarlama Adımları (Chrome CDP ile Doğrulandı):**
  - **Sır Sızıntısı:** Alice oturumunda `sessionStorage['inktrope:byok-gemini-key']` ayarla → `"Çıkış Yap"` → Bob oturumuyla giriş yap → `sessionStorage.getItem('inktrope:byok-gemini-key')` oku.
  - **180 ms Çapraz Kapsam Yarışı:** Misafir modunda `"Boş Kare"` tıklayıp `persistTimer` (180 ms) tetikle → 15 ms sonra Bob hesabıyla giriş yap (`/api/cloud/projects` 400 ms gecikmeliyken `setActiveStorageScope('usr_bob_002')` hemen çalışır) → `t=290ms` anında Bob'un IndexedDB anahtarını oku.
- **Gerçek Tarayıcı CDP Kanıtı (`chaos-06` & `chaos-06b`):**
  ```json
  "step4_signOutWhileUnsynced401": {
    "afterSignOut": {
      "byokKeyStillInSessionStorage": "AIzaSy_ALICE_SECRET_KEY_12345",
      "toast": "Çıkış yapıldı — bu cihazdaki hesap önbelleği temizlendi."
    }
  },
  "step5_bobSignedIn": {
    "bobCanSeeAliceByokKey": "AIzaSy_ALICE_SECRET_KEY_12345"
  },
  "race_6B_persistTimerCrossScope": {
    "bobIdbAt290ms_GuestProjectsWrittenIntoBobVault": [
      { "id": "prj_12b63dabdac6", "name": "Yeni Çizgi Film" },
      { "id": "prj_a67cf8c501ed", "name": "Kağıt Uçak & Rüzgar" }
    ]
  }
  ```
- **Çözüm:**
  - `signOutAccount`, `permanentlyDeleteAccount` ve `clearAllLocalStudioData` içinde `sessionStorage.removeItem('inktrope:byok-gemini-key')` çağır ve Zustand'da `activeMasterRig: null` sıfırla.
  - `schedulePersist` içine bir `scopeAtSchedule = getActiveStorageScope()` yakalaması ekle (`saveAllProjects` çağrılmadan önce kapsam değiştiyse yazmayı iptal et); `completeCloudSignIn` ve `signOutAccount` başlangıcında `clearTimeout(persistTimer)` yap ve `await flushActiveCanvasNow()` çağrısını `setActiveStorageScope` öncesinde bekle.

---

### #5 — [P1 / YÜKSEK] `StudioErrorBoundary` Modal Çökmelerinde Kurtarılamaz Sonsuz Döngüye Giriyor & Çevrimdışı Lazy-Chunk Kilitlenmesi

- **Ciddiyet:** **P1 — Yüksek (Kurtarma Mekanizmasının Çalışmaması / Uygulama Kilitlenmesi)**
- **Kaynak Kod Kanıtı:**
  - `src/main.tsx:34-36` — Uygulamada yalnızca en üst seviyede tek bir kaba `<StudioErrorBoundary>` bulunuyor; `src/App.tsx:68-125` içindeki lazy çalışma alanları ve opsiyonel modallar kendi izole sınırlarına sahip değil.
  - `src/components/ui/StudioErrorBoundary.tsx:33-41` — `handleReturnToDesk()` yalnızca `stopTour()` ve `setMode('desk')` çağırıyor; **`accountModalOpen`, `legalOpen`, `exportOpen`, `overviewShowOpen` durumlarını SIFIRLAMIYOR!**
  - `public/sw.js:1-11` — Service Worker `SHELL_URLS` içinde hiçbir lazy-loaded JS chunk'ı (`DrawWorkspace`, `AccountModal`, `LegalPolicyModal` vb.) önbelleğe alınmıyor; kullanıcı çevrimdışıyken daha önce açmadığı bir modal veya modüle tıkladığında `TypeError: Failed to fetch dynamically imported module` fırlıyor.
- **Tekrarlama Adımları (Chrome CDP ile Doğrulandı):**
  - **Vektör A (Çevrimdışı/Ağ Hatası Modal Chunk):** `LegalPolicyModal*.js` isteği ağ hatası döndürürken `"Gizlilik, KVKK & Performans"` butonuna tıkla → `StudioErrorBoundary` açılır → `"Ana Masaya Dön"` butonuna 3 kez tıkla.
  - **Vektör B (Senkron React Render Çökmesi):** `AccountModal` render sırasında hata fırlattığında (`Error: INJECTED_SYNC_RENDER_CRASH`) → `StudioErrorBoundary` yakalar → `"Ana Masaya Dön"` tıkla.
- **Gerçek Tarayıcı CDP Kanıtı (`chaos-06b-07b-races.mjs`):**
  ```json
  "errorBoundary_7B_7C_verified": {
    "modalCaught": true,
    "modalReturnAttempts": [
      { "attempt": 1, "stillTrappedInBoundary": true, "backOnDesk": false },
      { "attempt": 2, "stillTrappedInBoundary": true, "backOnDesk": false },
      { "attempt": 3, "stillTrappedInBoundary": true, "backOnDesk": false }
    ],
    "modalConsoleErrorCount": 8
  },
  "errorBoundary_7D_syncRenderCrash": {
    "syncCrashState": { "caughtByBoundary": true, "isWSOD": false },
    "afterReturnSyncCrash": { "stillTrappedInBoundary": true },
    "recoveryLogFound": true
  }
  ```
- **Çözüm:**
  - `StudioErrorBoundary.handleReturnToDesk()` içinde tüm modal bayraklarını kapat (`closeAccountModal()`, `closeLegal()`, `setExportOpen(false)`, `setOverviewShowOpen(false)`, `setFilmExportOpen(false)`, `setPuppetExportOpen(false)`).
  - `App.tsx` içindeki her lazy çalışma alanı ve her opsiyonel modal için ayrı hafif `ErrorBoundary` sarıcıları ekle (örneğin bir modal çökerse açık çizim tuvali yok olmasın) ve çevrimdışı `ChunkLoadError` durumunda "İnternet bağlantısı gerekiyor / Tekrar Dene" mesajı göster.

---

## 3. Detaylı Kaos Senaryo Matrisi

Her senaryo hem ilgili kaynak kod satırlarından hem de Chrome CDP üzerinden gerçek tarayıcıda çalıştırılarak kanıtlanmıştır.

### 3.1. Bozuk & Dev Görsel Yükleme — **`[FAIL]`**

Üretilen gerçek test dosyaları (`scratch/agent6/fixtures/`):
- `empty.png`: `0 byte`
- `corrupt.png`: `4.096 byte` (geçerli PNG başlığı + kesik rastgele ikili veri)
- `fake_svg.png`: `354 byte` (`.png` uzantılı, içinde `<script>window.__FAKE_SVG_EXECUTED = true;</script>` içeren SVG)
- `fake_html.png`: `96 byte` (`.png` uzantılı HTML + `<script>`)
- `huge.png`: `485.788 byte` disk / **10.000 × 10.000 px = 100 Megapiksel (~400 MB ham RGBA açılım bombası!)**
- `large_file.png`: **13.055.244 byte (12.45 MB)** geçerli 2400×2400 yüksek entropili PNG
- `valid_char.png`: `2.379 byte` geçerli 320×420 kontrol görseli

| Alt Senaryo & Yüzey | Durum | Kaynak Kod (`dosya:satır`) | Gerçek Tarayıcı (CDP) Kanıtı |
| :--- | :---: | :--- | :--- |
| **Desk (`InstantAliveStage`)** — 0B / bozuk / fake SVG / fake HTML / dev görsel | **`[PASS]`** *(notlu)* | `InstantAliveStage.tsx:2135-2306` | `empty`, `corrupt`, `fake_svg`, `fake_html`: 4/4'ünde kırmızı toast `"Görsel dosyası okunamadı"`, `svgXss: false`, `htmlXss: false`, 0 console/page hatası. `huge.png` (100MP) ve `large_file.png` (12.45MB) `prepareCharacterCanvas(img, { maxDim: 768 })` ile 4 sn'de canlandırıldı (`usedMB`: 4.1 → 18.1 MB). *Not:* `satır 2138` non-image dosyada toast vermeden sessizce dönüyor ve `input.value` temizlenmiyor. |
| **Puppet (`MeshWarpStage`)** — 0B / bozuk / fake SVG / dev görsel | **`[PASS]`** | `MeshWarpStage.tsx:527-598` | `empty`, `corrupt`, `fake_svg`: 3/3 kırmızı toast `"Görsel dosyası okunamadı"`, 0 hata. `huge.png`: 4.05 sn'de `"huge" 4 otomatik eklemle canlandırıldı` (`usedMB`: 25.3 → 27.4 MB). |
| **StudioDrawer (`.kagit.zip` yedek)** — bozuk dosya | **`[PASS]`** | `StudioDrawer.tsx:311-349` | `corrupt.png` yüklendiğinde kırmızı toast `"Geçersiz ZIP arşivi"`, `pageErrors: []`. |
| **Draw — Sabit Arka Plan (`LayerReferenceRail`)** — 0B / bozuk / fake SVG / 12.45 MB | **`[FAIL]`** | `LayerReferenceRail.tsx:189-201` | **Sıfır doğrulama ve sıfır boyut limiti!** `empty.png`, `corrupt.png`, `fake_svg.png` ve `large_file.png` (12.45 MB) dosyalarının **4'ü de doğrudan IndexedDB'ye kaydedildi (`idbBlobDelta: +1`)** ve kullanıcıya **sahte yeşil toast** (`toastLed: "emerald"`) gösterildi: `"Sabit sahne arka planı yüklendi (tüm karelerin altında sabit!)"`. Ayrıca >4 MB olan `large_file.png`, `cloudSync.ts:290,347` limiti yüzünden buluta sessizce hiç yüklenmeyecek. |
| **Draw — Referans Görsel (`LayerReferenceRail`)** — 0B / bozuk / fake SVG | **`[FAIL]`** | `LayerReferenceRail.tsx:169-187` | `extractSwatchesFromFile` hata fırlatıp kırmızı `"Referans yüklenemedi"` toast'ı gösterdi, **ancak `satır 173` (`await saveBlob(file)`) doğrulamadan ÖNCE çalıştığı için** her bozuk denemede yetim bozuk blob'lar IndexedDB'ye yazılıyor. |
| **Paper Camera (`PaperCameraStudio`)** — 0B / bozuk / fake SVG / dev görsel + toplu aktarım | **`[FAIL]`** | `PaperCameraStudio.tsx:620-655, 724-755` | `handleFilesSelected` hiçbir doğrulama yapmıyor; `useEffect` (`satır 626-633`) **`img.onerror` dinleyicisi içermiyor**. Sonuç: `empty`, `corrupt` ve `fake_svg` için **`toastText: null` (0 uyarı)**, DOM'da **`brokenImgs: 3`**, önizleme canvas'ları boş `300×150`. Üzerine geçerli `huge.png` eklenip `"4 · Kareyi Masaya Aktar"` tıklandığında 0. bozuk dosya yüzünden tüm toplu iş **`"Aktarım başarısız"`** ile çöktü. |
| **Film Director (`FilmDirectorStudio`)** — Oyuncu kadrosu dev görsel + ObjectURL sızıntısı + reload GC | **`[FAIL]`** | `FilmDirectorStudio.tsx:880-935, 1050-1094, 1181-1220`; `db.ts:409-429` | Bozuk görsellerde `"Çizim okunamadı"` doğru çalıştı, **ancak:** (1) `satır 883-886` `prepareCharacterCanvas` öncesi **ham `10000×10000` (400 MB RGBA)** geçici canvas ayırıyor (heap 29.1 → 56.2 MB sıçradı; mobil iOS Safari'de kesin OOM çökmesi!); (2) `handleUploadActor:1056` & `handleUploadCustomBg:1188` hata durumunda `URL.revokeObjectURL` çağırmıyor ve `prepared.empty` kontrolü eksik; (3) kadroya eklenen 2. oyuncu yenilemede `db.ts:409-429` yüzünden siliniyor. |
| **360° Master Rig (`CharacterMasterModal`)** — bozuk & 100MP dev görsel | **`[FAIL]`** | `CharacterMasterModal.tsx:95-119, 282-320` | `corrupt.png` için `"Görsel okunamadı, lütfen başka bir çizim dene."` doğru. Ancak `huge.png` için `loadCanvasFromUrl` (`satır 98-99`) **ham `10000×10000` = 400 MB canvas** oluşturup `FileReader.readAsDataURL` kullanıyor (4.55 sn donma, heap 26.2 → 41.0 MB + off-heap 400 MB GPU tamponu — mobil OOM bombası). |

---

### 3.2. Kamera / Mikrofon İzni Reddi — **`[PASS]`** *(kod uyarılı)*

CDP `Browser.setPermission` ile hem `camera: 'denied'` hem `microphone: 'denied'` tanımlandı ve `navigator.permissions.query` + doğrudan `getUserMedia` çağrısıyla gerçek `NotAllowedError: Permission denied` doğrulandı (`permissionProbe: { cam: "denied", mic: "denied", directErr: { name: "NotAllowedError", message: "Permission denied" } }`).

| Alt Senaryo & Yüzey | Durum | Kaynak Kod (`dosya:satır`) | Gerçek Tarayıcı (CDP) Kanıtı |
| :--- | :---: | :--- | :--- |
| **Desk — Konuş (Talk) Mikrofonu** | **`[PASS]`** | `InstantAliveStage.tsx:1727-1768` | `getUserMedia({ audio: true })` → `NotAllowedError` → `setMicFallback(true)`, 0 `pageerror`, 0 `console.error`, etkileşimli dokun-konuş fallback'i sorunsuz aktif. |
| **Paper Camera — Canlı Kamera** | **`[PASS]`** | `PaperCameraStudio.tsx:160-197` | `getUserMedia({ video: ... })` → `NotAllowedError` → DOM'da açık Türkçe yönlendirme: `"Kamera bulunamadı veya izin verilmedi. Masaüstünde webcam bağlayabilir ya da 'Fotoğraf Tarayıcı' sekmesinden telefonla çektiğin çizimleri yükleyebilirsin."`, `stuckSpinner: false`, 0 hata. |
| **Draw — X-Sheet Ses Kaydet** | **`[PASS]`** | `XSheetTimeline.tsx:96-120`, `audioEngine.ts:289` | `getUserMedia({ audio: true })` → `NotAllowedError` → kırmızı toast `"Mikrofon izni alınamadı"`, kayıt durumu kilitlenmedi, 0 hata. |
| **Puppet — Mikrofonla Konuş** | **`[PASS]`** | `MeshWarpStage.tsx:950-962`, `audioEngine.ts:289` | `getUserMedia({ audio: true })` → `NotAllowedError` → kırmızı toast `"Mikrofon izni alınamadı"`, 0 hata. |
| **Film — Mikrofonla Seslendirme** | **`[PASS]`** | `FilmDirectorStudio.tsx:1387-1460` | `getUserMedia({ audio: true })` → `NotAllowedError` → kırmızı toast `"Mikrofon izni verilmedi"`, kaynaklar temizlendi, 0 hata. |
| **Film — Hareket Yakala (Webcam + Mic Mocap)** | **`[PASS]`** | `PerformanceMocapDeck.tsx:159-206` | `getUserMedia({ video: 320x240, audio: true })` → `NotAllowedError` → hem DOM içi uyarı hem toast: `"Kamera izni verilmedi veya cihazda kamera bulunamadı. Video Aktar veya Canlı Kukla Pedi ile devam edebilirsin."`, 0 hata. |

> **Kod Düzeyinde Kenar Durum Uyarısı:** `PaperCameraStudio.tsx:168-181` ve `PerformanceMocapDeck.tsx:168-176` `await getUserMedia(...)` dönüşünde bileşenin hâlâ bağlı olup olmadığını (`mountedRef.current`) kontrol etmiyor. Kullanıcı tarayıcı izin penceresi açıkken başka moda geçip sonradan "İzin Ver" derse medya izi (`MediaStreamTrack`) durdurulmadan açık kalabilir.

---

### 3.3. Offline Modu + IndexedDB Hatası — **`[FAIL]`**

| Alt Senaryo | Durum | Kaynak Kod (`dosya:satır`) | Gerçek Tarayıcı (CDP) Kanıtı |
| :--- | :---: | :--- | :--- |
| **Engelli `indexedDB.open` (`SecurityError`) açılışta** | **`[FAIL]`** | `useStudioStore.ts:594-605`, `App.tsx:43-56` | `SecurityError: The operation is insecure (IDB blocked)` yakalanmamış Promise reddi (`isUnhandledRejection: true`); uygulama **sonsuza kadar `"Işıklı masa hazırlanıyor…"` ekranında kilitli** (`deskRendered: false`, `hasErrorBoundary: false`). |
| **Bozuk IndexedDB proje kaydı (`frames: null`) açılışta** | **`[FAIL]`** | `useStudioStore.ts:247-286, 597` | `TypeError: Cannot read properties of null (reading 'length')` → yakalanmamış Promise reddi; uygulama kalıcı kilitli (`stuckLoading: true`). |
| **Çalışma zamanı `QuotaExceededError` — Proje JSON kaydı (`saveAllProjects`)** | **`[PASS]`** | `db.ts:194-210`, `useStudioStore.ts:188-202` | `IDBObjectStore.prototype.put` üzerinde `QuotaExceededError` enjekte edildi → yetim blob süpürme + 1 yeniden deneme (`putCalls: 2`) → `StorageQuotaError` yakalandı ve anlamlı Türkçe toast gösterildi: `"Cihaz depolama alanı doldu — eski bir defteri sil veya .kagit.zip yedeği indir."`. |
| **Çalışma zamanı `QuotaExceededError` — Blob kaydı (`addFrameAfterCurrent` → `saveBlob`)** | **`[FAIL]`** | `useStudioStore.ts:1990-2007`, `db.ts:212-234` | Mürekkep içeren Kare #1 `"Çoğalt"` edilirken `saveBlob` `StorageQuotaError` fırlattı; `addFrameAfterCurrent` içinde `try/catch` olmadığı için **`toast: null`** (kullanıcıya sıfır geri bildirim) ve **`pageErrors: [{ text: "StorageQuotaError: ...", isUnhandledRejection: true }]`**. |
| **Çalışma zamanı kota dışı IDB hatası (`AbortError`)** | **`[FAIL]`** | `useStudioStore.ts:196-200` | `"Boş Kare"` eklendiğinde `putCalls: 1` `AbortError` fırlattı; `schedulePersist` yalnızca `err instanceof StorageQuotaError` kontrol ettiği için hatayı **tamamen sessizce yuttu** (`toast: null`, `pageErrors: []`). Kullanıcı çiziminin kaydedildiğini sanıyor ama yenilemede veri kayboluyor. |
| **Çevrimdışı (Offline) Lazy Chunk + Service Worker kapsamı** | **`[FAIL]`** | `public/sw.js:1-11`, `App.tsx:9-17` | `swCacheCheck` doğrulaması: `inktrope-v4.4` önbelleği yalnızca `/`, `/index.html`, font ve ikonları içeriyor; hiçbir lazy workspace/modal JS chunk'ı önbelleklenmiyor. Gerçek çevrimdışında (SW'nin ağ çağrısı da düştüğünde) önbelleksiz bir modül veya modal açılınca `TypeError: Failed to fetch dynamically imported module` ile `StudioErrorBoundary` patlıyor (modallarda sonsuz döngü). |
| **Çevrimdışı oturum açma denemesi (`POST /api/auth/login`)** | **`[FAIL]`** *(UX)* | `cloudSync.ts:126-141`, `AccountModal.tsx:123-124` | Uygulama çökmüyor (`newPageErrors: []`), ancak Türkçe arayüzde ham İngilizce tarayıcı hatası gösteriyor: **`"Failed to fetch"`** (`net::ERR_INTERNET_DISCONNECTED`). |

---

### 3.4. Hızlı Mod Değişimi (Rapid Mode Switching) — **`[FAIL]`**

| Alt Senaryo | Durum | Kaynak Kod (`dosya:satır`) | Gerçek Tarayıcı (CDP) Kanıtı |
| :--- | :---: | :--- | :--- |
| **32 ardışık üst menü sekme geçişi (42 ms aralık, `Çizim`/`Kâğıt`/`Kukla`/`Mini Film`) + 15 ek geçiş** | **`[PASS]`** | `TopConsoleBar.tsx:115-158`, `App.tsx:68-90`, `useStudioStore.ts:987-999` | 32 hızlı tıklama sonunda `activeTab: "Çizim" === expectedFinalTab`, `0` console error, `0` console warning, `0` pageError, `0` unhandled rejection, bellek `15.5 MB`. Ardından 15 hızlı geçişle `Mini Film` moduna inildiğinde `staleXSheetLeaked: false`, `stalePaperLeaked: false`, sahne canvas'ında `6400/6400` dolu piksel, `memMB: 24.2 MB`. |
| **Masa üzerinde hızlı asenkron stüdyo geçiş yarışı (`Canlı Kukla` t=0ms → `Mini Film Yönet` t=20ms)** | **`[FAIL]`** | `useStudioStore.ts:1396-1430` (`openSampleMeshPuppetDemo`), `1472-1489` (`openFilmDirectorDemo`) | Kullanıcı önce `Canlı Kukla`'ya, 20 ms sonra `Mini Film Yönet`'e tıkladı. `openFilmDirectorDemo` daha hızlı bitip `mode: 'film'` yaptı, ancak yaklaşık 150 ms sonra asenkron `createSampleMeshWarpRig()` tamamlanan eski `openSampleMeshPuppetDemo` çağrısı aktif mod kontrolü yapmadan `set({ mode: 'puppet' })` çalıştırdı ve kullanıcıyı **Mini Film'den zorla Kukla'ya geri attı** (`phase2_asyncDemoRace.activeTab: "Kukla"`, `toast: "Canlı kukla hazır..."`). |
| **Web Worker hata sonrası kurtarma / zaman aşımı** | **`[FAIL]`** *(kod)* | `paperWorkerClient.ts:35-58`, `rigWorkerClient.ts:41-52` | `paperWorkerClient.onerror` (`satır 35-40`) bekleyen Promise'leri reddediyor ancak `workerInstance = null` yapmıyor ve `terminate()` çağırmıyor; ayrıca her iki worker istemcisinde de istek zaman aşımı (timeout) veya mod değişiminde iptal mekanizması yok. |

---

### 3.5. WebGL `context-lost` & `context-restored` — **`[FAIL]`**

Gerçek donanım GPU (`NVIDIA GeForce RTX 3050 6GB`) üzerinde `InstantAliveStage` 60 FPS WebGL2 GPU vertex-shader skinning aktifken (`idx=1`, `drawCount=278`) gerçek `WEBGL_lose_context` uzantısıyla `loseContext()` → 2 sn bekleme → `restoreContext()` ve ardından geçici GPU sıfırlama testi çalıştırıldı.

| Alt Senaryo | Durum | Kaynak Kod (`dosya:satır`) | Gerçek Tarayıcı (CDP) Kanıtı |
| :--- | :---: | :--- | :--- |
| **`webglcontextlost` dinleyicisi & `e.preventDefault()` & CPU fallback** | **`[PASS]`** | `webglSkinnedRenderer.ts:490-493, 1060-1075` | `webglcontextlost` olayı yakalandı (`lostEvents: 1`, `defaultPrevented: true`). `INVALID_OPERATION` hata fırtınası oluşmadı (`consoleErrors: []`, `pageErrors: []`), CPU scanline fallback siyah ekranı önledi. |
| **Kayıp sırasında anında yeni bağlam oluşturma ve geri yüklemede 3x WebGL2 bağlam sızıntısı** | **`[FAIL]`** | `webglSkinnedRenderer.ts:369-374, 494-496` | `ts=1795518880448`: `idx=1` `webglcontextlost` oldu. **8 ms sonra (`ts=...80456`)** `getOrInitWebGL()` satır 369 (`if (_glState && !_glState.contextLost)`) `false` döndüğü için `webglcontextrestored` beklemeden **yeni WebGL2 bağlamı `idx=2` açtı** (`idx=1` yetim kaldı). 2 sn sonra `restoreContext()` `idx=1`'i geri getirdi (`ts=...82460`) → yetim dinleyici `_glState = null` çalıştırıp **canlı `idx=2`'yi sızdırdı** → 3 ms sonra (`ts=...82463`) **3. WebGL2 bağlamı `idx=3` açıldı!** Tek bir kayıp/geri yükleme döngüsünde `idx=1, 2, 3` **3 canlı WebGL2 bağlamı aynı anda bellekte sızdı** (Chrome 16 bağlam limitinde zincirleme context-loss tetikler). |
| **Geçici GPU sıfırlaması sonrası kalıcı WebGL2 ölümü (`_glInitFailed` kilidi)** | **`[FAIL]`** | `webglSkinnedRenderer.ts:366, 389-392, 494-496` | GPU sıfırlaması sırasında `getContext('webgl2')` geçici olarak `null` döndüğünde (`ts=...83965`), 1 ms içinde `_glInitFailed = true` kalıcı set edildi. 800 ms sonra GPU düzelip `webglcontextrestored` (`ts=...84782`) gelmesine rağmen `_glInitFailed` hiç sıfırlanmadı → `drawSnap1 === drawSnap2 === [0, 278, 288, 216]`, **`anyGlStillDrawingAfterGpuReset: false`**. Sayfa yenilenene kadar donanım WebGL2 kalıcı olarak ölü kaldı. |
| **Kare içi `gl.isContextLost()` kontrol eksikliği** | **`[FAIL]`** *(kod)* | `webglSkinnedRenderer.ts:850-962, 969-1054` | `loseContext()` çağrıldığı an `gl.isContextLost() === true` olurken `webglcontextlost` asenkron görev kuyruğunda gelir; arada çalışan karelerde `gl.isContextLost()` kontrol edilmediği için boş/kayıp bağlama çizim yapılıp `true` dönülerek CPU fallback atlanır. |

---

### 3.6. Misafir ↔ Hesap Geçişi (Auth, Logout, 401, Veri İzolasyonu) — **`[FAIL]`**

CDP `Fetch.enable` ile `http://127.0.0.1:4176/api/*` uç noktaları (`GET /api/auth/me`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET/PUT /api/cloud/projects*`) kontrollü olarak taklit edildi.

| Alt Senaryo | Durum | Kaynak Kod (`dosya:satır`) | Gerçek Tarayıcı (CDP) Kanıtı |
| :--- | :---: | :--- | :--- |
| **Normal sıralı hesap değişiminde IDB proje izolasyonu (Misafir → Alice → Çıkış → Bob)** | **`[PASS]`** | `db.ts:27-68`, `useStudioStore.ts:699, 862-863` | Sakin sıralı geçişte Alice'in `kagit:u:usr_alice_001:projects:v1` anahtarı çıkışta silindi; Bob girişinde `aliceLeakedIntoBobIdb: false` ve yalnızca `kagit:u:usr_bob_002:projects:v1` (`Bob Özel Defteri`) yüklendi. |
| **401 Token Expiry sırasında otomatik bulut push → Sahte yeşil `"Bulutta Güncel"`** | **`[FAIL]`** | `cloudSync.ts:348-376`, `useStudioStore.ts:172-177` | `PUT /api/cloud/projects/prj_alice_secret` HTTP **401** döndü; buna rağmen `showsFalseSyncedGreen: true`, buton başlığı `"Alice Artist (alice@inktrope.test) — Bulut kasası güncel"`. |
| **401 Token Expiry sırasında manuel senkronizasyon → Yanıltıcı `"Çevrimdışı"` & oturum açık kalması** | **`[FAIL]`** | `useStudioStore.ts:788-799`, `AccountModal.tsx:415-420` | `GET /api/cloud/projects` HTTP **401** döndü; `stillShowsSignedInAsAlice: true`, `misleadinglySaysOffline: true` (`"Çevrimdışı — yerelde güvende"`). |
| **401 / Çevrimdışı durumda Çıkış Yap → Kalıcı sessiz veri kaybı** | **`[FAIL]`** | `useStudioStore.ts:858-862` | `PUT` 401 dönmesine rağmen `clearScopedStorage(user.id)` çalıştı → `"Alice 401 Edits"` yerelden silindi, sunucuda hâlâ eski `"Alice Gizli Filmi"` kaldı. Sıfır uyarı! |
| **Çıkış sonrası BYOK Gemini API anahtarı & `activeMasterRig` sızıntısı** | **`[FAIL]`** | `aiStudioClient.ts:15-36`, `useStudioStore.ts:546, 849-898`, `db.ts:157-164` | Alice çıkış yaptıktan sonra Bob giriş yaptı → `bobCanSeeAliceByokKey: "AIzaSy_ALICE_SECRET_KEY_12345"`! Ayrıca `activeMasterRig` bellek durumu hesap değişiminde temizlenmiyor. |
| **180 ms `persistTimer` çapraz kapsam (cross-scope) IDB üzerine yazma yarışı** | **`[FAIL]`** | `useStudioStore.ts:159, 188-202, 688-699, 853` | Misafirde `"Boş Kare"` tıklandıktan 15 ms sonra Bob girişi tamamlandı → `t=290ms` anında `kagit:u:usr_bob_002:projects:v1` içine misafirin `["Yeni Çizgi Film", "Kağıt Uçak & Rüzgar"]` projeleri yazıldı! |
| **Başlangıç demosu yanlış sınıflandırması (`isStarterDemoProject`)** | **`[FAIL]`** *(P2)* | `cloudSync.ts:179-186`, `starterFlipbook.ts:48` | `starterFlipbook.ts:48` **16 kare** üretiyor, ancak `isStarterDemoProject` (`cloudSync.ts:182`) `p.frames.length <= 12` kontrolü yapıyor. Bu yüzden hiç çizim yapmamış kullanıcıya bile varsayılan demo `"misafir olarak çizdiğin defter"` diye buluta aktarma önerisi olarak çıkıyor (`step2_aliceSignedIn`: 1 özel proje varken `"2 defter bulundu"`). |

---

### 3.7. Console / Network / React `ErrorBoundary` Denetimi — **`[FAIL]`**

| Denetim Kalemi | Durum | Kaynak Kod (`dosya:satır`) | Gerçek Tarayıcı (CDP) Kanıtı |
| :--- | :---: | :--- | :--- |
| **`ErrorBoundary` varlığı & çalışma alanı çökmesinde WSOD önleme** | **`[PASS]`** | `StudioErrorBoundary.tsx:18-100`, `main.tsx:34-36` | `getDerivedStateFromError` + `componentDidCatch` mevcut. `DrawWorkspace` chunk hatasında `isWSOD: false`, `caughtByBoundary: true`, `[INKTROPE Studio Recovery]` loglandı ve `"Ana Masaya Dön"` tıklandığında `backOnDesk: true` ile temiz kurtarıldı. |
| **Modal render/chunk çökmesinde `"Ana Masaya Dön"` kurtarma döngüsü** | **`[FAIL]`** | `StudioErrorBoundary.tsx:33-41`, `App.tsx:94-125` | Hem lazy chunk hatasında (`LegalPolicyModal`) hem gerçek senkron render hatasında (`AccountModal` → `Error: INJECTED_SYNC_RENDER_CRASH`) `"Ana Masaya Dön"` butonu modal bayraklarını kapatmadığı için **3/3 denemede `stillTrappedInBoundary: true`** (tek çıkış tam sayfa yenileme). |
| **İzole bileşen/modal ErrorBoundary eksikliği** | **`[FAIL]`** | `App.tsx:68-125` | Tüm uygulama tek bir kök `StudioErrorBoundary` altında; önemsiz bir yardım/yasal modal çökmesi aktif animasyon çalışma alanını tamamen devreden çıkarıyor. |
| **Konsol / Ağ / Tarayıcı Uyarı Sınıflandırması (Tüm Testler Boyunca)** | **`[FAIL]`** | `cloudSync.ts:87`, `soundEngine.ts:34-45`, `useStudioStore.ts:594-605, 1998` | **(1) Yakalanmamış Promise Redleri (`pageerror`):** Boot IDB `SecurityError` (`useStudioStore.ts:597`), bozuk IDB `TypeError` (`useStudioStore.ts:267`), kare çoğaltma `StorageQuotaError` (`useStudioStore.ts:1998`). **(2) Ağ Hataları:** Backend'siz lokal/statik ortamda her açılışta `GET /api/auth/me` → `404 (Not Found)` konsol ağı hatası üretiyor; offline login'de `net::ERR_INTERNET_DISCONNECTED` ham `"Failed to fetch"` olarak kullanıcıya yansıyor. **(3) Tarayıcı Uyarıları:** İlk kullanıcı etkileşimi öncesi tetiklenen sesler 11 adet `The AudioContext was not allowed to start` tarayıcı uyarısı üretiyor (`chaos-05` browserLogs). |

---

## 4. Hızlı Düzeltme Yol Haritası (Öncelik Sırasıyla)

1. **Hemen (P0 — Veri Kaybı & Brick):**
   - `src/engine/db.ts:409-429`: `collectAllReferencedBlobKeys` içine `fg.actors` döngüsünü ekle.
   - `src/store/useStudioStore.ts:594-605, 247-286`: `bootstrap()` içine tam `try/catch` + in-memory fallback + savunmacı `normalizeProject` ekle.
   - `src/engine/cloudSync.ts:348-376` & `useStudioStore.ts:172-184, 858-862`: 401/non-2xx yanıtları hata olarak fırlat, sahte `'synced'` yazmayı durdur, senkronize edilmemiş veri varken çıkışta yerel kasayı uyarısız silme.
2. **Kısa Vadede (P1 — Güvenlik, İzolasyon & Kurtarma):**
   - `src/store/useStudioStore.ts:159, 688-699, 849-941`: `persistTimer` iptali + kapsam kilidi + `await flushActiveCanvasNow()` + `sessionStorage.removeItem('inktrope:byok-gemini-key')` + `activeMasterRig: null`.
   - `src/components/ui/StudioErrorBoundary.tsx:33-41`: `handleReturnToDesk` içinde tüm modal bayraklarını sıfırla; `App.tsx` içine çalışma alanı/modal bazlı granüler hata sınırları ekle.
   - `src/engine/webglSkinnedRenderer.ts:365-405, 490-496`: Kayıp bağlam varken yeni bağlam açma (`if (_glState?.contextLost) return null;`), `webglcontextrestored` içinde `_glInitFailed = false` yap ve yalnızca aktif canvas eşleşiyorsa `_glState = null` sıfırla; her çizim başında `gl.isContextLost()` kontrol et.
3. **Orta Vadede (P2 — Dosya Doğrulama & Sağlamlık):**
   - `LayerReferenceRail.tsx:169-201` ve `PaperCameraStudio.tsx:620-655`: Tüm dosya yüklemeleri için ortak `validateAndDecodeImageFile(file, { maxBytes: 15MB, maxPixels: 25MP })` kapısı ekle; `PaperCameraStudio`'ya `img.onerror` ekle; `FilmDirectorStudio.tsx:883` ve `CharacterMasterModal.tsx:97` içinde ham 10000×10000 canvas ayırmak yerine doğrudan `prepareCharacterCanvas(img, { maxDim: 768 })` veya `createImageBitmap(file, { resizeWidth: ... })` kullan.
   - `useStudioStore.ts:1396-1489`: Asenkron demo açılışlarına istek sayacı (monotonic request token) ekleyerek eski seçimin yeni modu ezmesini engelle.
   - `cloudSync.ts:182`: `isStarterDemoProject` kare eşiğini `<= 16` olarak güncelle.
