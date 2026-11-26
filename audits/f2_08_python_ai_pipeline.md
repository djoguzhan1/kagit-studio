# F2-08 Denetim Raporu — Python GPU / Gemini / FFmpeg AI Pipeline (`kagit_ai_pipeline`)

- **Denetlenen Proje:** INKTROPE / Kâğıt Studio (`C:\Users\salat\Downloads\kagit-studio`)
- **Canlı Adres:** `https://inktrope.com`
- **Denetim Kapsamı:** `server/kagit_ai_pipeline/` altındaki tüm dosyalar (14 dosya, 1.481 satır Python kodu), başlatma betikleri (`start-kagit-studio.ps1`, `start-kagit-studio.bat`), istemci entegrasyonu (`src/engine/kagit25dPipeline.ts`, `src/components/film/FilmDirectorStudio.tsx`, `src/types/film.ts`) ve dağıtım başlıkları (`public/_headers`, `vercel.json`, `wrangler.jsonc`).
- **Denetçi Rolü:** Bağımsız Python GPU / Gemini / FFmpeg Pipeline Denetçisi (Salt-okunur, savunma odaklı doğrulama; kaynak kodda sıfır değişiklik).
- **Denetim Tarihi:** 24 Kasım 2026

---

## 1. Yönetici Özeti & Dürüst Puan

### Genel Puan: **3.5 / 10**

**Gerekçe:**
`kagit_ai_pipeline` tek kullanıcılı yerel bir demo/prototip olarak temel "mutlu yol" (happy-path) akışlarını çalıştırabiliyor: tüm 10 Python dosyası sözdizimi doğrulamasından geçiyor (`py_compile` 10/10), mevcut 8 birim testi geçiyor (`unittest` 8/8), FFmpeg çağrılarında `shell=True` kullanılmıyor ve geçici dosyalar `tempfile.TemporaryDirectory` ile yönetiliyor.

Ancak **üretim sunucusu (production server)** iddiasıyla (`app.py:2, 39`, `Dockerfile:1-20`) değerlendirildiğinde servis ağır mimari, güvenlik ve kararlılık açıkları taşıyor:
1. **Docker imajı import aşamasında kesin olarak çöküyor:** `app.py:188` (`Path(__file__).resolve().parents[2]`) `Dockerfile:11` (`WORKDIR /app`) içinde `/app/app.py` için `IndexError: 2` fırlatıyor.
2. **Tek bir istek tüm sunucuyu dondurabiliyor:** 6 POST endpoint'inden 4'ü `async def` olarak tanımlı olmasına rağmen ağır senkron CPU/GPU/OpenCV işlemlerini, **120 saniyelik `subprocess.run` FFmpeg çağrısını** ve **sonsuz zaman aşımlı (`Timeout=None`) Gemini HTTP çağrısını** doğrudan Uvicorn event-loop'unda çalıştırıyor.
3. **Kimlik doğrulamasız Wildcard CORS (`*`) + `0.0.0.0`:** Herhangi bir web sitesi veya ağ üzerindeki yetkisiz istemci, kurbanın `GEMINI_API_KEY` kotasını tüketebilir, GPU donanımını parmak izi olarak okuyabilir ve yerel makineyi FFmpeg/VRAM OOM ile kilitleyebilir.
4. **Bellek/VRAM OOM ve FFmpeg güvenlik sınırları eksik:** Pillow `178.96 MP` altındaki görselleri hata vermeden belleğe açıyor; `cinema_refiner.py` çözünürlük sınırı koymadan dev tensörleri 6 GB GPU VRAM'ine gönderiyor; Starlette çok GB'lık multipart gövdeleri `_read_bounded` çalışmadan diske yazıyor; FFmpeg'de `-protocol_whitelist`, demuxer kısıtı, süre/çözünürlük/çıktı boyutu limiti yok.
5. **Sessiz veri bozulması, sahte GPU etiketlemesi ve ön yüz kopukluğu:** `light_angle_deg=nan` tamamen siyah PNG'yi `HTTP 200` döndürüyor; `horizon_y=nan` ve yarım/bozuk PNG'ler yakalanmamış `HTTP 500` üretiyor; `HTTP 500` yanıtları sunucunun Windows kullanıcı adını ve geçici dosya yolunu sızdırıyor; GPU yokken `cinema_refiner.py` 4 farklı sinema görünümünde (`ghibli-watercolor`, `noir-35mm`, `anime-makoto`, `klaus-3d-cel`) bit-bit özdeş çıktı üretiyor; `decompose-character` ve `decompose-background` hiç GPU/neural kod içermediği halde `"gpu-neural"` raporluyor; 6 endpoint'ten 2'si (`/api/v1/direct-film`, `/api/v1/refine-frame`) ön yüzde hiç çağrılmıyor ve canlı `https://inktrope.com` CSP kuralı (`connect-src 'self' blob: data:`) yerel/bulut pipeline bağlantısını tamamen engelliyor.

---

## 2. Doğrulama Ortamı & Gerçek Komut Kanıtları

Aşağıdaki salt-okunur doğrulamalar `C:\Users\salat\Downloads\kagit-studio\server\kagit_ai_pipeline\` üzerinde kaynak dosyalar değiştirilmeden (`PYTHONPYCACHEPREFIX` geçici dizine yönlendirilerek ve `-B` ile, `GEMINI_API_KEY=""` tutularak dış ücretli API çağrısı yapılmadan) yürütüldü:

| Doğrulama | Komut / Yöntem | Gerçek Sonuç | Durum |
|---|---|---|---|
| Dosya & Satır Envanteri | Python `pathlib` taraması (`.venv` ve `__pycache__` hariç) | 14 dosya, 10 `.py` dosyası, toplam **1.481** fiziksel `.py` satırı | `[PASS]` |
| Python Sözdizimi | `.venv\Scripts\python.exe -m py_compile` (10/10 `.py`) | Tüm 10 `.py` dosyası hatasız derlendi (`ALL_PY_COMPILE_OK=True`) | `[PASS]` |
| Mevcut Birim Testleri | `.venv\Scripts\python.exe -B -m unittest discover -s tests -v` (`GEMINI_API_KEY=""`) | `Ran 8 tests in 2.660s — OK` (`UNITTEST_EXIT=0`) | `[PASS]` |
| `.venv` & Donanım Gözlemi | `pyvenv.cfg` + `importlib` + `torch.cuda` + `ffmpeg -version` | Python 3.11.9 (`include-system-site-packages = true`), `fastapi 0.165.0`, `uvicorn 0.54.0`, `PIL 13.0.0` (`MAX_IMAGE_PIXELS=89478485`), `cv2 4.11.0`, `numpy 2.4.6`, `pydantic 2.14.1`, `edge_tts 7.3.1`, `google.genai 2.33.0`, `torch 2.5.1+cu121` (`NVIDIA GeForce RTX 3050 6GB Laptop GPU`), **`diffusers` YOK**, `ffmpeg 8.1-full_build` (WinGet) | `[PASS]` |
| Docker `parents[2]` Testi | `PurePosixPath("/app/app.py").parents[2]` | **`IndexError: 2`** (`parents=[PurePosixPath('/app'), PurePosixPath('/')]`) | `[FAIL]` |
| GPU/CV2/TTS Yok Simülasyonu | `sys.modules[mod] = None` (`torch`, `cv2`, `edge_tts`, `google`) | Import başarılı; fakat `refine_cinema_frame` 4 farklı `look` için **bit-bit özdeş PNG** üretti (`True/True/True`) ve `engine="opencv-cpu-refiner"` raporladı | `[FAIL]` |
| `TestClient` Uç Durum Testleri | `fastapi.testclient.TestClient(app, raise_server_exceptions=False)` | `horizon_y=nan` → `500`; truncated PNG (3 uçta) → `500`; `light_angle_deg=nan` → `200` (tam siyah `mean=0.0`); bozuk video → `500` + Windows temp yolu sızıntısı; `OPTIONS` `evil.example` → `200` `ACA-Origin: *`; `/docs` & `/openapi.json` → `200`; `X-Refiner-Engine` header → `None` | `[FAIL]` |
| `google.genai` Varsayılan Timeout | `genai.Client(api_key="dummy")._api_client._httpx_client.timeout` | **`Timeout(timeout=None)`** (sonsuz zaman aşımı) | `[FAIL]` |
| FFmpeg Protokol Yüzeyi | `ffmpeg -hide_banner -protocols` & `-h demuxer=hls` | `http, https, ftp, gopher, sftp, tcp, tls, rtmp, rtp, udp, concat, subfile, crypto, data, ipfs` etkin; pipeline'da `-protocol_whitelist` yok | `[FAIL]` |
| Canlı Gemini Ücretli API Çağrısı | Bilinçli olarak yürütülmedi (savunma odaklı / ücretsiz doğrulama kuralı) | Dış ücretli çağrı yapılmadı; kod incelemesi ile model adları ve hata yutma doğrulandı | `[TEST EDİLMEDİ]` |

### İncelenen Dosya Envanteri (`server/kagit_ai_pipeline/`)

| Dosya | Satır | Bayt | Rol |
|---|---:|---:|---|
| `app.py` | 197 | 6.838 | FastAPI sunucusu, CORS, 7 HTTP route, statik `dist/` mount |
| `pipeline/__init__.py` | 1 | 61 | Paket başlığı |
| `pipeline/character_decomposer.py` | 288 | 10.121 | Donanım algılama, kağıt arka plan temizleme, 6 sabit oranlı parça kesimi, Depth/Normal |
| `pipeline/cinema_refiner.py` | 254 | 11.286 | OpenCV/CUDA/Pillow kare iyileştirme + Gemini görsel iyileştirme |
| `pipeline/voice_tts.py` | 239 | 9.063 | 3 katmanlı TTS: Gemini TTS → `edge-tts`+FFmpeg → offline formant WAV |
| `pipeline/background_slicer.py` | 110 | 4.694 | 5 paralaks katmanı (Z0..Z5) + doğrusal derinlik gradyanı + ışık açısı |
| `pipeline/style_dna.py` | 94 | 3.331 | 96×96 nicemlenmiş renk paleti, kontrast, çizgi kalınlığı ve stil etiketi |
| `pipeline/mp4_transcoder.py` | 93 | 3.118 | FFmpeg binary bulma + H.264/AAC MP4 transcode |
| `pipeline/director_llm.py` | 81 | 3.730 | Gemini 2.5 Flash veya kural tabanlı deterministik film senaryo yönetmeni |
| `tests/test_pipeline.py` | 124 | 5.712 | 8 adet `unittest` birim testi (HTTP/FastAPI katmanı test edilmiyor) |
| `Dockerfile` | 20 | 667 | CUDA 12.4.1 Ubuntu 22.04 konteyner tanımı |
| `README.md` | 23 | 1.068 | Kurulum ve kullanım belgesi |
| `requirements.txt` | 8 | 160 | Temel bağımlılıklar |
| `requirements-gpu.txt` | 7 | 207 | Opsiyonel GPU + `google-genai` bağımlılıkları |

---

## 3. EN AĞIR 5 SORUN

### 1. [KRİTİK] Kimlik Doğrulamasız Wildcard CORS (`*`) + `0.0.0.0` Dinleme + Tarayıcı Üzerinden Yerel/Ağ API İstismarı
- **Ciddiyet:** KRİTİK
- **Kanıt (`dosya:satır`):**
  - `server/kagit_ai_pipeline/app.py:42-44, 59-66` (`KAGIT_ALLOWED_ORIGINS` varsayılan `"*"`, `allow_methods=["*"]`, `allow_headers=["*"]`)
  - `server/kagit_ai_pipeline/app.py:80-184` (7 route'un tamamında sıfır `Depends` auth / API key / Origin kontrolü)
  - `server/kagit_ai_pipeline/Dockerfile:20` & `README.md:10` (`--host 0.0.0.0 --port 8090` — tüm ağ arayüzlerine açık; `Dockerfile`'da `USER` yok, `root` olarak çalışır)
  - `start-kagit-studio.ps1:37` (`127.0.0.1:8090` — yerel olsa da tarayıcı kaynaklı cross-origin/DNS rebinding saldırısına açık)
  - `public/_headers:7` & `vercel.json:19` (`connect-src 'self' blob: data:` — canlı `https://inktrope.com` zaten `localhost:8090` veya RunPod URL'ine bağlanamıyor)
- **Kök Neden:** Servis hem yerel masaüstü (`http://localhost:8090`, aynı kökenden `dist/` sunuyor) hem de bulut GPU sunucusu (RunPod/Modal) olarak tasarlanmış; ancak iki dağıtım modu için de kimlik doğrulama (`Bearer` token), köken beyaz listesi (`allow_origins`) ve `Host` başlığı doğrulaması (`TrustedHostMiddleware`) eklenmemiş.
- **Etki:**
  1. **Yerel tarayıcı pivot saldırısı:** Kullanıcı `start-kagit-studio.ps1` çalıştırırken başka bir sekmede ziyaret ettiği kötü amaçlı herhangi bir site `fetch("http://localhost:8090/...")` gönderebilir (`OPTIONS` preflight testinde `evil.example` için `200 OK` ve `Access-Control-Allow-Origin: *` doğrulandı).
  2. **Ücretli Gemini API bütçe tüketimi:** Ortamda `GEMINI_API_KEY` tanımlıysa saldırgan `/api/v1/direct-film`, `/api/v1/refine-frame` (`engine=gemini-neural`) ve `/api/v1/synthesize-voice` üzerinden sınırsız ücretli Gemini çağrısı tetikleyip yanıtları okuyabilir.
  3. **Donanım parmak izi & yerel DoS:** `GET /health` kesin GPU modelini (`cuda:NVIDIA GeForce RTX 3050 6GB Laptop GPU`) sızdırır; ardışık `/api/v1/transcode-mp4` veya `/api/v1/refine-frame` çağrıları kullanıcının CPU/VRAM'ini kilitleyebilir.
  4. **Ağ/Bulut tam yetkisiz erişim:** `Dockerfile` veya `README.md` komutu (`0.0.0.0:8090`) ile açılan bir sunucu tüm LAN/İnternet tarafından kimliksiz kullanılabilir; ayrıca `/docs` ve `/openapi.json` (`200 OK`) tüm uçları ilan eder.
- **Somut Düzeltme:**
  1. Varsayılan `KAGIT_ALLOWED_ORIGINS` değerini `"http://localhost:8090,http://127.0.0.1:8090"` yapın; `"*"` yalnızca açık opt-in olsun.
  2. Başlangıçta zorunlu paylaşılan gizli anahtar (`KAGIT_API_TOKEN` — yoksa yerel modda rastgele üretilip yalnız `127.0.0.1`'e sunulabilir) + `Authorization: Bearer <token>` middleware/dependency ekleyin (sabit zamanlı `hmac.compare_digest` ile).
  3. DNS rebinding'i önlemek için `starlette.middleware.trustedhost.TrustedHostMiddleware` ekleyin; `Dockerfile` içinde `root` olmayan `USER` tanımlayın ve üretimde `docs_url=None, redoc_url=None, openapi_url=None` yapın.

---

### 2. [KRİTİK] 4 `async def` Endpoint'te Senkron Event-Loop Kilitlenmesi + Gemini İstemcisinde Sonsuz Timeout (`Timeout=None`)
- **Ciddiyet:** KRİTİK
- **Kanıt (`dosya:satır`):**
  - `server/kagit_ai_pipeline/app.py:86-93` (`async def api_decompose_character` → doğrudan `decompose_character(img)`)
  - `server/kagit_ai_pipeline/app.py:96-106` (`async def api_decompose_background` → doğrudan `decompose_background(img, ...)`)
  - `server/kagit_ai_pipeline/app.py:116-141` (`async def api_refine_frame` → doğrudan `refine_cinema_frame(...)`, içinde senkron OpenCV/CUDA + senkron `client.models.generate_content(...)` ağ çağrısı!)
  - `server/kagit_ai_pipeline/app.py:164-184` (`async def api_transcode_mp4` → doğrudan `transcode_to_broadcast_mp4(...)` → `mp4_transcoder.py:88` `subprocess.run(..., timeout=120)`)
  - `server/kagit_ai_pipeline/pipeline/cinema_refiner.py:175, 199`, `director_llm.py:59, 69`, `voice_tts.py:207, 212` (`genai.Client(api_key=api_key)` — `http_options` timeout parametresi YOK; doğrulanan değer: `Timeout(timeout=None)`)
  - `server/kagit_ai_pipeline/pipeline/voice_tts.py:110, 119-125` (`edge_tts.Communicate` çağrısında toplam `asyncio.wait_for` duvar-saati zaman aşımı yok)
- **Kök Neden:** FastAPI'de `UploadFile` okumak için `async def` seçilmiş, ancak devamındaki tüm yoğun CPU/GPU/disk/alt-süreç ve senkron HTTP çağrıları `asyncio.to_thread` / `starlette.concurrency.run_in_threadpool` veya `asyncio.create_subprocess_exec` içine alınmamış. Ayrıca `google-genai` SDK'sına `HttpOptions(timeout=...)` verilmediği için alttaki `httpx.Client` sınırsız (`None`) zaman aşımıyla çalışıyor ve her istekte yeni `genai.Client` oluşturularak kapatılmıyor (bağlantı havuzu sızıntısı).
- **Etki:**
  - Tek bir `/api/v1/transcode-mp4` çağrısı Uvicorn event-loop'unu **120 saniye boyunca tamamen kilitler**; bu sürede `/health` (istemcide 2.5 sn timeout'lu `kagit25dPipeline.ts:64` nedeniyle sunucu "çevrimdışı" görünür), diğer API çağrıları ve `dist/` statik dosyaları yanıt vermez.
  - Tek bir `POST /api/v1/refine-frame` (`engine=gemini-neural`) çağrısında Gemini TCP bağlantısı askıda kalırsa **`Timeout(timeout=None)` yüzünden tüm sunucu süresiz kilitlenir.**
  - İstemci bağlantıyı kesse bile event-loop tıkalı olduğu için `CancelledError` işlenemez, FFmpeg/GPU işi arka planda boşa çalışmaya devam eder.
- **Somut Düzeltme:**
  1. Tüm CPU/GPU işlerini `await run_in_threadpool(...)` (veya ayrı process/worker havuzuna) taşıyın; FFmpeg için `asyncio.create_subprocess_exec` + `asyncio.wait_for(..., timeout=...)` kullanarak iptal durumunda `proc.kill(); await proc.wait()` uygulayın.
  2. Tüm Gemini çağrılarında tek paylaşılan/kapatılan istemci veya `types.HttpOptions(timeout=30_000)` (ms) yapılandırın; `edge-tts` akışını `asyncio.wait_for(_gen_mp3(), timeout=15.0)` ile sarın.

---

### 3. [KRİTİK] 179 MP PIL Dekompresyon Bombası, Sınırsız VRAM/RAM Tüketimi, Multipart Disk Spool DoS ve Eşzamanlılık/Kuyruk Yokluğu
- **Ciddiyet:** KRİTİK
- **Kanıt (`dosya:satır`):**
  - `server/kagit_ai_pipeline/app.py:45-56` (`MAX_IMAGE_BYTES=20MB`, `MAX_VIDEO_BYTES=150MB`; `_read_bounded` yalnızca Starlette multipart gövdesini tamamen parse edip diske spool ettikten sonra çalışır)
  - `server/kagit_ai_pipeline/app.py:69-78, 109-113, 144-161` (`DirectFilmRequest` ve `SynthesizeVoiceRequest` için gövde/alan uzunluk sınırı yok; `prompt`, `style_dna`, `text` sınırsız JSON kabul eder)
  - `PIL.Image.MAX_IMAGE_PIXELS` değiştirilmemiş (`89,478,485` — Pillow 13.0.0 doğrulaması: `2 * MAX_IMAGE_PIXELS = 178,956,970` piksele kadar yalnızca `Warning` üretir, hata fırlatmaz!)
  - `server/kagit_ai_pipeline/pipeline/cinema_refiner.py:58-159` (`_refine_with_gpu_opencv` görseli hiç küçültmeden `float32` RGB dizilerine ve doğrudan `torch.device("cuda")` VRAM'ine taşır; `torch.cuda.OutOfMemoryError` yakalanmaz)
  - `server/kagit_ai_pipeline/pipeline/character_decomposer.py:111-147, 199-277` (görsel boyutu üst limiti yok; `compute_depth_and_normal_maps` satır 112'de `scale = min(1.0, 256.0 / max(1, w))` yalnızca **genişliği** kısıtlar, **yüksekliği** kısıtlamaz — örn. `256×50000` görselde saf Python Chamfer döngüsü 12.8 milyon piksel döner!)
  - `server/kagit_ai_pipeline/app.py` (tüm dosya): sıfır `asyncio.Semaphore`, sıfır istek kuyruğu, sıfır rate-limit; çoklu worker'da eşzamanlı CUDA/FFmpeg OOM.
- **Kök Neden:** Boyut koruması yalnızca dosya bayt uzunluğuna (`_read_bounded`) indirgenmiş; sıkıştırılmış piksel alanı (`w * h`), video süresi/çözünürlüğü, JSON payload boyutu, ASGI akış boyutu ve eşzamanlı GPU/FFmpeg slot sayısı hiç denetlenmemiş.
- **Etki:**
  - <500 KB boyutunda tek bir düz renkli `13000×13000` (169 MP) PNG dosyası hem 20 MB sınırını hem de Pillow'un 178.96 MP hata eşiğini geçer; `cinema_refiner.py` içinde ~6+ adet `float32` kopyası (~12 GB sistem RAM) ve CUDA tensörleri (>8 GB VRAM) ayırarak **6 GB RTX 3050 GPU'yu tek istekte `CUDA OOM` ile çökertir**.
  - Çok GB'lık bir multipart yüklemesi `_read_bounded` satırına ulaşmadan önce Starlette tarafından `%TEMP%`/`/tmp` diskine yazılarak diski doldurabilir.
  - `/api/v1/synthesize-voice` (senkron `def` → 40 AnyIO thread) üzerine gelen eşzamanlı istekler 40 adet paralel FFmpeg + 40 `edge-tts` WebSocket + 40 Gemini isteği açarak sunucuyu tüketir.
- **Somut Düzeltme:**
  1. ASGI seviyesinde `Content-Length` + streaming bayt sayacı middleware'i ekleyin (hem multipart hem JSON için, örn. JSON max 64 KB).
  2. `Image.MAX_IMAGE_PIXELS = 16_777_216` (16 MP) belirleyin; `Image.open()` hemen ardından `img.width`, `img.height` (örn. max `4096×4096`), `img.format` beyaz listesi (`PNG/JPEG/WEBP`) ve `img.load()` doğrulaması yapın; `compute_depth_and_normal_maps`'te `max(w, h)` ile ölçekleyin.
  3. GPU/FFmpeg işleri için `asyncio.Semaphore(1)` (veya yapılandırılabilir `KAGIT_MAX_CONCURRENT_JOBS`) + `try/finally` içinde CUDA OOM yakalama ve `torch.inference_mode()` ekleyin.
  4. Pydantic modellerinde `Field(min_length=1, max_length=...)` sınırları tanımlayın (`DirectFilmRequest.prompt <= 2000`, `SynthesizeVoiceRequest.text <= 500`, `style_dna` derinlik/anahtar kısıtı).

---

### 4. [YÜKSEK] FFmpeg Protokol/Demuxer Kısıtsızlığı (SSRF & Video Bombası Yüzeyi) + HTTP 500 İçinde Sunucu Dosya Yolu/Stderr Sızıntısı
- **Ciddiyet:** YÜKSEK
- **Kanıt (`dosya:satır`):**
  - `server/kagit_ai_pipeline/pipeline/mp4_transcoder.py:46-88` (`safe_ext` alfanümerik her uzantıya izin verir; `-protocol_whitelist` ve `-f` demuxer beyaz listesi YOK; `-t`, `-fs`, `-threads` ve maksimum çıkış çözünürlüğü YOK)
  - `server/kagit_ai_pipeline/pipeline/mp4_transcoder.py:89-90` (`raise RuntimeError(f"FFmpeg transcode failed: {proc.stderr.strip() or proc.returncode}")`)
  - `server/kagit_ai_pipeline/app.py:155, 178` (`detail=f"TTS failed: {exc}"`, `detail=f"MP4 transcode failed: {exc}"` — ham istisna/FFmpeg stderr istemciye aynen dönüyor)
  - `TestClient` doğrulama çıktısı: `{"detail":"MP4 transcode failed: FFmpeg transcode failed: ... Error opening input file C:\\Users\\salat\\AppData\\Local\\Temp\\kagit_mp4_0trlyquv\\input.mp4whoami."}`
  - Host `ffmpeg -protocols` çıktısı: `http, https, ftp, gopher, sftp, tcp, tls, rtmp, rtp, udp, srt, zmq, concat, subfile, crypto, data, ipfs` etkin.
- **Kök Neden:** `subprocess.run` liste biçimiyle OS komut enjeksiyonundan korunmuş ve `cinema_look` beyaz listelenmiş olsa da, FFmpeg'in kendi güçlü demuxer/protokol motoru sınırlandırılmamış, girdi dosyası magic-byte ile doğrulanmamış ve FFmpeg `stderr` çıktısı filtrelenmeden HTTP 500 yanıtına gömülmüştür.
- **Etki:**
  - **SSRF / İstenmeyen Demuxer Yüzeyi:** İstemci `m3u8`, `mpd`, `sdp`, `concat` veya sahte `.webm` uzantısıyla bir çalma listesi/konteyner yüklediğinde FFmpeg içerik algılama ile `hls`/`dash`/`sdp` demuxer'larını tetikleyip `http/https` veya yerel dosya erişim girişimleri yapabilir.
  - **Video Bombası (CPU/RAM/Disk DoS):** 50 KB'lık yüksek çözünürlüklü veya çok uzun süreli sentetik bir WebM/MP4 yüklemesi FFmpeg'i tüm CPU çekirdeklerinde 120 saniye koşturabilir, yüzlerce MB/GB geçici `output.mp4` üretip `f.read()` (`mp4_transcoder.py:93`) ile tümünü RAM'e çekerek OOM'a yol açabilir.
  - **Bilgi İfşası:** Hatalı videoda sunucunun işletim sistemi, Windows kullanıcı adı (`C:\Users\salat\...`), geçici dizin şablonu ve FFmpeg bellek işaretçileri dış istemciye sızdırılır.
- **Somut Düzeltme:**
  1. FFmpeg çağrısından önce girdi baytlarında konteyner magic-byte kontrolü yapın (WebM/EBML `1A 45 DF A3` veya MP4 `ftyp`) ve `safe_ext` değerini yalnızca `{"webm", "mp4"}` ile sınırlayın.
  2. FFmpeg argümanlarına `-protocol_whitelist file`, `-f matroska,webm` (veya `mov,mp4`), `-t 180` (süre üst sınırı), `-fs 200M` (çıktı dosya boyutu üst sınırı), `-threads 4` ve `scale='min(1920,trunc(iw/2)*2)':'min(1080,trunc(ih/2)*2)'` ekleyin.
  3. `proc.stderr` içeriğini yalnızca sunucu loguna yazın; HTTP yanıtında sabit, güvenli hata mesajı döndürün (ayrıca FFmpeg yoksa `500` yerine `503 Service Unavailable`).

---

### 5. [YÜKSEK] Docker İmajında Kesin Başlangıç Çökmesi (`IndexError: 2`) + Bozuk CPU/GPU Fallback & Ön Yüz Kontrat Kopuklukları
- **Ciddiyet:** YÜKSEK
- **Kanıt (`dosya:satır`):**
  - `server/kagit_ai_pipeline/app.py:188` (`_DIST_DIR = Path(__file__).resolve().parents[2] / "dist"`) + `Dockerfile:11, 18, 20` (`WORKDIR /app`, `COPY . .`, `CMD ["uvicorn", "app:app", ...]`) → `/app/app.py` için `parents` uzunluğu 2 olduğundan import sırasında **`IndexError: 2`** (doğrulandı).
  - `start-kagit-studio.ps1:15` (`pip install fastapi "uvicorn[standard]" python-multipart edge-tts` — `requirements.txt` yerine eksik paket kuruyor; `pillow`, `numpy`, `pydantic`, `opencv-python-headless` atlanmış!).
  - `server/kagit_ai_pipeline/pipeline/cinema_refiner.py:29-34, 88-93, 147-159` (`HAS_CUDA` `KAGIT_ENABLE_GPU_MODELS=0` bayrağını yok sayıyor; CPU yolunda 4 sinema `look`'u tamamen yok sayılıp özdeş çıktı veriliyor; `cv2` yokken bile `engine="opencv-cpu-refiner"` raporlanıyor).
  - `server/kagit_ai_pipeline/pipeline/character_decomposer.py:47-49, 280` & `background_slicer.py:104` (sıfır GPU/SAM-2/Depth-Anything kodu olmasına rağmen CUDA varken `source_engine: "gpu-neural"` döndürüyor; `requirements-gpu.txt`'deki `torchvision/diffusers/transformers/accelerate` kodun hiçbir yerinde import edilmiyor).
  - `server/kagit_ai_pipeline/app.py:90, 99, 103, 121, 126` (yarım/bozuk PNG 3 endpoint'te yakalanmamış `500`, `horizon_y=nan` → `500`, `light_angle_deg=nan` → `200` simsiyah bozuk görüntü).
  - `src/engine/kagit25dPipeline.ts:96, 389, 610, 633`, `src/types/film.ts:216, 232`, `src/components/film/FilmDirectorStudio.tsx:93-104, 1759` (`/api/v1/direct-film` ve `/api/v1/refine-frame` ön yüz UI'dan hiç çağrılmıyor; `app.py:65` `X-Refiner-Engine` header'ı hiç set edilmiyor; `source_engine: "gpu-neural"` `DecomposedBackgroundSet25D`'nin `'local-cv' | 'cloud-gpu'` tipini bozuyor).
- **Kök Neden:** Konteyner dağıtımı, CPU-only ortamlar, hata durumları ve ön yüz/arka yüz şema evrimi otomatik entegrasyon testleriyle (`TestClient` + Docker smoke test + CPU-only CI) doğrulanmamış; `tests/test_pipeline.py` yalnızca yerel mutlu yol fonksiyonlarını test ediyor, `app.py` HTTP katmanını hiç test etmiyor.
- **Etki:**
  - `Dockerfile` ile üretilen imaj ayağa kalkamaz.
  - Temiz bir Windows makinesinde `start-kagit-studio.ps1` `ModuleNotFoundError: No module named 'PIL'` / `'numpy'` ile çöker.
  - GPU'suz sunucuda `/api/v1/refine-frame` sessizce yanlış (look'suz) görüntü üretir.
  - Kullanıcılar canlı `https://inktrope.com` üzerinden yerel/bulut GPU sunucusuna bağlanmak istediğinde CSP `connect-src 'self' blob: data:` nedeniyle istekler tarayıcıda sessizce başarısız olur (`pingCloudPipeline` `catch` bloğu "sunucu bulunamadı" gösterir).
- **Somut Düzeltme:**
  1. `app.py:188` için güvenli üst dizin kontrolü yazın: `_p = Path(__file__).resolve(); _DIST_DIR = _p.parents[2] / "dist" if len(_p.parents) > 2 else _p.parent / "dist"`.
  2. `start-kagit-studio.ps1:15`'i `.\.venv\Scripts\pip.exe install -r requirements.txt` olarak düzeltin.
  3. `cinema_refiner.py` CPU yoluna 4 `look` için CUDA yoluyla birebir aynı renk/ton/gren/mürekkep matematiğini ekleyin, `KAGIT_ENABLE_GPU_MODELS` kontrolünü ortaklaştırın, `cv2` yoksa `"pillow-cpu-refiner"` raporlayın.
  4. `decompose_character` ve `decompose_background` için gerçek durumları yansıtacak şekilde `source_engine: "local-cv"` (veya ön yüzle uyumlu açık enum) döndürün, kullanılmayan paketleri `requirements-gpu.txt`'den çıkarın ya da gerçekten entegre edin.
  5. Tüm `float` form girdilerinde `math.isfinite(...)` doğrulaması ve `Image.open()` sonrasında `img.load()` ekleyin; `TestClient` ile HTTP sözleşme testleri yazın.

---

## 4. Detaylı Denetim Matrisi

### 4.1. 6 API Endpoint'inin (+ `/health` ve Statik Mount) Tam Envanteri ve Denetimi

| # | Method & Route | Handler (`app.py`) | Async / Bloklama | Auth | Input Doğrulama | Hata / Yanıt Kodları | Ön Yüz (`src/`) Uyumu | Sonuç |
|---|---|---|---|---|---|---|---|---|
| 0 | `GET /health` | `health` (`app.py:80-83`, `def`) | Threadpool; ancak **her istekte** `import torch`, CUDA sorgusu ve `shutil.which`/`glob.glob` disk taraması yapıyor (`character_decomposer.py:35-74`) | YOK (`[FAIL]`) | Girdi yok | `200`; donanım/GPU tam adını, FFmpeg ve Gemini anahtar varlığını herkese açar | `kagit25dPipeline.ts:65` çağırır (`2500ms` timeout). Uyumlu. | `[FAIL]` |
| 1 | `POST /api/v1/decompose-character` | `api_decompose_character` (`app.py:86-93`, **`async def`**) | **`[FAIL]` Event-loop blokluyor:** `Image.open` + `decompose_character(img)` (numpy, cv2/Chamfer, 8× `PNG optimize=True`) doğrudan event loop'ta! | YOK (`[FAIL]`) | `_read_bounded(20MB)` var; magic-byte/MIME/çözünürlük sınırı YOK; `img.load()` olmadığı için yarım PNG → **`500`** (test edildi). | `413` (>20MB), `400` (bozuk header, ham PIL hatası sızar), `500` (yarım PNG) | `kagit25dPipeline.ts:386` çağırır (timeout YOK). Backend `source_engine: "gpu-neural"` döndürür, istemci `'cloud-gpu'` olarak çevirir (satır 434). | `[FAIL]` |
| 2 | `POST /api/v1/decompose-background` | `api_decompose_background` (`app.py:96-106`, **`async def`**) | **`[FAIL]` Event-loop blokluyor:** `1280×720 LANCZOS` + 5× `1280×720 RGBA PNG optimize=True` doğrudan event loop'ta! | YOK (`[FAIL]`) | `_read_bounded(20MB)` var; `horizon_y` için `isfinite` kontrolü YOK (`horizon_y=nan` → **`500`** test edildi); yarım PNG → **`500`** (test edildi). | `413`, `400`, `500` (`nan` veya yarım PNG) | `kagit25dPipeline.ts:607` çağırır (timeout YOK). **`[FAIL]` Tip uyumsuzluğu:** backend `"gpu-neural"` döndürür, `kagit25dPipeline.ts:633` doğrudan atar ve `DecomposedBackgroundSet25D.sourceEngine` (`'local-cv' \| 'cloud-gpu'`) kontratını ihlal eder! | `[FAIL]` |
| 3 | `POST /api/v1/direct-film` | `api_direct_film` (`app.py:109-113`, `def`) | Threadpool (`[PASS]`), ancak Gemini çağrısı `Timeout=None` ile thread'i sonsuz tutabilir (`[FAIL]`). | YOK (`[FAIL]`) | Pydantic `DirectFilmRequest` (`app.py:69-71`): yalnız `prompt.strip()` kontrolü; `max_length` YOK, `style_dna` derinlik/boyut sınırı YOK; `style_dna` doğrudan LLM prompt'una gömülür (`director_llm.py:67`). | `400` (boş prompt), `422` (eksik alan), `200` (Gemini bozuk şema dönse bile yalnızca `shots` listesi >0 kontrolü var, `world`/shot alanları doğrulanmıyor `director_llm.py:75`). | **`[FAIL]` Ölü endpoint:** `src/` içinde HİÇ çağrılmıyor! Ön yüz `src/engine/aiStudioClient.ts:149` üzerinden Cloudflare Worker `/api/ai/direct-film` ucunu kullanıyor. | `[FAIL]` |
| 4 | `POST /api/v1/refine-frame` | `api_refine_frame` (`app.py:116-141`, **`async def`**) | **`[FAIL]` Event-loop blokluyor:** OpenCV bilateral/Canny/GaussianBlur + CUDA tensör + **senkron ve sonsuz timeout'lu Gemini HTTP çağrısı** (`cinema_refiner.py:199`) doğrudan event loop'ta! | YOK (`[FAIL]`) | `_read_bounded(20MB)` var; çözünürlük/VRAM sınırı YOK; `light_angle_deg=nan` → **`200` simsiyah bozuk görüntü** (test edildi); `style_dna_json="[1,2,3]"` dict kontrolü YOK (`AttributeError` sessiz yutulur); `look`/`engine` geçersiz değerleri 400 vermek yerine sessiz fallback yapar; yarım PNG → **`500`**. | `413`, `400`, `500` (yarım PNG / CUDA OOM); `app.py:65`'te expose edilen `X-Refiner-Engine` header'ı **hiç dönmüyor** (`None` test edildi). | **`[FAIL]` Ölü/bağlanmamış endpoint:** `kagit25dPipeline.ts:96` `refineCinemaFrameRemote` export ediyor ancak `FilmDirectorStudio.tsx` veya `src/` içinde **hiçbir yerden çağrılmıyor** (timeout da yok). | `[FAIL]` |
| 5 | `POST /api/v1/synthesize-voice` | `api_synthesize_voice` (`app.py:144-161`, `def`) | Threadpool; ancak 40 eşzamanlı istek sınırı/semaphore olmadan paralel Gemini (`Timeout=None`) + `edge-tts` WebSocket + `ffmpeg` alt süreci açabilir (`[FAIL]`). | YOK (`[FAIL]`) | `SynthesizeVoiceRequest` (`app.py:74-77`): `max_length` YOK (çok MB'lık JSON kabul eder, yalnız sonradan `[:220]` keser `voice_tts.py:193`); bilinmeyen `emotion`/`voice_name` sessizce varsayılana düşer. | `400` (boş metin), `500` (ham istisna sızıntısı `f"TTS failed: {exc}"`, `app.py:155`), `200` `audio/wav` + `X-Voice-Engine`. | `kagit25dPipeline.ts:143` & `FilmDirectorStudio.tsx:1513` çağırır (istemcide timeout YOK). `X-Voice-Engine` okunur ama UI'da gösterilmez/saklanmaz. | `[FAIL]` |
| 6 | `POST /api/v1/transcode-mp4` | `api_transcode_mp4` (`app.py:164-184`, **`async def`**) | **`[FAIL]` Event-loop blokluyor:** `subprocess.run(..., timeout=120)` doğrudan event loop'ta tüm sunucuyu 2 dk dondurur! | YOK (`[FAIL]`) | `_read_bounded(150MB)` + `<64 byte` kontrolü; magic-byte/MIME/uzantı beyaz listesi YOK; bilinmeyen `cinema_look` sessizce `"none"` olur. | `413`, `400`, `500` (**sunucu dosya yolu + FFmpeg stderr sızıntısı** `app.py:178`, `mp4_transcoder.py:90`), `200` `video/mp4` + `X-Video-Codec`. | `kagit25dPipeline.ts:168` & `FilmDirectorStudio.tsx:1759` çağırır (timeout YOK). UI `cinemaLook` geçmez, hep `"none"` gider; üstelik UI look ID'leri (`'watercolor'`) ile backend ID'leri (`'ghibli-watercolor'`) uyumsuz! | `[FAIL]` |
| 7 | `GET /` (Statik `dist/`) & `/docs`, `/openapi.json` | `StaticFiles` (`app.py:188-197`) + FastAPI varsayılanları | `BaseHTTPMiddleware` overhead; `/app/app.py` içinde `parents[2]` **`IndexError` çökmesi**. | YOK (`[FAIL]`) | Güvenlik başlıkları (`CSP`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`) **YOK** (canlı `public/_headers` ile uyumsuz). | `/docs` ve `/openapi.json` üretimde açık (`200 OK`). | `start-kagit-studio.ps1` aynı kökenden (`http://localhost:8090`) sunar. | `[FAIL]` |

---

### 4.2. CORS `"*"` Riski ve Ağ/Köken Güvenliği

| Denetim Maddesi | Kanıt (`dosya:satır` / Test) | Bulgular | Sonuç |
|---|---|---|---|
| `allow_credentials` ile wildcard çatışması | `app.py:62` (`allow_credentials=False`) | `allow_origins=["*"]` ile `allow_credentials=False` kullanılmış; çerez/kimlik bilgisi yansıtma hatası yapılmamış. | `[PASS]` |
| Varsayılan `allow_origins=["*"]` + `allow_methods=["*"]` + `allow_headers=["*"]` | `app.py:42-44, 59-66` + `TestClient` `OPTIONS` testi (`evil.example` → `200`, `Access-Control-Allow-Origin: *`) | Kimlik doğrulaması olmayan serviste herhangi bir harici web sitesi tüm POST/GET API uçlarını çağırıp yanıtlarını okuyabilir. | `[FAIL]` |
| Bind adresi (`0.0.0.0` vs `127.0.0.1`) | `Dockerfile:20` (`--host 0.0.0.0`), `README.md:10` (`--host 0.0.0.0`), `start-kagit-studio.ps1:37` (`--host 127.0.0.1`) | Yerel PowerShell başlatıcı `127.0.0.1` ile doğru sınırlandırılmış olsa da Docker ve README servisi tüm ağ arayüzlerine (`0.0.0.0`) kimliksiz açıyor. | `[FAIL]` |
| DNS Rebinding & Yerel Tarayıcı İstismarı (Bileşik Risk) | `app.py:36-66` (`TrustedHostMiddleware` yok, auth yok, `GEMINI_API_KEY` sunucu ortamında) | `127.0.0.1`'de dahi kötü amaçlı bir site (veya DNS rebinding alanı) kullanıcının yerel GPU/FFmpeg'ini tüketebilir, donanım parmak izini alabilir ve `GEMINI_API_KEY` bütçesini boşaltabilir. | `[FAIL]` |
| Canlı `inktrope.com` CSP ile CORS çelişkisi | `public/_headers:7`, `vercel.json:19` (`connect-src 'self' blob: data:`), `app.py:188-197` | Canlı site CSP nedeniyle zaten `localhost:8090` veya RunPod'a bağlanamıyor; yerel kurulumda ise `dist/` zaten aynı kökenden (`localhost:8090`) sunuluyor. Yani `CORS "*"` meşru bir ihtiyacı bile karşılamadan yalnızca saldırı yüzeyi açıyor! | `[FAIL]` |
| `expose_headers` doğruluğu | `app.py:65` (`X-Refiner-Engine`), `app.py:135-141` + `TestClient` (`None`) | `X-Voice-Engine` ve `X-Video-Codec` dönüyor, ancak `X-Refiner-Engine` hiçbir yanıt başlığında üretilmiyor. | `[FAIL]` |

---

### 4.3. Dosya Boyut / Bellek / VRAM Sınırları

| Denetim Maddesi | Kanıt (`dosya:satır` / Test) | Bulgular | Sonuç |
|---|---|---|---|
| `UploadFile.read()` okuma sınırı | `app.py:45-56` (`_read_bounded`: görsel 20 MB, video 150 MB) | Handler içi RAM okuması sınırsız `await file.read()` yerine `max_bytes + 1` ile sınırlanmış. Ancak **Starlette multipart gövdesini endpoint çalışmadan önce diske spool ettiği için** çok GB'lık yüklemeler 413 dönmeden önce diski doldurabilir. | `[FAIL]` |
| JSON endpoint gövde/alan sınırları | `app.py:69-78, 109-113, 144-161` | `/api/v1/direct-film` ve `/api/v1/synthesize-voice` için ne middleware boyut limiti ne de Pydantic `max_length` sınırı var. | `[FAIL]` |
| PIL Decompression Bomb & Piksel Sınırı | `PIL.Image.MAX_IMAGE_PIXELS=89,478,485` (Pillow 13.0.0 doğrulaması: `178.96 MP`'ye kadar yalnızca `Warning`, hata yok!), `app.py:90,103,126` | Özel `MAX_IMAGE_PIXELS` veya `max(w, h)` sınırı yok. <500 KB'lık 169 MP PNG belleğe açılıp ~12 GB RAM + >8 GB CUDA VRAM isteyerek OOM'a neden olabilir. | `[FAIL]` |
| CUDA VRAM Yönetimi & OOM Kurtarma | `cinema_refiner.py:97-146` (`torch.from_numpy(...).to(dev)`) | Girdi çözünürlüğü sınırlanmamış, `torch.inference_mode()` yok, `torch.cuda.OutOfMemoryError` yakalanıp CPU'ya düşülmüyor, `empty_cache()` çağrılmıyor (6 GB RTX 3050'de yüksek çözünürlük/eşzamanlı istekte OOM riski). | `[FAIL]` |
| `compute_depth_and_normal_maps` yükseklik ölçekleme hatası | `character_decomposer.py:112-114` (`scale = min(1.0, 256.0 / max(1, w))`) | Yalnızca genişlik (`w`) 256 px ile sınırlanmış, yükseklik (`h`) sınırsız! İnce uzun görselde (`256×50000`) 12.8M piksel bellekte işlenir ve `cv2` yokken saf Python çift döngü sunucuyu kilitler. | `[FAIL]` |
| Video uzunluk / çözünürlük / çıktı boyutu sınırı | `mp4_transcoder.py:55-93` | FFmpeg'de `-t`, `-fs`, max çözünürlük veya `ffprobe` ön kontrolü yok; `output.mp4` sınırsız biçimde `f.read()` ile RAM'e alınır (`input_bytes` 150 MB + `mp4_bytes` aynı anda RAM'de). | `[FAIL]` |
| Eşzamanlılık / Kuyruk / Rate-Limiting | `app.py` (tüm dosya) | `Semaphore`, kuyruk ve hız sınırlayıcı yok. `synthesize-voice` (threadpool) 40 paralel FFmpeg/TTS açabilir; çoklu Uvicorn worker'da GPU VRAM OOM kaçınılmaz. | `[FAIL]` |
| Büyük Base64 JSON yanıt bellek baskısı | `background_slicer.py:95-110`, `character_decomposer.py:261-288`, `cinema_refiner.py:248` | `decompose-background` 5 adet `1280×720` RGBA PNG + depth PNG'yi base64 JSON içinde döner; `decompose-character` 6 adet orijinal çözünürlüklü PNG + 2 haritayı tek JSON yanıtında döner (base64 +%33 şişme + Python str/JSON serialization kopyaları). | `[FAIL]` |

---

### 4.4. GPU Yokken Fallback, Bağımlılıklar ve Sahte GPU İddiaları

| Denetim Maddesi | Kanıt (`dosya:satır` / Test) | Bulgular | Sonuç |
|---|---|---|---|
| GPU / `torch` / `cv2` / `edge_tts` / `google-genai` yokken import & başlatma | Salt-okunur simülasyon (`sys.modules[mod] = None`) | `app.py` ve tüm `pipeline/*` modülleri opsiyonel bağımlılıklar yokken çökmeden import edildi; `/health`, `decompose_character`, `decompose_background`, `direct_film_script`, `synthesize_character_voice` çalıştı. | `[PASS]` |
| `cinema_refiner.py` CPU fallback'inde `look` parametresi kaybı | `cinema_refiner.py:110-159` + simülasyon çıktısı (`ghibli == noir == makoto == klaus: True`) | CUDA yokken 4 sinema görünümünün (`ghibli-watercolor`, `klaus-3d-cel`, `anime-makoto`, `noir-35mm`) tüm renk/ışık/gamma/split-tone/gren ayarları atlanıyor! `cv2` de yoksa 4 görünüm bit-bit özdeş PNG döndürüyor ve hâlâ `engine="opencv-cpu-refiner"` (`satır 93`) yalanını raporluyor. | `[FAIL]` |
| `KAGIT_ENABLE_GPU_MODELS=0` bayrağının yok sayılması | `character_decomposer.py:47` vs `cinema_refiner.py:29-34, 97` | `detect_hardware_capabilities()` bayrağa saygı duyarken `cinema_refiner.py` modül import anında `HAS_CUDA = bool(torch.cuda.is_available())` sabitleyip bayrağı tamamen yok sayıyor. | `[FAIL]` |
| `decompose-character` & `decompose-background` sahte `"gpu-neural"` iddiası | `character_decomposer.py:2-5, 47-49, 193-288`, `background_slicer.py:38-110`, `requirements-gpu.txt:2-6` | Docstring'ler SAM-2 / Depth-Anything-v2 / ControlNet'ten söz etse ve CUDA varken `source_engine: "gpu-neural"` döndürse de iki modülde de **tek satır PyTorch/CUDA/ONNX/SAM/Depth modeli yok** (sabit oranlı dikdörtgen kesim + PIL elips + yatay bant dilimleme). `requirements-gpu.txt`'deki `torchvision`, `diffusers` (zaten `.venv`'de kurulu bile değil), `transformers`, `accelerate` kodda hiç import edilmiyor. | `[FAIL]` |
| `GEMINI_API_KEY` yokluğunda fallback davranışı | `director_llm.py:54-81`, `cinema_refiner.py:168-170, 230-245`, `voice_tts.py:199-239` + simülasyon | Anahtar yokken 3 modül de çökmeden yerel/ücretsiz yola düşüyor (`deterministic-director`, `opencv-cpu-refiner`, `edge-tts`/`local-formant-tts`). | `[PASS]` |
| `voice_tts.py` 3. parti `edge-tts` gizli dış ağ çağrısı & şüpheli Gemini model adları | `voice_tts.py:110, 213` (`gemini-3.8-flash-tts`), `cinema_refiner.py:200` (`gemini-3.1-flash-lite-image`), `director_llm.py:70` (`gemini-2.5-flash`) | Gemini anahtarı yokken veya Gemini hata verdiğinde (örn. geçersiz/erişilemeyen model adı) `voice_tts.py` kullanıcı metnini sessizce Microsoft `edge-tts` bulut servisine gönderiyor (opt-out/gizlilik bildirimi yok); tüm Gemini hataları loglanmadan yutulduğu için yanlış model adı/kota hatası hiç fark edilmiyor. | `[FAIL]` |
| `start-kagit-studio.ps1` eksik bağımlılık kurulumu | `start-kagit-studio.ps1:14-15` vs `requirements.txt:1-8` | İlk kurulumda `requirements.txt` yerine yalnız 4 paket kuruluyor (`pillow`, `numpy`, `pydantic`, `opencv-python-headless` eksik). `--system-site-packages` üzerinde bu paketler yoksa başlatıcı ilk çalıştırmada çöker. | `[FAIL]` |
| `Dockerfile` başlangıç çökmesi & yorumlu GPU paketleri | `Dockerfile:5, 11-20`, `app.py:188` | `/app/app.py` içinde `parents[2]` **`IndexError: 2`** fırlatır; ayrıca `ENV KAGIT_ENABLE_GPU_MODELS=1` ayarlı olmasına rağmen `requirements-gpu.txt` yorum satırındadır (`satır 16`). | `[FAIL]` |

---

### 4.5. FFmpeg Argüman Güvenliği

| Denetim Maddesi | Kanıt (`dosya:satır` / Test) | Bulgular | Sonuç |
|---|---|---|---|
| `shell=True` / OS komut enjeksiyonu | `mp4_transcoder.py:88`, `voice_tts.py:135-139` | Her iki `subprocess.run` çağrısı da argüman listesi kullanır; `shell=True` YOK. | `[PASS]` |
| `-` ile başlayan dosya adı & path traversal (`..`, `/`, `\`) | `mp4_transcoder.py:46, 49-51`, `voice_tts.py:130-132` + `TestClient` testi (`../../etc/passwd.webm`, `-f.mp4;whoami`) | Dosya adları sabit `input.{safe_ext}` / `voice.mp3` ve `TemporaryDirectory` içinde tam yolla oluşturulur; `safe_ext` yalnız alfanümerik karakter bırakır. Leading-dash argüman enjeksiyonu ve path traversal engellenmiş. | `[PASS]` |
| `filter_complex` / `-vf` / `drawtext` enjeksiyonu | `mp4_transcoder.py:15-21, 47, 65-66` | Kullanıcıdan gelen `cinema_look` doğrudan FFmpeg'e verilmez; sabit sözlük `FFMPEG_LOOK_FILTERS.get(cinema_look, "")` beyaz listesinden seçilir. | `[PASS]` |
| Protokol & Demuxer kısıtı (SSRF / yerel dosya okuma yüzeyi) | `mp4_transcoder.py:46, 55-63` + `ffmpeg -protocols` (8.1 full_build) | `-protocol_whitelist file` ve `-f` (demuxer beyaz listesi) YOK; `safe_ext` `m3u8/mpd/sdp/concat` gibi her alfanümerik uzantıyı geçirir; girdi magic-byte doğrulanmaz. | `[FAIL]` |
| FFmpeg kaynak tüketim sınırları (Video Bombası) | `mp4_transcoder.py:55-86` | `-t` (süre), `-fs` (çıktı boyutu), `-threads` ve `scale` üst çözünürlük sınırı YOK. | `[FAIL]` |
| `ffmpeg` bulunamadığında davranış | `mp4_transcoder.py:42-44`, `voice_tts.py:97-99`, `app.py:177-178` + simülasyon | `voice_tts.py` temiz biçimde `local-formant-tts` fallback'ine geçer; ancak `/api/v1/transcode-mp4` `RuntimeError` fırlatıp `503` yerine `500` döndürür ve `find_ffmpeg_binary()` her istekte `glob.glob` disk taraması yapar (`mp4_transcoder.py:29-33`). | `[FAIL]` |

---

### 4.6. Temp Dosya Temizliği ve Disk Dayanıklılığı

| Denetim Maddesi | Kanıt (`dosya:satır`) | Bulgular | Sonuç |
|---|---|---|---|
| İstisna ve FFmpeg hatasında/timeout'ta temizlik | `mp4_transcoder.py:49`, `voice_tts.py:130` (`with tempfile.TemporaryDirectory(...)`) | Context manager normal çıkışta, `RuntimeError`'da ve `subprocess.TimeoutExpired` istisnasında geçici dizini temizler. | `[PASS]` |
| Tahmin edilebilir temp dosya adı / yarış durumu (race condition) | `mp4_transcoder.py:49` (`prefix="kagit_mp4_"`), `voice_tts.py:130` (`prefix="kagit_tts_"`) | `mkdtemp` tabanlı rastgele dizin adları kullanıldığı için istekler arası dosya adı çakışması/yarışı yok. | `[PASS]` |
| Windows dosya kilidi, `SIGKILL`/OOM yetim dizinleri ve 3× disk amplifikasyonu | `mp4_transcoder.py:49-53, 88-93`, `app.py:165-179` | 1) `ignore_cleanup_errors` kullanılmıyor (Windows'ta gecikmiş handle kilidi temizlikte `PermissionError` üretebilir). 2) Süreç `SIGKILL`/OOM/elektrik kesintisinde kapanırsa `%TEMP%/kagit_mp4_*` kalıcı olarak diskte birikir (başlangıçta eski dizin temizliği yok). 3) Bir 150 MB video isteğinde aynı anda Starlette `SpooledTemporaryFile` (150 MB) + `input.webm` (150 MB) + `output.mp4` diske yazılır (3× disk kullanımı). 4) İstemci bağlantısı koptuğunda `subprocess.run` event-loop'u blokladığı için iptal edilmez, temp dosyalar 120 sn daha diskte kalır. | `[FAIL]` |

---

### 4.7. Timeout, Hata Kurtarma, Bilgi Sızıntısı ve Gözlemlenebilirlik

| Denetim Maddesi | Kanıt (`dosya:satır` / Test) | Bulgular | Sonuç |
|---|---|---|---|
| FFmpeg subprocess `timeout` parametresi | `mp4_transcoder.py:88` (`timeout=120`), `voice_tts.py:138` (`timeout=20`) | Her iki FFmpeg çağrısında da `timeout=` açıkça tanımlanmış. (Ancak `mp4_transcoder` event loop'ta çalıştığı için 120 sn tüm sunucuyu bloklar.) | `[PASS]` |
| Gemini API istemcilerinde timeout, kaynak kapatma ve retry/backoff | `director_llm.py:59, 69`, `cinema_refiner.py:175, 199`, `voice_tts.py:207, 212` + SDK doğrulaması | Üç modülde de `http_options` timeout **YOK** → doğrulanan `httpx` ayarı **`Timeout(timeout=None)` (SONSUZ!)**. Her istekte yeni `genai.Client` açılıp kapatılmıyor; retry/backoff veya circuit-breaker yok. | `[FAIL]` |
| `edge-tts` akış timeout'u | `voice_tts.py:110, 119-125` + `inspect.signature` | `edge_tts.Communicate` varsayılan `connect_timeout=10, receive_timeout=60` (paket başına); toplam duvar-saati `asyncio.wait_for` sınırı yok. | `[FAIL]` |
| Ön yüz istemci (`src/`) HTTP zaman aşımları | `src/engine/kagit25dPipeline.ts:64` vs `115, 143, 168, 386, 607` | Yalnızca `/health` ping'inde `2500ms` `AbortController` var; **5 POST çağrısının hiçbirinde timeout yok** — arka uç askıda kalırsa UI yükleme durumu sonsuza dek takılı kalır. | `[FAIL]` |
| HTTP 500 yanıtlarında yol/stderr/istisna sızıntısı ve yakalanmamış 500'ler | `app.py:92, 105, 128, 155, 178`, `mp4_transcoder.py:90` + `TestClient` | Bozuk videoda `C:\Users\salat\AppData\Local\Temp\kagit_mp4_...\input...` ve ham FFmpeg stderr istemciye sızıyor; TTS hatasında `str(exc)` sızıyor; yarım PNG 3 uçta ve `horizon_y=nan` `decompose-background`'da yakalanmamış `500` üretiyor. (`GEMINI_API_KEY` doğrudan dönmüyor, ancak ham SDK istisnası `TTS failed: {exc}` benzeri yolla sızma potansiyeli taşır.) | `[FAIL]` |
| Loglama ve hata gözlemlenebilirliği | `server/kagit_ai_pipeline/` (tüm `.py` dosyalarında `import logging` **0 adet**!) | Tüm proje boyunca sıfır `logging` kullanımı var; `director_llm.py:78`, `cinema_refiner.py:213`, `voice_tts.py:144, 230` ve `app.py:132` tüm istisnaları sessizce yutuyor (`except Exception: pass` / `return None`). Gemini anahtar hatası, kota aşımı veya geçersiz model adı operatör tarafından fark edilemez. | `[FAIL]` |

---

## 5. Önceliklendirilmiş İyileştirme Yol Haritası

### P0 — Acil (Üretime Alınmadan Önce Zorunlu)
1. **Auth + CORS + TrustedHost:** Varsayılan `KAGIT_ALLOWED_ORIGINS` değerini localhost ile sınırla; `Bearer` token zorunluluğu ve `TrustedHostMiddleware` ekle; `Dockerfile`'ı non-root `USER` ile güncelle ve `/docs`/`/openapi.json`'ı üretimde kapat.
2. **Event-Loop Kurtarma & Timeout:** 4 `async def` endpoint'teki senkron işleri `run_in_threadpool` ve `asyncio.create_subprocess_exec` üzerine taşı; tüm `genai.Client` örneklerine `HttpOptions(timeout=30_000)` ekle ve yaşam döngüsünü (`lifespan`) tek istemci olarak yönet; `edge-tts` çağrısını `asyncio.wait_for(..., timeout=15)` ile sınırla.
3. **Docker & Başlatıcı Onarımı:** `app.py:188` `parents[2]` `IndexError` hatasını düzelt; `start-kagit-studio.ps1:15`'i `pip install -r requirements.txt` yap.

### P1 — Yüksek (Güvenlik & Kararlılık)
4. **Bellek/VRAM/Disk Sınırları & Kuyruk:** ASGI gövde boyut middleware'i, `Image.MAX_IMAGE_PIXELS = 16_777_216`, `max(w, h) <= 4096` + `img.load()` + `math.isfinite` doğrulaması, `compute_depth_and_normal_maps`'te `max(w, h)` ölçeklemesi, Pydantic `max_length` limitleri ve `asyncio.Semaphore` eşzamanlılık kilidi ekle.
5. **FFmpeg Sertleştirme & Hata Temizliği:** WebM/MP4 magic-byte doğrulaması, `-protocol_whitelist file`, `-f`, `-t`, `-fs`, `-threads` ve çıkış çözünürlüğü üst sınırı ekle; HTTP 500 yanıtlarından yerel dosya yollarını ve ham `stderr`/`exc` metinlerini kaldır; yapılandırılmış `logging` ekle.

### P2 — Orta (Ürün Kalitesi & Kontrat Tutarlılığı)
6. **CPU/GPU Parite & Dürüst Telemetri:** `cinema_refiner.py` CPU yoluna 4 `look` profilini ekle ve `KAGIT_ENABLE_GPU_MODELS` bayrağını uygula; `decompose-character` / `decompose-background` gerçek motor etiketini (`local-cv`) raporlasın; ön yüz `kagit25dPipeline.ts` içine `AbortController` timeout'ları ekle, ölü endpoint'leri (`/api/v1/direct-film`, `/api/v1/refine-frame`) ya bağla ya da kaldır, `sourceEngine` ve `cinemaLook` enum'larını hizala.
7. **HTTP Entegrasyon Testleri:** `tests/test_pipeline.py`'yi `fastapi.testclient.TestClient` ile genişleterek auth, CORS, 413, yarım PNG (400), `NaN` (400/422), CPU look paritesi, FFmpeg eksikliği (503) ve Docker import smoke testini otomatikleştir.
