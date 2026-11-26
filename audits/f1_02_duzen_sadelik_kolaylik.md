# INKTROPE / Kâğıt Studio — F1-02 Düzen, Sadelik & Kolaylık Cerrahi Denetim Raporu

- **Denetim Rolü:** AJAN 2 — Düzen, Sadelik & Kolaylık Cerrahı (Layout, Simplicity & Ergonomics Surgeon)
- **Denetim Tarihi:** 2026-11-24
- **Hedef Kod Kökü:** `C:\Users\salat\Downloads\kagit-studio`
- **Canlı Uygulama:** `https://inktrope.com` (`BROWSER_HOST_FACTS` ile doğrulandı; `visited_origins: https://inktrope.com`, `blocked_origins: none`)
- **Zorunlu Test Çözünürlükleri:** `1440×900`, `768×1024`, `390×844`, `360×800` (5 mod: `desk`, `draw`, `paper`, `puppet`, `film`)
- **Tek Dürüst Puan:** **`3.5 / 10`**

---

## EN AĞIR 5 SORUN (Önem Sırasına Göre Kök Neden Analizi)

### 1. `[FAIL]` `TopConsoleBar` 4 Çözünürlüğün 3'ünde (`768×1024`, `390×844`, `360×800`) Çöküyor: Geri Dönüş Eziliyor, Birincil `İndir` (Export) CTA Ekran Dışına Taşıyor
- **Somut Canlı Kanıt (`768×1024`, `390×844`, `360×800` — 4 stüdyo modunun tamamında):**
  - `768×1024` `draw` (`BROWSER_HOST_FACTS` ekran görüntüsü `final_step_165.png` ile görsel doğrulandı): `Atölye` (`x=12..91.5, w=79.5, h=29.6`) doğrudan `Çizim` sekmesi (`x=24.8..114.5`) altında **`66.7×29.6px` çakışmayla eziliyor**; `Ses` (`r=801`), `Tema` (`r=871`) ve birincil kırmızı `İndir` CTA (`x=897.2..966.5`) **ekranın `129–198px` dışına kırpılıyor**.
  - `390×844` ve `360×800` (`draw`, `paper`, `puppet`, `film` — `final_step_128.png` ve `final_step_159.png` ile görsel doğrulandı): `Atölye` düğmesi ilk mod sekmesinin altında **`23×28px` ezilerek okunmaz/tıklanmaz hâle geliyor**; sağda `Ses` (`r=405.8`), `Tema` (`r=443.4`), `İndir` (`r=489`) ve `360px`'te `Rehber` (`r=368.2`, yarı kesik) viewport dışına taşıyor. Mobil/dikey tablet kullanıcısı stüdyodan ne güvenli çıkabiliyor ne de çalışmasını dışa aktarabiliyor.
  - Ayrıca `<640px`'te 4 mod sekmesi metinsiz ikona düşerken (`48.1×27.6px`) hiçbirinde `aria-label` veya `title` yok; `İndir` `KeycapButton` da `<640px`'te etiketsiz ve `aria-label`/`title` olmadan kalıyor; dil değiştirici (`TR/EN`) tamamen kayboluyor (`hidden sm:inline-flex`).
- **Kök Neden (Kod):**
  - `src/components/studio/TopConsoleBar.tsx:56-69, 111-158, 161-270`: `<header>` tek satırlık sabit `h-14 flex items-center justify-between gap-2` düzeninde (`App.tsx:59` kökündeki `overflow-hidden` kırpmayı gizliyor). Sol kapta `min-w-0` (`TopConsoleBar.tsx:57`) olmasına rağmen içindeki geri düğmesi `shrink-0` (`TopConsoleBar.tsx:64`); ortadaki `<nav>` ve sağdaki `gap-2.5` kontrol şeridi (`TopConsoleBar.tsx:161`) ne `shrink` ne de `overflow-x-auto` / taşma menüsü (overflow menu) içeriyor. Sonuç: Flexbox sol kapsayıcıyı geri düğmesinden daha dar sıkıştırıp geri düğmesini `<nav>` altına bindiriyor, sağ blok ise `header` genişliğini aşarak `App.tsx:59`'un `overflow-hidden` sınırında sessizce kesiliyor.
  - `TopConsoleBar.tsx:125-156` (nav butonları) ve `TopConsoleBar.tsx:253-269` (Export CTA) erişilebilir isim (`aria-label`/`title`) taşımıyor; `TopConsoleBar.tsx:211` (`hidden sm:inline-flex`) mobilde dil değişimini tamamen engelliyor.

### 2. `[FAIL]` `FilmDirectorStudio` Sinema Sahnesi Mobilde `20px` Yarığa Eziliyor (Çalışma Alanı Fiilen Yok Edilmiş)
- **Somut Canlı Kanıt (`360×800`, `390×844`, `768×1024`):**
  - `360×800` `film` (`BROWSER_HOST_FACTS` ekran görüntüsü `final_step_159.png` ile görsel doğrulandı): `<main>` sahne kapsayıcısı `x=0, y=56, width=352, height=20px` yüksekliğine ezilmiş durumda. `328.8×183.6px` boyutundaki birincil `<canvas>` `top=3.9, bottom=187.5` koordinatlarıyla yukarıda `56px` sabit `TopConsoleBar` arkasına, aşağıda `1. Hikâye` panelinin arkasına gömülüyor; kullanıcı ekranda yalnızca **20 piksellik bir pencere yarığı** görebiliyor.
  - `390×844` `film`: `<canvas>` `y=-5px` konumunda aynı şekilde başlık ve panel arasına gömülü. Plan şeridi kontrolleri yatayda `r=762.3px`'e taşıyor.
  - `768×1024` `film`: Aynı `lg:flex-row` öncesi dikey yığılma nedeniyle sinema sahnesi eziliyor.
- **Kök Neden (Kod):**
  - `src/components/film/FilmDirectorStudio.tsx:2085-2089` ve `2882`: Dış gövde `flex-1 flex flex-col lg:flex-row min-h-0 overflow-y-auto lg:overflow-hidden`. İlk sırada gösterilen (`order-1`) `<main>` sahne kapsayıcısı **`flex-1 ... overflow-hidden`** (yani `flex-basis: 0%`, `flex-shrink: 1`, minimum yükseklik YOK!) olarak tanımlı; buna karşılık `order-2` sol ray (`FilmDirectorStudio.tsx:2089`) ve sağ ray **`shrink-0`** alıyor. Sınırlı yükseklikteki (`h-screen` - `56px` - alt zaman çizelgesi) dikey `flex-col` içinde iki `shrink-0` panel tüm yüksekliği yutunca `<main>` `20px`'e çöküyor ve `justify-center overflow-hidden` yüzünden `aspect-video` canvas üstten/alttan kesiliyor.
  - Benzer dikey ezilme kalıbı `src/components/puppet/MeshWarpStage.tsx:1343, 1367, 1620` içinde de tekrarlanıyor (`flex-col min-h-0 overflow-hidden` + `shrink-0` sağ ray; mobilde `overflow-y-auto` bile yok).

### 3. `[FAIL]` Mobil & Tablet `DrawWorkspace` Ergonomi Çöküşü: `1.556px` İşaretsiz Yatay `ToolDeck`, `%95–100` `<44px` Dokunma Hedefi, Çakışan Toast ve Kırpılan `XSheetTimeline`
- **Somut Canlı Kanıt (`768×1024`, `390×844`, `360×800` + `1440×900`):**
  - `ToolDeck` (`final_step_128.png`, `final_step_165.png`): `<1024px` ekranlarda araç çubuğu tek satır `overflow-x-auto` şeride dönüşerek `r=1556.6px` genişliğine taşıyor (`20–26` araç/palet/geri al/katman butonu görünür alan dışında). `768×1024`'te `Kova` yarı kesik; `360×800`'de yalnızca `G-Pen` ve `2B Grafit` görünüyor. Silgi, Fırça Boyutu (`px`), Renk Paleti, Geri Al/Yinele, Katmanı Temizle ve Mobil Katmanlar düğmesi hiçbir kaydırma oku/ipucu olmadan ekran dışında gizli.
  - Toast çakışması (`final_step_128.png`): `App.tsx:132` (`fixed top-16`) üzerinde açılan `"Yeni Çizgi Film" ışıklı masaya açıldı` bildirimi doğrudan `ToolDeck` üzerine oturarak `2B Grafit` ve devamını kapatıyor.
  - `XSheetTimeline` (`final_step_128.png`, `360×800`): 5 satıra yayılarak `800px` yüksekliğin ~`240px`'ini (`%30`) yutarken çalışma tuvali yalnızca `321×180px` (**`%20.04`**) alanda sıkışıyor; kare sayacı `01 / 01` 2 satıra kırılıyor, sağdaki `>` sonraki kare düğmesi ekran kenarında kesiliyor. Üstelik tuval alanı en dar olan `<768px` ekranlarda `Sade (Zen)` modu gizlenmiş (`TopConsoleBar.tsx:189`: `hidden md:inline-flex`).
  - Dokunma hedefi ihlali: 20 viewport×mod hücresinin tamamında **header butonlarının %100'ü `<44×44px`** (`21–42px`); `360×800` `draw`'da `64/64` (`%100`), `film`'de `65/66` (`%98.5`), `puppet`'ta `21/21` (`%100`), `1440×900` `draw`'da `86/87` (`%98.9`) düğme `44×44px` standardının altında.
- **Kök Neden (Kod):**
  - `src/components/studio/ToolDeck.tsx:157, 174-196, 277-291, 357-390, 422-460`: 11 araç + ayar düğmesi + 8 renk kutusu + 4 eylem tek yatay `flex overflow-x-auto` kapsayıcıya yığılmış; birincil araçlar (Silgi, Geri Al, Renk, Katman) sabit/pinned tutulmamış.
  - `src/components/studio/XSheetTimeline.tsx:258-323`: Transport şeridindeki `KeycapButton` bileşenleri (`src/components/ui/KeycapButton.tsx:68-73`, `src/index.css:223-231` `margin-top: 5px`) `flex-nowrap` iç grupta `min-w-[58px]` sayacıyla birlikte `360px`'e sığmıyor.
  - `src/components/studio/TopConsoleBar.tsx:189`: `zenMode` düğmesi `hidden md:inline-flex` ile mobil kullanıcıdan saklanıyor.

### 4. `[FAIL]` `StudioGuideOverlay` Hedeflerle Çakışıyor, Yanlış/Eksik Hedef Vurguluyor ve Mobilde Yanıltıcı Talimat Veriyor
- **Somut Canlı Kanıt (`1440×900` & `360×800`):**
  - `paper` turu: `1440×900` adım 1'de kart spotla `175×3px` çakışıyor; **adım 2'de kart (`328×192px`) spotun (`781.3×551.1px`) tam ortasına düşerek `%100` (`328×192px`) çakışıyor**. `360×800` adım 1 ve 2'de kart (`225×108px`) spot (`348×439px`) içinde **tam çakışma** üretiyor.
  - `puppet` turu (`360×800`): Adım 1'de **`spotlight: null`** (hedef DOM'da yok); adım 3'te *"Kuklayı İndir"* anlatılırken spot yanlışlıkla `Örnek` düğmesini (`x=14.8, y=272.1`) vurguluyor (`Kuklayı İndir` ekran dışı).
  - `film` turu (`360×800`): Adım 1'de spot içinden tıklama `CLICK_BLOCKED_BY_OVERLAY` (`div.fixed.left-0`) ile engellendi; metin dikey mobilde hâlâ *"Soldan hazır bir hikâye seç"* diyor.
  - `draw` turu (`360×800`): Açılan `GuideLauncherButton` menüsünün başlığı üst kenardan kesiliyor; adım 1 *"Soldan bir kalem..."* (mobilde araçlar üstte!), adım 3 *"sağ üstten tek tıkla indir"* (oysa `İndir` `r=489`'da `[offscreen]`!) diyerek kullanıcıyı olmayan yere yönlendiriyor.
- **Kök Neden (Kod):**
  - `src/components/guide/StudioGuideOverlay.tsx:17, 204-238`: Kart yüksekliği gerçek DOM'dan ölçülmek yerine **`CARD_H = 196` sabit** alınmış; 4 kenarın hiçbiri sığmadığında (büyük `paper-stage` / mobil ekranlar) döngü kırılmadan varsayılan ekran ortasına (`cardX`, `cardY`) düşüp `pointer-events-auto` kartı spot deliğinin tam üstüne koyuyor.
  - `src/components/guide/StudioGuideOverlay.tsx:150-169`: `pointerdown` yakalandıktan yalnızca `280ms` sonra `finishOrAdvance()` tetikleniyor — kullanıcı tuvale çizmeye başladığı an, ilk çizgisini bitiremeden tur sonraki adıma atlıyor. Ayrıca `StudioGuideOverlay.tsx:178-184`'teki `ArrowLeft`/`ArrowRight` dinleyicisi `DrawingStage.tsx:524-538` ile aynı `window` üzerinde çakışıyor (turda ok tuşu basınca arkada kare de değişiyor).
  - `src/store/useStudioStore.ts:1012-1044`: `startTour()` yalnızca `dest !== get().mode` iken `openSampleMeshPuppetDemo()` çağırıyor (`L1026-1030`). Kullanıcı `TopConsoleBar` ile `puppet` sekmesine boş projeyle geçip sonra rehberi açarsa `activeRig` `null` kalıyor, `MeshWarpStage.tsx:1605, 1731-1735`'teki `data-tour="puppet-moves"` ve `data-tour="puppet-export"` DOM'a hiç basılmıyor. Aynı şekilde `startTour` `zenMode: false` yapmadığı için `draw` Zen modundayken 3 hedefin 3'ü de (`draw-tools`, `draw-add-frame`, `draw-play`) `null` dönüyor (`DrawWorkspace.tsx:97, 132`). `Desk`'te `Örnek Sahneler` sekmesi açıkken `InstantAliveStage` unmounted (`InteractiveLightboxStage.tsx:1023`) olduğu için `desk-1` ve `desk-2` hedefsiz kalıyor.

### 5. `[FAIL]` `RadialQuickWheel` Sıfır Keşfedilebilirlik, Sıfır Mobil Erişim ve `prefers-reduced-motion` Konumlandırma Kırığı
- **Somut Canlı Kanıt (`1440×900` & `360×800`):**
  - `1440×900` `draw`: Tüm görünür arayüzde, kısayol ipuçlarında (`stageShortcutHint`), `title`/`aria-label` metinlerinde ve 15 adımlık turda `Q` tuşundan veya sağ-tık `RadialQuickWheel` menüsünden **0 (sıfır)** kez bahsediliyor. Kullanıcı kaynak kodu okumadan veya yanlışlıkla `Q`/sağ-tık basmadan özelliğin varlığını bilemez.
  - `360×800` `draw`: Dokunmatik/mobil cihazlarda tekerleği açacak **0 (sıfır)** düğme veya jest tetikleyicisi var (`DrawingStage.tsx:1057` `touch-none` + `setPointerCapture` ile mobil tarayıcılarda `contextmenu` zaten engelleniyor).
  - Açıldığında 8 radyal buton (`48×48px`) içinde `8px` mikroskobik font (`font-mono text-[8px]`) kullanılıyor ve 8 `menuitem` düğmesinin hiçbirinde `aria-label`/`title` yok.
- **Kök Neden (Kod):**
  - `src/components/studio/DrawWorkspace.tsx:44-75, 108-115`: Tek tetikleyiciler `keydown('q')` ve `onContextMenu`. Ne `ToolDeck.tsx` ne `DrawingStage.tsx` ne de `tourConfig.ts` içinde görünür bir tetikleyici veya ipucu tanımlı.
  - `src/components/studio/RadialQuickWheel.tsx:150-151` ve `src/index.css:1637-1650, 1809, 1830`: Tekerleği `(cx, cy)` merkezine oturtan `transform: translate(-50%, -50%)` kuralı statik CSS olarak değil **yalnızca `@keyframes radial-wheel-pop` içinde** tanımlı. `@media (prefers-reduced-motion: reduce)` bloğu `.radial-wheel-pop { animation: none !important; }` (`index.css:1809, 1830`) uyguladığında ortalama dönüşümü tamamen siliniyor; tekerlek imleçten `+114px, +114px` sağ-aşağı kayarak ekran kenarından taşıyor.

---

## Detaylı Kriter Matrisi

### 1. 4 Viewport Yerleşim & Responsive Matrisi (`1440×900`, `768×1024`, `390×844`, `360×800`)

> **Kritik Metodoloji Notu:** 20 hücrenin tamamında `document.documentElement.scrollWidth === window.innerWidth` çıktı; ancak bu responsive başarısı **değil**, `src/App.tsx:59` kök kapsayıcısındaki `h-screen flex flex-col overflow-hidden` sınıfının taşan düğmeleri (`r=489px`, `r=966.5px`, `r=1556.6px`) sessizce kesip gizlemesinden kaynaklanıyor.

| Viewport | Mod | Durum | `scrollW / innerW` | Header Taşması (`x..r`) | Header Çakışması | Header `<44px` | Toplam `<44px` / Görünür Btn | En Büyük `<canvas>` (`w×h`, `% alan`) | Header `TR/EN` |
|---|---|---|---:|---|---|---:|---:|---|---|
| `1440×900` | `desk` | `[FAIL]` *(touch target)* | `1440/1440` | Yok (`maxR=1336`) | Yok | `6/6` | `24 / 28` | `771×433` (`%25.79`) | Var (`26×21`) |
| `1440×900` | `draw` | `[FAIL]` *(87 btn, `<44px`)* | `1440/1440` | Yok (`maxR=1432`) | Yok | `13/13` | `86 / 87` | `874×491` (`%33.10`) | Var (`30×29`) |
| `1440×900` | `paper` | `[FAIL]` *(`<44px`)* | `1440/1440` | Yok (`maxR=1428`) | Yok | `12/12` | `25 / 26` | Yok (`<video>`) | Var (`30×29`) |
| `1440×900` | `puppet` | `[FAIL]` *(`<44px`)* | `1440/1440` | Yok (`maxR=1432`) | Yok | `12/12` | `23 / 23` | Yok (boş durum) | Var (`30×29`) |
| `1440×900` | `film` | `[FAIL]` *(72 btn, `<44px`)* | `1440/1440` | Yok (`maxR=1432`) | Yok | `12/12` | `71 / 72` | `777×436` (`%26.11`) | Var (`30×29`) |
| `768×1024` | `desk` | `[FAIL]` | `768/768` | `GÜNDÜZ DEFTERİ` (`674..836`) | Yok | `6/6` | `24 / 28` | `669×376` (`%31.93`) | Var (`26×21`) |
| `768×1024` | `draw` | `[FAIL]` | `768/768` | `Ses(801)`, `Tema(871)`, `İndir(966.5)` | `Atölye↔Çizim` (`66.7×29.6`) | `12/12` | `68 / 68` | `697×392` (`%34.71`) | Var (`30×29`) |
| `768×1024` | `paper` | `[FAIL]` | `768/768` | `Tema(800)`, `İndir(895)` | `Atölye↔Çizim` (`66×29`) | `11/11` | `27 / 28` | Yok (`<video>`) | Var (`30×29`) |
| `768×1024` | `puppet` | `[FAIL]` | `768/768` | `Tema(800)`, `İndir(895)` | `Atölye↔Çizim` (`66×29`) | `11/11` | `22 / 22` | Yok (boş durum) | Var (`30×29`) |
| `768×1024` | `film` | `[FAIL]` | `768/768` | `Tema(800)`, `İndir(895)` | `Atölye↔Çizim` (`66×29`) | `11/11` | `66 / 67` | `737×413` (`%38.70` *ezik*) | Var (`30×29`) |
| `390×844` | `desk` | `[FAIL]` *(kırpılan metin, `<44px`)* | `390/390` | Yok (`maxR=362`) | Yok | `6/6` | `22 / 27` | `311×174` (`%16.48`) | Var (`26×21`) |
| `390×844` | `draw` | `[FAIL]` | `390/390` | `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `64 / 64` | `350×196` (`%20.88`) | **YOK** |
| `390×844` | `paper` | `[FAIL]` | `390/390` | `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `21 / 24` | `<video>` `323×181` | **YOK** |
| `390×844` | `puppet` | `[FAIL]` | `390/390` | `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `21 / 21` | Yok (boş durum) | **YOK** |
| `390×844` | `film` | `[FAIL]` | `390/390` | `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `65 / 66` | `359×201` (`y=-5`, *gömülü*) | **YOK** |
| `360×800` | `desk` | `[FAIL]` | `360/360` | `Gündüz Defteri` (`298.6..354.2 > 344`) | Yok | `6/6` | `22 / 27` | `281×157` (`%15.33`) | Var (`26×21`) |
| `360×800` | `draw` | `[FAIL]` | `360/360` | `Rehber(368.2)`, `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `64 / 64` | `321×180` (`%20.04`) | **YOK** |
| `360×800` | `paper` | `[FAIL]` | `360/360` | `Rehber(368.2)`, `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `18 / 24` | `<video>` `293×164` | **YOK** |
| `360×800` | `puppet` | `[FAIL]` | `360/360` | `Rehber(368.2)`, `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `21 / 21` | Yok (boş durum) | **YOK** |
| `360×800` | `film` | `[FAIL]` | `360/360` | `Rehber(368.2)`, `Ses(405.8)`, `Tema(443.4)`, `İndir(489)` | `Atölye↔btn#2` (`23×28`) | `10/10` | `65 / 66` | `329×184` (`<main> h=20px`!) | **YOK** |

- **`[PASS]` Masaüstü (`1440×900`) Temel Yatay Sığma ve Sıfır Header Çakışması:** 5 modun tümünde `header` sağ sınırı `1336–1432px <= 1440px`, header buton çakışması `0`, `console.error` ve `pageerror` sayısı `0` (canlı tarayıcı ölçümü).
- **`[FAIL]` Mobil & Tablet Çalışma Alanı (Canvas) Yüzdesi:** Çizim/animasyon aracında tuval ekranın en az `%50–65`'ini kaplamalıdır; burada masaüstünde bile `draw` tuvali **`%33.10`**, `film` **`%26.11`**, `360×800` mobilde `draw` **`%20.04`**, `desk` **`%15.33`**, `film` ise **`20px` görünür yarık (`%2.5` efektif görünürlük)** düzeyindedir.
- **`[FAIL]` `Desk` Header Taşması (`768×1024` & `360×800`):** `StudioDeskHub.tsx:115, 132-181` içinde 5 sağ kontrol + `DeskLamp3D` (`GÜNDÜZ DEFTERİ`) `768px`'te `836px`'e, `360px`'te `354.2px > 344px` iç konteyner sınırına taşıyor. `360×800`'de `Desk` çizim araç çubuğunda `Kalın`, `Geri Al` ve `Temizle` sağ kenardan kırpılıyor.

---

### 2. 5 Mod Arası Akış, State Yönetimi & `TopConsoleBar` / UI Bileşen Ergonomisi

- **`[PASS]` 5 Modun Lazy-Loaded Ayrımı ve Tuval Flush Güvenliği:** `src/App.tsx:9-17, 60-92` ağır stüdyo modüllerini (`DrawWorkspace`, `PaperCameraStudio`, `PuppetStudio`, `FilmDirectorStudio`) ve modalları lazy-load ediyor; `src/store/useStudioStore.ts:987-999` `draw` modundan çıkarken `flushActiveCanvasNow()` çağırıp `isPlaying`, `filmExportOpen`, `puppetExportOpen` ve `zenMode` bayraklarını sıfırlıyor.
- **`[FAIL]` Mod Giriş Tutarsızlığı (`Desk` vs `TopConsoleBar`):**
  - `StudioDeskHub.tsx:342` `Canlı Kukla` kartına tıklayınca `openSampleMeshPuppetDemo()` çağırıp hazır kuklayla dolu bir sahne açarken, `TopConsoleBar.tsx:140` `Kukla` sekmesine tıklayınca düz `setMode('puppet')` çağırıyor ve kullanıcı boş bir ekrana düşüyor (`MeshWarpStage.tsx:1368`). Aynı tutarsızlık `StudioDeskHub.tsx:356` (`openFilmDirectorDemo()`) ile `TopConsoleBar` `Mini Film` sekmesi arasında da mevcut.
- **`[FAIL]` `TopConsoleBar` Bilgi Mimarisi ve Erişilebilirlik (`src/components/studio/TopConsoleBar.tsx`):**
  - Masaüstünde `draw` modunda tek satırda **13 ayrı kontrol** yığılmış (Geri + Proje Adı + Rozet + 4 Mod Sekmesi + Döner Dimmer + Sade Mod + Hesap + Rehber + Dil + Ses + Tema Şalteri + İndir). Kod içi yorum `L110` hâlâ `"3-Way Studio Mode Switcher"` diyor, gerçekte 4 sekme var.
  - `TopConsoleBar.tsx:125-156`: `<640px` altında metin `hidden sm:inline` olunca 4 mod sekmesi yalnızca `6.5px` LED + `14px` ikona düşüyor; `title` ve `aria-label` olmadığı için ekran okuyucu ve mobil kullanıcı açısından tamamen kör düğmelere dönüşüyor.
  - `TopConsoleBar.tsx:253-269`: Export `KeycapButton` `<640px` altında etiketsiz ve `aria-label`/`title` taşımıyor.
  - `TopConsoleBar.tsx:189`: `zenMode` (`Sade`) `hidden md:inline-flex` ile mobil kullanıcıya kapalı.
- **`[FAIL]` `KeycapButton` Fiziksel 3D Ofsetinin Dar Bar Hizalamasını Bozması (`src/components/ui/KeycapButton.tsx:66-74` & `src/index.css:223-231`):**
  - `.k3d { margin-top: var(--k-raise); }` (`5px`–`9px`) her 3D düğmeyi yanındaki düz HTML `<button>` öğelerine kıyasla dikeyde yukarı/aşağı kaydırıyor (`final_step_128.png` ve `final_step_165.png` `XSheetTimeline` satırlarında ve `TopConsoleBar` `İndir` düğmesinde `y=15.3` vs `y=12.8` olarak doğrudan ölçüldü).
  - Ayrıca `KeycapButton` `size="sm"` (`px-2.5 py-1.5 text-xs`) yüksekliği yalnızca `29.6px` — dokunmatik ekranların `44px` standardının çok altında.
- **`[FAIL]` `AccountButton` & `AccountModal` Dikey Taşma ve Mimari Sorunları (`src/components/account/AccountButton.tsx`, `AccountModal.tsx`):**
  - `AccountModal.tsx:203`: Modal gövdesinde **`overflow-hidden`** var ama **`max-h-[90dvh] overflow-y-auto` YOK**. `Register` sekmesinde (3 input + misafir bilgilendirme kutusu + Google OAuth + hata banner'ı) sanal klavye açıldığında veya kısa ekranlarda alt gönderim düğmesi kesilme riski taşıyor.
  - `AccountButton.tsx:19-32, 51-93`: `compact` modda oturum açıkken (`final_step_165.png` `Oğuzhan`, `final_step_128.png` LED + avatar + bulut) geniş yer kaplayarak `TopConsoleBar`'daki sağ taşmayı daha da ağırlaştırıyor.
  - `[TEST EDİLMEDİ]` *(Canlı oturum dışı `AccountModal` Login/Register sekmesi etkileşimi)*: Canlı tarayıcıda aktif oturum (`Private Cloud Vault`) bozulmaması için çıkış yapılmadı; ancak `AccountModal.tsx:90-384` kaynak kodunda `placeholder="sen@ornek.com"` (`L339`), `'Hesap silinemedi.'` (`L179`) ve 38 adet `useT()` bypass'ı doğrulandı.

---

### 3. İlk 60 Saniye Yardımsız Kullanıcı Yolculuğu

> Simülasyon: Hiç rehber açmadan ilk kez `https://inktrope.com` adresine giren kullanıcı (`1440×900` ve `390×844` / `360×800`).

| Zaman | Kullanıcı Hedefi | Masaüstü (`1440×900`) Deneyimi | Mobil (`390×844` / `360×800`) Deneyimi | Durum |
|---|---|---|---|---|
| **0–10 sn** | Uygulamanın ne yaptığını anlama | Işıklı masa ("3 saniyede herhangi bir şey çiz") + sağda 4 kapı net; 28 butonla makul ilk izlenim. | `360×800`'de başlıkta `Gündüz Defteri` taşıyor; tuval yalnızca `%15.33` (`281×157px`) alan alıyor; durum metinleri `"..."` ile kesiliyor. | `[FAIL]` *(mobil)* / `[PASS]` *(masaüstü)* |
| **10–25 sn** | İlk çizimi yapıp canlandırma | Cam masada çizip `CANLANDIR` basınca animasyonlu karaktere sorunsuz geçiyor (`"Tıkla zıplasın · Tut sürükle ve fırlat!"`). | `390×844`'te canlandırma çalışıyor, ancak `360×800`'de çizim sırasında `Kalın`, `Geri Al` ve `Temizle` düğmeleri sağ kenardan kırpılıp kayboluyor. | `[FAIL]` *(360px)* / `[PASS]` *(1440px)* |
| **25–40 sn** | `Kare Kare Çiz` (`draw`) moduna girip ilk çizgiyi atma | **Tıkanma 1:** Aniden **`87` görünür buton (`102` HUD düğümü)** yüzüne çarpıyor (aşırı bilişsel yük). **Tıkanma 2:** Kare `#01` üzerine çizgi atıldığında ortadaki `"Çizmeye başla — sonra + Kare (N) ekle..."` katmanı **kapanmadı** ve `#01` küçük resmi `Boş Kare` eklenene kadar `"BOŞ"` yazmaya devam etti. | **Tıkanma 1:** `Atölye` geri tuşu `Çizim` altına gömülü (`final_step_128.png`). **Tıkanma 2:** Açılış toast'ı `ToolDeck`'i örtüyor. **Tıkanma 3:** Silgi, Renk, Boyut, Geri Al ve Katmanlar `1.556px` yatay scroll ardında gizli — kullanıcı silgiyi bile bulamıyor! | `[FAIL]` |
| **40–55 sn** | 2. kare ekleyip oynatma | `Boş Kare` (`[data-tour="draw-add-frame"]`) ve `Oynat` (`[data-tour="draw-play"]`) çalışıyor. | `XSheetTimeline` 5 satırda sıkışmış, `01 / 01` iki satıra bölünmüş, `>` kare ileri düğmesi kırpılmış (`final_step_128.png`). | `[FAIL]` *(mobil)* / `[PASS]` *(masaüstü)* |
| **55–60 sn** | Çalışmayı dışa aktarma (`İndir`) veya `Mini Film`'e geçme | Sağ üstteki `İndir` çalışıyor; ancak `RadialQuickWheel` (`Q`) hiç keşfedilemiyor. | **Tam Tıkanma:** `İndir` CTA `r=489px`'te ekran dışında (`[offscreen]`) — kullanıcı ürettiği animasyonu **indiremiyor**! `Mini Film`'e geçerse sahne `20px` yarığa ezilmiş (`final_step_159.png`). | `[FAIL]` |

---

### 4. `StudioGuideOverlay` & `tourConfig` Denetimi

| Kriter | Durum | Somut Kanıt (Kod + Canlı Tarayıcı) |
|---|---|---|
| Tüm 15 `data-tour` seçicisinin kaynak kodda tanımlı olması | `[PASS]` | `src/engine/tourConfig.ts:28-148` içindeki 15 adımın tamamı kaynak dosyalarında mevcut (`InstantAliveStage.tsx:2847,3477,3503,3537`, `StudioDeskHub.tsx:212`, `ToolDeck.tsx:156`, `XSheetTimeline.tsx:261,328`, `PaperCameraStudio.tsx:961,1026,1114,1145,1300`, `MeshWarpStage.tsx:1605,1632,1735`, `FilmDirectorStudio.tsx:2101,2209,3674`). |
| Dinamik/koşullu durumlarda hedeflerin DOM'da gerçekten bulunması | `[FAIL]` | `360×800` canlı testte `puppet` s1 `spotlight: null`, s3 yanlış `Örnek` düğmesini vurguladı. Kök neden: `useStudioStore.ts:1026-1030` zaten `puppet` modundayken `openSampleMeshPuppetDemo()` çalıştırmıyor (`activeRig === null` iken `puppet-moves`/`puppet-export` render edilmiyor); `zenMode: true` iken `draw` turları (`DrawWorkspace.tsx:97,132`) ve `showcase` sekmesindeyken `desk` turları (`InteractiveLightboxStage.tsx:1023`) hedefsiz kalıyor. |
| Kart–spot çakışmasız yerleşim (`1440×900` & `360×800`) | `[FAIL]` | `paper` turu `1440×900` s1 (`175×3px`) ve s2 (**tam `328×192px` çakışma**); `360×800` `paper` s1 & s2 (**tam `225×108px` çakışma**). Kök neden: `StudioGuideOverlay.tsx:17` sabit `CARD_H = 196` + `L204-238` sığmayan durumlarda kartı doğrudan ekran/spot ortasına bırakıyor. |
| Spot deliği tıklama geçirgenliği ("Learn by Doing") | `[FAIL]` | `1440×900` `draw` s1 ve `360×800` `desk` s1 tıklamaları çalıştı (`[PASS]` alt durum); ancak `360×800` `film` s1 `CLICK_BLOCKED_BY_OVERLAY` (`div.fixed.left-0`) ile bloklandı. Ayrıca `StudioGuideOverlay.tsx:150-169` `pointerdown` sonrası yalnızca `280ms` içinde adımı otomatik geçiyor — tuvalde çizim yapan kullanıcının ilk çizgisini yarıda kesiyor. |
| Z-index ve mobil menü görünürlüğü | `[FAIL]` | `StudioGuideOverlay.tsx:298` (`z-[70]`) ile `GuideLauncherButton.tsx:89` (`z-[70]`) aynı katmanda; `360×800` `draw` modunda açılan `GuideLauncherButton` menüsünün üst başlığı (`Canlı Stüdyo Rehberi`) viewport üstünden kırpılıyor (canlı doğrulama). |
| Mobil yön tariflerinin doğruluğu | `[FAIL]` | `translations.ts:718, 722, 739` (`guideDraw1Body`, `guideDraw3Body`, `guideFilm1Body`) mobilde üstte/yığılı duran panellere *"Soldan..."* ve ekran dışına taşmış `[offscreen]` export tuşuna *"sağ üstten tek tıkla indir"* diyor. |
| Klavye kısayolu izolasyonu | `[FAIL]` | `StudioGuideOverlay.tsx:178-184` (`ArrowLeft`/`ArrowRight`) `stopImmediatePropagation()` çağırmıyor; `draw` turunda ok tuşuna basıldığında `DrawingStage.tsx:524-538` de tetiklenip arka planda kare değiştiriyor. |

---

### 5. `RadialQuickWheel` Keşfedilebilirlik & Kullanılabilirlik

| Kriter | Durum | Somut Kanıt |
|---|---|---|
| Masaüstü klavye (`Q`) ve sağ-tık (`contextmenu`) tetiklemesi | `[PASS]` | `1440×900` `draw` canlı testte hem `q` tuşu hem tuval üzerinde `contextmenu` olayı `[role="menu"]` (`228×228px`, `x=594, y=285`) menüsünü açtı; 8 radyal eylem + merkez `56×56px` `Q / KAPAT` düğmesi çalıştı (`DrawWorkspace.tsx:59-67, 110-114`). |
| Radyal düğme dokunma boyutları | `[PASS]` | 8 dairesel düğme `w-12 h-12` (`48×48px` >= `44px`) ve merkez düğme `w-14 h-14` (`56×56px`) (`RadialQuickWheel.tsx:157, 179`, canlı doğrulandı). |
| Keşfedilebilirlik (UI ipucu / rehber / kısayol metni) | `[FAIL]` | Canlı arayüzde ve kodun tamamında (`translations.ts:211` `stageShortcutHint`, `tourConfig.ts`, `ToolDeck.tsx`, `DrawingStage.tsx`) `Q` tuşuna veya sağ-tık tekerleğine **0 (sıfır) referans** var. Tamamen gizli bir "easter egg" gibi kalmış. |
| Mobil / dokunmatik kullanılabilirlik (`390×844`, `360×800`) | `[FAIL]` | `DrawWorkspace.tsx:108-141` içinde dokunmatik cihazlar için **0 tetikleyici düğme** ve **0 jest (uzun basma vb.)** mevcut. `360×800` canlı testte erişim yolu bulunamadı. |
| Tipografi ve erişilebilirlik | `[FAIL]` | `RadialQuickWheel.tsx:187` etiketleri `text-[8px]` (`8px` kutu yüksekliği) — okunabilirlik sınırının çok altında; 8 `menuitem` düğmesinin hiçbirinde `aria-label` veya `title` yok (`L170-189`). |
| `prefers-reduced-motion: reduce` konumlandırma güvenliği | `[FAIL]` | `RadialQuickWheel.tsx:150-151` ortalama `translate(-50%, -50%)` kuralını yalnızca `@keyframes radial-wheel-pop` (`src/index.css:1637-1650`) üzerinden alıyor; `src/index.css:1809, 1830` reduced-motion altında `animation: none !important` vererek tekerleği imleçten `+114px, +114px` sağ-aşağı kaydırıyor ve kenardan kırpıyor. |

---

### 6. i18n (`translations.ts`, TR/EN Tutarlılığı, Hardcoded Metinler, Taşma)

| Kriter | Durum | Somut Kanıt |
|---|---|---|
| `translations.ts` TR/EN anahtar eşitliği | `[PASS]` | Statik tarama (`audit_scan.mjs`): `TR = 911` benzersiz anahtar, `EN = 911` benzersiz anahtar, `Missing in EN: 0`, `Extra in EN: 0`, `EN` sözlüğüne sızan Türkçe karakter `0`. (16 ortak/uluslararası terim `G-Pen`, `Marker`, `Robot`, `ZOOM`, `PAN X`, `Bristol`, `ACME 12` vb. bilinçli olarak aynı.) |
| `translations.ts` ölü (kullanılmayan) anahtar temizliği | `[FAIL]` | `22` tanımlı çeviri anahtarı (`heroManifesto`, `heroBadges`, `propNone`, `shareLoaded`, `magicStrokeMore`, `paperBtnShort`, `puppetBtnShort`, `filmBtnShort`, `railReplaceBg`, `railOnionTint`, `railPaperGrain`, `railShakeNone/Light/Med/Hard`, `xsheetOnionShort`, `filmActorTitle`, `puppetVoiceActive`, `guideActionTip`, `v4BtnMultiPoseA4`, `v4DetectedChange`, `filmActionGroupMove`) hiçbir bileşende kullanılmıyor (statik tarama `audit_i18n.mjs`). |
| Merkezi `useT()` disiplini (bypass olmaması) | `[FAIL]` | `17` dosya `useT()` sistemini atlayıp **`227` adet satır-içi `locale === 'en'` / `isEn ?`** üçlü operatörü kullanıyor (`FilmDirectorStudio.tsx`: 48, `AccountModal.tsx`: 38, `MeshWarpStage.tsx`: 37, `useStudioStore.ts`: 30, `PuppetStudio.tsx`: 23, `InstantAliveStage.tsx`: 21, `PerformanceMocapDeck.tsx`: 9, `AccountButton.tsx`: 6 vb.). |
| EN modunda sıfır Türkçe sızıntı (canlı + statik) | `[FAIL]` | Canlı EN modunda doğrulanan Türkçe kalıntılar: **1)** `<title>` (`index.html:38`) sürekli `"INKTROPE — Işıklı 2D & 2.5D Animasyon Masası"` (`useStudioStore.ts:960-965` `setLocale` yalnızca `lang` özniteliğini güncelliyor, `document.title`'ı güncellemiyor); **2)** `TopConsoleBar.tsx:93` `title="Adı değiştirmek için tıkla"` ve `L248` `aria-label="Tema"`; **3)** `StudioDeskHub.tsx:165` `aria-label="Ses efektleri"`, `L245` `aria-label="Kapat"`; **4)** `InteractiveLightboxStage.tsx:981` `aria-label="Işıklı Masa Görünümü"`, `L1037` `aria-label="Örnek Sahneler"`; **5)** `Puppet` hazır karakteri `"Şapkalı Baron"`, 6 pim etiketi (`Sol El`, `Baş`, `Gövde`, `Sağ El`, `Sol Ayak`, `Sağ Ayak` — `meshWarpEngine.ts:87-173`, `cartoonMotionEngine.ts:507-511`) ve 6 eklem ağacı adı; **6)** `Film` hazır oyuncusu `"Şapkalı Baron"`, ön-dolu senaryo (`"Şapkalı kahraman yağmurlu sokakta yürüsün..."`) ve diyalog (`"Merhaba dünya, bugün hava çok güzel!"`); **7)** `Draw` varsayılan projesi `"Kağıt Uçak & Rüzgar"`, katman adları (`Mürekkep`, `Boya`, `Eskiz (Mavi)` — `useStudioStore.ts:214,224,234`, `starterFlipbook.ts:548,690`), sahne/kare notları (`Sahne 1 · Tepe`, `Hazırlık (Nişan)`). Ek statik doğrulama: **31+ korumasız Türkçe hata/toast/placeholder** (`PaperCameraStudio.tsx:164,184,284,286,387,711,713,900,903,979`, `PerformanceMocapDeck.tsx:162,199,202,212,386,412,450,482,484`, `DrawingStage.tsx:790,795`, `AccountModal.tsx:179,339` `sen@ornek.com`, `AccountButton.tsx:36` `'Üye'`, `StudioDrawer.tsx:148,149,413,472`, `CharacterMasterModal.tsx:1086`, `PocketFlipbook3DPreview.tsx:109,120,208`, `ExportModal.tsx:226`). |
| Mobil dil değişimi erişilebilirliği | `[FAIL]` | `TopConsoleBar.tsx:211` (`hidden sm:inline-flex`): `<640px` (`390×844` ve `360×800`) stüdyo modlarında kullanıcı dil değiştiremiyor (canlı doğrulandı). |
| Dil değişiminde taşan/kesilen butonlar | `[FAIL]` | EN modunda canlı tespitler: `Short Film -> 1. Story` hazır hikâye butonu `"✦ Snowy Night Street & Warm Lantern (3 Sh..."` (`267px` içinde kırpılıyor), zaman çizelgesi kartı `"Shot 2 · Low Angl"` kırpılıyor, `Puppet -> Stage Backdrop` içinde `"Transparent"` `63px` dar hapta sıkışıp kesiliyor. |

---

## Canlı Test Kanıt Özeti

- **Doğrulanan Origin (`BROWSER_HOST_FACTS`):** `https://inktrope.com` (`blocked_origins: none`).
- **Konsol / Sayfa Hataları:** `0` `console.error`, `0` yakalanmamış `pageerror` (20 viewport×mod geçişi boyunca).
- **Bizzat Görsel Olarak İncelenen `BROWSER_HOST_FACTS` Ekran Görüntüleri (`read_file` ile doğrulandı):**
  1. `final_step_128.png` (`360×800`, `draw`): `TopConsoleBar` içinde `Atölye` düğmesinin `Çizim` sekmesi altında ezildiği, `Rehber`'in sağdan yarı kesildiği, `Ses`/`Tema`/`İndir`/`TR` kontrollerinin tamamen ekran dışına taşarak kaybolduğu; `"Yeni Çizgi Film" ışıklı masaya açıldı` toast'ının `ToolDeck` üzerine bindiği; `ToolDeck`'in yalnızca 2 araç gösterip kalanını gizli yatay kaydırmaya attığı; `XSheetTimeline`'da `01 / 01`'in 2 satıra bölündüğü ve `>` düğmesinin sağdan kesildiği; tuval üzerinde mikroskobik okunmaz `KAMERA 1.00x` rozeti ve kapanmayan boş-tuval katmanı görsel olarak doğrulandı.
  2. `final_step_159.png` (`360×800`, `film`): Aynı kırık `TopConsoleBar` altında `<main>` sinema sahnesinin **`20px` yüksekliğe (`y=56..76`) ezilerek** gökdelen pencerelerinin yalnızca en üst şeridinin göründüğü, kalan tüm ekranın `1. Hikâye` paneli + alt zaman çizelgesi tarafından işgal edildiği görsel olarak doğrulandı.
  3. `final_step_165.png` (`768×1024`, `draw`): Tablet portre genişliğinde bile `Atölye` geri düğmesinin `Çizim` sekmesi altında tamamen yutulduğu (`x=12..91.5` vs `24.8..114.5`), `TR`'nin sağ kenara dayandığı ve `Ses`/`Tema`/`İndir` (`x=897.2..966.5`) düğmelerinin ekrandan tamamen silindiği; `ToolDeck`'te `Kova`'nın yarı kesildiği (`Kov`) ve renk paleti / fırça boyutu / silgi / geri al / katman düğmelerinin hiç görünmediği görsel olarak doğrulandı.

---

## Nihai Değerlendirme ve Tek Dürüst Puan

Masaüstü `1440×900` ilk açılış sahnesi (`StudioDeskHub` + `InstantAliveStage`) fikir ve hız bakımından işler görünse de, gerçek ürün kalitesi 4 çözünürlük ve 5 modun tamamında ölçülür. INKTROPE / Kâğıt Studio şu hâliyle **4 zorunlu çözünürlüğün 3'ünde (`768×1024`, `390×844`, `360×800`) temel üst gezinme çubuğunu (`TopConsoleBar`) kendi üzerine bindirip birincil dışa aktarma (`İndir`) butonunu ekran dışına atmakta**, `Mini Film` tuvalini mobilde **`20px` yarığa ezmekte**, çizim modunda **87 butonluk duvarı `%95–100` `<44px` hedeflerle ve `1.556px` işaretsiz yatay kaydırmayla** sunmakta, `StudioGuideOverlay`'i kendi hedefleriyle çarpıştırmakta, `RadialQuickWheel`'i tamamen görünmez ve dokunmatikte erişilmez bırakmakta ve EN modunda onlarca Türkçe metin sızdırmaktadır.

**Nihai Puan: `3.5 / 10`**
