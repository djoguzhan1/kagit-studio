# INKTROPE / Kâğıt Studio — Faz 2 Denetim Raporu #09: Test, PWA, SEO & Dağıtım

- **Denetlenen Proje:** `C:\Users\salat\Downloads\kagit-studio`
- **Canlı Dağıtım:** `https://inktrope.com`
- **Denetçi Rolü:** Ajan 9 — Test, PWA, SEO & Dağıtım Denetçisi (Bağımsız / Salt-Okunur Denetim)
- **Denetim Tarihi:** 24 Kasım 2026
- **Kapsam & Yöntem:** Gerçek `npm test`, `npm run typecheck`, `npm run build` koşuları; 14 Vitest test dosyası ve 92 üretim kaynak dosyasının (`src/` + `worker/`) satır bazlı kapsam analizi; dağıtım/PWA/SEO/hukuki dosyaların tam incelemesi; canlı `https://inktrope.com` uçlarına pasif `curl.exe` HEAD/GET doğrulaması. Kaynak kodda hiçbir değişiklik yapılmamıştır.

---

## 1. Yönetici Özeti & Dürüst Puan

### **Dürüst Puan: `4.8 / 10`**

**Puan Gerekçesi:**
- **Çalışan Temel (Artılar):** `npm test` (14 dosya, 117 test), `npm run typecheck` ve `npm run build` sıfır hatayla (`exit code 0`) tamamlanıyor. Canlı `https://inktrope.com` statik dosya içerikleri (14/14 kontrol edilen uç + `dist/index.html` hash'leri) yerel derleme ile byte-byte %100 senkron; `/api/auth/me` ve `/api/ai/status` canlıda sağlıklı çalışıyor; `www.inktrope.com -> https://inktrope.com/` 301 yönlendirmesi aktif; fontlar yerel sunuluyor ve `sw.js` `/api/*` uçlarını önbelleğe almıyor.
- **Ağır Üretim ve Kalite Borçları (Eksiler):**
  1. **Canlı üretimde HİÇBİR HTTP güvenlik başlığı (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, nosniff) ve HİÇBİR immutable asset önbelleklemesi çalışmıyor** — çünkü `public/_headers` Cloudflare **Workers Static Assets** tarafından tamamen yok sayılıyor.
  2. **Test kapsamı yanıltıcı:** 92 üretim dosyasının **58'i (%63,0 — 33.874 satır) %0 doğrudan testli**; 35 React bileşeninin 34'ü (%97,1), `webglSkinnedRenderer.ts`, `cloudSync.ts`, `aiStudioClient.ts`, `encodeFramesToMp4WebCodecs`, Google OAuth akışı, Web Worker'lar ve `sw.js` hiç test edilmiyor. Bu kör nokta, V4 çoklu oyuncu (`filmGraph.actors`) blob'larının GC tarafından silinmesi gibi **gerçek bir veri kaybı hatasını** doğrudan kaçırmış.
  3. **`public/sw.js` offline fallback'ı canlıda `307 Temporary Redirect` dönen `/index.html`'e dayanıyor** (Fetch/SW spec gereği redirected yanıt navigation'da reddedilir), hiçbir JS/CSS/font/worker chunk'ı precache edilmiyor ve `skipWaiting` + `clients.claim` istemci koordinasyonu olmadan eski sekmelerin lazy chunk'larını bozabiliyor.
  4. **Hukuki/Gizlilik & SEO Çelişkileri:** `privacy/index.html` AI yan profil görselinin "geçici" işlendiğini ve hesap silmenin "tüm bulut verilerini" sildiğini söylerken, `worker/index.js` üretilen görseli TTL'siz `ai_turnaround_cache`'e kalıcı yazıyor ve hesap silme ne `ai_turnaround_cache`'i ne `ai_usage_ledger`'ı siliyor. `sitemap.xml` ve `canonical` etiketleri `/privacy` ve `/terms` (slash'sız) verirken canlı site bunları **307 Temporary Redirect** ile `/privacy/` ve `/terms/`'e atıyor. `index.html` ve `llms.txt` kodda var olmayan yaratık sınıflarını (`arachnid_multi`, `cute_blob`) ilan ediyor.
  5. **Viral Büyüme Akışları Yarım/Ölü:** `shareFileOnMobileIfSupported` (Web Share Level 2) %100 ölü kod; ana sayfa `#kagit=` paylaşımı fotoğraf/örnek kahramanlarda sessizce hiçbir şey yapmıyor; panoya kopyalama hata verince yalan toast gösteriyor; ana giriş sahnesindeki GIF/MP4'lerde marka mührü yok; 3 ana viral motor 16:9 yataya kilitli (9:16 Reels/TikTok/Shorts ihracı yok).

---

## 2. EN AĞIR 5 SORUN (Öncelik Sıralı)

### 1. [KRİTİK — GÜVENLİK & PERFORMANS] Canlı `https://inktrope.com` Üretiminde `public/_headers` Tamamen Etkisiz: Sıfır Güvenlik Başlığı + Sıfır Immutable Asset Cache
- **Ciddiyet:** KRİTİK (`P0`)
- **Kanıt (`dosya:satır` + canlı `curl.exe`):**
  - `wrangler.jsonc:6-12`: Proje Cloudflare Pages değil, **Cloudflare Workers Static Assets** (`assets.directory: "./dist"`, `run_worker_first: ["/api/*"]`) ile dağıtılıyor.
  - `public/_headers:1-16`: `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `/sw.js` `no-store` ve `/assets/*` `max-age=31536000, immutable` kuralları tanımlı.
  - `worker/index.js:1299-1312`: Worker sadece `/api/*` için çalışıyor; statik dosyalar `run_worker_first` dışında kaldığından doğrudan edge asset servisinden dönüyor ve Cloudflare Workers Static Assets `_headers` / `_redirects` dosyalarını işlemiyor.
  - **Canlı kanıt (`curl.exe -sI https://inktrope.com/`):**
    ```http
    HTTP/1.1 200 OK
    Content-Type: text/html
    CF-Cache-Status: HIT
    Cache-Control: public, max-age=0, must-revalidate
    Server: cloudflare
    ```
    CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy başlıklarının **HİÇBİRİ YOK** (clickjacking ve XSS sertleştirmesi sıfır).
  - **Canlı kanıt (`curl.exe -sI https://inktrope.com/assets/index-BjGFSWLz.js` ve `index-B42hRhax.css`):**
    ```http
    HTTP/1.1 200 OK
    Content-Type: text/javascript
    CF-Cache-Status: HIT
    Cache-Control: public, max-age=0, must-revalidate
    ```
    Hash'li immutable Vite chunk'ları `max-age=31536000, immutable` yerine `max-age=0, must-revalidate` ile servis ediliyor.
  - Ek olarak `vercel.json:19` CSP'sinde Google profil fotoğrafı kaynağı (`https://lh3.googleusercontent.com`) unutulmuş ve `vercel.json:37` `rewrites` kuralı `/api/*` yollarını bile `/index.html`'e yönlendirerek Vercel dağıtımını kırıyor.
- **Çözüm:**
  1. Cloudflare Dashboard **Transform Rules (HTTP Response Header Modification)** veya `wrangler.jsonc` `run_worker_first` + `worker/index.js` wrapper'ı (HTML + `/sw.js` + `/assets/*` için) ile tüm güvenlik başlıklarını ve `/assets/*` için `Cache-Control: public, max-age=31536000, immutable`, `/sw.js` için `Cache-Control: no-cache, no-store, must-revalidate` başlıklarını doğrudan enjekte edin.
  2. Kullanılmayan/yanıltıcı `public/_headers`, `public/_redirects` ve `vercel.json` çakışmalarını temizleyin ya da tek kaynak (single source of truth) ile senkronize edin.

---

### 2. [KRİTİK — VERİ KAYBI & TEST KÖR NOKTASI] %63 Test Edilmemiş Kod Tabanı ve Testlerin Kaçırdığı Gerçek V4 Çoklu Oyuncu Veri Kaybı + 600 KB Bulut Sync Kırılması
- **Ciddiyet:** KRİTİK (`P0`)
- **Kanıt (`dosya:satır` + kapsam analizi):**
  - Envanter taraması: `src/` + `worker/` toplam **92 dosya / 67.112 satır**. Bunların **58 dosyası (%63,0) / 33.874 satırı (%50,5)** hiçbir Vitest testinden doğrudan import edilmiyor (`src/components/`: 35 dosyadan 34'ü = **%97,1 test dışı**; `webglSkinnedRenderer.ts` 1.167L, `cloudSync.ts` 378L, `aiStudioClient.ts` 212L, `flipbookPdf.ts` 243L, `rigWorker.ts` 140L, `sw.js` 73L = **%0 testli**).
  - **Testlerin kaçırdığı Gerçek Veri Kaybı Bug'ı #1 (GC Silmesi):** `src/components/film/FilmDirectorStudio.tsx:492-500, 890` V4'ün 2–6. oyuncularını (`filmGraph.actors[1..5]`) `saveBlob(blob)` ile IndexedDB'ye yazıyor. Ancak `src/engine/db.ts:409-429` (`collectAllReferencedBlobKeys`) **yalnızca tekil `fg.actor`** alanını topluyor, `fg.actors` dizisini **HİÇ dolaşmıyor!** Sonuç:
    - Sayfa yenilendiğinde `src/store/useStudioStore.ts:603` (`sweepUnreferencedBlobs`) 2–6. oyuncuların görsellerini "sahipsiz çöp" sayıp IndexedDB'den **kalıcı siler**.
    - `src/engine/cloudSync.ts:263, 321, 340` bu blob'ları buluta **hiç yüklemez** ve `/api/cloud/blobs/gc` bunları siler.
    - `src/engine/exportEngine.ts:626, 755-804` (`exportPortableBackupZip` & `importPortableBackupZip`) 2–6. oyuncuları `.kagit.zip` yedeğine dahil etmez ve geri yüklemede remap etmez.
    - `src/engine/__tests__/studio.test.ts:65-227, 764-795` yalnızca eski V3 `fg.actor`'ı test ettiği için bu hatayı tamamen kaçırmış.
  - **Testlerin kaçırdığı Gerçek Bug #2 (Bulut 413 Sessiz Hata):** `src/types/masterRig.ts:34-43` (`RigViewSlot.dataUrl`) 360° çoklu açı PNG görsellerini `blobKey` yerine ham Base64 string olarak proje JSON'una gömüyor. `worker/index.js:16` `MAX_PROJECT_JSON_BYTES = 600_000` (600 KB) limiti koyuyor (`worker/index.js:240-243, 572` -> HTTP `413`). 3–4 açılı 512×512 PNG Base64'leri + çoklu aktör kolayca 600 KB'ı aşar ve `src/engine/cloudSync.ts:315, 370` (`if (putRes.ok)`) başarısız `413` yanıtını kullanıcıya hiçbir hata göstermeden sessizce yutar!
- **Çözüm:**
  1. `db.ts:collectAllReferencedBlobKeys` ve `exportEngine.ts:importPortableBackupZip` içine `fg.actors` (ve her aktörün `sourceBlobKey` + `decomposed`) döngüsünü ekleyin; buna regresyon testi yazın.
  2. `CharacterMasterRig.views[angle]` görsellerini proje JSON'una Base64 gömmek yerine `blobKey` olarak IndexedDB + `/api/cloud/blobs/:key` üzerinden saklayın; `cloudSync.ts`'te HTTP 4xx/5xx hatalarını `cloudSyncStatus: 'error'` olarak yüzeye çıkarın.
  3. `@testing-library/react` + `jsdom` + Miniflare/Vitest D1 + Playwright duman testleri ekleyin.

---

### 3. [YÜKSEK — PWA & OFFLINE KIRILMASI] `public/sw.js` Offline Fallback'ı Canlıda 307 Yönlendiren `/index.html`'i Önbelleğe Alıyor, Asset Precache Yok ve `skipWaiting`/`clients.claim` Aktif Sekmeleri Kırıyor
- **Ciddiyet:** YÜKSEK (`P1`)
- **Kanıt (`dosya:satır` + canlı `curl.exe`):**
  - **Redirected Response Offline Hatası:** `public/sw.js:2-11` `SHELL_URLS` içine hem `'/'` hem `'/index.html'` koymuş ve `sw.js:17` `cache.addAll(SHELL_URLS)` çağırıyor. Canlıda `curl.exe -sI https://inktrope.com/index.html` çıktısı:
    ```http
    HTTP/1.1 307 Temporary Redirect
    Location: /
    ```
    (`wrangler.jsonc:9` `"html_handling": "auto-trailing-slash"` sebebiyle). Bu yüzden `/index.html` önbellek girdisi `response.redirected === true` olarak saklanır. Çevrimdışı navigasyonda `sw.js:54` (`caches.match(event.request).then((c) => c || caches.match('/index.html'))`) bu redirected yanıtı döndüğünde, `redirect: 'manual'` modundaki tarayıcı navigation isteği Fetch/SW standardı gereği yanıtı reddeder (`ERR_FAILED`).
  - **Offline İlk Kurulum & Lazy Chunk Kırılması:** `public/sw.js:2-11` hiçbir JS/CSS/font/Web Worker chunk'ını precache etmiyor (`dist/assets/index-*.js`, `DrawWorkspace-*.js`, `FilmDirectorStudio-*.js`, `PuppetStudio-*.js`, `mp4-muxer-*.js`, `paperWorker-*.js`, `rigWorker-*.js` dahil). Çevrimdışı açılışta ziyaret edilmemiş herhangi bir modül tıklandığında `Suspense` / `ErrorBoundary` patlar.
  - **Koordinasyonsuz `skipWaiting()` + `clients.claim()` + Eski Cache Silme:** `public/sw.js:18, 27, 29` yeni SW'yi anında zorla devreye alıp eski cache'i siliyor; ancak `src/main.tsx:24-30` içinde `controllerchange`, `updatefound` veya `updateViaCache: 'none'` yok. Yeni deploy sonrası açık sekmeler eski hash'li lazy chunk'ı istediğinde `ChunkLoadError` alır.
  - **SWR Hataları:** `sw.js:59-72` hem `event.waitUntil(networkFetch)` çağırmıyor (SW arka plan yenilemesi kesilebilir), hem offline + cache miss durumunda `.catch(() => cached)` ile `undefined` döndürerek `TypeError: Failed to convert value to 'Response'` fırlatıyor, hem de immutable `/assets/*` dosyalarına her seferinde gereksiz ağ isteği atıyor. Ayrıca `sw.js:50` query string'leri (`/?auth=ok`, `/?mode=draw`) temizlemeden cache'liyor ve önbellekte hiçbir boyut/adet sınırı yok.
- **Çözüm:**
  1. `SHELL_URLS`'ten `/index.html`'i kaldırın (yalnızca `'/'` kullanın ve fallback'ta `caches.match('/')` dönün).
  2. Vite build aşamasında üretilen precache manifest'ini (ör. `vite-plugin-pwa` / `injectManifest` veya build-time asset listesi) kullanarak kritik kabuk JS/CSS/font/worker dosyalarını build hash'li cache adına bağlayın.
  3. `/assets/*` için **Cache-First** (hash değişince URL değişir), HTML için **Network-First** (query string normalize + `200 && !response.redirected`), offline + miss durumunda geçerli `new Response('', { status: 503 })` dönün; `main.tsx`'te `updateViaCache: 'none'` ve kontrollü güncelleme akışı ekleyin.

---

### 4. [YÜKSEK — GİZLİLİK / KVKK-GDPR & SEO ÇELİŞKİSİ] Gizlilik Politikası ile D1 Veritabanı Gerçekliği Çelişiyor; Canlıda Canonical-307 Döngüsü ve Yanlış Özellik Beyanları Var
- **Ciddiyet:** YÜKSEK (`P1`)
- **Kanıt (`dosya:satır` + canlı `curl.exe`):**
  - **Gizlilik / KVKK-GDPR Uyumsuzluğu #1 (Kalıcı AI Görsel Cache):** `public/privacy/index.html:88, 106` AI Yan Profil Eskiz Rehberi'nin *"geçici görseli"* (*"temporarily processes"*) işlediğini söylüyor. Oysa `worker/index.js:1276-1285` ve `migrations/0002_ai_budget_and_cache.sql:20-28` üretilen karakter yan profil görselini (`data_b64`, 680 KB'a kadar) **süresiz (TTL'siz) ve `user_id`'siz `ai_turnaround_cache` D1 tablosuna kalıcı olarak yazıyor**; ne bir temizleme cron'u ne de kullanıcı bazlı silme mekanizması var!
  - **Gizlilik / KVKK-GDPR Uyumsuzluğu #2 (Eksik Hesap Silme / Right to Erasure):** `public/privacy/index.html:93, 111` hesabın ve *"tüm bulut verilerinin"* tek tıkla kalıcı silindiğini beyan ediyor. Oysa `DELETE /api/auth/account` (`worker/index.js:377-382`) yalnızca `project_blobs`, `projects`, `sessions`, `users` tablolarını siliyor — kullanıcının `actor_key = 'u:' + uid` kayıtlarını tutan **`ai_usage_ledger` tablosunu SİLMİYOR!** Ayrıca `src/engine/db.ts:143-168` (`clearAllLocalStudioData`) `sessionStorage`'daki `inktrope:byok-gemini-key` (`src/engine/aiStudioClient.ts:15`) anahtarını temizlemiyor!
  - **Gizlilik / KVKK-GDPR Uyumsuzluğu #3 (Uygulama İçi Modal vs Web Politikası Sapması):** `src/components/legal/LegalPolicyModal.tsx` (`src/i18n/translations.ts:775-789, 1752-1766`) Cloudflare Workers AI'dan, `ai_usage_ledger`'da saklanan IP adresi SHA-256 hash'inden (`worker/index.js:783-788`) ve BYOK Gemini anahtarının Worker üzerinden proxy'lenmesinden (`worker/index.js:1002, 1023, 1176`) hiç bahsetmiyor.
  - **Canlı SEO Canonical-Redirect Döngüsü:** `public/sitemap.xml:10, 16`, `public/privacy/index.html:11`, `public/terms/index.html:11`, `index.html:118` ve `public/llms.txt:29-30` slash'sız `https://inktrope.com/privacy` ve `https://inktrope.com/terms` adreslerini kullanıyor. Canlıda (`wrangler.jsonc:9` `"html_handling": "auto-trailing-slash"`):
    - `curl.exe -sI https://inktrope.com/privacy` -> **`HTTP/1.1 307 Temporary Redirect` -> `Location: /privacy/`**
    - `curl.exe -sI https://inktrope.com/terms` -> **`HTTP/1.1 307 Temporary Redirect` -> `Location: /terms/`**
    Arama motoru `sitemap.xml` -> `/privacy` -> `307` -> `/privacy/` sayfasına gidiyor, orada `<link rel="canonical" href="https://inktrope.com/privacy" />` görüp tekrar 307 veren URL'ye geri dönüyor.
  - **Yanlış Özellik Beyanı (`index.html` & `llms.txt` vs Kod):** `index.html:90, 113` ve `public/llms.txt:8` 7 yaratık sınıfı arasında `arachnid_multi` (örümcek) ve `cute_blob` (kafa-bacak) olduğunu iddia ediyor; gerçek kodda (`src/engine/universalCreatureRig.ts:19-25`) bu iki sınıf **YOK**, gerçekte `aquatic_fish` (balık) ve `biped_tailed` (kuyruklu iki ayaklı/dinozor) var.
  - **Geçersiz `hreflang` & Dil Karışıklığı:** `index.html:13-15` hem `hreflang="tr"` hem `hreflang="en"` etiketini **aynı tek URL'ye (`https://inktrope.com/`)** bağlıyor; `og:title`/`og:description` + `og-card.png` Türkçe iken `twitter:title`/`twitter:description` İngilizce (`index.html:21-37`).
- **Çözüm:**
  1. `ai_turnaround_cache` için kısa TTL (örn. 24 saat) veya `user_id` kapsamlı otomatik silme ekleyin; `DELETE /api/auth/account` içine `DELETE FROM ai_usage_ledger WHERE actor_key = ?` ekleyin; `clearAllLocalStudioData` içine `sessionStorage.removeItem('inktrope:byok-gemini-key')` ekleyin; `LegalPolicyModal` ile `privacy/index.html`'i tam hizalayın (IP hash + Worker AI + BYOK proxy açıklansın).
  2. `sitemap.xml`, `canonical`, `llms.txt` ve iç linkleri `https://inktrope.com/privacy/` ve `https://inktrope.com/terms/` olarak eşitleyin (veya `wrangler.jsonc` `html_handling: "drop-trailing-slash"` yapıp 301 ile standardize edin).
  3. `index.html` ve `llms.txt`'deki yaratık listesini `universalCreatureRig.ts` ile birebir hizalayın; ayrı `/en/` URL'si yoksa çakışan `hreflang="en"` etiketini kaldırın.

---

### 5. [ORTA-YÜKSEK — VİRAL BÜYÜME & MOBİL DÖNÜŞÜM] Ölü Web Share API, Fotoğraf/Örnek Çizimde Sessizce Çalışmayan Paylaşım Linki, Yalan Toast, Mühürsüz Ana İhraç ve 9:16 Dikey Viral Format Yokluğu
- **Ciddiyet:** ORTA-YÜKSEK (`P1/P2`)
- **Kanıt (`dosya:satır`):**
  - **%100 Ölü Web Share Level 2 Kodu:** `src/engine/videoExportEngine.ts:336-357` `shareFileOnMobileIfSupported(blob, filename, title)` fonksiyonunu yazmış ve export etmiş; ancak tüm `src/` genelinde **0 çağrı yeri** var. `ExportModal.tsx`, `InstantAliveStage.tsx`, `FilmDirectorStudio.tsx`, `PuppetStudio.tsx`, `MeshWarpStage.tsx` tamamı yalnızca masaüstü `<a download>` (`triggerDownload`) kullanıyor; iOS/Android doğal Share Sheet (WhatsApp / Reels / TikTok / Fotoğraflar) hiç açılmıyor.
  - **Kırık Remix Link Butonu + Yalan Toast:** `src/components/desk/InstantAliveStage.tsx:2763-2787`:
    - Satır `2764`: `if (heroStrokesRef.current.length === 0) return;` — Kullanıcı fotoğraf yüklediyse, A4 taradıysa veya "Örnek Kahraman" (`sample-hero.png`) seçtiyse, aktif görünen "Link Paylaş" butonuna (`3620-3627`) bastığında **hiçbir şey olmuyor** (uyarı bile yok!).
    - Satır `2784-2786`: `catch { notify(t('shareCopied')); }` — Pano izni reddedilse veya `clipboard.writeText` hata fırlatsa bile kullanıcıya **"Link kopyalandı!"** yalan bildirimi gösteriliyor!
  - **Sıfır Atribüsyon & URL Eksikliği:**
    - `InstantAliveStage.tsx:2609-2760` (ana viral giriş ekranından 1 tıkla indirilen GIF ve MP4) `drawKagitSealStamp`'i **hiç çağırmıyor** — sıfır marka/site imzası!
    - `exportEngine.ts:27-68` (`drawKagitSealStamp`) yalnızca `INKTROPE` / `STUDIO` yazıyor, **`inktrope.com` alan adı yok** ve sadece son 0.45 saniyede görünüyor. Tüm GIF ihraçlarında (`exportEngine.ts:412`, `MeshWarpStage.tsx:1147`, `PuppetStudio.tsx:835`, `FilmDirectorStudio.tsx:1832`) mühür hiç yok.
  - **3 Ana Viral Motor 16:9 Yataya Kilitli (9:16 Dikey Reels/TikTok/Shorts İhracı YOK):**
    - `src/types/studio.ts:13` yalnızca `DrawWorkspace` proje oluşturmada `9:16` (`720×1280` — 1080×1920 değil) sunuyor.
    - `InstantAliveStage.tsx:2615-2616, 2685-2686` (`480×270` GIF, `960×540` MP4), `FilmDirectorStudio.tsx:1593-1594` (`1280×720`) ve `MeshWarpStage.tsx:977-978` / `PuppetStudio.tsx:853-854` (`1280×720`) **hardcoded 16:9**; proje `9:16` olsa bile kukla ve film ihracı yatay `1280×720` basıyor!
  - **Dinamik Sosyal Önizleme Yok:** `#kagit=...` URL hash'i sunucuya gitmediği için paylaşılan her remix linki WhatsApp/X/Discord/Telegram'da aynı statik Türkçe `og-card.png` kartını gösteriyor. Ayrıca PWA `beforeinstallprompt` kurulum teşviki hiç yok.
- **Çözüm:**
  1. Mobil cihazlarda tüm MP4/GIF ihraçlarına `shareFileOnMobileIfSupported` + "Paylaş / İndir" aksiyonu bağlayın.
  2. `handleShareRemixLink` içinde raster/fotoğraf karakter varsa dürüst yönlendirme (örn. "Fotoğraf karakterler için MP4/GIF paylaş" veya sunucu-tabanlı kısa `/s/:id` linki) yapın, `catch` bloğunda gerçek hata/manuel kopyalama gösterin ve mobilde `navigator.share({ title, url })` kullanın.
  3. `drawKagitSealStamp`'e okunaklı `inktrope.com` ekleyin (opsiyonel toggle ile) ve `InstantAliveStage` MP4/GIF ihracına bağlayın.
  4. `InstantAliveStage`, `FilmDirectorStudio` ve `PuppetStudio`/`MeshWarpStage` için 1-tık **9:16 Dikey (1080×1920)** Reels/TikTok/Shorts export kırpma/çerçeveleme seçeneği ekleyin.

---

## 3. Detaylı Denetim Matrisi

### 3.1. Gerçek Komut Koşuları (`npm test`, `npm run typecheck`, `npm run build`) ve Bundle Tablosu

| Denetim Maddesi | Durum | Gerçek Kanıt (Çıktı / Süre / Exit Code) | Not & Risk |
|---|---|---|---|
| `npm test` (`vitest run`) | `[PASS]` | Exit Code: **`0`** \| Vitest Duration: **`22.84s`** (Toplam duvar süresi: `27.072 ms`) \| **14/14 test dosyası, 117/117 test geçti** (`Vitest v3.2.7`) | Geçiyor ancak coverage aracı (`@vitest/coverage-v8`) yok; 58/92 dosya %0 testli (bkz. 3.2). |
| `npm run typecheck` (`tsc --noEmit`) | `[PASS]` | Exit Code: **`0`** \| Toplam süre: **`49.835 ms`** (paralel test/build yükü altında) \| 0 hata | **`tsconfig.json:19`** yalnızca `"include": ["src"]` kapsıyor — `worker/index.js` (1.322L) ve `public/sw.js` (73L) tip denetimi DIŞINDA! |
| `npm run build` (`tsc --noEmit && vite build`) | `[PASS]` | Exit Code: **`0`** \| Vite build: **`26.76s`** (tsc+vite toplam `81.095 ms`) \| `1695 modules transformed` \| `dist/`: **71 dosya, 2.449.574 bayt (2,34 MB)** | Derleme geçiyor fakat 1 adet **500 kB+ chunk uyarısı** ve 2 adet **kırık dynamic import uyarısı** var (aşağıda `[FAIL]`). |
| Ana JS Chunk Boyut Bütçesi (< 500 kB) | `[FAIL]` | `dist/assets/index-BjGFSWLz.js`: **`637.63 kB`** (`gzip: 209.59 kB`) — Vite `500 kB` eşiğini %27,5 aşıyor. İlk yükleme kritik JS+CSS: **`922.26 kB`** (`284.30 kB` gzip) | `InstantAliveStage.tsx` (3.704L) ve çekirdek skinning motorları doğrudan `StudioDeskHub` üzerinden ana entry chunk'a giriyor. |
| Dinamik Import / Code-Splitting Temizliği | `[FAIL]` | Vite build uyarısı: `characterIntakeEngine.ts` (`useStudioStore.ts` dinamik, 11 dosya statik) ve `meshWarpEngine.ts` (`useStudioStore.ts` dinamik, 3 dosya statik) ayrı chunk'a taşınamıyor | Kod-bölme niyeti statik import'lar tarafından boşa düşürülmüş. |
| Font Dağıtım Optimizasyonu | `[FAIL]` | `dist/assets/`: 16 `.woff2` (`197,98 kB`) + **16 eski `.woff` (`266,58 kB`)** = 32 font dosyası (`464,56 kB` toplam) | `@fontsource/*` eski `.woff` fallback'larını da `dist/`'e yayıyor; modern PWA hedefinde (`es2022`) gereksiz build/dağıtım şişkinliği. |
| Python Pipeline Testleri (`server/kagit_ai_pipeline`) | `[TEST EDİLMEDİ]` | `server/kagit_ai_pipeline/tests/test_pipeline.py` (124L, 8 `unittest` metodu) okundu; `npm test` kapsamı dışında olduğu için koşturulmadı | FastAPI HTTP uçları (`app.py:80-197`), CORS ve 413 sınırları bu dosyada test edilmiyor. |

#### Gerçek `dist/` Bundle & Chunk Dökümü (`npm run build` çıktısı)

| Çıktı Dosyası / Kategori | Ham Boyut | Gzip Boyutu | Rol / Yüklenme Zamanı |
|---|---:|---:|---|
| `dist/assets/index-BjGFSWLz.js` | **637.63 kB** | **209.59 kB** | **İlk yükleme (kritik — >500 kB uyarısı!)** |
| `dist/assets/react-vendor-BPiL1QK8.js` | 143.45 kB | 46.27 kB | İlk yükleme (`react`, `react-dom`, `zustand`, `idb-keyval`) |
| `dist/assets/icons-vendor-DDENCPmn.js` | 47.57 kB | 9.95 kB | İlk yükleme (`lucide-react`) |
| `dist/assets/index-B42hRhax.css` | 93.61 kB | 18.49 kB | İlk yükleme (Tailwind + özel stiller + font-face) |
| `dist/index.html` | 8.04 kB | 2.77 kB | İlk yükleme HTML kabuğu |
| **İlk Yükleme Kritik Toplam (JS+CSS+HTML)** | **930.30 kB** | **287.07 kB** | Fontlar ve `sample-hero.png` (`343.06 kB`) hariç |
| `dist/assets/FilmDirectorStudio-CVRS6p-6.js` | 120.21 kB | 31.00 kB | Lazy (Film modu) |
| `dist/assets/DrawWorkspace-R9TDtJNs.js` | 109.04 kB | 28.92 kB | Lazy (Çizim modu) |
| `dist/assets/PuppetStudio-uuA0qEti.js` | 99.31 kB | 27.59 kB | Lazy (Kukla modu) |
| `dist/assets/rigWorker-D0mFYSps.js` | 55.94 kB | — | Web Worker (Mesh/Rig oluşturma) |
| `dist/assets/film25dEngine-DfPlXGIE.js` | 52.74 kB | 19.31 kB | Lazy (Film motoru) |
| `dist/assets/mp4-muxer-CR73arlb.js` | 31.18 kB | 9.13 kB | Lazy (WebCodecs MP4 export) |
| `dist/assets/PaperCameraStudio-CKiEc9Xn.js` | 27.39 kB | 8.40 kB | Lazy (Kâğıt tarayıcı modu) |
| `dist/assets/ExportModal-DGWXSY_V.js` | 15.22 kB | 4.27 kB | Lazy (Dışa aktarma modalı) |
| `dist/assets/AccountModal-BIWU6vVq.js` | 14.27 kB | 4.71 kB | Lazy (Hesap/Bulut modalı) |
| `dist/assets/exportEngine-CwM_1OE7.js` | 13.40 kB | 5.15 kB | Lazy (İhraç motoru) |
| `dist/assets/StudioOverviewShow-Uu_V5k_5.js` | 11.19 kB | 3.91 kB | Lazy (10s tanıtım şovu) |
| `dist/assets/paperWorker-Da4250vn.js` | 10.40 kB | — | Web Worker (Kâğıt/GIF/FloodFill) |
| `dist/assets/StudioGuideOverlay-ClgvAt8x.js` | 7.80 kB | 3.00 kB | Lazy (Rehber turu) |
| `dist/assets/LegalPolicyModal-BMmdAZJu.js` | 7.39 kB | 2.25 kB | Lazy (Gizlilik/Performans modalı) |
| `dist/assets/frameComposite-D7YFQow1.js` | 5.15 kB | 2.15 kB | Lazy (Kare birleştirici) |
| `dist/assets/flipbookPdf-qTkcFyBd.js` | 4.24 kB | 2.08 kB | Lazy (A4 Flipbook PDF) |
| `dist/assets/starterPresets-DNjb3MHm.js` | 2.89 kB | 1.37 kB | Lazy (Başlangıç şablonları) |
| Fontlar (16 `.woff2` + 16 `.woff`) | 464.56 kB | — | Self-hosted Plus Jakarta Sans + JetBrains Mono |
| Görseller (`sample-hero.png` 343 kB, `og-card.png` 80 kB, ikonlar) | 422.99 kB | — | Statik görseller (`public/`) |
| **TÜM `dist/` TOPLAMI (71 dosya)** | **2.449.57 kB (2,34 MB)** | — | `_headers`, `_redirects`, `sw.js`, `privacy/`, `terms/` dahil |

---

### 3.2. 14 Vitest Testinin Derin Analizi ve Gerçek Kör Noktaları

#### Üretim Modülü Test Kapsam Haritası (`src/` + `worker/`)

| Klasör / Alan | Toplam Dosya | Toplam Satır | Doğrudan Testte Import Edilen Dosya | %0 Testli Dosya | %0 Testli Satır | Durum |
|---|---:|---:|---:|---:|---:|---|
| `src/components/*` | 35 | 27.484 | 1 (`ColorWheelPopover.tsx` — yalnız 1 saf helper!) | **34 (%97,1)** | **27.179 (%98,9)** | `[FAIL]` |
| `src/engine/*` | 47 | 32.819 | 28 | **19 (%40,4)** | **6.341 (%19,3)** | `[FAIL]` |
| `src/store/*` | 1 | 2.604 | 1 (`useStudioStore.ts` — ~%10 fonksiyon) | 0 (kısmi) | ~2.300+ (kısmi) | `[FAIL]` |
| `worker/*` | 2 | 1.355 | 1 (`worker/index.js` — auth+budget kısmi) | 1 (`.d.ts`) | ~600+ satır dal | `[FAIL]` |
| `src/i18n/*` | 1 | 1.969 | 1 (`translations.ts` — parite + jargon) | 0 | 0 | `[PASS]` |
| `src/types/*` | 3 | 690 | 2 | 1 (`masterRig.ts`) | 130 | `[FAIL]` |
| `src/root` (`App.tsx`, `main.tsx`, `vite-env.d.ts`) | 3 | 191 | 0 | **3 (%100)** | **191 (%100)** | `[FAIL]` |
| **TOPLAM** | **92** | **67.112** | **34 (%37,0)** | **58 (%63,0)** | **33.874 (%50,5)** | `[FAIL]` |

*(Test kodu toplamı: 14 dosya, 4.766 satır, 117 `it(...)` testi, 638 `expect(...)` çağrısı.)*

#### %0 Testli Kritik Alanlar Envanteri

| Kritik Alan | %0 Testli Dosyalar (Satır) | Risk / Kaçırılan Hata | Durum |
|---|---|---|---|
| **Tüm React UI & Etkileşim** | `FilmDirectorStudio.tsx` (4.066L), `InstantAliveStage.tsx` (3.704L), `MeshWarpStage.tsx` (2.383L), `PuppetStudio.tsx` (1.836L), `CharacterMasterModal.tsx` (1.489L), `PaperCameraStudio.tsx` (1.481L), `InteractiveLightboxStage.tsx` (1.408L), `DrawingStage.tsx` (1.181L), `AccountModal.tsx` (545L), `ExportModal.tsx` (439L), `LegalPolicyModal.tsx` (294L), `App.tsx` (150L), `StudioErrorBoundary.tsx` (101L) + 21 bileşen | `@testing-library/react`, `jsdom`/`happy-dom`, Playwright yok (`package.json:23-33`). Kırık butonlar (`handleShareRemixLink`), erişilebilirlik, mobil touch ve render çökmeleri sıfır koruma altında. | `[FAIL]` |
| **WebGL2 GPU Skinning Renderer** | `src/engine/webglSkinnedRenderer.ts` (1.167L) | `v3RendererParity.test.ts` adına rağmen WebGL2 shader'larını hiç çalıştırmıyor veya CPU ile karşılaştırmıyor. | `[FAIL]` |
| **Bulut Sync & AI İstemci** | `src/engine/cloudSync.ts` (378L), `src/engine/aiStudioClient.ts` (212L) | Çakışma çözümü, dirty-blob delta sync, HTTP 413 sessiz yutma (`cloudSync.ts:315`), BYOK timeout/hata yolları %0 testli. | `[FAIL]` |
| **Worker OAuth, AI Uçları, Kota & Gerçek SQL** | `worker/index.js:360-518, 708-727, 961-1296` | Google OAuth PKCE/callback (130L), `logout`, `blobs/gc`, `/api/ai/status`, `/api/ai/direct-film` başarı/BYOK/parser, `/api/ai/side-guide` D1 cache + FLUX multipart, 413/409 kotalar %0 testli. Mock D1 string-match (`cloudAccountIsolation.test.ts:61-198`) gerçek SQLite şemasını doğrulamıyor. | `[FAIL]` |
| **MP4 Muxer & Export Akışı** | `encodeFramesToMp4WebCodecs` (`videoExportEngine.ts:124-331`), `exportEngine.ts:70-822` (mühür hariç 750L+), `flipbookPdf.ts` (243L), `frameComposite.ts` (89L) | Gerçek MP4/GIF/PNG-ZIP/Sprite/PDF üretimi ve `.kagit.zip` import/export %0 testli (`importPortableBackupZip` V4 `actors` hatası kaçırılmış!). | `[FAIL]` |
| **Web Workers & Service Worker** | `rigWorker.ts` (140L), `rigWorkerClient.ts` (189L), `paperWorkerClient.ts` (119L), `public/sw.js` (73L) | Zero-copy ArrayBuffer transferi, worker `onerror` kurtarma, SW cache/offline/307 davranışı %0 testli. | `[FAIL]` |
| **Ses & Dünya & Başlangıç Motorları** | `soundEngine.ts` (494L), `liveAudioStudio.ts` (451L), `filmFoleyEngine.ts` (399L), `storybookWorlds.ts` (733L), `starterFlipbook.ts` (741L), `starterPresets.ts` (189L), `brushTextures.ts` (159L), `underlayGuides.ts` (228L), `normalMapEngine.ts` (106L) | Hiçbir birim testi yok. | `[FAIL]` |

#### 14 Mevcut Test Dosyasındaki Yüzeysel Assertion & Kör Nokta Kanıtları

| Test Dosyası | Test Sayısı | Tespit Edilen Kör Nokta / Zayıf Assertion (`dosya:satır`) | Durum |
|---|---:|---|---|
| `v4UniversalCreatures.test.ts` | 4 | **Başlık/İçerik Çelişkisi + Atlanan Sınıf:** Satır `119` *"animates ALL 7 creature classes"* derken satır `150` `if (cls !== 'humanoid')` ile `humanoid`'i atlıyor! Satır `229` başlığı *"amorphous silhouettes"* derken satır `230-236`'da **`amorphous_vehicle` assertion'ı hiç yok** (sadece 3/7 sınıf test edilmiş). Satır `200` `if (mesh!.inpaintedSocketOnlyRgba)` koşullu olduğu için alan `undefined` olursa sessizce geçer. | `[FAIL]` |
| `v3RendererParity.test.ts` | 3 | **Yanıltıcı İsim + Flaky Zamanlama:** Dosya adı "Renderer Parity" ama WebGL2'yi hiç import etmiyor, yalnızca `cpuRasterizer.ts` test ediyor. Satır `210` `expect(avgMs).toBeLessThan(35)` duvar saati benchmark'ı yük altında kararsız (bu koşuda test 3 `725 ms` sürdü). | `[FAIL]` |
| `conformingSkinning.test.ts` | 7 | Satır `312` başlığı *"and locks upward rigid swords"* diyor ama test gövdesinde kılıç testi **yok**. Satır `280` (`<= 6` inverted tris) ve `355` (`<= 4`) ters dönmüş üçgenleri tolere ediyor; yalnızca sentetik dikdörtgenler (`fillRect`) kullanılıyor. | `[FAIL]` |
| `productionReadiness.test.ts` | 5 | Satır `268-288` DoS testi `encodeSharedStage`'e sadece **40** stroke veriyor (`packStrokes` zaten 32'ye kırpıyor), sonra `<= 64` kontrol ediyor! `decodeSharedStage`'e ham el yapımı >64 stroke / >96 nokta / `NaN` / prototype-pollution token'ı gönderilmiyor. `encodeFramesToMp4WebCodecs` hiç test edilmiyor. | `[FAIL]` |
| `cloudAccountIsolation.test.ts` | 2 | Yalnızca 2 test; D1 yerine kırılgan `q.startsWith(...)` mock'u (`61-198`). OAuth Google, logout, GC, kota sınırları (409/413), expired session, duplicate email (409) ve SQL şema doğruluğu test edilmiyor. | `[FAIL]` |
| `v4MultiActorAndAiBudget.test.ts` | 7 | `worker/index.js` AI uçlarının sadece 403 CSRF reddi ve saf `checkAiBudgetAndQuota` fonksiyonu test edilmiş (`248-309`); `/api/ai/direct-film` & `/api/ai/side-guide` uçtan uca akışları, D1 cache, BYOK ve `sanitizeDirectedScreenplay` hiç test edilmiyor. | `[FAIL]` |
| `studio.test.ts` | 33 | Test 1 (`65-227`) & Test 21 (`764-795`) `collectAllReferencedBlobKeys` testinde V4 `filmGraph.actors` yok -> gerçek GC veri kaybı bug'ını kaçırdı. Test 14 (`507-533`) `exportEngine.ts`'ten yalnız mock-ctx üzerinde `drawKagitSealStamp` çağırıyor. Tüm görüntü testleri sentetik `fillRect`. | `[FAIL]` |
| `filmDirector.test.ts` | 8 | Test 4 (`125-140`) `createMockCanvasCtx()` sadece `save`/`fillRect`/`restore` çağrı sırasına bakıyor; çıktı piksel/renk doğruluğu yok. | `[FAIL]` |
| `characterIntake.test.ts` | 21 | Geniş senaryo kapsamı (gölge, kareli/çizgili/kırmızı çizgili defter, ahşap masa) **fakat** tamamı ideal sentetik `fillRectRgba` blokları — gerçek JPEG sıkıştırma gürültüsü, kamera perspektifi veya gerçek el çizimi PNG fixture'ı 0 adet. | `[PASS]` *(algoritmik)* / `[FAIL]` *(gerçek foto fixture eksik)* |
| `drawWorkspace.test.ts` | 10 | 2.604 satırlık `useStudioStore.ts`'nin yalnızca 5 dar akışını test ediyor; `bootstrap`, cloud sync, undo/redo, deleteProject, audio/puppet/film store aksiyonları %0 testli. | `[FAIL]` |
| `studioGuide.test.ts` | 3 | Satır `124` seçici formatını yalnız regex ile (`/^[data-tour=...]/`) doğruluyor; seçicilerin bileşen DOM'unda varlığını test etmiyor (elle doğrulamamızda 15 adımın tamamı bileşenlerde mevcut, 2'si dinamik ternary ile). | `[PASS]` *(kısıtlı)* |
| `puppetStudio.test.ts` | 7 | Bone cycle ve preset keyframe matematiği tutarlı, fakat gerçek canvas render, audio RMS senkronu ve UI etkileşimi test edilmiyor. | `[PASS]` *(algoritmik)* |
| `v3BiomechanicsAndTopology.test.ts` | 4 | 21 kemik, Ink-Watershed ve Reverse-Foot IK için güçlü sayısal assertion'lar; ancak sadece 2 sentetik `fillRect` karakteri ve `<= 4` inversion toleransı (`247`). | `[PASS]` *(algoritmik)* |
| `v3ArapAndNaturalWalk.test.ts` | 3 | ARAP ada izolasyonu ve ayak roll eğrileri net test edilmiş; ekstrem/dejenere mesh veya 0-pin edge case'leri yok. | `[PASS]` *(algoritmik)* |

---

### 3.3. `wrangler.jsonc` vs `vercel.json` (+ `public/_headers`, `public/_redirects`, `vite.config.ts`) Karşılaştırması

| Özellik / Alan | `wrangler.jsonc` + `worker/index.js` (Canlı Üretim) | `vercel.json` (Alternatif / Artık Config) | `public/_headers` & `public/_redirects` (Pages Artığı) | Sapma / Dağıtım Riski | Durum |
|---|---|---|---|---|---|
| **Backend & `/api/*` Yönlendirmesi** | `wrangler.jsonc:4,11`: `main: "./worker/index.js"`, `run_worker_first: ["/api/*"]`. Auth, Cloud Vault, Workers AI tam aktif. | `vercel.json:36-38`: **`"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]`** — `/api/*` dahil TÜM yolları `index.html`'e ezer; Vercel'de `/api/*` fonksiyonu yok! | `public/_redirects:1`: `/* /index.html 200` — Workers Assets'ta yok sayılıyor (Pages'te olsa `/api/*` ile çakışır). | Vercel'e deploy edilirse Auth, Cloud Sync ve AI **%100 çalışmaz** (HTML 200 döner). | `[FAIL]` |
| **SPA Fallback & 404** | `wrangler.jsonc:10`: `not_found_handling: "single-page-application"`. Canlı `/nonexistent-spa-route-check-404` -> `200 text/html`. | `vercel.json:37`: `/(.*) -> /index.html` (statik dosya yoksa). | `public/_redirects:1`: `/* /index.html 200`. | Bilinmeyen rotalar (örn. yazım hatalı bot URL'leri) `404` yerine `200` (`index.html`) dönüyor (Soft-404 SEO riski, SPA'da beklenen davranış ama canonical koruyor). | `[PASS]` *(SPA)* |
| **HTML Trailing Slash & `/privacy`, `/terms`** | `wrangler.jsonc:9`: `html_handling: "auto-trailing-slash"`. Canlıda `/privacy` -> **307** `/privacy/`, `/terms` -> **307** `/terms/`, `/index.html` -> **307** `/`. | `trailingSlash` tanımlı değil (varsayılan `false` -> `/privacy` 200/308 farklı davranır). | `_redirects` bunu ele almıyor. | İki platformda URL yapısı çelişiyor; Cloudflare'deki `307` canlıda **SEO canonical döngüsü** ve **SW offline kırılması** yaratıyor! | `[FAIL]` |
| **Güvenlik Başlıkları (CSP, HSTS, XFO, vb.)** | **CANLIDA YOK!** `worker/index.js` sadece `/api/*` yanıtlarına `X-Content-Type-Options: nosniff` ve `Cache-Control: no-store` ekliyor (`29-30, 701-702`). Statik HTML/JS/CSS'te **0 güvenlik başlığı!** | `vercel.json:3-22`: Tüm güvenlik başlıkları tanımlı, **FAKAT** satır `19` CSP `img-src 'self' data: blob:` — **`https://lh3.googleusercontent.com` EKSİK!** (Google avatarı kırılır!) | `public/_headers:1-7`: Tüm başlıklar + `lh3.googleusercontent.com` var — **FAKAT Workers Static Assets bunu YOK SAYIYOR!** | Üç dosya birbiriyle çelişiyor; canlı sitede güvenlik başlıkları **fiilen kapalı**! | `[FAIL]` |
| **Statik Asset Caching (`/assets/*`)** | **CANLIDA `max-age=0, must-revalidate`!** (`curl.exe -sI .../index-BjGFSWLz.js`). | `vercel.json:30-34`: `public, max-age=31536000, immutable`. | `public/_headers:15-16`: `public, max-age=31536000, immutable` (etkisiz). | Hash'li JS/CSS/font dosyaları canlıda tarayıcı cache'inde uzun süre kalamıyor, her seferinde revalidation yapıyor. | `[FAIL]` |
| **`sw.js` & `index.html` Cache-Control** | Canlıda ikisi de `public, max-age=0, must-revalidate`. | `vercel.json:24-28`: `no-cache, no-store, must-revalidate` (`/` kökü regex'le eşleşmiyor! Yalnız `/index.html` ve `/sw.js` eşleşir). | `public/_headers:9-13`: `/index.html` ve `/sw.js` `no-cache, no-store, must-revalidate` (`/` eşleşmiyor + Workers'ta etkisiz). | `/` kök URL'si hem `vercel.json`'da hem `_headers`'ta `no-store` kapsamına alınmamış. | `[FAIL]` |
| **D1 & Workers AI & Secrets Binding** | `wrangler.jsonc:13-22`: `DB` (`inktrope-db`, id `bb2b7499-...`), `AI`, `GOOGLE_CLIENT_ID`/`SECRET` (secrets). Canlıda hepsi aktif. | Yok (Vercel'de bağlanamaz). | Yok. | Proje Cloudflare Workers'a sıkı bağlı; `vercel.json` ve `_headers`/`_redirects` canlıyla bağdaşmayan hayalet/artık config'ler. | `[FAIL]` |
| **`vite.config.ts` Build & Worker Ayarları** | `vite.config.ts:6-19`: `worker.format: 'es'`, `target: 'es2022'`, `sourcemap: false`, `manualChunks` (`react-vendor`, `icons-vendor`). | Aynı `dist/` çıktısını kullanır. | `public/*` olduğu gibi `dist/`'e kopyalanır (hatta `dist/_headers` ve `dist/_redirects` oluşur). | `sourcemap: false` üretimde hata ayıklamayı zorlaştırır; `manualChunks` ana `index` chunk'ını 637 kB altında tutamıyor. | `[FAIL]` |

---

### 3.4. `public/sw.js` Cache Stratejisi ve Risk Analizi

| Denetim Maddesi | Durum | Kod & Canlı Kanıt (`dosya:satır`) | Risk Değerlendirmesi |
|---|---|---|---|
| `/api/*` & Auth Yanıtlarının Cache Dışı Tutulması | `[PASS]` | `public/sw.js:34-38`: `if (event.request.method !== 'GET') return;`, `if (url.origin !== self.location.origin) return;`, `if (url.pathname.startsWith('/api/')) return;` | `/api/auth/*`, `/api/cloud/*` ve `/api/ai/*` yanıtları SW tarafından hiç yakalanmaz ve önbelleğe sızmaz. |
| HTML Navigation Stratejisi (Network-First) | `[FAIL]` | `public/sw.js:41-57`: Network-First doğru niyet, **FAKAT** (1) `cache.put(event.request, clone)` query string'leri (`/?auth=ok`, `/?mode=draw`) ayrı ayrı cache'liyor; (2) offline fallback satır `54` `caches.match('/index.html')` canlıda `307 -> /` ile redirect olmuş (`response.redirected === true`) yanıtı dönerek offline navigation'ı çökertir! | Çevrimdışı alt rota / query-param açılışında `ERR_FAILED` riski + gereksiz cache girdileri. |
| Precache (`SHELL_URLS`) Kapsamı & Offline Çalışabilirlik | `[FAIL]` | `public/sw.js:2-11`: Sadece `/`, `/index.html`, manifest, ikonlar ve `og-card.png` precache ediliyor. **SIFIR** JS (`index-*.js`, `react-vendor-*.js`, `DrawWorkspace-*.js`, `paperWorker-*.js`, `rigWorker-*.js`), **SIFIR** CSS, **SIFIR** font precache var! | İlk ziyaret sonrası veya ziyaret edilmemiş bir stüdyo modülü açılırken çevrimdışına geçilirse uygulama beyaz ekran / modül yükleme hatası verir. |
| Asset Cache Stratejisi (SWR vs Cache-First) | `[FAIL]` | `public/sw.js:59-72`: Hash'li `/assets/*.js|css|woff2` dahil her statik dosyada SWR çalışıyor -> her yüklemede arka planda gereksiz ağ isteği + `event.waitUntil(networkFetch)` eksik + cache miss & offline'da `.catch(() => cached)` `undefined` dönerek `TypeError` üretiyor. | Gereksiz bant genişliği/revalidation yükü, yarıda kesilen güncellemeler ve offline TypeError. |
| Cache Versiyonlama & Temizleme (`activate`) | `[FAIL]` | `public/sw.js:1, 22-31`: `CACHE_NAME = 'inktrope-v4.4'` elle yazılan statik string. Build hash'ine bağlı değil; `activate` eski cache adını siler ama aynı `v4.4` içinde yeni deploy yapılırsa eski hash'li `/assets/*` dosyaları süresiz birikir. Cache boyut/adet limiti **YOK**. | Deploy unutulursa eski asset'ler birikir, depolama kotası şişer. |
| `skipWaiting()` / `clients.claim()` & Güncelleme Döngüsü | `[FAIL]` | `public/sw.js:18, 29` koşulsuz `skipWaiting()` + `clients.claim()`. `src/main.tsx:24-30` yalnızca `navigator.serviceWorker.register('/sw.js')` çağırıyor — `updateViaCache: 'none'`, `updatefound`, `controllerchange` veya kullanıcıya "Yeni sürüm hazır" bildirimi **YOK**. | Açık sekme eski `index.html` ile çalışırken yeni SW eski cache'i siler -> lazy chunk `ChunkLoadError`! |
| `sw.js` Otomatik Test Kapsamı | `[FAIL]` | 14 Vitest test dosyasında `sw.js` için **0 test** var. | Yukarıdaki 307 redirect ve `undefined` Response hataları hiç yakalanmamış. |

---

### 3.5. Manifest, İkonlar, OG/Twitter, `llms.txt`, `robots.txt`, `sitemap.xml`, IndexNow, `privacy` & `terms` — Yerel vs Canlı `https://inktrope.com`

#### Canlı vs Yerel Birebir Karşılaştırma Tablosu (`curl.exe` kanıtlı, 24 Kasım 2026)

| Uç Nokta (`https://inktrope.com...`) | HTTP Durum | `Content-Type` | Canlı `Cache-Control` | Güvenlik Başlıkları | Yerel vs Canlı Gövde (SHA-256) | Sonuç |
|---|---|---|---|---|---|---|
| `/` | `200 OK` | `text/html` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`8041 B`, `fb7811ea3021`, `dist/index.html`) | `[FAIL]` *(header yok)* |
| `https://www.inktrope.com/` | `301 Moved Permanently` | `text/html; charset=UTF-8` | — (`Location: https://inktrope.com/`) | Yok | N/A | `[PASS]` |
| `/manifest.webmanifest` | `200 OK` | `application/manifest+json` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`1989 B`, `513a5a1b0a09`) | `[PASS]` *(içerik)* / `[FAIL]` *(maskable/screenshots)* |
| `/sw.js` | `200 OK` | `text/javascript` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`2159 B`, `b3ebff86f93b`) | `[FAIL]` *(no-store yok + SW bug'ları)* |
| `/robots.txt` | `200 OK` | `text/plain` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`82 B`, `7600153657ea`) | `[PASS]` |
| `/sitemap.xml` | `200 OK` | `application/xml` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`583 B`, `b7c774276378`) | `[FAIL]` *(/privacy & /terms 307 veriyor)* |
| `/llms.txt` | `200 OK` | `text/plain` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`3531 B`, `331332ec055f`) | `[FAIL]` *(yanlış yaratık listesi + 307 linkler)* |
| `/privacy` | **`307 Temporary Redirect`** | — (`Location: /privacy/`) | — | **YOK** | Redirect | `[FAIL]` *(307 + canonical çelişkisi)* |
| `/privacy/` | `200 OK` | `text/html` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`8670 B`, `a641466fc371`) | `[FAIL]` *(canonical & D1 uyumsuzluğu)* |
| `/terms` | **`307 Temporary Redirect`** | — (`Location: /terms/`) | — | **YOK** | Redirect | `[FAIL]` *(307 + canonical çelişkisi)* |
| `/terms/` | `200 OK` | `text/html` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`4797 B`, `d5b521163b2f`) | `[FAIL]` *(canonical çelişkisi)* |
| `/og-card.png` | `200 OK` | `image/png` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`80328 B`, `d2f6ed10649a`, `1200×630`) | `[FAIL]` *(og-card.svg ile sapma + TR/EN uyumsuz)* |
| `/7c9e4b2a1f8d3e6c5a0b9d4f2e8a1c7b.txt` | `200 OK` | `text/plain` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`32 B`, `36b14e85558b`, içerik = dosya adı) | `[PASS]` *(IndexNow formatı doğru)* |
| `/icon-180.png`, `/icon-192.png`, `/icon-512.png`, `/icon.svg` | `200 OK` | `image/png` / `image/svg+xml` | `public, max-age=0, must-revalidate` | **YOK** | **%100 Eşit** (`180×180`, `192×192`, `512×512`, 8-bit RGBA) | `[FAIL]` *(maskable şeffaf köşeli)* |
| `/assets/index-BjGFSWLz.js` & `.css` | `200 OK` | `text/javascript` / `text/css` | **`public, max-age=0, must-revalidate`** | **YOK** | Hash yerel `dist/` ile birebir aynı | `[FAIL]` *(immutable cache yok)* |
| `/api/auth/me` (GET / HEAD) | `200 OK` (GET) / `404` (HEAD) | `application/json; charset=utf-8` | `no-store` | `nosniff` | `{"user":null,"googleEnabled":true}` | `[PASS]` *(GET)* |
| `/api/ai/status` (GET) | `200 OK` | `application/json; charset=utf-8` | `no-store` | `nosniff` | `{"ok":true,"aiAvailable":true,"monthlyBudgetCapped":false,...}` | `[PASS]` |

#### Teknik, SEO ve Hukuki Uyum Kontrolleri

| Denetim Maddesi | Durum | Detaylı Kanıt (`dosya:satır`) |
|---|---|---|
| **Manifest Kısayolları (`shortcuts`) İşlevselliği** | `[PASS]` | `public/manifest.webmanifest:13-42` (`/?mode=draw|paper|puppet|film`) -> `src/store/useStudioStore.ts:619-635` URL parametresini okuyup başlangıç modunu açıyor ve `history.replaceState` ile temizliyor. |
| **Manifest İkonları & Richer Install UI** | `[FAIL]` | `public/manifest.webmanifest:48,54`: `purpose: "any maskable"` tek girdide birleştirilmiş ve görsel incelemede `public/icon-512.png` **şeffaf dış köşeli squircle** — maskable ikonlar tam opak olmalı! Ayrıca `screenshots` ve `scope` alanı yok. |
| **OG / Twitter Kartları & `og-card.svg` Paritesi** | `[FAIL]` | `public/og-card.png` (1200×630, 80 KB) görsel olarak okunaklı fakat: (1) alt satırda `inktrope.com · %100 Cihazında · Hesapsız` yazıyor, bu satır `public/og-card.svg`'de yok (kaynak-çıktı sapması); (2) `index.html:21-37` `og:title/description` Türkçe iken `twitter:title/description` İngilizce, ikisi de Türkçe `og-card.png`'ye işaret ediyor; (3) `og-card.png` V4 özelliklerini (7 yaratık, 360° 2.5D, 1–6 oyuncu) yansıtmıyor. |
| **HTML Meta, `hreflang`, JSON-LD & Versiyon Tutarlılığı** | `[FAIL]` | (1) `index.html:13-15` `hreflang="tr"` ve `hreflang="en"` aynı tek URL'ye (`https://inktrope.com/`) işaret ediyor (geçersiz çok dilli yapı); (2) `index.html:90, 113` & `public/llms.txt:8` kodda olmayan `arachnid_multi` (örümcek) ve `cute_blob` (kafa-bacak) sınıflarını yazıyor (`src/engine/universalCreatureRig.ts:19-25` gerçekte `aquatic_fish` ve `biped_tailed` içerir); (3) `index.html:77` & `llms.txt:5` sürüm `4.1` derken `sw.js:1` `inktrope-v4.4`. |
| **`robots.txt` & IndexNow Anahtar Dosyası** | `[PASS]` | `public/robots.txt:1-5` `/api/` engelleyip `Sitemap: https://inktrope.com/sitemap.xml` bildiriyor. `public/7c9e4b2a1f8d3e6c5a0b9d4f2e8a1c7b.txt` dosya adı ile 32-bayt içeriği birebir eşleşiyor ve canlıda `200 text/plain` dönüyor. |
| **`sitemap.xml` & Canonical URL Uyumluluğu** | `[FAIL]` | `public/sitemap.xml:10,16` ve `public/privacy/index.html:11`, `public/terms/index.html:11` trailing slash olmadan `/privacy` ve `/terms` veriyor; canlı Cloudflare Workers Assets bunlara **307 Temporary Redirect** -> `/privacy/` ve `/terms/` dönüyor. |
| **Privacy & Terms vs Gerçek Veri İşleme Tutarlılığı** | `[FAIL]` | (1) `privacy/index.html:88,106` AI yan profil görselinin "geçici" olduğunu beyan ederken `worker/index.js:1276-1285` bunu TTL'siz `ai_turnaround_cache`'e kalıcı yazıyor; (2) `privacy/index.html:93,111` hesap silmede tüm bulut verilerinin silindiğini söylerken `worker/index.js:377-382` `ai_usage_ledger` (`actor_key = 'u:...'`) ve `ai_turnaround_cache`'i silmiyor; (3) `db.ts:157-165` (`clearAllLocalStudioData`) BYOK Gemini `sessionStorage` anahtarını silmiyor; (4) `LegalPolicyModal.tsx` (`translations.ts:775-789`) Workers AI, IP hash (`worker/index.js:783-788`) ve BYOK Worker proxy'sinden hiç bahsetmiyor; (5) `privacy/index.html` ve `terms/index.html` sayfalarında `og:*` meta yok ve uygulama arayüzünde (`/privacy/`, `/terms/`) statik sayfalara doğrudan link yok (sadece `<noscript>` içinde `index.html:118`). |

---

### 3.6. Viral Paylaşım, Deep-Link, Web Share API, Sosyal Önizleme ve Büyüme Denetimi

| Büyüme / Paylaşım Kabiliyeti | Durum | Kod Kanıtı (`dosya:satır`) & Eksik Analizi |
|---|---|---|
| **Web Share API (`navigator.share` / Dosya Paylaşımı)** | `[FAIL]` | `src/engine/videoExportEngine.ts:336-357` `shareFileOnMobileIfSupported` fonksiyonunu yazmış ama proje genelinde **0 çağrı yeri** (ölü kod). Mobil kullanıcılar MP4/GIF'i doğrudan WhatsApp/Reels/TikTok/iOS Fotoğraflar paylaşım menüsüne gönderemiyor; yalnızca `<a download>` çalışıyor. |
| **Serverless Remix Link (`#kagit=...`) & Deep-Link** | `[FAIL]` | `src/engine/shareCodec.ts` ve `InstantAliveStage.tsx:1640-1690, 2763-2787` yalnızca ana sayfa vektör çizimlerini (stroke) destekliyor. **Kırıklar:** (1) Fotoğraf, A4 tarama veya Örnek Kahraman yüklendiğinde `heroStrokesRef.current.length === 0` nedeniyle `2764` sessizce `return` ediyor (buton bozuk gibi davranıyor); (2) Pano hatasında `2785` yalan `"shareCopied"` toast'u gösteriyor; (3) Draw, Paper, Puppet, Film projeleri veya 360° çoklu açılı karakterler için hiçbir paylaşım linki yok. |
| **Mod Deep-Link (`/?mode=...`)** | `[PASS]` | `src/store/useStudioStore.ts:619-635` `/?mode=draw`, `/?mode=paper`, `/?mode=puppet`, `/?mode=film` deep-link'lerini açılışta işleyip URL'yi temizliyor. |
| **Sosyal Önizleme (Dinamik OG / Watch Sayfası)** | `[FAIL]` | `#kagit=...` hash parçası sunucuya gitmediği için sosyal ağlar/mesajlaşma uygulamaları her paylaşımda sabit Türkçe `og-card.png` gösterir. Paylaşılabilir sunucu destekli `/s/:id` veya `/watch/:id` + dinamik `og:image`/`og:video` altyapısı yok. |
| **Marka Atribüsyonu / Filigran (`drawKagitSealStamp`)** | `[FAIL]` | (1) Ana viral giriş noktası `InstantAliveStage.tsx:2609-2760` (1-tık GIF & MP4) mührü **hiç basmıyor**; (2) Tüm GIF ihraçları mühürsüz; (3) `exportEngine.ts:27-68` mühründe **`inktrope.com` URL'si yok** (sadece `INKTROPE / STUDIO` yazıyor ve son 0.45s görünüyor). |
| **9:16 Dikey Sosyal Medya Formatları (Reels / TikTok / Shorts)** | `[FAIL]` | `src/types/studio.ts:13` yalnızca Draw proje açılışında `720×1280` (1080×1920 değil) sunuyor. Ana viral motorlar tamamen **16:9 yataya kilitli**: `InstantAliveStage.tsx:2615-2616, 2685-2686` (`480×270`, `960×540`), `FilmDirectorStudio.tsx:1593-1594` (`1280×720`), `MeshWarpStage.tsx:977-978` (`1280×720`), `PuppetStudio.tsx:853-854` (`1280×720`). |
| **Before/After Reels & Timelapse İhracı** | `[PASS]` *(kısmi)* / `[FAIL]` *(format)* | `ExportModal.tsx:303-341` + `exportEngine.ts:301-407` Before/After perde geçişli klip ve çizim timelapse üretiyor; ancak `exportBeforeAfterReel` WebCodecs MP4 yolunu kullanmıyor (`MediaRecorder` zorunlu -> Firefox'ta WebM, WebView'da hata) ve 9:16 dikey değil proje oranında çıkıyor. |
| **PWA Kurulum Teşviki (`beforeinstallprompt`)** | `[FAIL]` | Tüm `src/` taramasında `beforeinstallprompt` için **0 eşleşme**. Kullanıcıya uygulama içi "Ana Ekrana Ekle / Kur" akışı sunulmuyor. |

---

## 4. Önceliklendirilmiş Eylem Planı (Hızlı Kazanım -> Yapısal İyileştirme)

1. **Gün 1 (Canlı Güvenlik & Cache Düzeltmesi):** Cloudflare Transform Rules veya Worker static wrapper ile `CSP` (Google avatar dahil), `HSTS`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `/assets/*` `immutable` ve `/sw.js` `no-store` başlıklarını canlıya alın; `sitemap.xml` + `canonical` + `llms.txt` `/privacy/` & `/terms/` trailing-slash uyumunu sağlayın.
2. **Gün 1–2 (Veri Kaybı & KVKK Düzeltmeleri):** `db.ts:collectAllReferencedBlobKeys` ve `exportEngine.ts:importPortableBackupZip` içine `filmGraph.actors` desteğini ekleyin; `DELETE /api/auth/account` içine `ai_usage_ledger` silmeyi, `ai_turnaround_cache`'e TTL/temizleme ekleyin; `clearAllLocalStudioData`'da `inktrope:byok-gemini-key` temizleyin; `LegalPolicyModal` ile `privacy/index.html` ve `index.html`/`llms.txt` yaratık listesini koda eşitleyin.
3. **Gün 2–3 (PWA & Service Worker Sertleştirme):** `public/sw.js`'ten `/index.html`'i kaldırıp `/` fallback kullanın; build-time asset precache + `/assets/*` Cache-First + offline 503 response + `main.tsx` `updateViaCache: 'none'` + güncelleme bildirimi ekleyin; `manifest.webmanifest`'te `any` ve opak `maskable` ikonlarını ayırıp `screenshots` ekleyin.
4. **Gün 3–5 (Viral Büyüme & Bundle):** `shareFileOnMobileIfSupported`'ı tüm MP4/GIF ihraçlarına bağlayın; `InstantAliveStage` paylaşım linki raster fallback + gerçek clipboard hata kontrolü + `inktrope.com` mührü + 9:16 (1080×1920) dikey Reels/TikTok/Shorts ihracı ekleyin; `characterIntakeEngine` / `meshWarpEngine` import çakışmalarını ve 637 kB `index` chunk'ını bölün.
5. **Sürekli (Test Altyapısı):** Vitest coverage (`@vitest/coverage-v8`), `cloudSync.ts`, `aiStudioClient.ts`, `worker/index.js` OAuth/AI/gerçek D1 testleri, `exportEngine` `.kagit.zip` round-trip (multi-actor dahil), `sw.js` birim testi ve en az 5 kritik akış için Playwright E2E testi (`Çiz -> Canlandır -> MP4/GIF`, `A4 Tara`, `Kukla`, `Film`, `Bulut Giriş`) kurun.
