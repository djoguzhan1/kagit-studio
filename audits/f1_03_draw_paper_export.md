# F1-03 DENETİM RAPORU — ÇİZİM, KAĞIT TARAMA & EXPORT / PAYLAŞIM

- **Denetçi Rolü:** AJAN 3 — Çizim, Kağıt Tarama & Export Uzmanı (Draw, Paper Scan & Export Auditor)
- **Proje:** INKTROPE / Kâğıt Studio
- **Yerel Kod Kökü:** `C:\Users\salat\Downloads\kagit-studio`
- **Canlı Uygulama:** `https://inktrope.com`
- **Denetim Tarihi:** 2026-11-24
- **Denetim Standardı:** Çizim motorunda Procreate / RoughAnimator / Looom; kağıt tarama, inpaint, video/PDF/ZIP export ve paylaşım hattında üretim (production) mühendisliği standardı.
- **Kapsam:** `DrawWorkspace`, `DrawingStage`, `ToolDeck`, `XSheetTimeline`, `LayerReferenceRail`, `ColorWheelPopover`, `canvasEngine`, `brushTextures`, `frameComposite`, `underlayGuides`, `timelapseRecorder`, `PaperCameraStudio`, `cameraEngine`, `paperWorker`, `paperWorkerClient`, `socketInpaint`, `characterIntakeEngine`, `ExportModal`, `exportEngine`, `videoExportEngine`, `flipbookPdf`, `zipBuilder`, `shareCodec`, `InstantAliveStage`, `worker/index.js`, `server/kagit_ai_pipeline/`.
- **Tek Dürüst Puan:** **`4/10`**

> **Puan Gerekçesi:** Uygulama temel tuval çizimi, X-Sheet kare ekleme/çoğaltma, ZIP/GIF/PDF üretimi ve canlı oturumda konsol hatasız çalışma gibi temel işlevleri ayağa kaldırabilmiş; ancak üretim kalitesini belirleyen beş temel mühendislik hattının tamamında ağır kusurlar mevcuttur. Kağıt tarama algoritması uygulamanın kendi yerleşik maskotunun gövdesini bile oyup delmektedir; Chrome MP4 export yolu kare-hassas WebCodecs yerine gerçek-zamanlı fragmented fMP4'e düşmekte ve diğer sahnelerde sesi sessizce düşürmektedir; çizim motoru strok-içi tamponsuz olduğu için saydam fırçalarda boğumlanma üretmekte ve kare değişiminde Undo/Redo geçmişini tamamen silmektedir; `ExportModal`'da ("İndir & Paylaş") proje paylaşım linki hiç bulunmamakta ve görsel yüklenince paylaş butonu sessiz ölü butona dönüşmektedir; `socketInpaint` ve `flipbookPdf` üretim baskısı / rigging kalitesini karşılamamaktadır.

---

## EN AĞIR 5 SORUN

### 1. `[FAIL]` Kağıt Tarama Motoru (`paperWorker.ts`) Kalın Siyah Mürekkebi İçten Oyup Deliyor, Gölge Kenarını Mürekkep Sanıyor ve Izgara Kesimde Nearest-Neighbor Pikselleştirme Yapıyor

- **Kök Neden (Kod Kanıtı):**
  - `src/engine/paperWorker.ts:328-389`: `processPaperScan` tek ölçekli integral-image kutu ortalaması (`radius = Math.max(14, Math.min(48, Math.round(Math.min(w, h) * 0.045)))`) kullanır ve her pikselin parlaklığını kendi etrafındaki `(2r+1)²` ortalama parlaklıkla karşılaştırır (`delta = localMean - lum`). Dolgu genişliği `2*radius` eşiğini aşan her siyah mürekkep alanının merkezinde `localMean` da siyaha çöktüğü için `delta ≈ 0` olur ve algoritma saf siyah mürekkebi "boş kağıt" sanıp şeffaf (`alpha = 0`) yapar.
  - Aynı yerel ortalama eşiği, boş kağıt üzerindeki keskin bir gölge sınırında (aydınlık piksel ile gölge pikseli arası ani parlaklık düşüşü) yüksek `delta` üretir ve kağıt gölgesini siyah mürekkep gibi boyar.
  - `src/engine/paperWorker.ts:307-313, 357-370`: Mavi/kırmızı eskiz kalemi silici (`hueCode === 1 || hueCode === 2`) kenar yumuşatmasız (binary) çalışır; mavi/kırmızı çizgi üstünden geçen siyah mürekkep kenarlarında 1-2 px tırtıklı halo bırakır.
  - `src/engine/paperWorker.ts:645-656`: A4 çoklu-kare ızgara dilimleyici (`sliceGridCells`) sub-piksel hizalamada bilinear enterpolasyon yerine `srcX | 0` / `srcY | 0` (nearest-neighbor) örnekleme yapar; ince mürekkep çizgilerinde basamaklanma (aliasing) üretir.
  - `src/engine/paperWorker.ts:5, 77-159`: Yorum satırında "Sobel + Bright-Page Mask" iddia edilmesine karşın kodda tek bir Sobel gradyanı yoktur; salt parlaklık eşiğine (`lum > 148 && sat < 45`) dayandığı için açık renkli masa üstünde `0.04..0.96` fallback'ine düşer ve tek bir 10×10 parlak ışık yansımasında köşeyi tamamen bozar.
  - `src/components/paper/PaperCameraStudio.tsx:130, 533-575`: Çoklu fotoğraf (batch) akışında her sayfa için ayrı perspektif köşesi yerine tek bir ortak `corners` dörtgeni tüm fotoğraflara uygulanır.
  - **Mimari Çatallanma:** `src/engine/characterIntakeEngine.ts` (Desk/Puppet/Film yüklemesinde kullanılır) gölge telafili yerel tavan haritası (`computeLocalPaperCeilingMap`) ile çok daha sağlıklı ayrıştırma yaparken, asıl kağıt tarama stüdyosu (`PaperCameraStudio.tsx`) hâlâ ilkel kutu-ortalamalı `paperWorker.ts`'yi kullanmaktadır.
- **Sayısal Probe Kanıtı (`audit_probes.mjs`, doğrudan `processPaperScan` & `detectPaperCorners` üzerinde):**
  - 90×90 tam siyah mürekkep dolgu: merkez alfa **`centerAlpha = 0`**, iç bölgedeki **`3600/3600` (%100) piksel oyulup tamamen şeffaflaştı**.
  - İnce 2 px açık grafit çizgi (`delta = 14`): **`pencilAlpha = 0`** (tamamen silindi).
  - Boş kağıt üstünde keskin düşme gölgesi kenarı: **`shadowEdgeAlpha = 212`**, **`2080` adet sahte siyah mürekkep pikseli** üretildi.
  - `detectPaperCorners`: Açık renkli masa üzerindeki `[0.20..0.80]` A4 sayfa → `[0.04..0.96]` fallback'ine düştü; sol-üst köşeye 10×10 parlak yansıma eklendiğinde sol-üst köşe `(0.045, 0.06)` noktasına sıçradı.
- **Canlı Tarayıcı Kanıtı (`https://inktrope.com`):**
  - Paper modunda uygulamanın kendi yerleşik örnek A4 kağıdı ("Şapkalı Baron") seçilip `"4 · Kareyi Masaya Aktar"` ile çizim masasına aktarıldığında (incelenen sandbox ekran görüntüsü `step_61_shot_1_suite3_imported_paper_frames_in_draw.png`), Baron'un siyah smokin gövdesinin tam ortasında devasa beyaz/şeffaf bir delik açıldığı ve çizgi kenarlarında nearest-neighbor kırıkları oluştuğu görsel olarak doğrulandı.

---

### 2. `[FAIL]` Gerçek MP4 Export Hattı Chrome'da Kare-Hassas `mp4-muxer`'ı Atlayıp Gerçek-Zamanlı Fragmented `fMP4` Üretiyor, H.264 Level Uyumsuzluğu ve Sessiz/Çöken Ses Yolları Barındırıyor

- **Kök Neden (Kod Kanıtı):**
  - `src/engine/exportEngine.ts:186`: `if (!support.nativeMp4Mime && support.webCodecsMp4)` koşulu yüzünden, Chrome 126+ gibi `MediaRecorder.isTypeSupported('video/mp4...') === true` dönen tarayıcılarda **kare-hassas çevrimdışı `mp4-muxer + VideoEncoder` (Yol 1) tamamen atlanır** ve gerçek-zamanlı `MediaRecorder` + `canvas.captureStream(project.fps)` + `setTimeout` döngüsüne (Yol 2, `exportEngine.ts:227-271`) düşülür. Sekme arka plana alındığında veya CPU yüklendiğinde `setTimeout` kayması kare düşürür/dondurur ve `MediaRecorder` `fastStart` standart MP4 yerine parçalı (fragmented `moof`) akış üretir.
  - `src/engine/videoExportEngine.ts:22-26`: H.264 profil/seviye olarak `avc1.42E01E` (**Level 3.0** — maksimum 1620 makro-blok = 720×576 SD) seçilmiştir; varsayılan 1280×720 HD tuval 3600 makro-blok gerektirir (Level 3.1+ gerekir). Ayrıca `video/mp4;codecs=avc1.42E01E` (yalnızca video) seçilip projede ses (`project.audio`) varsa `exportEngine.ts:231-245` ses parçasını stream'e ekleyip `new MediaRecorder(combinedStream, { mimeType })` çağırır → `NotSupportedError` fırlatır.
  - `src/engine/videoExportEngine.ts:57`: `pickBestMediaRecorderFormat()` hiçbir `mimeType` desteklenmediğinde bile `{ mime: 'video/webm', ext: 'webm' }` döndürür; kurtarma yerine doğrudan `new MediaRecorder` çökmesine yol açar.
  - `src/engine/videoExportEngine.ts:286-312`: WebCodecs AAC ses kodlama yolu `project.audio.volume` değerini tamamen yoksayar (ses hep %100 kazançla kodlanır).
  - `src/components/desk/InstantAliveStage.tsx:2684-2733` ve `PuppetStudio.tsx:861-886`: WebCodecs MP4 fallback çağrısında `audioBuffer` hiç verilmez → kullanıcıya uyarı vermeden **sessiz MP4** üretir. `FilmDirectorStudio.tsx:1606` ise `soundOn` açıkken Firefox'ta WebCodecs MP4'ü atlayıp `.webm`'e düşer.
  - `src/engine/timelapseRecorder.ts:70-76`: `video/webm;codecs=vp9` adayını `video/mp4`'ten **önce** kontrol eder; Chrome ve Firefox'ta timelapse daima `.webm` çıkar. `exportBeforeAfterReel` (`exportEngine.ts:301-406`) hiç WebCodecs kullanmaz ve `frame.hold` değerini yoksayar.
  - `src/engine/exportEngine.ts:140-160`: Export başlamadan önce tüm kareler tam çözünürlüklü `rendered[]` canvas dizisinde aynı anda RAM'e çizilir (200 kare × 1280×720 × 4B ≈ 737 MB → mobilde OOM).
  - `server/kagit_ai_pipeline/pipeline/mp4_transcoder.py` (`/api/v1/transcode-mp4`) yalnızca yerel Python FastAPI sunucusunda mevcuttur; `https://inktrope.com` üretim Cloudflare Worker'ında (`worker/index.js`) transcode uç noktası yoktur.
- **Canlı İndirilen Dosyanın Bayt-Düzeyi Kanıtı (`Yeni__izgi_Film_tam_film.mp4`, 11.786 bayt, `https://inktrope.com`):**
  - ISO BMFF kutu haritası: `ftyp:36 | moov:721 | moof:104 | mdat:10849 | mfra:76`.
  - Markalar (`ftyp`): `isomiso6iso2avc1`, `avc1: true`, `avcC: true`, **`moof` (fragmented fMP4): `true`**, `mp4a` (ses kanalı): `false`.
  - Bu bayt yapısı, canlı `https://inktrope.com` üzerinde Chrome'un `mp4-muxer` (`fastStart: 'in-memory'`) yolunu gerçekten **atlayıp** `MediaRecorder` fragmented fMP4 ürettiğini kesin olarak doğrulamaktadır (bu yapı pek çok mobil oynatıcıda, WhatsApp/Telegram önizlemelerinde ve kurgu yazılımlarında süre/sarım hatasına yol açar).

---

### 3. `[FAIL]` Çizim Motoru (`canvasEngine.ts` / `DrawingStage.tsx`) Strok-İçi Tamponsuz Olduğu İçin Saydam Fırçalarda Boğumlanma Yapıyor, Kare Değişince Undo/Redo Geçmişini Siliyor ve Her Strokta Çift Tam-Tuval GPU→CPU Okuması Yapıyor

- **Kök Neden (Kod Kanıtı):**
  - **Strok-içi tampon yokluğu & boğumlanma (`src/engine/canvasEngine.ts:1316-1428`):** Hiçbir fırça ayrı bir geçici strok tamponuna çizilip strok bitiminde katmana kompozitlenmez. `marker` (`globalAlpha = opacity * 0.42`, `lineCap = 'square'`), `gpen` (`0.25 * w` aralıklı çakışan daire damgaları), `pencil`/`blue-rough`, `dry-brush` ve `screentone` her pointer segmentini doğrudan katman üzerine biriktirir; hız yavaşlayınca veya kavis dönülünce üst üste binen segment birleşim noktalarında koyu boğumlar/düğümler oluşur.
  - **Grafit doku kırpılması ve titreşimi (`canvasEngine.ts:148-149, 238-241, 1389-1409`):** `grainScratch` tuvali `64×64` piksele sabitlenmiştir. Fırça boyutu `48` olduğunda (`r = 35.7`, çap > 64) dairesel damga kare kutu kenarlarından kesilir. Ayrıca doku kaydırması `tx = Math.floor(x) % 64` damganın `-diam/2` başlangıç ofsetini hesaba katmadığı için basınç değiştikçe kağıt dokusu fırçanın altında kayar ("grain crawl"). `dry-brush` (`1348-1371`) her segmentte normal vektörü `(nx, ny)` bağımsız hesapladığı için kavislerde kıllar kırık ve kopuk görünür.
  - **Stabilizer kuyruk kesilmesi (`canvasEngine.ts:1148-1236`):** `handlePointerUp` aşamasında stabilizer tamponundaki gecikmiş nokta son gerçek pointer konumuna tamamlanmaz; stabilizasyon açıkken her çizgi erken kesilir.
  - **Bozuk kalem basıncı & coalesced event eksikliği (`canvasEngine.ts:1240`, `DrawingStage.tsx:774`):** Basınç algılama `e.pointerType === 'pen'` yerine `pressure !== 0.5` varsayımına bağlanmıştır; gerçek bir stylus/Apple Pencil basıncı tam `0.50` noktasından geçerken genişlik aniden `0.72` varsayılanına sıçrar. `getCoalescedEvents()` hiç okunmadığı için 120Hz/240Hz kalemlerde hızlı eğriler poligona dönüşür.
  - **Kare değişiminde Undo/Redo silinmesi & bellek/GPU darboğazı (`canvasEngine.ts:318-329, 342-344, 351, 844, 873, 1080-1082, 1603`):**
    - `loadFrame()` çağrıldığı anda `this.undoStack = []; this.redoStack = [];` çalışır; kullanıcı bir önceki kareye göz atıp geri döndüğünde o karedeki tüm geri alma geçmişi yok olur.
    - Her `handlePointerDown` ve `commitDirtyUndo` işleminde tam tuval boyutunda **iki kez** `getImageData(0, 0, W, H)` (1080p'de 2 × 8,3 MB GPU→CPU senkron readback) yapılır; üstelik katman kanvasları `willReadFrequently: true` **olmadan** oluşturulduğu için her strok GPU pipeline'ını kilitler.
    - Silinen katmanların ofscreen canvas'ı `layerCanvases` haritasından ve `undoStack` girdilerinden temizlenmez (oturum içi bellek sızıntısı).
    - `DrawWorkspace.tsx:77-92` `handleUndo`/`handleRedo` doğrudan `engine.undo()` çağırarak `DrawingStage` debounce kayıt kuyruğunu baypas eder (hızlı geri-al + kare değiştirme yarış koşulu).
  - **Pasif `onWheel` Zoom hatası, Sürükleme Kilidi & Dar Ekran Kırpılması:**
    - `DrawingStage.tsx:809-815, 842`: React sentetik `onWheel` dinleyicisi pasiftir (`preventDefault()` çalışmaz/tarayıcı sayfa zoom'unu engelleyemez), imleç merkezli zoom yoktur ve `transition-transform duration-75` (`DrawingStage.tsx:988`) pinch/pan esnasında görünür gecikme yaratır.
    - `src/store/useStudioStore.ts:2179-2201` (`moveFrame`): `activeFrameIndex: toIndex` günceller ama `activeLayerId` yeni karenin katmanına bağlanmaz; aktif olmayan bir kareyi sürükleyip bırakan kullanıcı manuel katman seçmeden çizim yapamaz.
    - `DrawingStage.tsx:642, 693`: İki parmak pinch iptali yalnızca `isDrawing` stroklarını iptal eder; `bucket` (boya kovası) modunda iki parmakla zoom girişimi tuvali boyayla doldurabilir.
- **Canlı Tarayıcı Kanıtı (`https://inktrope.com`):**
  - `step_53_shot_1_suite2_draw_workspace.png` görsel incelemesinde gri Marker ile çizilen kavisli strokta koyu segment birleşim boğumları çıplak gözle doğrulandı.
  - Kare #3'te çizim sonrası Kare #2'ye geçilip Kare #3'e dönüldüğünde `Geri Al` butonunun `disabled: false → true` konumuna düşerek Undo yığınının sıfırlandığı canlı doğrulandı.
  - `Ctrl+Wheel` zoom hareketi canlı testte tuval yakınlaştırmasını **`100%` değerinde kilitli bıraktı**.
  - `1280×800` viewport'ta sağ üst çubuk kontrolleri (`Geri Al`, `Yinele`, `Katmanlar & Kılavuzlar`, `İndir`) ekran dışına taştı (`1440×900`'da görünür oldu).

---

### 4. `[FAIL]` Paylaşım Linki (`shareCodec.ts`) Ana Proje / `ExportModal`'da Hiç Yok, Yüklenen Çizimlerde Sessiz Ölü Butona Dönüşüyor, 32 Strok Üstünü Sessizce Kırpıyor ve URL Limitlerini Aşıyor

- **Kök Neden (Kod Kanıtı):**
  - `src/components/export/ExportModal.tsx:1-438`: Modal başlığı `"İndir & Paylaş"` olmasına rağmen içinde **tek bir paylaşım linki butonu, üreticisi veya akışı yoktur**. Çok kareli Draw / Paper / Puppet / Film projeleri bağlantıyla hiç paylaşılamaz. Cloudflare Worker (`worker/index.js`) üzerinde herhangi bir paylaşım kısaltma/depolama uç noktası bulunmamaktadır.
  - `src/components/desk/InstantAliveStage.tsx:2763-2765`: Paylaşım yalnızca Desk sahnesindeki vektör stroklara sıkıştırılmıştır ve `if (heroStrokesRef.current.length === 0) return;` satırı yüzünden kağıt/PNG görsel yükleyen (`Yükle`) kullanıcılarda **"Paylaş" butonu aktif (`disabled = false`) görünmesine rağmen tıklanınca tamamen sessizce hiçbir şey yapmaz** (hata/uyarı yok, URL değişmez).
  - `src/components/desk/InstantAliveStage.tsx:2778-2786`: Pano yazma (`navigator.clipboard.writeText`) başarısız olup `catch` bloğuna düştüğünde bile sahte olarak `notify(t('shareCopied'))` ("Link kopyalandı") bildirimi gösterir.
  - `src/engine/shareCodec.ts:30-66, 111-154`:
    - `simplifyPoints` yorumunda dikey mesafe / RDP izlenimi verir ama aslında kaba Öklid adım filtresi (`Math.hypot >= 6.5`) uygular; keskin köşeleri yuvarlar/yok eder.
    - `packStrokes`: `maxStrokes = 32` (ikinci karakter `20`), `maxPtsPerStroke = 36` (`28`) üzerinde kalan tüm strokları kullanıcıya tek bir uyarı vermeden sessizce kesip atar.
    - Hiçbir sıkıştırma (Deflate/LZ) kullanmadan ham JSON'u Base64URL'ye çevirir; bu yüzden orta-detaylı çizimlerde hash boyutu standart URL limitlerini (2.000–8.192 karakter) katbekat aşar.
- **Sayısal Probe Kanıtı (`audit_probes.mjs`):**
  - 50 hero + 30 buddy stroklu gerçekçi çizim `encodeSharedStage → decodeSharedStage` testinde: **18 hero + 10 buddy stroku sessizce silindi** (`50 → 32`, `30 → 20`), buna rağmen üretilen tek hash tokenı **19.480 karakter** uzunluğa ulaştı (WhatsApp/SMS/tarayıcı/proxy paylaşımında kesilme veya bozulma garantili).
- **Canlı Tarayıcı Kanıtı (`https://inktrope.com`):**
  - `final_step_76.png` (**`BROWSER_HOST_FACTS` doğrulamalı ekran görüntüsü**) ve `step_63_shot_1_suite4_export_modal.png`: `ExportModal` içindeki 8 kartın tamamı yalnızca dosya indirme kartıdır (MP4, GIF, PNG Dizisi, A4 PDF, Şeffaf PNG, Proje Yedeği, Öncesi/Sonrası, Timelapse); **0 adet paylaşım linki kontrolü** mevcuttur.
  - Desk sahnesinde PNG görsel yüklendikten sonra `Paylaş` butonuna tıklandığında buton aktif olduğu hâlde hiçbir toast, URL hash güncellemesi veya geri bildirim oluşmadığı canlı doğrulandı.
  - 4 basit stroklu vektör çizimde üretilen 449 karakterlik `#kagit=...` bağlantısı yeni sekmede toy/world/mood/strokları geri yükledi (`step_20.png`), ancak geri yüklenen karakterin yüz bölgesinde rig/mesh çatlağı gözlemlendi.

---

### 5. `[FAIL]` PDF Flipbook (`flipbookPdf.ts`) Baskı Ergonomisi / Bozuk Binary İşaretçi / Türkçe Karakter Kaybı / Başlık Çakışması ve `socketInpaint.ts`'nin Kaba Blok-Bulanıklaştırması

- **Kök Neden — PDF Flipbook (`src/engine/flipbookPdf.ts` & `src/engine/exportEngine.ts`):**
  - **Bozuk PDF ikili yorum başlığı (`flipbookPdf.ts:16-22, 218`):** `asciiBytes('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')` fonksiyonu tüm baytları `& 0x7f` ile maskelediği için `0xFF` yerine **`0x7F 0x7F 0x7F 0x7F` (DEL)** yazar; PDF 1.4 §3.4.1 ikili dosya belirteci şartını (≥4 adet `>= 0x80` bayt) ihlal eder.
  - **Türkçe karakter kaybı & sabit kırık Türkçe metin (`flipbookPdf.ts:24-38, 147`):** Standard Helvetica `/WinAnsiEncoding` kullanılmayıp `sanitizePdfText` ile tüm Türkçe harfler ASCII'ye indirgenir (`Yeni Çizgi Film` → `Yeni Cizgi Film`, `ş/ğ/ı/İ/ö/ü` kaybolur). Üstelik satır `147`'deki talimat (`Kesikli cizgilerden kesip sol paydan zimbalayin`) İngilizce (`en`) arayüzde bile sabit Türkçe ve bozuk harflerle basılır.
  - **Üst bilgi metin çakışması (`flipbookPdf.ts:144-147`):** Sol başlık `x = 24pt` konumundan, sağ talimat `x = 361.3pt` konumundan başlar; başlık kırpılmadığı (truncate edilmediği) için ~25 karakterden uzun her proje adı sağdaki kesim talimatının üzerine biner (`pdf_probe.mjs` 95 karakterlik başlıkta ~456 pt genişliğe ulaşıp ~119 pt bindirme üretti).
  - **Hold (poz süresi) yoksayılıyor (`exportEngine.ts:591-602`):** `exportFlipbookPdf` yalnızca benzersiz kareleri döner; `frame.hold` sayısını hiç dikkate almaz. Canlı projede Kare #1 `×2` (toplam 8 poz / 7 benzersiz kare) olmasına rağmen indirilen PDF'de yalnızca 7 kart (`#001..#007`) üretildi — basılan fiziksel flipbook'un zamanlaması animasyonla uyuşmaz.
  - **Baskı en-boy oranı ve başparmak kenarı hatası (`flipbookPdf.ts:132-192`):** Kart çizim alanı `195.64 × 174.47 pt` (1,12:1) oranındadır; `16:9` animasyonda dikey alanın %37'si boş bant kalır, `9:16` dikey projede ise görsel yatayda ortalandığı için sağdaki başparmak çevirme kenarında ~17 mm boş beyaz şerit oluşur (flipbook çevrilirken akıcılığı bozar).
- **Canlı İndirilen PDF Kanıtı (`Yeni__izgi_Film_A4_flipbook.pdf`, 73.024 bayt, `https://inktrope.com`):**
  - Baytlar `[10..13]`: **`0x7f 0x7f 0x7f 0x7f`** (bozuk binary belirteç doğrulandı).
  - Sayfa akış metinleri: `(Yeni Cizgi Film — Kagit Studio A4 Flipbook · 7 kare · 12 FPS)` ve `(Kesikli cizgilerden kesip sol paydan zimbalayin)` — Türkçe karakterler bozulmuş, Kare #1 `×2` hold yoksayılarak yalnızca 7 kart (`#001..#007`) basılmış.
- **Kök Neden — `socketInpaint.ts` (`src/engine/socketInpaint.ts:4, 23-198`):**
  - Dosya başında "Telea-inspired directional inpainting" iddia edilmesine karşın kodda ne yönlü gradyan ne de doku sentezi vardır: en fazla 200 px yüksekliğindeki kaba `topoW × topoH` ızgarasında basit **4-komşulu izotropik BFS ortalama yayılımı (`sr / cnt`, satır 157)** yapıp bunu tam çözünürlüğe **nearest-neighbor blok kopyalama (`Math.floor(x * topoW / srcW)`, satır 172-176)** ile büyütür.
  - Yalnızca kol soketleri (`reg === 2 || reg === 3`, satır 162) doldurulur; bacak soketleri (`4, 5`) ve boyun (`0`) tamamen göz ardı edilir.
  - `audit_probes.mjs` Probe 3: Kırmızı-beyaz çizgili gövdede inpaint bölgesi tamamen tekdüze çamurlu pembeye (`RGB(231..234, 132..153, 132..153)`) eridi, 4×4 özdeş piksel blokları oluştu ve `legInpainted = 0` döndü.
  - Üstelik `inpaintedBackRgba` bellekte oluşturulup `rigWorker.ts` üzerinden aktarılmasına karşın sahnede kullanılmayan ölü tampon (`dead allocation`) olarak kalır; `webglSkinnedRenderer.ts:809-848` (`drawInpaintedSocketBackingPass`) yalnızca `socketOnlyRgba`'yı ışıksız/düz katı yama olarak göğüs kemiğine yapıştırır (Klaus normal ışıklandırmasına katılmaz).

---

## DETAYLI KRİTER MATRİSİ

### 1. Çizim Motoru & Fırça Hissi (`DrawWorkspace`, `DrawingStage`, `ToolDeck`, `canvasEngine`, `brushTextures`)

| Kriter | Durum | Somut Kanıt (Kod / Canlı / Probe) |
|---|---|---|
| Temel pointer çizimi, fırça değişimi, renk seçici ve araç paleti çalışır | `[PASS]` | `src/components/studio/DrawWorkspace.tsx:1-210`, `ToolDeck.tsx:1-260`, `ColorWheelPopover.tsx:1-220`; canlı `https://inktrope.com` testinde G-Pen, Marker, 2B Kalem, Boya Kovası, Silgi seçimi ve tuval üzerinde gerçek pointer sürüklemeleri çizim üretti (`step_53_shot_1_suite2_draw_workspace.png`). |
| Saydam/yarı-saydam fırçalarda strok-içi homojen kompozisyon (Marker, G-Pen, Graphite, Dry-Brush) | `[FAIL]` | `src/engine/canvasEngine.ts:1316-1428`: Ayrı strok tamponu yok; her segment doğrudan katmana birikir (`marker` `globalAlpha = opacity*0.42`, `gpen` `0.25*w` daire damgaları). Canlı `step_53_shot_1_suite2_draw_workspace.png` içinde gri Marker kavisi üzerinde koyu eklem boğumları doğrulandı. |
| Kağıt dokusu gerçekçiliği ve büyük fırçada kırpılmama (`brushTextures.ts` & `grainScratch`) | `[FAIL]` | `src/engine/canvasEngine.ts:148-149, 238-241, 1389-1409`: `grainScratch` `64×64` sabit; `size=48`'de damga kare sınırdan kesiliyor. `tx = Math.floor(x) % 64` ofseti `-diam/2` kaymasını yoksaydığı için basınç değişiminde doku titriyor. `dry-brush` (`1348-1371`) kavislerde kıl süreksizliği üretiyor. |
| Kalem basıncı (stylus pressure) ve yüksek Hz örnekleme (`getCoalescedEvents`) | `[FAIL]` | `src/engine/canvasEngine.ts:1240`: `pointerType === 'pen'` yerine `pressure !== 0.5` testi yapılıyor; stylus `0.50` basıncından geçerken `0.72` genişliğine sıçrar. `src/components/studio/DrawingStage.tsx:774`: `getCoalescedEvents()` hiç çağrılmıyor. |
| Stabilizer (çizgi yumuşatma) bitiş doğruluğu | `[FAIL]` | `src/engine/canvasEngine.ts:1148-1236`: `handlePointerUp` stabilizer kuyruğunu son pointer koordinatına yakalamadan keser; her stabilize strok kısa biter. |
| Zoom / Pan / Wheel / Palm & Touch yönetimi | `[FAIL]` | `src/components/studio/DrawingStage.tsx:809-815, 842, 988`: React sentetik `onWheel` pasiftir; canlı testte `Ctrl+Wheel` zoom'u **`100%` değerinde kilitli bıraktı**. İmleç merkezli zoom yok; `transition-transform duration-75` pinch/pan gecikmesi yaratır. `DrawingStage.tsx:642, 693`: 2 parmak pinch yalnızca `isDrawing`'i iptal eder, `bucket` modunda tuvali doldurur. |
| Çizim performans/bellek hijyeni (GPU→CPU readback & katman temizliği) | `[FAIL]` | `src/engine/canvasEngine.ts:318-329, 351, 844, 873, 1080-1082`: Katman kanvaslarında `willReadFrequently: true` yok; her strok `handlePointerDown` + `commitDirtyUndo` ile **2× tam-tuval `getImageData`** (1080p'de 2 × 8,3 MB) readback yapar. Silinen katmanlar `layerCanvases` ve `undoStack`'ten temizlenmez. |
| Masaüstü responsive araç çubuğu sığması (`1280×800`) | `[FAIL]` | Canlı `https://inktrope.com` testinde `1280×800` viewport'ta `TopConsoleBar` sağ kontrolleri (`Geri Al`, `Yinele`, `Katmanlar & Kılavuzlar`, `İndir`) ekran dışına taştı (`1440×900` çözünürlükte görünür oldu). |
| Fiziksel Apple Pencil / Wacom stylus tilt & gerçek palm rejection testi | `[TEST EDİLMEDİ]` | Sanal tarayıcı ortamında gerçek donanım kalemi/dokunmatik ekran mevcut değil; kaynak kod mantığı yukarıda `[FAIL]` olarak denetlendi (`canvasEngine.ts:1240`, `DrawingStage.tsx:693, 774`). |

---

### 2. `XSheetTimeline` & Katman Sistemi (`LayerReferenceRail`, `frameComposite`, Undo/Redo)

| Kriter | Durum | Somut Kanıt (Kod / Canlı / Probe) |
|---|---|---|
| X-Sheet temel kare işlemleri (ekle, çoğalt, sil, hold `×1..×24`, FPS `8/12/15/24`, onion skin aç/kapa) | `[PASS]` | `src/components/studio/XSheetTimeline.tsx:73-580`, `src/store/useStudioStore.ts:1955-2175`; canlı `https://inktrope.com` testinde yeni kare ekleme, çoğaltma, Kare #1 hold `×2`, onion skin aç/kapa ve Play/Pause sorunsuz çalıştı. |
| Kare değişiminde Undo/Redo sürekliliği ve yarış koşulu güvenliği | `[FAIL]` | `src/engine/canvasEngine.ts:342-344`: `loadFrame` her kare değişiminde `undoStack = []`, `redoStack = []` yapar; canlı testte Kare #3 → #2 → #3 geçişinde `Geri Al` butonunun `disabled: false → true` olduğu doğrulandı. `src/components/studio/DrawWorkspace.tsx:77-92`: `handleUndo`/`handleRedo` `DrawingStage` debounce kuyruğunu atlar. Kare silme işleminin Undo desteği yoktur. |
| Kare sürükle-bırak sıralama sonrası aktif katman bağlaması (`moveFrame`) | `[FAIL]` | `src/store/useStudioStore.ts:2179-2201`: `moveFrame` `activeFrameIndex: toIndex` atar ama `activeLayerId` yeni aktif karenin katmanlarına güncellenmez; sürükleme sonrası çizim `no-layer` durumuna kilitlenir. |
| Oynatma FPS senkronu, ses senkronu ve In/Out `loopRange` uyumu | `[FAIL]` | `src/components/studio/DrawingStage.tsx:315-453`: (1) Satır `397, 413` `loopRange` aktifken bile sesi hep `startAt(0, ...)` ile baştan başlatır; (2) `useEffect` bağımlılık dizisi (`453`) `project.audio` içermez — oynatma sırasında sessize alma/ses seviyesi değişimi etkisiz kalır; (3) `tick` içinde asenkron kare çözümleme (`420, 433`) yavaş karede sırayı bozup eski kareyi geç çizebilir; (4) `XSheetTimeline.tsx:122-136` dalga formu tıklamasını `audio.durationSec` yerine `totalExposures` oranıyla eşler. |
| `LayerReferenceRail` UI işlemleri (ekle, kilitle, görünürlük, opaklık, sıralama, Multiply/Normal) | `[PASS]` | `src/components/studio/LayerReferenceRail.tsx:396-486`; canlı `https://inktrope.com` testinde yeni katman (`Boya 4`) eklendi, kilit açılınca çizim engellenip toast gösterildi, opaklık sürgüsü çizgiyi soldurdu ve katman sıralaması değişti. |
| Onion-skin katman blend-mode kompozisyonu (`buildOnionComposites`) | `[FAIL]` | `src/engine/canvasEngine.ts:367-385`: `buildOnionComposites` katmanın `blendMode` (`multiply`) özelliğini yoksayıp her katmanı `source-over` çizer; opak taranmış kağıt katmanı onion skin'de tuvali tamamen örten katı kırmızı/mavi dikdörtgene dönüşür. |
| Katman düzenleme sonrası X-Sheet küçük resim (thumbnail) güncelliği & şeffaf PNG export kompozisyonu | `[FAIL]` | `src/store/useStudioStore.ts:2254-2322`: Katman gizleme, opaklık, sıralama veya silme sonrası `frame.thumbKey` yenilenmez (X-Sheet önizlemesi bayat kalır). `src/engine/frameComposite.ts:43-80`: `transparentBg: true` exportunda `multiply` opak kağıt katmanı şeffaf alanda beyaz arka plan bırakır. `useStudioStore.ts:1001, 1961`: `setExportOpen(true)` ve `selectFrame` `void flushActiveCanvasNow()` çağırıp `await` etmez — hızlı tıklamada son strok kaybolabilir. |
| Katman opaklık sürgüsü alt sınırı & erişilebilirlik | `[FAIL]` | `src/components/studio/LayerReferenceRail.tsx:459, 631`: Opaklık sürgüsü `min={0.1}` ile kısıtlı (%1–%9 yapılamaz); katman opaklık/blend kontrolleri yalnızca aktif seçili katmanda görünür. |

---

### 3. Kağıt Tarama, Kırpma & Inpaint Kalitesi (`PaperCameraStudio`, `cameraEngine`, `paperWorker`, `socketInpaint`, `characterIntakeEngine`)

| Kriter | Durum | Somut Kanıt (Kod / Canlı / Probe) |
|---|---|---|
| Örnek A4 kağıt yükleme, 4 köşe arayüzü, Öncesi/Sonrası kaydırıcı ve çizim masasına aktarım akışı | `[PASS]` | `src/components/paper/PaperCameraStudio.tsx:495-582`; canlı `https://inktrope.com` testinde örnek A4 kağıt ("Şapkalı Baron") yüklendi, 4 köşe tutamacı ve Öncesi/Sonrası ayracı çalıştı (`step_59_shot_1_suite3_paper_corners_and_wipe.png`) ve 4 kare Draw masasına aktarıldı. |
| Mürekkep eşikleme ve gölge bastırma doğruluğu (`processPaperScan`) | `[FAIL]` | `src/engine/paperWorker.ts:328-389`: Tek ölçekli kutu-ortalaması 90×90 siyah dolgunun %100 içini oydu (`3600/3600` şeffaf piksel), 2px grafit çizgiyi tamamen sildi (`pencilAlpha=0`), keskin gölge sınırında `2080` sahte siyah piksel üretti (`audit_probes.mjs`). Canlı aktarılan Baron maskotunun siyah smokin ortasında dev beyaz delik doğrulandı (`step_61_shot_1_suite3_imported_paper_frames_in_draw.png`). |
| Otomatik 4 köşe tespiti (`detectPaperCorners`) & çoklu fotoğraf (batch) köşe yönetimi | `[FAIL]` | `src/engine/paperWorker.ts:5, 77-159`: Sobel yok; açık masada `[0.04..0.96]` fallback'ine çöker, 10×10 ışık parlamasında köşe `(0.045, 0.06)`'ya sıçrar (`audit_probes.mjs`). `PaperCameraStudio.tsx:130, 533-575`: Batch akışında tüm sayfalara aynı tek `corners` uygulanır. |
| A4 ızgara dilimleme ve mavi/kırmızı eskiz temizleme kalitesi | `[FAIL]` | `src/engine/paperWorker.ts:307-313, 357-370, 645-656`: Mavi/kırmızı temizleyici binary/AA'sız halo bırakır; `sliceGridCells` `srcX \| 0` nearest-neighbor ile pikselleştirme üretir. |
| `socketInpaint.ts` doku doldurma ve eklem kapsama kalitesi | `[FAIL]` | `src/engine/socketInpaint.ts:4, 44-198`: Telea/doku sentezi yok; kaba ızgarada (max 200px) 4-komşulu ortalama BFS (`sr/cnt`) + nearest-neighbor blok büyütme. Probe 3: çizgili kumaş tekdüze çamurlu pembeye (`RGB(231..234, 132..153, 132..153)`) ve 4×4 bloklara dönüştü; bacak/boyun soketleri sıfır (`legInpainted=0`). `inpaintedBackRgba` ölü bellek tahsisidir; `webglSkinnedRenderer.ts:809-848` ışıksız düz yama çizer. |
| Canlı kamera yakalamada perspektif düzeltme (kod incelemesi) | `[FAIL]` | `src/components/paper/PaperCameraStudio.tsx:205-245`: `captureLiveFrame`, `runPaperProcess` çağrısına `corners` geçmez; canlı kamera çekiminde hiçbir perspektif kırpma/düzeltme yapılmaz. |
| Desk/Puppet karakter alma hattı (`characterIntakeEngine.ts`) | `[PASS]` | `src/engine/characterIntakeEngine.ts` 5 aşamalı yerel kağıt tavan haritası (`computeLocalPaperCeilingMap`) + BFS ayrıştırma kullanır; `npx vitest run` içinde 21 birim testi geçmektedir (ancak `PaperCameraStudio` bu üstün motoru kullanmamaktadır — yukarıdaki mimari kopukluk). |
| Gerçek fiziksel webcam akışı ve alkış (clap) ses tetikleyicisi canlı donanım testi | `[TEST EDİLMEDİ]` | Sanal tarayıcıda fiziksel kamera/kağıt/mikrofon bulunmadığından canlı donanım yakalama ve alkış eşiği test edilemedi; kamera izni olmadığında fallback UI'nin kilitlenmeden göründüğü doğrulandı, kaynak kod algoritmaları ayrıca yukarıda `[FAIL]` olarak denetlendi (`cameraEngine.ts`, `PaperCameraStudio.tsx:160-398`). |

---

### 4. `ExportModal` — Gerçek MP4 Çıktısı (`videoExportEngine`, `exportEngine`, `timelapseRecorder`, `worker/index.js`)

| Kriter | Durum | Somut Kanıt (Kod / Canlı / Probe) |
|---|---|---|
| Chrome'da gerçek H.264 MP4 container üretimi (WebM'i `.mp4` diye kandırmıyor mu?) | `[PASS]` | Canlı indirilen `Yeni__izgi_Film_tam_film.mp4` (11.786 bayt) bayt analizinde geçerli ISO BMFF `ftyp` (`isomiso6iso2avc1`), `avc1` + `avcC` H.264 kutuları doğrulandı; sahte WebM etiketlemesi yapılmıyor. |
| Chrome'da kare-hassas, `fastStart` non-fragmented MP4 üretimi (`mp4-muxer` önceliği) | `[FAIL]` | `src/engine/exportEngine.ts:186`: `!support.nativeMp4Mime && support.webCodecsMp4` koşulu Chrome 126+'da `mp4-muxer`'ı atlayıp gerçek-zamanlı `MediaRecorder` + `setTimeout` yoluna girer. Canlı indirilen `Yeni__izgi_Film_tam_film.mp4` kutu haritası **`ftyp \| moov \| moof \| mdat \| mfra`** (fragmented fMP4!) olarak doğrulandı. |
| H.264 profil/seviye uyumluluğu ve sesli proje MediaRecorder kararlılığı | `[FAIL]` | `src/engine/videoExportEngine.ts:22-26, 57`: HD 720p için Level 3.0 (`avc1.42E01E`, SD limit) kullanılıyor; video-only MP4 mime seçilip `project.audio` eklendiğinde (`exportEngine.ts:231-245`) `new MediaRecorder` `NotSupportedError` fırlatır. Hiç destek yoksa `pickBestMediaRecorderFormat` geçersiz `'video/webm'` döndürüp çökertir. |
| Ses kanalı ve ses düzeyi (volume) sadakati (Draw / Desk / Puppet / Film) | `[FAIL]` | `src/engine/videoExportEngine.ts:286-312`: WebCodecs AAC yolu `project.audio.volume` değerini yoksayar. `InstantAliveStage.tsx:2684-2733` ve `PuppetStudio.tsx:861-886` WebCodecs fallback'inde `audioBuffer` geçmez → sessiz MP4 üretir. `FilmDirectorStudio.tsx:1606` sesli Firefox exportunda `.webm`'e düşer. |
| Büyük projede bellek güvenliği & Timelapse / Before-After MP4 uyumu | `[FAIL]` | `src/engine/exportEngine.ts:140-160`: Tüm kareleri aynı anda `rendered[]` canvas dizisinde RAM'e çizer (200 kare HD ≈ 737 MB OOM riski). `src/engine/timelapseRecorder.ts:70-76`: `video/webm;codecs=vp9`'u `video/mp4` önüne koyar (Chrome'da `.webm` çıkar). `exportBeforeAfterReel` (`exportEngine.ts:347-406`) `frame.hold` yoksayar ve WebCodecs kullanmaz. |
| Sunucu tarafı MP4 transcode yedek yolu (`inktrope.com`) | `[FAIL]` | `server/kagit_ai_pipeline/pipeline/mp4_transcoder.py` (`/api/v1/transcode-mp4`) yalnızca yerel FastAPI içindir; üretim `worker/index.js` üzerinde MP4 transcode uç noktası yoktur. |
| Gerçek Safari iOS/macOS donanımında WebCodecs/MediaRecorder MP4 uyumluluğu | `[TEST EDİLMEDİ]` | Denetim Chromium tabanlı sanal tarayıcıda yürütüldü; Safari özelindeki çalışma zamanı davranışı canlı doğrulanamadı, kod düzeyindeki Level 3.0 / ses / fallback kusurları yukarıda `[FAIL]` olarak raporlandı. |

---

### 5. `ExportModal` — PDF Flipbook (`flipbookPdf`) & ZIP (`zipBuilder`) & GIF

| Kriter | Durum | Somut Kanıt (Kod / Canlı / Probe) |
|---|---|---|
| PDF xref tablosu, nesne ofsetleri ve sayfa yapısı bütünlüğü | `[PASS]` | Canlı indirilen `Yeni__izgi_Film_A4_flipbook.pdf` (73.024 bayt): `%PDF-1.4`, `startxref=72697`, 12 nesne, **`badXref=0`**. `pdf_probe.mjs` çok sayfalı (10 kare) testte de 17 nesne, `badXref=0` doğrulandı. |
| PDF 1.4 ikili dosya başlık belirteci (§3.4.1) | `[FAIL]` | `src/engine/flipbookPdf.ts:16-22, 218`: `asciiBytes('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n')` `& 0x7f` maskesi uyguladığı için hem probe hem canlı PDF baytlarında (`[10..13]`) **`0x7f 0x7f 0x7f 0x7f`** yazıldığı doğrulandı. |
| PDF Türkçe karakter desteği ve yerelleştirme (i18n) | `[FAIL]` | `src/engine/flipbookPdf.ts:24-38, 147`: `sanitizePdfText` tüm Türkçe karakterleri bozar (`Yeni Çizgi Film` → `Yeni Cizgi Film`); satır `147` İngilizce modda bile sabit kırık Türkçe (`Kesikli cizgilerden kesip sol paydan zimbalayin`) basar — canlı indirilen PDF içerik akışında doğrulandı. |
| PDF başlık çakışmaması, `frame.hold` sadakati ve baskı en-boy oranı | `[FAIL]` | `src/engine/flipbookPdf.ts:132-192` & `src/engine/exportEngine.ts:591-602`: ~25 karakter üstü başlık sağdaki talimatla çakışır (`pdf_probe.mjs`: 119 pt bindirme); canlı 7 kare / 8 pozluk (Kare #1 `×2`) projede yalnızca 7 kart (`#001..#007`) üretildi; `16:9` projede %37 boş bant, `9:16` projede başparmak kenarında ~17 mm ölü boşluk bırakır. |
| ZIP yazımı — IEEE CRC32, UTF-8 dosya adları, Central Directory & EOCD | `[PASS]` | `src/engine/zipBuilder.ts:15-106`; IEEE CRC32 (`"123456789"` → `0xcbf43926`) doğrulandı. Canlı indirilen `Yeni__izgi_Film_png_dizisi.zip` (415.358 B, 7 PNG, UTF-8 bayrağı `0x800`, `crcBad=0`, EOCD `415336`) ve `Yeni__izgi_Film.kagit.zip` (512.959 B, 19 dosya, `crcBad=0`, EOCD `512937`) geçerli arşivler olarak doğrulandı. |
| ZIP okuma (`parseZipBytes`) — CRC32 doğrulama, Deflate uyumu, sınır kontrolü & yazım bellek/zaman damgası | `[FAIL]` | `src/engine/zipBuilder.ts:99-149`: (1) `buildZipBlob` her girdide `.buffer.slice()` yaparak büyük projede RAM'i 2-3× katlar; (2) DOS zaman damgası `0` (`1980-00-00` geçersiz tarih); (3) `parseZipBytes` **hiç CRC32 kontrolü yapmaz** (bozuk yedek dosyalarını sessizce kabul eder); (4) `method === 8` (Deflate) girdilerini sessizce atlar (`audit_probes.mjs`: Finder/Explorer/7-Zip ile yeniden sıkıştırılan `.kagit.zip` yedeği `0` dosya olarak açılır!); (5) kesilmiş tamponda sınır kontrolü olmadan `RangeError` fırlatır. |
| Animasyonlu GIF çıktısı (`ExportModal`) | `[PASS]` | Canlı indirilen `Yeni__izgi_Film.gif` (47.925 bayt): geçerli `GIF89a` başlığı, `640×360`, 256 renkli global palet ve `0x3b` bitiş baytı doğrulandı. |

---

### 6. Paylaşım Linki (`shareCodec`, Uçtan Uca Round-Trip Doğrulaması)

| Kriter | Durum | Somut Kanıt (Kod / Canlı / Probe) |
|---|---|---|
| Küçük vektör çizimde `#kagit=...` encode/decode round-trip (toy/world/mood/strok) | `[PASS]` | `src/engine/shareCodec.ts:111-154`; canlı `https://inktrope.com` testinde Desk sahnesinde çizilen 4 strok + "Uzay" sahnesiyle üretilen 449 karakterlik `#kagit=...` linki yeni sekmede açılarak karakter/sahne/strokları geri yükledi (`step_20.png`, ancak geri yüklenen karakterde yüz mesh çatlağı görüldü). |
| `ExportModal` ("İndir & Paylaş") içinde proje paylaşım linki | `[FAIL]` | `src/components/export/ExportModal.tsx:1-438`, `worker/index.js`: Modalda ve sunucuda paylaşım linki özelliği hiç yok (`final_step_76.png` **`BROWSER_HOST_FACTS` doğrulamalı**). Çok kareli çizim projeleri paylaşılamıyor. |
| Yüklenen (PNG/Kağıt) karakterde Paylaş butonu davranışı ve pano hata yönetimi | `[FAIL]` | `src/components/desk/InstantAliveStage.tsx:2763-2786`: `heroStrokesRef.current.length === 0` erken dönüşü yüzünden aktif görünen `Paylaş` butonu canlı testte tamamen sessiz ölü buton gibi davrandı; pano yazma hatasında bile `catch` içinde sahte `"Link kopyalandı"` bildirimi veriliyor. |
| Strok kaybı olmadan kodlama ve URL uzunluk limiti (≤ 2.000–8.192 karakter) | `[FAIL]` | `src/engine/shareCodec.ts:30-66`: Ham sıkıştırmasız JSON + Base64URL. `audit_probes.mjs` Probe 5: 50 hero + 30 buddy strok sessizce 32 + 20'ye kırpıldı (28 strok kalıcı kayboldu), buna rağmen **19.480 karakter** token üretildi. `simplifyPoints` RDP yerine Öklid adımlaması yaparak köşeleri kesiyor. |

---

### 7. Otomatik Test Suite Kapsamı Denetimi (`npx vitest run`)

| Kriter | Durum | Somut Kanıt |
|---|---|---|
| Mevcut Vitest regresyon paketi çalışıyor | `[PASS]` | `C:\Users\salat\Downloads\kagit-studio` dizininde `npx vitest run`: 14 test dosyası, **117/117 test geçti** (13,17 sn). |
| Kritik üretim hatalarını yakalayacak gerçek test kapsamı | `[FAIL]` | 117/117 yeşil sonuç yanıltıcıdır: `drawWorkspace.test.ts` `StudioCanvasEngine` fırça/undo/zoom davranışını hiç test etmez; `studio.test.ts` `processPaperScan`, `detectPaperCorners`, `flipbookPdf`, `videoExportEngine` MP4/ses yollarını ve `zipBuilder` Deflate/CRC doğrulamasını hiç kapsamaz; `productionReadiness.test.ts` yalnızca sahte `MediaRecorder` mock'u kullanır. Yukarıdaki 5 ağır üretim kusurunun tamamı 117 yeşil testten tek hata vermeden geçmektedir. |

---

## CANLI TEST KANIT ÖZETİ (`https://inktrope.com`)

### Doğrulama Kapsamı (`BROWSER_HOST_FACTS`)
- **Host-Doğrulamalı Ziyaret Edilen Origin:** `https://inktrope.com` (`blocked_origins: none`).
- **Host-Doğrulamalı Ekran Görüntüsü (`BROWSER_HOST_FACTS`):**
  - `C:/Users/salat/.gemini/antigravity/brain/eb0fb9c6-9b9a-4578-9958-3348578fcdd8/browser_evidence/bd932c35-a36a-4f12-a1a8-9e3e813a1217/final_step_76.png` — `read_file` ile bizzat incelendi: `ExportModal` açık, 8 indirme kartı mevcut, 0 paylaşım linki kontrolü, ilerleme `%100`, `"İndirildi: Yeni_Çizgi_Film.kagit.zip"` bildirimi görünür.
- **Subagent Sandbox Ara Ekran Görüntüleri (`read_file` ile görsel inceleme):**
  - `step_20.png`: `#kagit=...` round-trip sonrası Uzay sahnesinde geri yüklenen 4 stroklu karakter — yüz bölgesinde mesh çatlağı görünür.
  - `step_53_shot_1_suite2_draw_workspace.png`: `1440×900` DrawWorkspace — G-Pen / Marker / 2B Kalem çizimleri; gri Marker kavisinde segment birleşim koyulaşması çıplak gözle seçiliyor.
  - `step_59_shot_1_suite3_paper_corners_and_wipe.png`: PaperCameraStudio yerleşik A4 "Şapkalı Baron" örneği üzerinde 4 köşe tutamacı ve Öncesi/Sonrası ayracı.
  - `step_61_shot_1_suite3_imported_paper_frames_in_draw.png`: Paper'dan Draw'a aktarılan Şapkalı Baron — siyah smokin gövdesinin ortasında tek-ölçekli kutu-ortalamasının açtığı dev beyaz oyuk ve basamaklı kenarlar net biçimde görülüyor.
  - `step_63_shot_1_suite4_export_modal.png`: `ExportModal` tam ekran görünümü — paylaşım linki eksikliği doğrulandı.

### Canlı Tetiklenen 5 Export Dosyasının Bayt-Düzeyi Doğrulama Tablosu

| İndirilen Dosya (Canlı `https://inktrope.com`) | Boyut | Bayt-Düzeyi Gözlem | Sonuç |
|---|---:|---|---|
| `Yeni__izgi_Film_tam_film.mp4` | 11.786 B | `ftyp:36 (isomiso6iso2avc1) \| moov:721 \| moof:104 \| mdat:10849 \| mfra:76`; `avc1+avcC` var, `mp4a` yok, **fragmented `fMP4` (`moof=true`)** — `mp4-muxer` atlanmış | `[FAIL]` |
| `Yeni__izgi_Film_A4_flipbook.pdf` | 73.024 B | `%PDF-1.4`, `startxref=72697`, 12 nesne, `badXref=0`; ancak binary belirteç **`0x7f×4`**, Türkçe karakterler silinmiş (`Yeni Cizgi Film`, `Kesikli cizgilerden...`), Kare #1 `×2` hold yoksayılıp sadece 7 kart basılmış | `[FAIL]` |
| `Yeni__izgi_Film_png_dizisi.zip` | 415.358 B | 7 PNG (`Yeni_Çizgi_Film_0001..0007.png`), `method=0`, UTF-8 bayrağı `0x800`, `crcBad=0`, geçerli EOCD `415336` | `[PASS]` (yazım) / `[FAIL]` (`parseZipBytes` okuma & bellek) |
| `Yeni__izgi_Film.kagit.zip` | 512.959 B | 19 girdi (`manifest.json` + 18 `blobs/*`), `method=0`, `crcBad=0`, geçerli EOCD `512937` | `[PASS]` (yazım) / `[FAIL]` (Deflate/CRC okuma yok) |
| `Yeni__izgi_Film.gif` | 47.925 B | Geçerli `GIF89a`, `640×360`, 256 renkli global tablo, `0x3b` bitiş baytı | `[PASS]` |

### Konsol & Etkileşim Bulguları Özeti
- **Konsol Hataları:** Canlı oturum boyunca (Desk, Draw, Paper, Export, `#kagit=` round-trip) kritik yakalanmamış JS istisnası veya 5xx ağ hatası gözlenmedi.
- **Doğrulanan Canlı İşlev Hataları:**
  1. `Ctrl+Wheel` zoom tuvali `100%` değerinde kilitledi (pasif React `onWheel`).
  2. Kare değişiminde (`#3 → #2 → #3`) `Geri Al` butonu `disabled=true` oldu (Undo geçmişi silindi).
  3. `1280×800` çözünürlükte üst araç çubuğunun sağındaki kritik kontroller ekran dışına taştı.
  4. Yerleşik Baron örneğinin siyah smokin gövdesi Paper taramasında oyulup delindi.
  5. PNG yüklenen Desk sahnesinde aktif görünen `Paylaş` butonu sessiz ölü buton olarak tepkisiz kaldı; `ExportModal`'da ise paylaşım linki hiç mevcut değildi.
- **Canlı Donanım Kapsamı Dışındakiler (`[TEST EDİLMEDİ]`):** Gerçek fiziksel webcam/kağıt yakalama, mikrofon alkış tetikleyicisi, Apple Pencil/Wacom fiziksel basınç/tilt ve iOS Safari donanım testi (tümünün kaynak kod algoritmaları yukarıda ayrı ayrı denetlenip etiketlenmiştir).

---

**Nihai Değerlendirme Puanı: `4/10`**
