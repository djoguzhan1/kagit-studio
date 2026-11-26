# INKTROPE / Kâğıt Studio — Faz 2 Denetim Raporu #5: Motor Gücü, Algoritmalar & WebGL2 Mühendisliği

- **Denetçi Rolü:** Bağımsız Motor Gücü & WebGL2 Mühendisi (Ajan 5)
- **Hedef Proje:** `C:\Users\salat\Downloads\kagit-studio` | **Canlı Ortam:** `https://inktrope.com`
- **Ölçüm Ortamı:** Windows 11, Node `v24.14.0`, Headless Chrome `158.0.0.0`, NVIDIA GeForce RTX 3050 6GB Laptop GPU (`ANGLE Direct3D11 / WebGL 2.0`), 12 mantıksal çekirdek, 16 GB RAM, Lighthouse `13.6.0`
- **İzole Prod Build:** `npx vite build --outDir <scratch>\agent5\dist5` (proje `dist/` ve `src/` dizinlerine **hiç dokunulmamıştır**)

---

## 1. Yönetici Özeti & Dürüst Puan

### **Dürüst Mühendislik Puanı: `4.5 / 10`**

INKTROPE'un 2D/2.5D motoru kâğıt üzerinde iddialı bir mimariye sahip: 200px Viterbi mürekkep-havza (Ink-Watershed) ayrıştırması, 21 kemikli Reverse-Foot Roll IK, top-left kurallı sıfır dikişli CPU scanline rasterizer ve WebGL2 donanım hızlandırmalı mesh render hattı. Gerçek RTX 3050 donanımında Film (52.1 FPS @ 4x CPU) ve Puppet (118.4 FPS @ 4x CPU) sahneleri akıcı çizilebiliyor ve CLS skoru kusursuza yakın (`0.0002` lokal / `0.0007` canlı).

Ancak derin kaynak kod denetimi ve canlı Chrome CDP + Lighthouse ölçümleri, motorun üretim kalitesini ciddi biçimde zedeleyen **doğrulanmış matematiksel matris hatalarını, %0 WebGL/VRAM temizliğini (kanıtlı doku/tampon ve JS Heap sızıntısını), ana iş parçacığını 1.0–1.8 sn donduran başlangıç/worker atlamalarını ve 4x CPU altında 23 FPS'e çöken açılış masasını** ortaya koymaktadır.

#### Puan Kırılma Gerekçesi (`10.0 - 5.5 = 4.5 / 10`)

| Kalem | Kesinti | Kanıtlı Gerekçe |
|---|---:|---|
| 1. GPU Skinning & CoR Matematik/Matris Hataları | **-1.8** | `universalCreatureRig.ts:1378` GPU'da uzuvları **203 px** kaydırıyor; `drawInpaintedSocketBackingPass` (`webglSkinnedRenderer.ts:837`) koltuk altı yamasını **145.4 px** kaydırıyor; CoR tam-açı antipodal işaret çevirmesi (`dualQuatSkinning.ts:753`, `webglSkinnedRenderer.ts:146`) **91°'de 90° ani kırılma** yaratıyor. |
| 2. WebGL/VRAM Temizlik Yokluğu & Bellek Sızıntısı | **-1.3** | Tüm depoda `deleteTexture`, `deleteBuffer`, `deleteVertexArray`, `deleteFramebuffer` çağrısı **0**. Canlı CDP'de 8 yeniden canlandırmada `10/10` doku ve `10/10` VBO/IBO silinmeden kaldı (`deleted=0`); 12 mod geçişinde V8 canlı heap her döngüde tekdüze arttı (`6.21 → 7.57 MB`, `+%21.9`), 13 `ImageBitmap` hiç kapatılmadı. |
| 3. İlk Yükleme TBT, Eager Bundle & 4x CPU Desk Çöküşü | **-1.1** | Lighthouse Mobil: canlı **`61/100` (TBT `1,664 ms`, LCP `3.3 s`)**, lokal **`68/100` (TBT `2,400 ms`)**, lokal Masaüstü **`78/100` (TBT `516 ms`)**. Eager `index` chunk **`637.63 kB` raw (`209.59 kB` gzip)** (`469 KiB` kullanılmayan JS). 4x CPU Desk Hub **`23.09 FPS`**, 5.5 sn içinde **62 adet 64–99 ms Long Task**. |
| 4. Worker Baypasları, Yaşam Döngüsü & ARAP/Verlet İsrafı | **-0.8** | Film/Puppet/DeskLightbox `rigWorker`'ı baypas edip senkron `getOrBuildCachedRigPack` koşuyor (canlı CDP'de `workers.created=0`, Film açılışında **`1,274 ms`**, Puppet açılışında **`877 ms`** donma). Hiçbir worker'da `.terminate()` yok; `paperWorkerClient.ts:35` hata sonrası ölü worker'ı önbellekte tutuyor. `arapSolver.ts:209` her karede Dijkstra koşuyor; `verletPhysics.ts` `dt`'siz ve her karede ~30 nesne tahsis ediyor. |
| 5. WebGL2 ↔ CPU Parite Sapmaları & Dinamik VBO Düşüşü | **-0.5** | `webglSkinnedRenderer.ts` ve `cpuRasterizer.ts` arasında **7 somut matematik/görsel sapma** (normalize edilmemiş Klaus ışık vektörüyle %67.8 gölge farkı dahil); `v3RendererParity.test.ts` WebGL ile CPU'yu hiç karşılaştırmıyor; `canPureGpuSkin` eşikleri yüzünden Film oynatmada **898 kez `DYNAMIC_DRAW` VBO yüklemesi** yapılıyor; VAO kullanımı **0**. |

---

## 2. EN AĞIR 5 SORUN (Öncelik Sıralı)

### SORUN #1 — [KRİTİK / DOĞRULUK] GPU Skinning, CoR Rotasyon ve Socket Backing Matris Hataları (`203 px`, `145 px`, `90° Flip`)
- **Ciddiyet:** Kritik (Görsel Bozulma & Geometri Çökmesi)
- **Etki:** Donanım WebGL2 aktifken evrensel yaratık uzuvları (dört ayaklı, kuş, balık, kuyruklu vb.) viewport dışına **200+ px** fırlar; hümanoid koltuk altı inpaint yaması gövde eğildiğinde karakterden **145 px** kopar; herhangi bir eklem >90° büküldüğünde hem CPU hem GPU CoR skinning **90° ters döner**.
- **Kod & Sayısal Kanıt:**
  1. **Evrensel Yaratık GPU Koordinat Uzayı Uyumsuzluğu:** `src/engine/universalCreatureRig.ts:1344-1380` `gpuBones[i].tx/ty` değerlerini **dünya (world) uzayındaki** `rx = bounds.x + bn.start.x * bounds.w` üzerinden hesaplar (`tx = worldPivotX - (m00*rx + m01*ry)`). Ancak `src/engine/cartoonMotionEngine.ts:2135` bu matrisleri doğrudan `renderConformingMeshWebGLGpuSkinned` shader'ına verir. `VERT_GPU_SKIN_SRC` (`src/engine/webglSkinnedRenderer.ts:122,170`) ise `restPx = a_restUV * u_bounds.zw` (**yerel `[0..W, 0..H]`**) çarpıp sonradan `+ u_bounds.xy` ekler! Sonuç: `worldPos` gerçek konumdan **`(I - M) · bounds.xy`** kadar sapar. Sayısal doğrulama: `bounds=(500, 300)`, `rot=0.35 rad (20°)` için hata **`(+133.2 px, -153.3 px) = 203.0 px`**; `rot=0, yaw=45°` için hata **`+45.7 px`**.
  2. **Socket Backing Matris Çarpım Hatası:** `src/engine/dualQuatSkinning.ts:668-675` `gpuBones[1].tx = _tx[1] - bounds.x` üretir (yerel `restPx` bekler). Fakat `drawInpaintedSocketBackingPass` (`src/engine/webglSkinnedRenderer.ts:837-845`) `ctx.transform(m00, m10, m01, m11, tx, ty)` uyguladıktan sonra `ctx.drawImage(patchCanvas, bounds.x, bounds.y, bounds.w, bounds.h)` çağırır — yani `bounds.xy` noktasını göğüs rotasyon/squash matrisiyle çarpar! Hata: **`(M - I) · bounds.xy`**. Sayısal doğrulama: `bounds=(500, 300)`, `torsoLeanRad=0.25 rad` için **`(-89.8 px, +114.4 px) = 145.4 px`** kayma; `lean=0, squashY=0.90` için **`40.4 px`** kayma.
  3. **CoR Tam-Açı Antipodal İşaret Hatası (`>90°` Ani Ters Dönüş):** `src/engine/dualQuatSkinning.ts:115-116,740-756` ve `src/engine/webglSkinnedRenderer.ts:141-157,889-893` tam-açı birim vektörleri `(cos θ, sin θ)` üzerinde yarım-açı kuaterniyon antipodal düzeltmesi (`dot(rRef, r1) < 0 ? -r1 : r1`) uygular. Tam açıda `-r1` aynı rotasyon değil **`θ + 180°` ters rotasyondur!** Sayısal doğrulama (`w0=w1=0.5`, `θ0=0°`): `θ1=89° → +44.5°`, `θ1=91° → -44.5°` (**90.0° anlık sıçrama!**), `θ1=95° → -42.5°` (beklenen `+47.5°`).
- **Çözüm Önerisi:**
  - `universalCreatureRig.ts:1378` içinde `gpuBones` için `dualQuatSkinning.ts:671` ile özdeş yerel-uzay `tx/ty` (`restLocalPx` kullanarak `_tx - bounds.x`) üretin.
  - `drawInpaintedSocketBackingPass` içinde `ctx.translate(bounds.x, bounds.y)` → `ctx.transform(...)` → `ctx.drawImage(patchCanvas, 0, 0, bounds.w, bounds.h)` sırasını uygulayın.
  - Hem CPU (`dualQuatSkinning.ts`) hem GPU (`VERT_GPU_SKIN_SRC`) CoR rotasyon harmanlamasında yarım-açı spinor `(cos(θ/2), sin(θ/2))` kullanıp normalize sonrası çift-açı `(qc² - qs², 2·qc·qs)` ile geri döndürün.

---

### SORUN #2 — [KRİTİK / VRAM & BELLEK] Sıfır WebGL Kaynak Temizliği, Sınırsız Doku/Tampon Sızıntısı ve Monotonik JS Heap Artışı
- **Ciddiyet:** Kritik (Uzun Oturum / Mobil Tarayıcı Çökmesi & OOM)
- **Etki:** Kullanıcı karakter çizip yeniden canlandırdıkça her karakter için yeni `WebGLTexture` (ana + normal map) ve `WebGLBuffer` (VBO + IBO) GPU belleğinde sonsuza dek birikir; mod geçişlerinde JS Heap GC sonrası dahi düşmez, 2048×2048 high-water-mark WebGL backbuffer + FBO (yaklaşık 32 MB GPU belleği) uygulama kapanana dek asla bırakılmaz.
- **Kod & Canlı CDP Kanıtı:**
  - Tüm `src/` taramasında `deleteTexture`, `deleteBuffer`, `deleteVertexArray`, `deleteFramebuffer` çağrısı **`0`** adettir (`deleteProgram` yalnızca link hatasında `webglSkinnedRenderer.ts:348`).
  - `src/engine/webglSkinnedRenderer.ts:312-314` GPU nesnelerini `WeakMap<HTMLCanvasElement | Uint16Array | ConformingSkinnedMesh, WebGLTexture | WebGLBuffer>` içinde saklar; JS nesnesi GC edildiğinde WebGL `delete*` çağrısı **hiç tetiklenmez**.
  - `src/engine/webglSkinnedRenderer.ts:515-528`: `sourceCanvas` boyutu değiştiğinde `cached = { tex, normalTex: null, w: sw, h: sh }` yazılırken eski `cached.normalTex` **`gl.deleteTexture` çağrılmadan ezilir**.
  - **Canlı CDP Kanıtı — Karakter Yeniden Canlandırma Churn Testi (8 döngü + GC + Masa dışına çıkış):**
    - `initial`: `GLtex=0`, `GLbuf=0`
    - `reanimate_1 → reanimate_8`: `GLtex` **`3 → 4 → 5 → 6 → 7 → 8 → 9 → 10` (`deleted=0`)**, `GLbuf` **`3 → 4 → 5 → 6 → 7 → 8 → 9 → 10` (`deleted=0`)**
    - `after_leave_desk` (Draw moduna geçip double `gc()` sonrası): **`10/10` doku, `10/10` buffer, `3/3` program, `1/1` FBO ve `1/1` `rigWorker` hâlâ canlı!**
  - **Canlı CDP Kanıtı — 12 Döngü Mod Geçişi (`draw → paper → puppet → film → desk` + her döngüde `HeapProfiler.collectGarbage` + 2× `window.gc()`):**
    - V8 `JSHeapUsedSize`: **`6.21 MB` (cycle 0) → `7.57 MB` (cycle 12)** (`+1.36 MB`, **+%21.9**, her döngüde tekdüze artış).
    - `performance.memory.usedJSHeapSize`: **`15.43 MB → 17.25 MB`** (`+1.82 MB`).
    - `ImageBitmap`: **`13 created, 0 closed, 13 live`** (`src/engine/db.ts` önbelleğinde/çerçevelerde kapatılmayan bitmapler).
- **Çözüm Önerisi:**
  - `webglSkinnedRenderer.ts`'e LRU + `FinalizationRegistry` veya açık `disposeWebGLResources()` / `evictActorTextures(canvas)` ekleyin; resize sırasında `cached.normalTex` üzerinde `gl.deleteTexture` çağırın; moddan çıkınca FBO/backbuffer'ı küçültün veya `WEBGL_lose_context` ile serbest bırakın.
  - `conformingMeshEngine.ts:2592`'de tüm kod tabanında **hiç okunmayan** `inpaintedBackRgba` (`srcW*srcH*4`, 1024²'de 4 MB/karakter) ölü tamponunu kaldırın.

---

### SORUN #3 — [YÜKSEK / PERFORMANS] Açılışta 1.0–1.8 sn Senkron Donma (TBT `1,664–2,400 ms`), 638 kB Eager Bundle ve 4x CPU Desk Çöküşü (`23.09 FPS`)
- **Ciddiyet:** Yüksek (Core Web Vitals Başarısızlığı & Düşük/Orta Mobil Cihazlarda Takılma)
- **Etki:** İlk kez gelen kullanıcılar masaüstünde bile ~1.04 sn, mobil 4x CPU'da **1.42–1.79 sn tamamen kilitlenen** bir yükleme ekranı görür; açılış sonrası yalnızca arka plan duvar kâğıdı (`AnimatedUniverseCanvas`) 4x CPU'da ana iş parçacığının %85–100'ünü yiyerek masayı **23 FPS'e** düşürür.
- **Kod & Ölçüm Kanıtı:**
  1. **Senkron Starter Flipbook Üretimi:** `src/App.tsx:47-56` tüm uygulamayı `ready` beklerken bloklar; `src/store/useStudioStore.ts:598-601` ilk ziyarette `await createStarterFlipbookProject()` (`src/engine/starterFlipbook.ts:45-65`) çağırarak **16 kare × 1280×720 × 3 katman** (`rough`, `color`, `ink`) + thumbnail çizip PNG/WebP encode ederek IndexedDB'ye yazar.
  2. **Lighthouse 13.6.0 Gerçek Ölçümleri:**
     - **Canlı `https://inktrope.com` (Mobil 4x CPU):** Perf **`61/100`**, LCP **`3.3 s`**, **TBT `1,664 ms`**, Max Potential FID **`1,421 ms`**, Main Thread **`5.7 s`**, Bootup **`3.0 s`**, Long Tasks **`18`**.
     - **Lokal Prod Build (Mobil 4x CPU):** Perf **`68/100`**, LCP **`2.2 s`**, **TBT `2,400 ms`**, Max Potential FID **`1,788 ms`**, Unused JS **`469 KiB`**.
     - **Lokal Prod Build (Masaüstü 1x CPU):** Perf **`78/100`**, **TBT `516 ms`**, Max Potential FID **`545 ms`**.
  3. **Bozuk Code-Splitting & Paket Şişmesi:** `index-BjGFSWLz.js` **`637.63 kB` raw (`209.59 kB` gzip)** — toplam eager JS **`828.65 kB` (`265.81 kB` gzip)** + CSS `93.61 kB`. Vite build kendisi uyarı veriyor: `useStudioStore.ts`'in dinamik import ettiği `characterIntakeEngine.ts` ve `meshWarpEngine.ts`, açılışta eager yüklenen `StudioDeskHub → InteractiveLightboxStage → InstantAliveStage` tarafından **statik olarak import edildiği için** tüm `webglSkinnedRenderer`, `conformingMeshEngine`, `universalCreatureRig`, `dualQuatSkinning`, `cpuRasterizer`, `arapSolver`, `socketInpaint` motorları ana chunk'a gömülmüş ve `conformingMeshEngine + universalCreatureRig` **hem `index.js` hem `rigWorker.js` (55.94 kB) içine çift paketlenmiştir**.
  4. **Arka Plan Canvas 4x CPU Katili:** `src/components/desk/AnimatedUniverseCanvas.tsx:148-221,625` 12 FPS ile tam viewport (`1440×900×dpr`) `clearRect + createRadialGradient + fillRect + 42 yıldız + kesikli elips` çizer. Canlı CDP 4x CPU ölçümü: Desk Hub **`23.09 FPS`**, **`p95 = 90.3 ms`**, **`max = 104.1 ms`**, 5.5 sn içinde **62 ardışık 64–99 ms Long Task** (TBT **`1,704 ms`**). Aynı 83–95 ms periyodik task izi canlı Lighthouse `inktrope.com` izinde de (`3747ms, 3842ms, 3931ms`) doğrulanmıştır!
- **Çözüm Önerisi:**
  - `createStarterFlipbookProject()` işlemini `ready: true` **sonrasına** erteleyin (idle/worker veya yalnızca "Devam Et / Draw" tıklanınca üretin).
  - `InstantAliveStage` (140 KB kaynak) ve rigging motorlarını `React.lazy()` + dinamik `import()` arkasına alın; `rigWorkerClient.ts`'teki senkron fallback importlarını dinamik `import()` yapıp 56 kB çift paketlemeyi kaldırın.
  - `AnimatedUniverseCanvas` radyal lamba ışığını ve sabit gökyüzünü tek seferlik offscreen/CSS katmanına önbelleğe alın; `dpr` değerini `1.0` ile sınırlayın veya `OffscreenCanvas` worker'a taşıyın.

---

### SORUN #4 — [YÜKSEK / MİMARİ] `rigWorker` Ana Akışlarda Baypas Ediliyor (1.27 sn UI Donması) & Worker Yaşam Döngüsü/Hata Kurtarma Kusurları
- **Ciddiyet:** Yüksek (UI Tepkiselliği & Hata Dayanıklılığı)
- **Etki:** Film Director, Puppet Studio, Desk Lightbox ve 360° çoklu-açı görünümünde ağır 200px Viterbi + 64-iterasyon Harmonik Laplacian rig kurulumu Web Worker'a **hiç gönderilmeden** ana iş parçacığında çalışır; kullanıcı stüdyoya tıkladığında arayüz **0.88–1.27 saniye donar**. Worker çökerse `paperWorker` kalıcı olarak kilitlenir, `rigWorker` kalıcı olarak devre dışı kalır ve hiçbiri asla `terminate()` edilmez.
- **Kod & Canlı CDP Kanıtı:**
  - **Canlı CDP Kanıtı:** Desk + Film Director + Puppet Studio + 12 mod geçişinin tamamında `workers = { created: 0, terminated: 0, live: 0 }`! Film Director açılışında **`1,274 ms`**, Puppet Studio açılışında **`877 ms`** tek parça ana iş parçacığı Long Task'ı ölçüldü.
  - **Kök Neden:** `src/engine/characterIntakeEngine.ts:2004-2030` (`getOrBuildCachedRigPack`) senkron `buildRiggedCharacterPack` çağırır. Bu fonksiyon doğrudan `film25dEngine.ts:1450`, `meshWarpEngine.ts:484`, `MeshWarpStage.tsx:282,336,640,1242`, `puppetEngine.ts:671`, `InteractiveLightboxStage.tsx:515,584,900` içinden çağrılır. Ayrıca `viewRigBlender.ts:293` ve `InstantAliveStage.tsx:1650,1657,2335` de senkron kurucu kullanır.
  - **`paperWorkerClient.ts:35-40` Kalıcı Kilitlenme Hatası:** `workerInstance.onerror` bekleyen promise'leri reddeder ancak **`workerInstance = null` yapmaz ve `terminate()` çağırmaz**; tek bir worker çöküşünden sonra `getWorker()` sonsuza dek ölü worker'ı döndürür.
  - **`rigWorkerClient.ts:41-46` Kalıcı Degredasyon:** `w.onerror` `_workerDisabled = true` set eder, bozuk worker'ı `terminate()` etmez ve oturum sonuna kadar tüm işleri ana iş parçacığına düşürür. Her iki istemcide de `terminate()`, `AbortSignal`/iptal, zaman aşımı ve `onmessageerror` handler'ı yoktur.
  - **Bellek Kopyalama Pikleri:** `paperWorkerClient.ts:107-111` (`runGifEncode`) tüm kareleri aynı anda `new Uint8ClampedArray(f.rgba)` ile klonlar (60 kare 720p = **~221 MB** RAM pik kopyası); `paperWorker.ts:432` `warpPerspective`'in zaten yeni ayırdığı tamponu tekrar kopyalar.
- **Çözüm Önerisi:**
  - `getOrBuildCachedRigPack` için asenkron `preloadRigPackAsync` + worker kuyruğu (latest-wins iptal token'lı) oluşturun; `film25dEngine`/`MeshWarpStage`/`viewRigBlender` ilk karede placeholder gösterip worker bitince rig'i bağlasın.
  - Her iki worker istemcisine `onerror` içinde `w.terminate(); instance = null;` ile kontrollü yeniden başlatma (retry cap), `onmessageerror`, timeout ve oturum/mod temizliği için `terminateRigWorker()` / `terminatePaperWorker()` ekleyin.

---

### SORUN #5 — [ORTA-YÜKSEK / MOTOR VERİMLİLİĞİ & PARİTE] WebGL2 ↔ CPU Parite Kırıkları, Dinamik VBO Düşüşü, ARAP Her-Kare Dijkstra ve `dt`'siz Verlet
- **Ciddiyet:** Orta-Yüksek (Çapraz Cihaz Görsel Tutarlılık, GC Baskısı & Fizik Doğruluğu)
- **Etki:** GPU'lu cihaz ile GPU'suz/yazılım-GL cihaz aynı karakteri farklı gölgeleme/kenar/halo ve kafa paralaksı ile çizer; "sıfır per-frame VBO upload" iddiasına rağmen Film oynatmada karelerin büyük bölümünde CPU skinning + `DYNAMIC_DRAW` VBO yüklemesine düşülür; ARAP her karede tüm pimleri için baştan Dijkstra koşar; Verlet kumaş fiziği ekran tazeleme hızına (60Hz vs 144Hz vs 24 FPS) bağlı olarak farklı hızlarda sallanır.
- **Kod & Ölçüm Kanıtı:**
  1. **WebGL2 vs CPU Scanline 7 Parite Farkı:**
     - Klaus ışık yönü WebGL2'de normalize edilir (`webglSkinnedRenderer.ts:642-644`), CPU'da **edilmez** (`cpuRasterizer.ts:170-172,352`) → `v3RendererParity.test.ts:144`'teki `(0.85, -0.35)` ışığıyla gölge ağırlığında **`%67.8` bağıl sapma** (`0.0336` vs `0.0564`).
     - `v_shade` CPU'da `[0.72, 1.12]` aralığına kırpılır (`cpuRasterizer.ts:343`), WebGL2'de kırpılmaz (`webglSkinnedRenderer.ts:200`).
     - Alfa atma eşiği: WebGL2 `c.a < 0.015` (`~3.8/255`, `webglSkinnedRenderer.ts:198`) vs CPU `sa <= 6` (`6/255`, `cpuRasterizer.ts:317,341`).
     - Normal map örneklemesi: WebGL2 `gl.LINEAR` (`webglSkinnedRenderer.ts:538`) vs CPU en yakın üst-sol texel `i00` (`cpuRasterizer.ts:327,349`).
     - Rim kesme eşiği: CPU `rim > 0.04` (`cpuRasterizer.ts:363`) vs WebGL2 eşiksiz (`webglSkinnedRenderer.ts:212`).
     - Gece halosu: WebGL2 `r=2.4`, çapraz `1.728`, `pad=10`, MSAA kapalı FBO (`webglSkinnedRenderer.ts:239-240,867`) vs CPU tam sayı `±2` / çapraz `(±1,±1)` (`1.414`), `pad=6`, 2px kenar boşluk (`cpuRasterizer.ts:448-464,523`).
     - GPU Vertex Shader (`VERT_GPU_SKIN_SRC:133-168`) kafa paralaksını, şapka takibini (`dualQuatSkinning.ts:718-732`) ve `corUV` yokken 80/20 2D-DQ yedek yolunu (`dualQuatSkinning.ts:783-813`) **uygulamaz**; ayrıca `cartoonMotionEngine.ts:2367-2380` GPU başarısız fallback dalında `drawInpaintedSocketBackingPass` çağrısını unutur.
     - `v3RendererParity.test.ts` yalnızca `cpuRasterizer`'ı kendi kendine test eder; WebGL2 ile tek piksel bile karşılaştırmaz!
  2. **Sahte WebGL2 / Dinamik VBO Düşüşü:** `webglSkinnedRenderer.ts:376` `webgl2` bağlamı açar ama `WebGLRenderingContext` (WebGL1) olarak tipler, GLSL ES 1.00 kullanır, **0 VAO** oluşturur (her draw call'da 9 attribute için `disableAllVertexAttribsExcept` döner, `webglSkinnedRenderer.ts:754-773`), vertex shader içinde kemik başına **24 iterasyonlu lineer döngü** (vertex başına 192 iterasyona kadar, `webglSkinnedRenderer.ts:100-118`) koşar. Canlı CDP'de `cartoonMotionEngine.ts:2297-2301`'deki aşırı dar `|headTurnX| < 0.06 && |headLagY| < 0.015` koşulu yüzünden Film oynatmada **`898` kez `gl.bufferData` (`DYNAMIC_DRAW`)** tetiklendiği ölçüldü!
  3. **ARAP Her-Kare Dijkstra & Yakınsamayan 3-Hop Jacobi:** `src/engine/arapSolver.ts:186-210` yalnızca `(mesh, pinVerts)` topolojisine bağlı olan jeodezik uzaklık alanlarını önbelleğe almadan **her karede `P` kez `O((V+E) log V)` Dijkstra** koşar (ve her karede 13+ TypedArray + pin başına 4 dizi tahsis eder). Global adım (`arapSolver.ts:249,291-335`) `iters=3` sönümlü Jacobi ile bilgiyi en fazla **3 komşu vertex** yayar ve rotasyonları en-boy oranı düzeltilmemiş `[0..1]×[0..1]` UV uzayında hesaplayarak kare olmayan görsellerde kayma (shear) üretir.
  4. **`dt`'siz ve Her-Kare Yeniden Kurulan Verlet:** `src/engine/verletPhysics.ts:59-152` `step()` metodunda `dt` parametresi yoktur (144Hz'de 2.4× hızlı, 24 FPS'de 2.5× yavaş çalışır). `VerletClothChain` kod tabanında hiçbir yerde kalıcı örneklenmez; tek çağrıcı `film25dEngine.ts:1683` her karede sabit anchor ile ~30 nesne tahsis edip 10 ısınma adımı koşan `evaluateDeterministicVerletRibbon` (`verletPhysics.ts:159-189`) fonksiyonunu çağırır.
- **Çözüm Önerisi:**
  - Klaus ışık normalizasyonu, alfa/rim/shade eşikleri ve halo yarıçapını ortak sabitlerle tek kaynakta eşitleyin; WebGL2 + CPU gerçek piksel farkı (PSNR/MAE) testi ekleyin.
  - WebGL2 için gerçek GLSL ES 3.00 (`#version 300 es`, VAO, dinamik uniform array/UBO indeksleme) ve kafa paralaksını shader uniform'una taşıyarak `DYNAMIC_DRAW` düşüşünü sıfırlayın.
  - `arapSolver.ts`'te `(mesh, pinKey)` bazlı jeodezik önbelleği + en-boy düzeltmeli uzay + Gauss-Seidel/Cholesky çözücü kullanın; `verletPhysics.ts`'e sabit zaman adımı (`fixedDt`) ve scratch tampon havuzu ekleyin.

---

## 3. Detaylı Denetim Matrisi

| # | Denetim Alanı | Durum | Kanıt (`dosya:satır` / Ölçüm) |
|---|---|---|---|
| 1 | `arapSolver.ts` — Algoritmik karmaşıklık, önbellek & nümerik kararlılık | **`[FAIL]`** | `src/engine/arapSolver.ts:186-210` her çağrıda `P × O((V+E) log V)` Dijkstra + 13+ TypedArray tahsis ediyor; `arapSolver.ts:60-64,273-280` en-boy oranı (`aspect`) düzeltmesiz UV uzayında rijit rotasyon hesaplıyor; `arapSolver.ts:249,329-330` `iters=3` Jacobi (yalnızca 3 hop yayılım); `arapSolver.ts:208` aynı vertex'e düşen iki pim birbirini sessizce eziyor. |
| 2 | `dualQuatSkinning.ts` — 21 kemik IK, CoR matematik & GC baskısı | **`[FAIL]`** | Reverse-Foot Roll IK (`dualQuatSkinning.ts:430-636`) iyi tasarlanmış ancak `dualQuatSkinning.ts:115-116,740-756` CoR tam-açı antipodal işareti `>90°` bükülmelerde **90° ters dönme** üretiyor (`89°→+44.5°`, `91°→-44.5°`). "Zero-GC" yorumuna (`dualQuatSkinning.ts:18`) karşın her karede ~100+ JS nesnesi (`gpuBones` 21 nesne, `liveBones` 21+42 nesne, `Vec2` + closure'lar, `665-677,846-872`) tahsis ediyor. |
| 3 | `conformingMeshEngine.ts` — Topoloji, ağırlık, bellek & kenar durumları | **`[FAIL]`** | 200px Viterbi Ink-Watershed + Connectivity Rollback güçlü (`conformingMeshEngine.ts:727-1060`). Ancak: (a) `airWebbingTriangles: 0` ölçülmeden sabit yazılmış (`2600,2768`); (b) Dial kovalarında **8,192 adet JS dizi** + delik Dijkstra iç döngüsünde piksel başına `nCoords` tuple tahsisi (`637-641,1132-1133`); (c) Pass B alt-quad kenarlarında kısmi örtüşmede **T-junction çatlak riski** (`2114,2177-2180`); (d) `kneeBand` sağ bacakta bile `legL` uzunluğunu kullanıyor (`2368,2372`); (e) kardeş kemik `getSharedJointPivot` sıraya bağımlı (`2485`); (f) `inpaintedBackRgba` (4 MB/karakter) hiç okunmadan üretilip taşınıyor (`2592`). |
| 4 | `verletPhysics.ts` — Fizik kararlılığı, `dt` bağımsızlığı & tahsis | **`[FAIL]`** | `verletPhysics.ts:59-152` `dt` parametresi yok (kare hızına bağımlı). `verletPhysics.ts:146-148` `dist===0` durumunda sıfır vektör çökmesi ve zemin kırpmanın segment boyunu bozması. `verletPhysics.ts:159-189` "zero-allocation" iddiasına rağmen (`verletPhysics.ts:3`) tek çağrıcı `film25dEngine.ts:1683`'ten her kare ~30 nesne tahsisi + 10 sabit-anchor alt adımı koşuyor (karakter hareket izi/wake yok). `nodeCount=0` korumasız. |
| 5 | `webglSkinnedRenderer.ts` vs `cpuRasterizer.ts` — Görsel & fonksiyonel parite | **`[FAIL]`** | **7 somut parite farkı** doğrulandı: (1) Klaus ışık normalizasyonu (`webglSkinnedRenderer.ts:642` vs `cpuRasterizer.ts:170` → %67.8 gölge farkı), (2) `v_shade` kırpma (`cpuRasterizer.ts:343`), (3) alfa discard `0.015` vs `6/255`, (4) normal map `LINEAR` vs nearest `i00`, (5) rim `0.04` eşiği, (6) gece halosu yarıçap/çapraz/padding ve FBO'da MSAA kaybı, (7) GPU'da kafa paralaksı + DQ yedeği yok ve `universalCreatureRig.ts:1378` GPU'da **203 px** kayıyor, `drawInpaintedSocketBackingPass` (`837-845`) **145.4 px** kayıyor. `v3RendererParity.test.ts` WebGL'i hiç test etmiyor. |
| 6 | `cpuRasterizer.ts` — Top-left kuralı & Zero-GC scanline motoru | **`[PASS]`** | `cpuRasterizer.ts:244-255` tam top-left kenar kuralı, `cpuRasterizer.ts:319-327` premultiplied-safe bilinear örnekleme ve `rowStride` + 64px bucket'lı yeniden kullanılabilir `_scratchImageData` (`529-566`) ile gerçek sıfır-tahsisli CPU rasterizasyonu çalışıyor. *(Not: `sourcePixelCache` aynı tuval içi boyama güncellemelerini `w/h` değişmedikçe fark etmez, satır `103`.)* |
| 7 | `rigWorker` / `paperWorker` — Transferable, yaşam döngüsü & hata yönetimi | **`[FAIL]`** | Return yolları `Transferable` kullanıyor (`rigWorker.ts:43-66`, `paperWorker.ts:950-975`) — bu kısım doğru. Ancak: (a) Film/Puppet/Lightbox `rigWorker`'ı baypas edip ana iş parçacığını **1,274 ms / 877 ms** donduruyor (`characterIntakeEngine.ts:2004`); (b) Tüm depoda `.terminate()` **0** kez çağrılıyor; (c) `paperWorkerClient.ts:35-40` hata sonrası ölü worker'ı sıfırlamıyor; (d) `rigWorkerClient.ts:41-46` tek hatada worker'ı kalıcı kapatıyor ve 55.94 kB kodu ana pakete çift gömüyor; (e) iptal (`AbortSignal`), timeout ve `onmessageerror` yok; (f) `paperWorkerClient.ts:107` GIF encode'da tüm kareleri RAM'de çift kopyalıyor. |
| 8 | 4x CPU Throttle FPS — Gerçek Chrome CDP Ölçümü (Film & Puppet) | **`[PASS]`** | Donanım WebGL2 (RTX 3050) ile **Film Director 2.5D Playback @ 4x CPU:** `52.07 FPS` (`p50=13.9ms`, `p95=41.7ms`, `630 glDraws`, `LT=2/115ms`); **Puppet Studio @ 4x CPU:** `118.39 FPS` (`p50=7.0ms`, `p95=20.8ms`, `73 glDraws`, `LT=0`). *(Ancak Film 1x CPU'da `140.43 FPS` / `1,804 glDraws` ile gereksiz 144Hz çiziyor ve `898` kez `DYNAMIC_DRAW` VBO yüklüyor.)* |
| 9 | 4x CPU Throttle FPS — Gerçek Chrome CDP Ölçümü (Desk Hub / Açılış Masası) | **`[FAIL]`** | **Desk Hub @ 1x CPU:** `137.13 FPS` (`p95=7.1ms`, `LT=1/8ms`) → **Desk Hub @ 4x CPU:** **`23.09 FPS`**, `p50=14.1ms`, **`p95=90.3ms`**, **`max=104.1ms`**, **`61` dropped frame (>33ms)**, **`61` jank frame (>50ms)**, **`62` Long Task (5.5 sn'de `TBT=1,704 ms`)**. Kök neden: `AnimatedUniverseCanvas.tsx:198-637` tam ekran 2D radyal gradyan çizimi. |
| 10 | Lighthouse Gerçek Ölçümü — Lokal Prod Build (Mobil & Masaüstü) | **`[FAIL]`** | **Mobil (4x CPU):** Perf **`68/100`**, FCP `2.2s`, LCP `2.2s`, **TBT `2,400 ms`**, CLS `0.0002`, Max Potential FID **`1,788 ms`**, Bootup `3.8s`, Main Thread `6.4s`, Unused JS **`469 KiB`**. **Masaüstü (1x CPU):** Perf **`78/100`**, FCP/LCP `0.3s`, **TBT `516 ms`**, CLS `0.0002`. |
| 11 | Lighthouse Gerçek Ölçümü — Canlı `https://inktrope.com` (Pasif) | **`[FAIL]`** | **Mobil (4x CPU, Lighthouse 13.6.0):** Perf **`61/100`**, FCP `1.0s` (`987ms`), **LCP `3.3s` (`3,312ms`)**, **TBT `1,664 ms`**, CLS `0.0007` (`[PASS]`), SI `5.5s`, TTI `4.5s`, Max Potential FID **`1,421 ms`**, Bootup `3.0s`, Main Thread `5.7s`, Transfer `655 KiB`, Unused JS `140 KiB` (sıkıştırılmış). |
| 12 | Core Web Vitals — Gerçek Saha INP (CrUX / Field User Interaction) | **`[TEST EDİLMEDİ]`** | Laboratuvar Lighthouse tek sayfa yüklemesinde gerçek CrUX saha INP değeri üretmez (canlı trafik/kullanıcı etkileşimi gerektirir). Laboratuvar etkileşim vekilleri ölçülmüştür: Lighthouse `Max Potential FID = 1,421 ms` (canlı) / `1,788 ms` (lokal), CDP 4x CPU Desk kare blokajı `p95=90.3ms / max=104.1ms`, mod açılış senkron blokajı `1,274 ms` (Film) / `877 ms` (Puppet). |
| 13 | JS Bundle & Lazy-Loading Analizi (`dist5`) | **`[FAIL]`** | Toplam dist: `2,392.16 KiB` raw (`1,342.99 KiB` gzip). Eager entry `index-BjGFSWLz.js` **`637.63 kB` raw (`209.59 kB` gzip)** — Vite'in 500 kB sınırını aşıyor! Toplam ilk yük JS: **`828.65 kB` (`265.81 kB` gzip)**. `characterIntakeEngine` & `meshWarpEngine` dinamik importları statik importlarla boşa düşmüş; `conformingMeshEngine + universalCreatureRig` ana chunk ve `rigWorker` içinde **çift kopya**; 16 eski `.woff` dosyası (`266.58 KiB`) modern `.woff2` yanında gereksiz taşınıyor. |
| 14 | Mod Değişimi & Karakter Yenilemede WebGL/VRAM ve JS Heap Sızıntısı | **`[FAIL]`** | (a) 12 mod geçiş döngüsünde double-GC sonrası V8 canlı heap **`6.21 → 7.57 MB` (+%21.9)** her döngüde arttı (`performance.memory`: `15.43 → 17.25 MB`), `ImageBitmap` `13 created / 0 closed`, WebGL `deleted = 0`, VAO `0`. (b) 8 karakter yeniden canlandırmada `WebGLTexture` **`3 → 10` (`deleted=0`)**, `WebGLBuffer` **`3 → 10` (`deleted=0`)**, Masa terk edilip GC yapılsa bile `10/10` doku, `10/10` tampon ve `1/1` `rigWorker` bellekten düşmedi. |
| 15 | Stabilite — Çalışma Zamanı Hata / İstisna Kontrolü | **`[PASS]`** | 6 FPS benchmarkı, 12 mod geçişi (48+ tab/ekran geçişi) ve 8 çizim-canlandırma döngüsü boyunca yakalanmamış sayfa hatası (`pageErrors = 0`) ve konsol hatası (`consoleErrors = 0`) oluşmadı. |

---

## 4. Derin Teknik Bulgular Özeti (Modül Bazlı)

### 4.1 `arapSolver.ts`
- **Önbellek Eksikliği (`arapSolver.ts:186-210`):** `arapGraphCache` yalnızca komşuluk grafını tutar; pime özgü `computeGeodesicDistances(graph, bestV)` sonuçları önbelleğe alınmadığından sürükleme/oynatma sırasında **her karede `P` adet Dijkstra** çalıştırılır.
- **Yakınsama & Anizotropi (`arapSolver.ts:60-64,249,291-335`):** Yalnızca 3 (maks 6) iterasyon sönümlü Jacobi (`0.25·cur + 0.75·avg`) uygulanır; 25–50 kenar çapındaki bir mesh'te bu, gerçek global ARAP sistemi `L·p' = b` çözümüne yakınsamaz ve başlangıç Shepard tahminine yapışık kalır. Kenarlar ve 2D Procrustes rotasyonları `drawW / drawH` oranıyla ölçeklenmemiş `[0..1]²` UV uzayında hesaplandığından kare olmayan karakterlerde rotasyon **kayma (shear)** üretir.

### 4.2 `dualQuatSkinning.ts` & `universalCreatureRig.ts`
- **CoR `>90°` Kırılması (`dualQuatSkinning.ts:740-756`):** Hemen altındaki 2D-DQ yedek yolu (`784-808`) doğru biçimde yarım-açı `_qrC/_qrS` kullanırken, CoR yolu tam-açı `_cosR/_sinR` üzerinde `dot < 0 ? -1 : 1` uygular.
- **Sıfır-GC İhlali (`dualQuatSkinning.ts:18,665-677,846-872`):** `_m00.._qdY` dizi havuzu ayrılmış olsa da dönüşte her karede 21 `gpuBones` nesnesi, 21 `liveBones` + 42 `Vec2`, 5 iç closure ve `evaluateArchetypeSilhouetteMesh`'te `solveQuadLegOffset` başına `{x,y}` tahsis edilir.
- **Evrensel Yaratık GPU Hatası (`universalCreatureRig.ts:1344-1380`):** Dünya koordinatlı `tx/ty` yerel koordinat bekleyen `VERT_GPU_SKIN_SRC`'ye verildiği için rotasyon veya yaw foreshortening anında uzuvlar 45–203 px kayar ve kırpılır. Ayrıca `evaluateUniversalCreatureMesh` her karede `new Float32Array(vCount*2)` ve `worldPivotX/Y/worldRot` dizileri ayırır (`1330-1332,1385`).

### 4.3 `conformingMeshEngine.ts`
- **Ağır İnşa Tahsisleri (`conformingMeshEngine.ts:637-641,1132-1133`):** `MAX_COST = 8192` boş JS dizi kovası + her delik Dijkstra pikselinde 4 geçici dizi (`nCoords`).
- **Ölü Bellek & Sert Kodlu Metrik (`conformingMeshEngine.ts:2592,2600`):** `inpaintedBackRgba` (tam çözünürlüklü kopya) tüm kodda hiç okunmuyor; `airWebbingTriangles: 0` hesaplanmadan sabit dönülüyor.
- **T-Junction & Asimetrik Eşik (`conformingMeshEngine.ts:2114,2368-2372,2485`):** Bölünmüş hücre (Pass B) kısmi örtüşmelerde kaynaklanmamış T-junction düğümü yaratır; `kneeBand/ankleBand` her iki bacak için yalnızca `legL`'den ölçülür.

### 4.4 `verletPhysics.ts`
- **Kare Hızı Bağımlılığı (`verletPhysics.ts:91-107`):** `vx = (node.x - node.px) * damping`, `node.y += vy + gravity` — `dt` yok.
- **Kalıcı Fizik Yok (`film25dEngine.ts:1683`):** `VerletClothChain` sınıfı sahneler arası kalıcı tutulmaz; her kare `evaluateDeterministicVerletRibbon` ile yeni `VerletClothChain` + 8 node + 10 adım + map dizisi tahsis edilir ve anchor 10 alt adım boyunca sabit tutulduğundan karakter hız izi (inertia wake) gerçek fizik olarak aktarılmaz.

### 4.5 `webglSkinnedRenderer.ts` vs `cpuRasterizer.ts`
- **WebGL2 Adı Altında WebGL1 Boru Hattı (`webglSkinnedRenderer.ts:77-180,376,754-773`):** `webgl2` bağlamı açılır ancak `VAO = 0`, GLSL ES 1.00, vertex başına 24-iterasyonlu kemik arama döngüleri (`applyBone` & `getBoneRot`, 192 iterasyona kadar!) ve her karede offscreen WebGL canvas'tan 2D stage canvas'a çapraz-bağlam `ctx.drawImage(state.canvas, ...)` bliti yapılır (`751`).
- **Sıkı `canPureGpuSkin` Düşüşü (`cartoonMotionEngine.ts:2297-2301`):** `|headTurnX| >= 0.06 || |headLagY| >= 0.015` anında GPU vertex skinning iptal edilip CPU vertex döngüsü + `gl.bufferData(..., DYNAMIC_DRAW)` çalışır (Film benchmarkında **898 dinamik VBO yüklemesi** ölçüldü).
- **Kısmi Hata Sızıntıları (`webglSkinnedRenderer.ts:336-341,402-405`):** Shader veya başlangıç kaynağı yarıda başarısız olursa önceden ayrılan shader/program/buffer/texture/FBO silinmez.

---

## 5. Kanıt Ekleri (Ham Ölçüm Tabloları & Komut Çıktıları)

### Ek A — JS / CSS / Font Bundle Dağılımı (`dist5` Gerçek Build)

Komut: `npx vite build --outDir <scratch>\agent5\dist5 --emptyOutDir` (`✓ built in 20.96s`, `1695 modules transformed`)

| Dosya / Chunk | Tür | Raw (KiB) | Raw (Vite kB) | Gzip (KiB) | Yükleme |
|---|---|---:|---:|---:|---|
| `assets/index-BjGFSWLz.js` | JS Entry | **622.68** | **637.63** | **204.26** | **Eager (İlk Yük)** |
| `assets/react-vendor-BPiL1QK8.js` | Vendor JS | 140.09 | 143.45 | 45.11 | Eager (`modulepreload`) |
| `assets/icons-vendor-DDENCPmn.js` | Icons JS | 46.45 | 47.57 | 9.58 | Eager (`modulepreload`) |
| `assets/index-B42hRhax.css` | CSS | 91.41 | 93.61 | 17.91 | Eager (Render-blocking) |
| `assets/FilmDirectorStudio-CVRS6p-6.js` | Lazy JS | 117.39 | 120.21 | 30.17 | Lazy (`mode='film'`) |
| `assets/DrawWorkspace-R9TDtJNs.js` | Lazy JS | 106.48 | 109.04 | 28.11 | Lazy (`mode='draw'`) |
| `assets/PuppetStudio-uuA0qEti.js` | Lazy JS | 96.99 | 99.31 | 26.84 | Lazy (`mode='puppet'`) |
| `assets/rigWorker-D0mFYSps.js` | Worker JS | 54.63 | 55.94 | 20.23 | Worker (çift kopya!) |
| `assets/film25dEngine-DfPlXGIE.js` | Lazy JS | 51.51 | 52.74 | 18.81 | Lazy (`mode='film'`) |
| `assets/mp4-muxer-CR73arlb.js` | Lazy JS | 30.45 | 31.18 | 8.88 | Lazy (Export) |
| `assets/PaperCameraStudio-CKiEc9Xn.js` | Lazy JS | 26.74 | 27.39 | 8.19 | Lazy (`mode='paper'`) |
| `assets/ExportModal-DGWXSY_V.js` | Lazy JS | 14.86 | 15.22 | 4.16 | Lazy (Modal) |
| `assets/AccountModal-BIWU6vVq.js` | Lazy JS | 13.93 | 14.27 | 4.59 | Lazy (Modal) |
| `assets/exportEngine-CwM_1OE7.js` | Lazy JS | 13.08 | 13.40 | 5.03 | Lazy (Export) |
| `assets/StudioOverviewShow-Uu_V5k_5.js` | Lazy JS | 10.93 | 11.19 | 3.81 | Lazy (Modal) |
| `assets/paperWorker-Da4250vn.js` | Worker JS | 10.16 | 10.40 | 4.56 | Worker |
| Diğer 6 küçük JS (`StudioGuide`, `Legal`, `frameComposite`, `flipbookPdf`, `starterPresets`, `sw.js`) | JS | 28.92 | 29.61 | 11.55 | Lazy / SW |
| 16× `.woff` + 16× `.woff2` (`@fontsource` Plus Jakarta + JetBrains Mono) | Font | **464.56** | 475.71 | 464.61 | Statik CSS `@font-face` |
| 5× `.png` + 2× `.svg` + 3× `.html` + meta | Statik | 449.89 | 460.69 | 426.50 | Statik / PWA |
| **TOPLAM `dist5` (71 dosya)** | — | **2,392.16** | **2,449.57** | **1,342.99** | — |

**Eager `index-BjGFSWLz.js` Modül Parmak İzi Kanıtı:**
`webglSkinnedRenderer` (`true`), `conformingMeshEngine` (`true` + `rigWorker: true`), `universalCreatureRig` (`true` + `rigWorker: true`), `dualQuatSkinning` (`true`), `cpuRasterizer` (`true`), `arapSolver` (`true`), `meshWarpEngine` (`true`), `socketInpaint` (`true` + `rigWorker: true`), `InstantAliveStage` (`true`), `InteractiveLightboxStage` (`true`), `translations` (`true`), `soundEngine` (`true`).

---

### Ek B — Gerçek Chrome CDP 1x vs 4x CPU Throttle FPS Ölçümü

GPU: `ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 6GB Laptop GPU Direct3D11)` | `WebGL 2.0 (OpenGL ES 3.0 Chromium)` | Ekran: `1440×900` @ 144Hz

| Sahne | CPU Hızı | Süre | Kare | Avg FPS | Avg ms | p50 ms | p95 ms | p99 ms | Max ms | >33ms | >50ms | Long Tasks (TBT) | WebGL Draw | Canlı Anim |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| **Desk Hub** | 1x | 5.51s | 755 | 137.13 | 7.29 | 6.9 | 7.1 | 13.9 | 55.5 | 3 | 1 | 1 (8 ms) | 0 | `true` |
| **Desk Hub** | **4x** | 5.50s | 127 | **23.09** | **43.31** | 14.1 | **90.3** | **97.3** | **104.1** | **61** | **61** | **62 (1,704 ms)** | 0 | `false`* |
| **Film Director 2.5D** | 1x | 6.00s | 843 | 140.43 | 7.12 | 6.9 | 7.1 | 13.9 | 55.6 | 1 | 1 | 0 (0 ms) | 1,804 | `true` |
| **Film Director 2.5D** | **4x** | 6.01s | 313 | **52.07** | 19.20 | 13.9 | **41.7** | 48.7 | **131.9** | **40** | 3 | 2 (115 ms) | 630 | `true` |
| **Puppet Studio Rig** | 1x | 6.00s | 854 | 142.31 | 7.03 | 6.9 | 7.1 | 7.6 | 36.1 | 1 | 0 | 0 (0 ms) | 72 | `true` |
| **Puppet Studio Rig** | **4x** | 6.01s | 711 | **118.39** | 8.45 | 7.0 | 20.8 | 27.8 | 41.8 | 5 | 0 | 0 (0 ms) | 73 | `true` |

*\*Desk Hub 4x CPU'da her `AnimatedUniverseCanvas` 12 FPS adımı 64–99 ms sürdüğü için orta/son piksel kontrolü esnasında tuval kilitlenmiş; açılış/geçiş Long Task'ları: Boot `1,038 ms`, Film açılış `1,274 ms`, Puppet açılış `877 ms`.*

---

### Ek C — Canlı CDP WebGL/VRAM & JS Heap Bellek Sızıntısı Ölçümleri

#### C.1 — 12 Döngü Mod Geçişi (`draw → paper → puppet → film` + her 2 döngüde `desk → film`, her döngüde `HeapProfiler.collectGarbage` + 2× `window.gc()`)

| Döngü | V8 Live Heap (MB) | `perf.memory` (MB) | DOM Nodes | GL Tex (+ / -) | GL Buf (+ / -) | GL Prog | GL FBO | GL VAO | `bufUploads` | Workers | `ImageBitmap` (+ / -) |
|---|---:|---:|---:|---|---|---:|---:|---:|---:|---|---|
| Baseline (0) | 6.21 | 15.43 | 512 | 5 (+5/-0) | 6 (+6/-0) | 3 | 1 | 0 | 898 | 0 (+0/-0) | 1 (+1/-0) |
| Cycle 1 | 6.39 | 15.77 | 725 | 5 (+5/-0) | 6 (+6/-0) | 3 | 1 | 0 | 898 | 0 (+0/-0) | 13 (+13/-0) |
| Cycle 2 | 6.41 | 15.82 | 705 | 5 (+5/-0) | 6 (+6/-0) | 3 | 1 | 0 | 898 | 0 (+0/-0) | 13 (+13/-0) |
| Cycle 4 | 6.49 | 15.96 | 705 | 5 (+5/-0) | 6 (+6/-0) | 3 | 1 | 0 | 898 | 0 (+0/-0) | 13 (+13/-0) |
| Cycle 6 | 6.69 | 16.21 | 705 | 5 (+5/-0) | 6 (+6/-0) | 3 | 1 | 0 | 898 | 0 (+0/-0) | 13 (+13/-0) |
| Cycle 8 | 6.89 | 16.47 | 705 | 5 (+5/-0) | 6 (+6/-0) | 3 | 1 | 0 | 898 | 0 (+0/-0) | 13 (+13/-0) |
| Cycle 10 | 7.35 | 16.98 | 705 | 5 (+5/-0) | 6 (+6/-0) | 3 | 1 | 0 | 898 | 0 (+0/-0) | 13 (+13/-0) |
| **Cycle 12** | **7.57 (+21.9%)** | **17.25 (+11.8%)** | 705 | **5 (+5/-0)** | **6 (+6/-0)** | **3** | **1** | **0** | **898** | **0 (+0/-0)** | **13 (+13/-0)** |

#### C.2 — 8 Döngü Yeni Çizim → `CANLANDIR ⚡` (`InstantAliveStage` + `rigWorker`) VRAM & Worker Churn Testi

| Adım | V8 Live Heap (MB) | GL Textures (live / + / -) | GL Buffers (live / + / -) | WebGL Draws | Workers (live / + / -) |
|---|---:|---|---|---:|---|
| `initial` | 2.61 | 0 (+0 / -0) | 0 (+0 / -0) | 0 | 0 (+0 / -0) |
| `reanimate_1` | 4.38 | 3 (+3 / -0) | 3 (+3 / -0) | 122 | 1 (+1 / -0) |
| `reanimate_2` | 4.45 | 4 (+4 / -0) | 4 (+4 / -0) | 276 | 1 (+1 / -0) |
| `reanimate_3` | 4.57 | 5 (+5 / -0) | 5 (+5 / -0) | 428 | 1 (+1 / -0) |
| `reanimate_4` | 4.65 | 6 (+6 / -0) | 6 (+6 / -0) | 583 | 1 (+1 / -0) |
| `reanimate_5` | 4.69 | 7 (+7 / -0) | 7 (+7 / -0) | 736 | 1 (+1 / -0) |
| `reanimate_6` | 4.72 | 8 (+8 / -0) | 8 (+8 / -0) | 886 | 1 (+1 / -0) |
| `reanimate_7` | 4.72 | 9 (+9 / -0) | 9 (+9 / -0) | 1,040 | 1 (+1 / -0) |
| `reanimate_8` | 4.74 | **10 (+10 / -0)** | **10 (+10 / -0)** | 1,194 | 1 (+1 / -0) |
| `after_leave_desk` (Draw modu + GC) | 4.28 | **10 (+10 / -0)** | **10 (+10 / -0)** | 1,194 | **1 (+1 / -0)** (`rigWorker`) |

---

### Ek D — Gerçek Lighthouse `13.6.0` Ölçümleri

| Hedef & Profil | Perf Skoru | FCP | LCP | TBT | CLS | Speed Index | TTI | Max Pot. FID | Bootup | Main Thread | Unused JS | Long Tasks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **Lokal `127.0.0.1:4175` (Mobil 4x)** | **68/100** | 2.2 s (2,156 ms) | 2.2 s (2,156 ms) | **2,400 ms** | 0.0002 | 3.0 s (2,954 ms) | 7.3 s | **1,788 ms** | 3.8 s | 6.4 s | 469 KiB | 20 |
| **Lokal `127.0.0.1:4175` (Masaüstü 1x)** | **78/100** | 0.3 s (298 ms) | 0.3 s (298 ms) | **516 ms** | 0.0002 | 0.9 s (941 ms) | 1.7 s | **545 ms** | 1.1 s | 1.7 s | 469 KiB | 4 |
| **Canlı `https://inktrope.com` (Mobil 4x)** | **61/100** | 1.0 s (987 ms) | **3.3 s (3,312 ms)** | **1,664 ms** | 0.0007 | 5.5 s (5,503 ms) | 4.5 s | **1,421 ms** | 3.0 s | 5.7 s | 140 KiB (gzip) | 18 |

**En Uzun Görev İzleri (Lighthouse):**
- Lokal Mobil: `1,788 ms @ 3,956 ms | 386 ms @ 7,139 ms | 117 ms @ 6,930 ms | 103 ms @ 5,744 ms | 101 ms @ 617 ms`
- Canlı Mobil (`https://inktrope.com`): `1,421 ms @ 2,187 ms | 183 ms @ 4,654 ms | 95 ms @ 3,747 ms | 89 ms @ 3,842 ms | 83 ms @ 3,931 ms`

---

### Ek E — Matematiksel Hata Doğrulama Çıktısı (`verify-math-bugs.mjs`)

```text
=== 1. CoR FULL-ANGLE ANTIPODAL FLIP BUG ===
89 deg: { theta0Deg: 0, theta1Deg: 89, dot:  0.0175, sign:  1, outDeg:  44.5, expectedDeg: 44.5 }
91 deg: { theta0Deg: 0, theta1Deg: 91, dot: -0.0175, sign: -1, outDeg: -44.5, expectedDeg: 45.5 }
95 deg: { theta0Deg: 0, theta1Deg: 95, dot: -0.0872, sign: -1, outDeg: -42.5, expectedDeg: 47.5 }

=== 2. SOCKET BACKING MATRIX SHIFT ERROR ===
lean=0.25rad, sqY=1.0 @ (500,300):  { errX: -89.8, errY: 114.4, errDistPx: 145.4 }
lean=0.00rad, sqY=0.90 @ (500,300): { errX:  27.0, errY: -30.0, errDistPx:  40.4 }
lean=0.25rad, sqY=0.92 @ (640,220): { errX: -43.6, errY: 141.2, errDistPx: 147.8 }

=== 3. UNIVERSAL CREATURE GPU SKINNING SHIFT ERROR ===
rot=0.35rad, yaw=0 @ (500,300):     { errX: 133.2, errY: -153.3, errDistPx: 203.0 }
rot=0.00rad, yaw=45 @ (600,250):    { errX:  45.7, errY:    0.0, errDistPx:  45.7 }

=== 4. KLAUS LIGHTING NORMALIZATION PARITY ERROR ===
light=(0.85,-0.35), normal=(-0.3,0.1,0.95): { lightLen: 1.0561, ndlCpu: 0.204, ndlGpu: 0.1932, shadowWeightCpu: 0.0336, shadowWeightGpu: 0.0564 }
```
