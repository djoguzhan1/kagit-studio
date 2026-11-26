# INKTROPE / Kâğıt Studio — Cloudflare Worker Auth, D1 İzolasyon & AI Bütçe Güvenlik Denetimi (Ajan 7)

- **Denetlenen Hedef:** `C:\Users\salat\Downloads\kagit-studio` | Canlı Pasif Gözlem: `https://inktrope.com`
- **Denetim Tarihi:** 24 Kasım 2026
- **Denetçi Rolü:** Cloudflare Worker Auth & D1 Güvenlik Mühendisi (Savunma Odaklı Kaynak Kod + Pasif Başlık Denetimi)
- **İncelenen Dosyalar (Tam Satır Okuması):**
  - `worker/index.js` (1–1321. satırlar, tamamı)
  - `worker/index.d.ts` (1–32. satırlar)
  - `migrations/0001_init.sql` (1–49. satırlar)
  - `migrations/0002_ai_budget_and_cache.sql` (1–30. satırlar)
  - `wrangler.jsonc` (1–33. satırlar)
  - `public/_headers` (1–16. satırlar), `public/_redirects` (1. satır), `public/sw.js` (1–73. satırlar), `index.html` (1–123. satırlar), `public/privacy/index.html` (1–122. satırlar), `public/terms/index.html` (1–101. satırlar), `vercel.json`
  - İstemci Auth/Sync/AI/Depolama Dosyaları: `src/engine/cloudSync.ts`, `src/engine/aiStudioClient.ts`, `src/engine/db.ts`, `src/engine/exportEngine.ts`, `src/engine/shareCodec.ts`, `src/engine/kagit25dPipeline.ts`, `src/components/account/AccountModal.tsx`, `src/components/account/AccountButton.tsx`, `src/components/rig/CharacterMasterModal.tsx`, `src/components/film/FilmDirectorStudio.tsx`, `src/store/useStudioStore.ts`, `src/engine/__tests__/cloudAccountIsolation.test.ts`, `src/engine/__tests__/v4MultiActorAndAiBudget.test.ts`
- **Canlı Sistem Kısıtı:** `https://inktrope.com` üzerinde **hiçbir** saldırı, fuzzing, brute-force, durum değiştiren istek veya yük testi yapılmamıştır; yalnızca pasif, salt-okunur HTTP başlık gözlemi (`curl.exe -sI` / `curl.exe -sD -`) gerçekleştirilmiştir.

---

## 1. Yönetici Özeti & Dürüst Güvenlik Puanı

### Dürüst Puan: **`4.5 / 10`**

**Puan Gerekçesi (Neden 7–8 Değil, Neden 2 Değil?):**

Projenin **temel veri erişim ve kriptografik iskeleti** özenle kurgulanmıştır: `worker/index.js` içindeki 27 SQL sorgusunun tamamı parametrelidir (sıfır SQL Injection), bulut proje ve blob uçlarının tamamında oturumdan gelen `user_id` ile bileşik birincil anahtar izolasyonu sağlanmıştır (sıfır doğrudan yatay IDOR), oturum belirteçleri 256-bit CSPRNG entropi ile üretilip D1'de yalnızca SHA-256 özeti saklanmaktadır, OAuth akışında S256 PKCE ve zaman-sabitli `state` kontrolü mevcuttur, CORS varsayılan olarak kapalıdır ve React ön yüzünde `dangerouslySetInnerHTML`/`innerHTML`/`eval` bulunmamaktadır.

Ancak **üretim güvenliği açısından kritik ve doğrudan istismar edilebilir 5 ağır zafiyet** bu sağlam temeli ciddi biçimde zayıflatmaktadır:

1. **"$19.00 Hard Budget Circuit Breaker" fiilen delinmektedir:** 5–15 saniyelik `env.AI.run()` çağrıları öncesinde atomik bütçe rezervasyonu yapılmadığı için geniş bir TOCTOU yarış penceresi mevcuttur; başarısız/ayrıştırılamayan AI çağrıları deftere (`ai_usage_ledger`) hiç yazılmaz; Llama 3.3 70B çağrıları sabit `32` Neuron varsayılırken `max_tokens: 1400` ile gerçek maliyet **~305 Neuron'a (~9.5×)** çıkabilmektedir; FLUX.2 Klein 9B girdi görseli megapiksel boyutu kontrol edilmez; ve hız sınırsız/doğrulamasız kayıt ile tek IP sınırsız yeni `u:usr_*` kimliği oluşturarak günlük kotayı aşabilir.
2. **Ön-Hesap Ele Geçirme (Pre-Account Takeover):** E-posta doğrulaması olmadan kayıt açılabilmesi ve Google OAuth callback'inin eşleşen e-postadaki mevcut hesaba `google_sub` bağlarken **saldırganın belirlediği `password_hash`'i silmemesi ve mevcut oturumları iptal etmemesi**, henüz üye olmamış Google kullanıcılarının bulut kasalarının sessizce ele geçirilmesine yol açar.
3. **Aynı-Origin Stored XSS (`/api/cloud/blobs/:key`):** İstemcinin gönderdiği `Content-Type` başlığı (`text/html`, `image/svg+xml`, `text/javascript`) doğrulamasız saklanıp aynı origin (`https://inktrope.com`) altında `Content-Disposition: attachment` ve `CSP: sandbox` olmadan servis edilmektedir. `.kagit.zip` içe aktarma (`src/engine/exportEngine.ts:680-681`) ve Ön-Hesap Ele Geçirme zinciriyle birlikte kurbanın oturumunda tam XSS'e dönüşebilir.
4. **Canlı `https://inktrope.com` Sıfır HTTP Güvenlik Başlığıyla Yayındadır:** Pasif `curl.exe` gözlemi, `public/_headers` dosyasında tanımlanan CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` ve `Permissions-Policy` başlıklarının **hiçbirinin** canlı üretim yanıtlarında (`/`, `/privacy/`, `/sw.js`, `/assets/*`, `/api/*`) gönderilmediğini kanıtlamıştır.
5. **Kimlik Doğrulamada Sıfır Rate-Limit / Brute-Force Koruması ve 4 GB/Hesap D1 Depolama Amplifikasyonu:** Sınırsız giriş denemesi, kesin hesap sayımı (enumeration), doğrulamasız kayıt başına 1.000 × 4 MB = 4 GB ham (~5.33 GB base64) D1 tüketimi ve `Content-Length` olmayan chunked gövdelerin kontrol öncesi Worker RAM'ine tamamen alınması ciddi erişilebilirlik (DoS) ve hesap güvenliği riski oluşturmaktadır.

### Özet Durum Dağılımı

| Denetim Alanı | `[PASS]` | `[FAIL]` | `[TEST EDİLMEDİ]` | Genel Durum |
| :--- | :---: | :---: | :---: | :---: |
| 1. Google OAuth PKCE / CSRF | 4 | 4 | 0 | **YÜKSEK RİSK** |
| 2. PBKDF2 Parola Güvenliği | 2 | 5 | 0 | **YÜKSEK RİSK** |
| 3. Cookie Bayrakları & Oturum Yaşam Döngüsü | 4 | 4 | 0 | **ORTA-YÜKSEK RİSK** |
| 4. Per-User D1 İzolasyonu (IDOR & SQLi) | 6 | 3 | 0 | **İYİ / KOTA YARIŞI MEVCUT** |
| 5. Chunked Blob Sınırları | 3 | 5 | 0 | **KRİTİK/YÜKSEK RİSK** |
| 6. Workers AI Bütçe & Rate-Limit Tasarımı | 2 | 7 | 0 | **KRİTİK RİSK** |
| 7. XSS / CORS / CSP & HTTP Güvenlik Başlıkları | 3 | 5 | 0 | **KRİTİK/YÜKSEK RİSK** |
| **TOPLAM** | **24** | **33** | **0** | **`4.5 / 10`** |

---

## 2. EN AĞIR 5 SORUN (Öncelik Sıralı)

---

### SORUN #1 — Workers AI `$19.00` Sert Bütçe Devre Kesicisinin Çok Katmanlı Atlatılması (TOCTOU, Eksik Neuron Tahmini, Faturalanmayan Hata Yolları & Sybil Kayıt)

- **Ciddiyet / Tahmini CVSS v3.1:** **KRİTİK — 8.6** (`AV:N/AC:L/PR:N/UI:N/S:C/C:N/I:L/A:H` — doğrudan finansal zarar + tüm kullanıcılar için AI servis kesintisi)
- **Kod Kanıtı (`dosya:satır`):**
  - `worker/index.js:741-742` (`AI_NEURONS_DIRECTOR_EST = 32`, `AI_NEURONS_SIDE_GUIDE_EST = 1410`)
  - `worker/index.js:774-789` (`resolveAiActorIdentity` — oturum açan kullanıcılar için IP bağımsız `u:${sess.user.id}`)
  - `worker/index.js:791-863` (`checkAiBudgetAndQuota` ve `recordAiLedger` ayrı okuma/yazma; `802-804` fail-open)
  - `worker/index.js:1058-1113` (`direct-film`: `1058` kontrol → `1073` AI çağrısı → `1100-1102` erken çıkış → `1104` kayıt)
  - `worker/index.js:1219-1273` (`side-guide`: `1219` kontrol → `1238` AI çağrısı → `1260-1262` erken çıkış → `1264` kayıt)
  - `worker/index.js:273-320` (hız sınırsız ve doğrulamasız `POST /api/auth/register`)
  - `migrations/0002_ai_budget_and_cache.sql:4-18` (`ai_usage_ledger` atomik rezervasyon / sayaç tablosu yok)

- **Kök Neden:**
  1. **Geniş TOCTOU Yarış Penceresi (5–15 saniye):** Hem `direct-film` hem `side-guide` önce `checkAiBudgetAndQuota()` ile D1'den okuma yapmakta, ardından 3–15 saniye süren `env.AI.run()` çağrısını beklemekte ve ancak yanıt döndükten sonra `recordAiLedger()` ile satır eklemektedir. Aynı anda gelen paralel isteklerin tamamı `used = 0` ve `monthUsd = 0` görerek izni alır; dahası her biri kontrol anında hesaplanan **bayat** `guard.billableUsd` (ör. `$0.00`) değerini `ai_usage_ledger`'a yazar (`worker/index.js:1112, 1272`).
  2. **Başarısız/Ayrıştırılamayan Çağrılar Sıfır Maliyetle Geçer:** `worker/index.js:1100-1102` (`direct-film`) ve `1260-1262` (`side-guide`) satırlarında `env.AI.run()` çalışıp Cloudflare hesabına Neuron yazdırdıktan sonra JSON ayrıştırma hatası (`parse_error`) veya boş görsel (`empty_image`) oluşursa `recordAiLedger()` çağrılmadan `502` dönülür. Sistem istemine enjekte edilen metinlerle (`worker/index.js:995-997, 1003-1019`) modelin geçersiz JSON üretmesi tetiklenerek sınırsız ücretsiz AI tüketimi yapılabilir.
  3. **Gerçek Maliyetle 9.5× Uyumsuz Sabit Neuron Tahmini:**
     - `@cf/meta/llama-3.3-70b-instruct-fp8-fast` resmi Cloudflare fiyatı: girdi `26,668 Neuron / 1M token`, çıktı `204,805 Neuron / 1M token`. `worker/index.js:1079` `max_tokens: 1400` izni verirken `741. satır` her çağrıyı sabit `32` Neuron saymaktadır. ~700 girdi + 1.400 çıktı tokenlı bir çağrı **~305 Neuron (~9.5×)** harcar; D1 `$19.00` gösterdiğinde gerçek fatura ~$150–$180 bandına ulaşabilir.
     - `@cf/black-forest-labs/flux-2-klein-9b` resmi fiyatı: ilk 1MP çıktı `1,363.64 Neuron` **+ her girdi görseli MP başına `181.82 Neuron`**. Normal 448×448 girdi bile 1 MP yuvarlamasıyla `~1,545 Neuron` (> `1410`) tutarken, `parseDataUrlBytes` (`worker/index.js:865-875`) yalnızca base64 bayt uzunluğunu (`<= 720_000`) denetler, piksel çözünürlüğünü (ör. yüksek sıkıştırılmış 4096×4096 PNG = 16 MP → `~4,273 Neuron`, ~3× sapma) doğrulamaz.
  4. **Sybil Çoklu Hesap Atlatması:** `resolveAiActorIdentity` (`worker/index.js:776-779`) oturumlu kullanıcılarda IP'yi dikkate almaz; doğrulamasız `POST /api/auth/register` ile sınırsız hesap açılarak her hesapta günlük 8 `side-guide` + 80 `direct-film` kotası elde edilir.
  5. **Fail-Open Davranış:** `worker/index.js:802-804` `if (!env.DB) return { allowed: true, ... }` diyerek veritabanı bağlamı eksikliğinde bütçe korumasını açık bırakır.

- **Etki:** `$19.00/ay` sert tavan garantisi fiilen geçersizdir; saldırganlar Cloudflare Workers AI faturasını yüzlerce dolara çıkarabilir, meşru kullanıcılar için AI özelliklerini ay boyunca kapatabilir (budget-exhaustion DoS) veya `ai_turnaround_cache` tablosunu sınırsız doldurabilir.

- **Somut Savunma Düzeltmesi:**
  1. **Atomik Ön-Rezervasyon (Durable Object veya Atomik D1 Koşullu `UPDATE`):** En güvenilir çözüm, aylık/günlük bütçe ve aktör kotası için tekil bir **Cloudflare Durable Object** (veya D1'de `ai_budget_counters(scope_key PRIMARY KEY, used_neurons, used_usd)` tablosu üzerinde `UPDATE ... SET used_usd = used_usd + ? WHERE scope_key = ? AND used_usd + ? <= ?` şeklinde atomik koşullu güncelleme + `meta.changes === 1` kontrolü) ile **`env.AI.run()` çağrısından ÖNCE** en kötü durum maliyetini (`worstCaseNeurons`) rezerve etmektir.
  2. **Hata Yollarında da Faturalandırma + Gerçek Kullanıma Göre Düzeltme:** `env.AI.run()` çağrısı başlatıldığı anda rezervasyon tüketilmiş sayılmalı; yalnızca Cloudflare tarafında hiç çalışmayan ön-hata durumlarında iade edilmelidir. Llama 3.3 için `aiResp.usage` (`prompt_tokens`/`completion_tokens`) varsa gerçek Neuron hesaplanıp rezervasyon farkı düzeltilmeli; yoksa en kötü durum (`~310` Neuron) düşülmelidir.
  3. **Çift Katmanlı Aktör Kotası & Turnstile:** Oturumlu kullanıcılar için hem `u:<uid>` hem de IP `/24` (IPv4) / `/64` (IPv6) kotası birlikte zorlanmalı; misafir AI çağrıları ve yeni kayıtlar Cloudflare Turnstile ile korunmalıdır.
  4. **Fail-Closed & Görsel Boyut Doğrulaması:** `!env.DB` durumunda `{ allowed: false, reason: 'db_unavailable' }` dönülmeli; `parseDataUrlBytes` PNG/JPEG sihirli baytlarını ve IHDR/SOF piksel genişlik/yüksekliğini (`<= 512×512`) doğrulamalı; `byokFullTurnaround` bayrağı BYOK anahtarı yokken `cacheKey`'e katılmamalıdır.

---

### SORUN #2 — Doğrulanmamış E-posta Kaydı + Google OAuth Sessiz Hesap Birleştirme ile Ön-Hesap Ele Geçirme (Pre-Account Takeover)

- **Ciddiyet / Tahmini CVSS v3.1:** **YÜKSEK — 8.1** (`AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H`)
- **Kod Kanıtı (`dosya:satır`):**
  - `worker/index.js:273-320` (`POST /api/auth/register` — e-posta doğrulaması yok, anında aktif hesap ve 30 günlük oturum)
  - `worker/index.js:481-492` (`GET /api/auth/google/callback` — `email` eşleşmesiyle sessiz `UPDATE users SET google_sub = ?`)
  - `migrations/0001_init.sql:4-13` (`users` tablosunda `email_verified` kolonu yok)

- **Kök Neden:**
  - `POST /api/auth/register` (`worker/index.js:288-303`) e-posta adresinin kayıt olan kişiye ait olduğunu doğrulamadan `users` tablosuna kayıt ekler, saldırganın seçtiği `password_hash` değerini kaydeder ve 30 günlük oturum açar.
  - Hedef kullanıcı daha sonra **Google ile Devam Et** akışıyla giriş yaptığında `worker/index.js:482-491`:
    ```js
    const byEmail = await env.DB.prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`)
      .bind(email).first();
    if (byEmail) {
      await env.DB.prepare(
        `UPDATE users SET google_sub = ?, avatar_url = COALESCE(avatar_url, ?), updated_at = ? WHERE id = ?`
      ).bind(googleSub, avatarUrl, now, byEmail.id).run();
      userRow = byEmail;
    }
    ```
    sorgusuyla Google kimliğini (`google_sub`) saldırganın oluşturduğu hesaba sessizce bağlar. Bu işlem sırasında:
    1. `password_hash` **sıfırlanmaz (`NULL` yapılmaz)**,
    2. O hesaba ait mevcut tüm `sessions` kayıtları **iptal edilmez**,
    3. `WHERE id = ? AND google_sub IS NULL` koşulu olmadığı için halihazırda başka bir `google_sub` bağlıysa bile üzerine yazılabilir.

- **Etki:** Saldırgan, henüz INKTROPE'a kaydolmamış bir kurbanın e-postasını önceden kaydeder. Kurban ileride Google ile giriş yaptığında saldırganın kurduğu hesabın içine düşer ve tüm özel çizimlerini/projelerini bu bulut kasasına senkronize eder. Saldırgan ise hem önceden aldığı 30 günlük oturum çereziyle hem de değişmeyen e-posta+şifresiyle kurbanın tüm bulut verilerini gizlice okuyabilir, değiştirebilir, silebilir veya Sorun #3 ile birleştirerek kurbanın tarayıcısında aynı-origin XSS çalıştırabilir.

- **Somut Savunma Düzeltmesi:**
  1. `users` tablosuna `email_verified INTEGER NOT NULL DEFAULT 0` kolonu ekleyin.
  2. Google OAuth callback'inde `byEmail` bulunduğunda:
     - Mevcut kayıtta `google_sub IS NOT NULL` ve farklıysa birleştirmeyi **reddedin** (hata dönün).
     - Mevcut kayıtta `email_verified = 0` ise, otomatik şifre koruyarak birleştirmek yerine: ya (a) doğrulanmamış yerel kaydın `password_hash = NULL`, `email_verified = 1`, `google_sub = ?` olarak güncellenip `DELETE FROM sessions WHERE user_id = ?` ile **tüm eski oturumların atomik olarak silinmesini** (ve ideal olarak önceki sahipsiz verilerin temizlenmesini / kullanıcıya açık uyarı verilmesini) sağlayın; ya da (b) e-posta/şifre kaydında doğrulama bağlantısı (OTP/token) tamamlanmadan bulut hesabını etkinleştirmeyin.
  3. `worker/index.js:468` satırında `Boolean(info?.email_verified)` yerine katı `info?.email_verified === true` kontrolü uygulayın.

---

### SORUN #3 — `/api/cloud/blobs/:key` Üzerinde İzin Listesiz `Content-Type` ile Aynı-Origin Stored XSS (`text/html` / `image/svg+xml`)

- **Ciddiyet / Tahmini CVSS v3.1:** **YÜKSEK — 8.0** (`AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:H/A:N` — `.kagit.zip` içe aktarma veya Sorun #2 ile zincirlendiğinde tam aynı-origin XSS)
- **Kod Kanıtı (`dosya:satır`):**
  - `worker/index.js:651` (`PUT /api/cloud/blobs/:key` — istemciden gelen `Content-Type` doğrudan kabul edilip D1'e yazılıyor)
  - `worker/index.js:687-704` (`GET /api/cloud/blobs/:key` — kaydedilen `mime_type` doğrudan yanıtın `Content-Type` başlığı olarak dönülüyor; `Content-Disposition` ve `Content-Security-Policy` yok)
  - `src/engine/exportEngine.ts:680-681` (`.kagit.zip` içindeki `manifest.json -> mimeMap` değeri doğrulanmadan `Blob` tipi atanıyor)
  - `src/engine/cloudSync.ts:291-297` (`blob.type` değeri doğrudan `PUT /api/cloud/blobs/:key` isteğinin `Content-Type` başlığına konuyor)

- **Kök Neden:**
  - `worker/index.js:651`:
    ```js
    const mimeType = (request.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().slice(0, 80);
    ```
    hiçbir MIME izin listesi (allowlist) uygulamadan `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/javascript` gibi tarayıcıda betik çalıştırabilen içerik türlerini kabul eder.
  - `worker/index.js:697-704`:
    ```js
    return new Response(out, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
    ```
    yanıtında `Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox` ve `X-Frame-Options: DENY` bulunmaz (üstelik Worker yanıtlarına `public/_headers` uygulanmaz).
  - İstemci tarafında `src/engine/exportEngine.ts:680-681` paylaşılan bir `.kagit.zip` yedeğinin içindeki `manifest.json` dosyasındaki `mimeMap` alanına körü körüne güvenir; oturumlu bir kullanıcı başkası tarafından paylaşılan bir `.kagit.zip` dosyasını içe aktardığında bu `text/html` / `image/svg+xml` blob'u `cloudSync.ts:295` üzerinden otomatik olarak buluta yüklenir.

- **Etki:** Oturum çerezi `inktrope_sid` `SameSite=Lax` olduğundan, kurban harici bir sayfadan `https://inktrope.com/api/cloud/blobs/<key>` bağlantısına tıklandığında çerez gönderilir ve tarayıcı blob içeriğini **`https://inktrope.com` origin'inde HTML/SVG olarak çalıştırır**. Çalışan betik:
  - Aynı origin olduğu için `verifySameOrigin` korumasını tamamen atlayarak `/api/cloud/*` ve `DELETE /api/auth/account` dahil tüm API uçlarını çağırabilir,
  - `sessionStorage` içindeki kullanıcının kişisel BYOK Gemini API anahtarını (`inktrope:byok-gemini-key`, `src/engine/aiStudioClient.ts:15`) ve IndexedDB'deki tüm çizim/projeleri okuyabilir.

- **Somut Savunma Düzeltmesi:**
  1. `PUT /api/cloud/blobs/:key` ucunda katı bir MIME izin listesi zorlayın (ve mümkünse ilk 12 bayt üzerinden magic-byte doğrulaması yapın):
     ```js
     const ALLOWED_BLOB_MIMES = new Set([
       'image/png', 'image/jpeg', 'image/webp', 'image/gif',
       'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav',
       'application/octet-stream',
     ]);
     const rawMime = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
     const mimeType = ALLOWED_BLOB_MIMES.has(rawMime) ? rawMime : 'application/octet-stream';
     ```
     (`text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/javascript` kesinlikle yasaklanmalıdır!)
  2. `GET /api/cloud/blobs/:key` yanıtında **mutlaka** şu başlıkları ekleyin:
     - `Content-Type: ${ALLOWED_BLOB_MIMES.has(mimeType) ? mimeType : 'application/octet-stream'}`
     - `Content-Disposition: attachment`
     - `Content-Security-Policy: default-src 'none'; sandbox`
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: DENY`
     (Not: `cloudSync.ts:268-274` bu ucu yalnızca `fetch().then(r => r.blob())` ile okuduğu için `Content-Disposition: attachment` ve `CSP: sandbox` uygulamayı hiç bozmaz!)
  3. İstemci tarafında `src/engine/exportEngine.ts:680` içinde de `parsed.mimeMap?.[oldKey]` aynı güvenli MIME izin listesiyle filtrelenmelidir.

---

### SORUN #4 — Canlı `https://inktrope.com` Üzerinde Tüm HTTP Güvenlik Başlıklarının (CSP, HSTS, XFO, nosniff) Yokluğu + Zayıf CSP Tanımı

- **Ciddiyet / Tahmini CVSS v3.1:** **YÜKSEK — 7.5** (`AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:L/A:N` — Clickjacking, SSL-stripping / HSTS yokluğu, CSP korumasızlığı)
- **Kod & Canlı Pasif Gözlem Kanıtı (`dosya:satır` + `curl.exe` çıktısı):**
  - `public/_headers:1-16` (6 güvenlik başlığı + 3 önbellek kuralı tanımlı)
  - `public/_redirects:1` (`/* /index.html 200` — Workers Static Assets'te desteklenmeyen 200 rewrite)
  - `wrangler.jsonc:6-12` (`assets.directory: "./dist"`, `run_worker_first: ["/api/*"]`)
  - `worker/index.js:24-45, 697-704, 1299-1312` (`json()` yalnızca `nosniff`, `redirect()` hiçbir güvenlik başlığı eklemiyor)
  - **Canlı Pasif Gözlem (`24.11.2026 10:57–11:00 UTC`):**
    - `GET https://inktrope.com/` → `Content-Type: text/html`, `Cache-Control: public, max-age=0, must-revalidate`, **CSP YOK, HSTS YOK, X-Frame-Options YOK, X-Content-Type-Options YOK, Referrer-Policy YOK, Permissions-Policy YOK.**
    - `GET https://inktrope.com/privacy/` → Aynı şekilde **6 güvenlik başlığının tamamı YOK.**
    - `GET https://inktrope.com/sw.js` & `HEAD https://inktrope.com/assets/index-B42hRhax.css` → **6 güvenlik başlığının tamamı YOK** ve `public/_headers:12-16` özel `Cache-Control` kuralları da uygulanmıyor (`public, max-age=0, must-revalidate` dönüyor).
    - `GET https://inktrope.com/api/auth/me` & `GET /api/ai/status` → Yalnızca `Cache-Control: no-store` ve `X-Content-Type-Options: nosniff`; **HSTS, CSP, XFO, Referrer-Policy YOK.**
    - `GET https://inktrope.com/api/auth/google/start` → Yalnızca `Location`, `Cache-Control: no-store`, `Set-Cookie`; **`nosniff`, HSTS, Referrer-Policy YOK.**

- **Kök Neden:**
  1. **Worker Yanıtlarında Mimari Boşluk:** Cloudflare Workers Static Assets dokümantasyonuna göre `_headers` dosyası Worker kodunun ürettiği yanıtlara (`/api/*`) **hiçbir zaman uygulanmaz**. `worker/index.js` ise yanıt sarmalayıcısında HSTS, CSP, `X-Frame-Options`, `Referrer-Policy` ve `Permissions-Policy` başlıklarını eklememektedir.
  2. **Canlı Statik Varlıklarda `_headers` Devre Dışı:** `dist/_headers` yerel derlemede mevcut olmasına rağmen canlı dağıtımda hiçbir kuralın (`/assets/*` `immutable` dahil!) etkinleşmediği deneysel olarak görülmüştür. Bu durum canlı dağıtımın `_headers` ayrıştırması olmadan yapıldığını (eski Wrangler/API yüklemesi veya dağıtım/yapılandırma uyumsuzluğu) ve `public/_redirects:1` içindeki geçersiz `200` rewrite kuralıyla birlikte yalnızca Cloudflare varsayılan başlıklarının servis edildiğini göstermektedir.
  3. **Zayıf CSP Tanımı (`public/_headers:7`):** Dosya devreye alınsa bile `script-src 'self' 'unsafe-inline' blob:` direktifi yer almaktadır. `index.html:43-121`, `public/privacy/index.html` ve `public/terms/index.html` içinde yürütülebilir inline `<script>` **bulunmamaktadır** (`application/ld+json` yürütülebilir betik değildir); dolayısıyla `'unsafe-inline'` ve `blob:` gereksiz biçimde CSP'nin XSS korumasını etkisizleştirmektedir. Ayrıca `object-src 'none'` direktifi eksiktir.

- **Etki:**
  - `X-Frame-Options` ve `frame-ancestors 'none'` olmadığı için `https://inktrope.com` herhangi bir saldırgan sitesi içinde `<iframe>` ile gömülerek **Clickjacking** saldırılarına (ör. "Hesabı Kalıcı Sil" veya "Google ile Giriş" butonlarının gizli tıklatılması) açıktır.
  - `Strict-Transport-Security` (HSTS) olmadığı için ilk HTTP bağlantısında SSL-stripping / MitM riski devam eder (`http://inktrope.com` → `301 https://inktrope.com/` yönlendirmesi HSTS olmadan tek başına koruyucu değildir).
  - CSP olmadan herhangi bir XSS vektörü (ör. Sorun #3) tarayıcı katmanında engellenemez.

- **Somut Savunma Düzeltmesi:**
  1. `worker/index.js` içinde tüm yanıtları sarmalayan tek bir `withSecurityHeaders(response, isHtml)` yardımcı fonksiyonu ekleyin ve tüm `/api/*` yanıtlarına `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` ve API için `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` ekleyin.
  2. Statik HTML/varlıklar için: (a) güncel Wrangler (`>= 4.x`) ile `wrangler deploy` ederek `dist/_headers` dosyasının canlıda gerçekten aktif olduğunu `curl -sI https://inktrope.com/` ile doğrulayın **ve/veya** Cloudflare Dashboard → Rules → **Response Header Transform Rules** ile Zone seviyesinde garanti altına alın; (b) gereksiz ve geçersiz `public/_redirects` dosyasını kaldırın (`wrangler.jsonc:10` `not_found_handling: "single-page-application"` zaten SPA yönlendirmesini yapar).
  3. `public/_headers:7` CSP'sini sertleştirin: `script-src 'self'` (`'unsafe-inline'` ve `blob:` kaldırılarak) ve `object-src 'none'` ekleyin; `vercel.json:14` ile senkronize edin (veya kullanılmıyorsa `vercel.json`'ı kaldırın).

---

### SORUN #5 — Auth Uçlarında Sıfır Rate-Limit / Brute-Force Koruması, Sınırsız Kayıt ile D1 Depolama Tükenmesi (4 GB/Hesap), Hesap Sayımı ve Chunked Bellek DoS'u

- **Ciddiyet / Tahmini CVSS v3.1:** **YÜKSEK — 7.5** (`AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:H`)
- **Kod Kanıtı (`dosya:satır`):**
  - `worker/index.js:273-357` (`POST /api/auth/register` ve `POST /api/auth/login` — sıfır hız sınırı, sıfır lockout, sıfır CAPTCHA/Turnstile)
  - `worker/index.js:289-291, 340-353` (kesin e-posta sayımı: `409` zaten kayıtlı, `"Bu hesap Google ile açılmış"` ve PBKDF2 zamanlama farkı)
  - `worker/index.js:15, 18, 635-668` (`MAX_BLOB_BYTES = 4 MB`, `MAX_BLOBS_PER_USER = 1000` → toplam byte kotası yok: hesap başına **4 GB ham / ~5.33 GB base64 D1**)
  - `worker/index.js:239-243, 624-633` (`readBoundedJson` ve `PUT /api/cloud/blobs/:key` — `Content-Length` yokken tüm gövdeyi `request.text()` / `request.arrayBuffer()` ile önce RAM'e okur)

- **Kök Neden:**
  1. **Sıfır Auth Hız Sınırı:** `verifySameOrigin` yalnızca tarayıcı kaynaklı CSRF'yi engeller; `curl`/betik istemcileri `Origin: https://inktrope.com` başlığını kolayca ekleyerek saniyede yüzlerce `login` (şifre kaba kuvvet / credential stuffing) veya `register` (kitlesel sahte hesap oluşturma) isteği gönderebilir.
  2. **Toplam Depolama Kotası Eksikliği (D1 Disk Tükenmesi):** `MAX_BLOBS_PER_USER = 1000` ve `MAX_BLOB_BYTES = 4 MB` sınırı var, ancak kullanıcı başına **toplam bayt kotası** (ör. 50–100 MB) yok! Base64 şişmesiyle (`×1.333`) tek bir ücretsiz ve doğrulamasız hesap D1'de **5.33 GB** yer kaplayabilir. Cloudflare D1 ücretsiz/başlangıç 5–10 GB veritabanı limiti yalnızca 2 sahte hesapla tamamen doldurulabilir.
  3. **Gövde Boyutu Kontrolünde RAM Tamponlama (Chunked OOM DoS):** `readBoundedJson` (`worker/index.js:240-243`) ve `PUT /api/cloud/blobs/:key` (`worker/index.js:624-631`) `Content-Length` başlığı yoksa (`Transfer-Encoding: chunked`) `len === 0` kabul edip `await request.text()` / `await request.arrayBuffer()` çağırır. Cloudflare 100 MB'a kadar istek gövdesini Worker'a iletebilirken Worker izolatı 128 MB RAM limitine sahiptir; birkaç eşzamanlı büyük chunked istek Worker OOM çökmesine yol açabilir.
  4. **Eksik Login Parola Üst Sınırı & Zayıf Parola Politikası:** `register` 8–128 karakter sınırlar (`284. satır`), fakat `login` (`329. satır`) üst sınır uygulamaz (4 KB'a kadar parolayı 100k PBKDF2'ye sokar) ve `"12345678"` gibi çok zayıf parolalar engellenmez.

- **Etki:** Parola kaba kuvvet / credential stuffing ile kullanıcı hesaplarının kırılması, tüm kayıtlı e-postaların tespiti (enumeration), birkaç sahte hesapla D1 veritabanının tamamen doldurularak tüm kullanıcıların bulut kaydının durdurulması ve büyük chunked isteklerle Worker bellek tükenmesi.

- **Somut Savunma Düzeltmesi:**
  1. **Cloudflare Rate Limiting / WAF Kuralları + Turnstile:** `/api/auth/login` ve `/api/auth/register` için IP başına sıkı Cloudflare Rate Limiting (ör. 10 istek/dk) + D1/KV tabanlı hesap bazlı başarısız giriş sayacı (üstel bekleme/lockout) + `register` üzerinde Cloudflare Turnstile zorunlu kılın.
  2. **Toplam Kullanıcı Bayt Kotası:** `PUT /api/cloud/blobs/:key` içinde kullanıcı başına `SUM(byte_size)` (ör. **100 MB** tavan, `WHERE user_id = ? AND chunk_index = 0`) kontrolü ekleyin; mümkünse büyük binary varlıkları D1 yerine **Cloudflare R2**'ye taşıyın.
  3. **Akışlı (Streaming) Gövde Okuyucu:** `request.text()` / `request.arrayBuffer()` yerine `request.body.getReader()` ile okunan baytları sayıp `maxBytes` aşıldığı anda `reader.cancel()` ile `413` döndürün.
  4. **Hesap Sayımını ve Zamanlama Farkını Azaltın:** `login` hata mesajlarını tek tip yapın, kullanıcı bulunamadığında dahi sabit bir dummy tuz ile 100.000 iterasyon PBKDF2 çalıştırarak zamanlama kanalını kapatın ve `login` tarafında da `password.length > 128` kontrolü ekleyin.

---

## 3. Detaylı Güvenlik Denetim Matrisi (7 Zorunlu Alan)

### Alan 1: Google OAuth PKCE / CSRF (`worker/index.js:388-518`)

| # | Denetim Maddesi | Durum | Kanıt (`dosya:satır`) & Teknik Değerlendirme |
| :-: | :--- | :---: | :--- |
| 1.1 | PKCE (`code_verifier` & `code_challenge` S256) | `[PASS]` | `worker/index.js:394-395, 404-405, 443`. 32 bayt CSPRNG `verifier` (43 karakter base64url, RFC 7636 uyumlu), `S256` challenge üretiliyor ve token takasında `code_verifier` gönderiliyor. Canlı `/api/auth/google/start` yanıtında `code_challenge_method=S256` doğrulandı. |
| 1.2 | `state` üretimi, saklanması ve zaman-sabitli doğrulanması | `[PASS]` | `worker/index.js:393, 408, 422-432`. 24 bayt (192-bit) CSPRNG `state`, `HttpOnly; SameSite=Lax; Secure` çerezde saklanıyor, `timingSafeStringEqual` ile karşılaştırılıyor ve hem hata hem başarıda `Max-Age=0` ile temizleniyor (`414, 515`). |
| 1.3 | OAuth çerezi bütünlüğü / `__Host-` öneki (Subdomain Cookie Tossing / Login CSRF) | `[FAIL]` | `worker/index.js:10, 148-159, 408`. Çerez adı `inktrope_oauth` (`__Host-` öneki yok) ve HMAC imzası yok. `parseCookies` (`151-157`) aynı isimde birden fazla çerez varsa sonuncuyu (`map[k] = v`) kazanır kılar. Ele geçirilmiş bir alt alan adı (`*.inktrope.com`) `Domain=.inktrope.com` ile `inktrope_oauth` enjekte ederek Login CSRF yapabilir. |
| 1.4 | OIDC `nonce` ve `id_token` imza/claim (`iss`, `aud`, `exp`) doğrulaması | `[FAIL]` | `worker/index.js:398-406, 453-465`. `scope=openid email profile` istenmesine rağmen `nonce` parametresi üretilmiyor/gönderilmiyor ve `tokenData.id_token` doğrulanmadan yoksayılıyor (yalnızca `/v1/userinfo` çağrısı yapılıyor). OIDC Core 1.0 en iyi uygulamasına aykırı. |
| 1.5 | `email_verified` kontrolü | `[PASS]` | `worker/index.js:468, 472-474`. Google `userinfo` yanıtında `email_verified` kontrol ediliyor ve doğrulanmamışsa reddediliyor. *(Not: `468. satır` `Boolean(info?.email_verified)` yerine katı `info?.email_verified === true` kullanmalıdır.)* |
| 1.6 | Otomatik hesap birleştirme & Ön-Hesap Ele Geçirme (Account Takeover) | `[FAIL]` | `worker/index.js:273-320, 481-492`. E-posta doğrulaması olmayan yerel kayıt ile Google OAuth sessizce birleştiriliyor; birleştirmede `password_hash` temizlenmiyor, eski `sessions` iptal edilmiyor ve `AND google_sub IS NULL` kontrolü yapılmıyor (**Bkz. Sorun #2**). |
| 1.7 | `redirect_uri` & Open Redirect koruması | `[PASS]` | `worker/index.js:396, 441, 512`. Kullanıcı kontrolünde `next`/`returnTo` parametresi yok; yönlendirme sabit `${url.origin}/?auth=ok`. Google tarafı kayıtlı `redirect_uri` izin listesiyle kısıtlı. *(Savunma derinliği: dinamik `url.origin` yerine sabit `env.PUBLIC_ORIGIN` kullanılması ve `wrangler.jsonc`'de `workers_dev: false` eklenmesi önerilir.)* |
| 1.8 | Session fixation & eski oturum temizliği | `[FAIL]` | `worker/index.js:218-237, 510-517`. Giriş sonrası yeni rastgele token üretilip çerez üzerine yazılması klasik token-tekrarı fixation'ını engeller; **ancak** istekte halihazırda mevcut bir `inktrope_sid` çerezi varsa önceki D1 `sessions` kaydı iptal edilmeden 30 gün boyunca canlı bırakılır (`303, 355, 510`). |

---

### Alan 2: PBKDF2 Parola Güvenliği (`worker/index.js:13, 104-146, 273-357`)

| # | Denetim Maddesi | Durum | Kanıt (`dosya:satır`) & Teknik Değerlendirme |
| :-: | :--- | :---: | :--- |
| 2.1 | PBKDF2 iterasyon sayısı (OWASP vs Cloudflare Workers sınırı) | `[FAIL]` | `worker/index.js:13, 123, 137`. `PBKDF2_ITERS = 100_000` (PBKDF2-HMAC-SHA256, 256-bit). Cloudflare Workers `workerd` çalışma zamanı Web Crypto PBKDF2'yi 100.000 iterasyonla sınırlar (>100k `NotSupportedError` fırlatır); ancak bu değer OWASP 2023+ PBKDF2-SHA256 önerisinin (**600.000**) 6 kat altındadır ve sunucu tarafı gizli `pepper` (HMAC-SHA256 `env.PASSWORD_PEPPER`) veya bellek-sert Argon2id/scrypt WASM desteği yoktur. Ayrıca `137. satır` minimum eşiği `10_000` kabul etmekte, maksimumu `250_000` yazsa da Workers'ta >100k çalışmayacaktır. |
| 2.2 | Tuz (Salt) üretimi ve uzunluğu | `[PASS]` | `worker/index.js:120`. Her parola için `randomBytes(16)` (128-bit CSPRNG) benzersiz tuz üretilip `pbkdf2_sha256$<iters>$<saltHex>$<hashHex>` biçiminde saklanıyor (NIST SP 800-132 uyumlu). |
| 2.3 | Sabit zamanlı karşılaştırma (`timingSafeEqual`) | `[PASS]` | `worker/index.js:104-117, 145`. `timingSafeStringEqual` her iki dizgeyi SHA-256 ile sabit 32 bayta indirgeyip `crypto.subtle.timingSafeEqual` (veya sabit-zamanlı XOR döngüsü) ile karşılaştırıyor. |
| 2.4 | Parola politikası ve `login` uzunluk/DoS sınırı | `[FAIL]` | `worker/index.js:284-286, 325-331, 350`. `register` 8–128 karakter sınırlar ancak yaygın/zayıf parolaları (`12345678`, `password`) engellemez. `login` ucunda ise `password.length > 128` üst sınırı **yoktur** (`readBoundedJson(request, 4096)` içindeki ~4 KB parola doğrudan `verifyPassword` PBKDF2'ye verilir). Parola değiştirme/sıfırlama mekanizması da yoktur. |
| 2.5 | Brute-force / Credential Stuffing hız sınırı & kilitleme | `[FAIL]` | `worker/index.js:273-357`. `POST /api/auth/login` ve `POST /api/auth/register` uçlarında ne IP hız sınırı, ne hesap bazlı başarısız giriş sayacı/backoff, ne de Turnstile/CAPTCHA koruması mevcuttur (**Bkz. Sorun #5**). |
| 2.6 | Hesap / e-posta varlığı sızıntısı (Account Enumeration — mesaj + zamanlama) | `[FAIL]` | `worker/index.js:289-291, 340-353`. (1) `register` kayıtlı e-postada `409` `"Bu e-posta zaten kayıtlı"` döner; (2) `login` Google hesaplarında `401` `"Bu hesap Google ile açılmış"` döner; (3) `login` olmayan e-postada PBKDF2 çalıştırmadan (~2 ms) dönerken var olan parolalı hesapta 100k PBKDF2 (~20–50 ms) çalıştırarak net bir zamanlama yan kanalı oluşturur. |
| 2.7 | Eşzamanlı kayıt UNIQUE kısıtı hata yönetimi | `[FAIL]` | `worker/index.js:288-301, 494-499`. `SELECT` sonrası ayrı `INSERT` yapılmakta; eşzamanlı iki aynı e-posta kaydında D1 `UNIQUE constraint failed` hatası yakalanmadığından `409` yerine `500` sunucu hatası döner (`1317-1318`). |

---

### Alan 3: Cookie Bayrakları & Oturum Yaşam Döngüsü (`worker/index.js:9-12, 148-237, 360-386`)

| # | Denetim Maddesi | Durum | Kanıt (`dosya:satır`) & Teknik Değerlendirme |
| :-: | :--- | :---: | :--- |
| 3.1 | `HttpOnly`, `Secure`, `SameSite`, `Path`, `Domain` bayrakları | `[PASS]` | `worker/index.js:161-171, 260`. `Path=/; HttpOnly; SameSite=Lax; Max-Age=...; Secure` (`isHttps` iken); `Domain` atanmadığı için host-only çerez. Canlı `/api/auth/google/start` yanıtında `Set-Cookie: inktrope_oauth=...; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure` doğrulandı. İstemcide (`src/engine/cloudSync.ts:4`) `localStorage` belirteci yok. |
| 3.2 | `__Host-` çerez öneki ve `parseCookies` çakışma güvenliği | `[FAIL]` | `worker/index.js:9-10, 148-159`. `inktrope_sid` ve `inktrope_oauth` çerezleri `__Host-` önekini kullanmıyor. Ayrıca `parseCookies` yinelenen çerez adlarında son değeri seçtiğinden alt alan adı kaynaklı cookie tossing/shadowing riskine açıktır. |
| 3.3 | Oturum token entropisi & D1'de özet (hash) saklama | `[PASS]` | `worker/index.js:203, 219-229`. 32 bayt (256-bit) `crypto.getRandomValues` ham belirteç çerezde taşınır; D1 `sessions.id` kolonunda yalnızca `sha256Hex(rawToken)` saklanır. Veritabanı sızıntısı aktif oturumları açığa çıkarmaz. |
| 3.4 | Çıkış (logout) ve süre dolumu iptali | `[PASS]` | `worker/index.js:209, 232-234, 360-369`. `POST /api/auth/logout` D1'den `DELETE FROM sessions WHERE id = ?` çalıştırıp çerezi `Max-Age=0` ile temizler; `getSessionUser` `s.expires_at > now` zorlar ve süresi dolanlar arka planda budanır. |
| 3.5 | Oturum ömrü, hareketsizlik (idle) zaman aşımı, eşzamanlı oturum sınırı ve "tüm cihazlardan çıkış" | `[FAIL]` | `worker/index.js:11, 222, 225-229`. 30 günlük sabit mutlak ömür (`SESSION_TTL_MS`), hareketsizlik zaman aşımı yok, kullanıcı başına maksimum oturum sayısı yok, "tüm cihazlardan çıkış" ucu yok ve girişte mevcut oturum rotasyonu/iptali yapılmıyor. |
| 3.6 | Durum değiştiren (state-changing) uçlarda CSRF koruması | `[PASS]` | `worker/index.js:173-185, 274, 324, 361, 373, 529, 979`. Tüm `POST`/`PUT`/`DELETE` uçları `verifySameOrigin` çağırıyor; hem `Origin` hem `Referer` yoksa fail-closed (`false`) dönüyor ve tam origin eşitliği (`=== url.origin`) uyguluyor. *(İyileştirme: `handleCloud` `529. satır` CSRF kontrolünü `524. satır` D1 oturum sorgusunun önüne almalı ve `Sec-Fetch-Site` eklenmelidir.)* |
| 3.7 | Kritik hesap silme (`DELETE /api/auth/account`) öncesi yeniden kimlik doğrulama | `[FAIL]` | `worker/index.js:372-386`. 30 günlük oturum çereziyle tek istekte tüm hesap ve bulut verileri geri dönüşsüz silinebiliyor; parola teyidi veya yakın zamanlı giriş (`recent auth`) şartı yok. |
| 3.8 | `Secure` bayrağının `url.protocol` bağımlılığı | `[FAIL]` | `worker/index.js:169, 260`. `isHttps = url.protocol === 'https:'` koşuluna bağlı; yanlış yapılandırılmış bir proxy/tünel durumunda `Secure` düşebilir. Yalnızca `localhost`/`127.0.0.1` hariç her ortamda `Secure` zorunlu kılınmalıdır. |

---

### Alan 4: Per-User D1 İzolasyonu — IDOR & SQLi (Tüm 27 SQL Sorgusunun Tam Denetimi)

`worker/index.js` içindeki **27 `.prepare()` çağrısının tamamı** tek tek incelenmiştir:

| Satır | Endpoint / Fonksiyon | Tablo | Parametreli? | `user_id` Kapsamı / Not |
| :---: | :--- | :--- | :---: | :--- |
| 205 | `getSessionUser` | `sessions JOIN users` | Evet (`?`) | `WHERE s.id = ? AND s.expires_at > ?` (hashli token) |
| 225 | `createSessionCookie` | `sessions` | Evet (`?`) | `INSERT` — `userId` sunucu kaynaklı |
| 233 | `createSessionCookie` (GC) | `sessions` | Evet (`?`) | `DELETE WHERE expires_at < ?` (süresi dolanlar) |
| 288, 296 | `POST /api/auth/register` | `users` | Evet (`?`) | E-posta kontrol & `INSERT` |
| 333 | `POST /api/auth/login` | `users` | Evet (`?`) | `WHERE email = ?` |
| 364 | `POST /api/auth/logout` | `sessions` | Evet (`?`) | `WHERE id = ?` (`auth.sessionId` oturumdan) |
| 378–381 | `DELETE /api/auth/account` | `project_blobs`, `projects`, `sessions`, `users` | Evet (`?`) | 4 sorgunun tamamı `uid` (`auth.user.id`) ile `DB.batch` |
| 477, 482, 486, 494, 503 | `GET /api/auth/google/callback` | `users` | Evet (`?`) | `google_sub` / `email` eşleşmesi (**bkz. Sorun #2!**) |
| 536, 541 | `GET /api/cloud/projects` | `projects`, `project_blobs` | Evet (`?`) | `WHERE user_id = ?` (`uid`) |
| 579, 583, 595 | `PUT /api/cloud/projects/:id` | `projects` | Evet (`?`) | `WHERE user_id = ?` + `ON CONFLICT(user_id, id)` (**TOCTOU kota yarışı!**) |
| 612 | `DELETE /api/cloud/projects/:id` | `projects` | Evet (`?`) | `WHERE user_id = ? AND id = ?` (ilgili blob'ları silmez!) |
| 635, 641, 656, 662 | `PUT /api/cloud/blobs/:key` | `project_blobs` | Evet (`?`) | `WHERE user_id = ?` + `DB.batch` atomik chunk yazımı (**TOCTOU kota yarışı!**) |
| 675 | `GET /api/cloud/blobs/:key` | `project_blobs` | Evet (`?`) | `WHERE user_id = ? AND blob_key = ?` |
| 711, 722 | `POST /api/cloud/blobs/gc` | `project_blobs` | Evet (`?`) | `WHERE user_id = ?` + `WHERE user_id = ? AND blob_key = ?` |
| 807, 810, 813, 857 | `checkAiBudgetAndQuota` / `recordAiLedger` | `ai_usage_ledger` | Evet (`?`) | Global aylık/günlük + `actor_key` (**TOCTOU yarışı!**) |
| 1150, 1156, 1278 | `POST /api/ai/side-guide` | `ai_turnaround_cache` | Evet (`?`) | Global SHA-256 önbellek (kullanıcı izolasyonu / TTL yok) |

| # | Denetim Maddesi | Durum | Kanıt (`dosya:satır`) & Teknik Değerlendirme |
| :-: | :--- | :---: | :--- |
| 4.1 | Tüm SQL sorgularında SQL Injection (SQLi) koruması | `[PASS]` | `worker/index.js` tüm 27 `.prepare()` çağrısı statik SQL + `?` `.bind(...)` kullanır; SQL içine dinamik metin birleştirmesi sıfırdır. |
| 4.2 | Bulut proje & blob CRUD/GC uçlarında `user_id` sahiplik izolasyonu (IDOR) | `[PASS]` | `worker/index.js:524-727`. Tüm `/api/cloud/*` sorguları oturumdan çözülen `uid = auth.user.id` ile kısıtlı; bileşik PK `(user_id, id)` ve `(user_id, blob_key, chunk_index)` (`migrations/0001_init.sql:32, 46`) aynı ID'li kayıtların çapraz üzerine yazılmasını engeller. |
| 4.3 | Paylaşılan / genel proje ID tahmin edilebilirliği | `[PASS]` | `worker/index.js` içinde herkese açık bulut proje paylaşım ucu yoktur; paylaşım (`src/engine/shareCodec.ts`) tamamen istemci tarafında URL hash (`#kagit=...`) ile çalışır. |
| 4.4 | `migrations/0001_init.sql` şema kısıtları (`FOREIGN KEY`, `CASCADE`, `UNIQUE`, indeksler) | `[PASS]` | `migrations/0001_init.sql:4-49`. `email UNIQUE COLLATE NOCASE`, `google_sub UNIQUE`, `ON DELETE CASCADE` tüm alt tablolarda tanımlı ve sorgu desenlerine uygun indeksler (`idx_sessions_user`, `idx_sessions_exp`, `idx_projects_user_upd`, `idx_blobs_user_key`) mevcut. |
| 4.5 | İstemci tarafı yerel IndexedDB çoklu hesap izolasyonu | `[PASS]` | `src/engine/db.ts:27-68`, `src/store/useStudioStore.ts:699, 862`. Oturumlu kullanıcılar `kagit:u:${scope}:...` alan adına ayrılıyor, çıkışta/silmede `clearScopedStorage` ve GPU bellek önbelleği temizleniyor. |
| 4.6 | Hesap silmede (`DELETE /api/auth/account`) atomik silme | `[PASS]` | `worker/index.js:377-382`. `env.DB.batch([...])` atomik SQLite işlemiyle `project_blobs`, `projects`, `sessions`, `users` tablolarından `uid` kayıtlarını temizler. |
| 4.7 | Proje/Blob kota kontrollerinde TOCTOU yarış durumu | `[FAIL]` | `worker/index.js:579-604` ve `635-668`. `SELECT 1` ve `SELECT COUNT(*)` kontrolleri `INSERT`'ten ayrı sorgularda yapıldığı için paralel `PUT` istekleri `MAX_PROJECTS_PER_USER` (50) ve `MAX_BLOBS_PER_USER` (1000) sınırlarını aşabilir. |
| 4.8 | `DELETE /api/cloud/projects/:id` sonrası yetim blob birikimi & GC raporlama hatası | `[FAIL]` | `worker/index.js:610-616, 720-726`. Proje silindiğinde ilgili blob'lar sunucu tarafında silinmez (`project_blobs` tablosunda `project_id` FK yok); ayrıca `POST /api/cloud/blobs/gc` en fazla `100` blob sildiği halde (`toDelete.slice(0, 100)`) yanıtta `removed: toDelete.length` (yanlış sayı) döner. |
| 4.9 | `ai_turnaround_cache` global paylaşım / KVKK-GDPR silme eksikliği & sınırsız büyüme | `[FAIL]` | `migrations/0002_ai_budget_and_cache.sql:20-30`, `worker/index.js:377-382, 1146-1169, 1276-1285`. Önbellekte `user_id`, TTL veya satır üst sınırı yok; `cached: true` yanıtı kimliksiz aktörlere görsel varlık kahini (existence oracle) sunar ve hesap silmede bu tablodan kullanıcının türetilmiş görselleri temizlenmez. |

---

### Alan 5: Chunked Blob Sınırları (`worker/index.js:14-19, 618-727`)

| # | Denetim Maddesi | Durum | Kanıt (`dosya:satır`) & Teknik Değerlendirme |
| :-: | :--- | :---: | :--- |
| 5.1 | Tek chunk boyutu ve D1 satır boyutu uyumu | `[PASS]` | `worker/index.js:14, 658-667`. `BLOB_CHUNK_BYTES = 210_000` → base64 boyutu `280_000` bayt (~280 KB); Cloudflare D1 2 MB satır sınırının güvenli biçimde altında. |
| 5.2 | Chunk indeksi/sayısı doğrulaması ve atomik yazım | `[PASS]` | `worker/index.js:652-668`. İstemci `chunk_index` veya `total_chunks` belirleyemez; sunucu `0..totalChunks-1` dilimlerini tek `env.DB.batch([DELETE..., INSERT...])` işlemi içinde atomik yazar. Negatif/dev indeks enjeksiyonu veya yarım yazım mümkün değil. |
| 5.3 | Anahtar biçimi (`blobKey`) doğrulaması | `[PASS]` | `worker/index.js:19, 619, 622`. `SAFE_KEY_RE = /^[a-zA-Z0-9_-]{3,90}$/` yol geçişini (path traversal) ve özel karakterleri engeller. |
| 5.4 | Sunulan blob içeriğinde MIME izin listesi & `Content-Disposition` / XSS koruması | `[FAIL]` | `worker/index.js:651, 687-704`, `src/engine/exportEngine.ts:680-681`. İzin listesi yok, `text/html`/`image/svg+xml` aynı origin'de `Content-Disposition: attachment` ve `CSP: sandbox` olmadan servis ediliyor (**Bkz. Sorun #3**). |
| 5.5 | Kullanıcı başına toplam depolama bayt kotası (D1 depolama amplifikasyonu) | `[FAIL]` | `worker/index.js:15, 18, 646`. Yalnızca adet kotası (`1000`) ve tek dosya sınırı (`4 MB`) var; toplam bayt kotası yok. Tek hesap **4 GB ham (~5.33 GB base64)** D1 alanı tüketebilir (**Bkz. Sorun #5**). |
| 5.6 | `Content-Length` olmayan (chunked) büyük istek gövdelerinde Worker RAM/OOM sınırı | `[FAIL]` | `worker/index.js:239-243, 624-633`. `Content-Length` yokken `await request.arrayBuffer()` / `await request.text()` tüm gövdeyi kontrol etmeden önce 128 MB Worker RAM'ine alır (**Bkz. Sorun #5**). |
| 5.7 | Okuma tarafında (`GET /api/cloud/blobs/:key`) bütünlük & bozuk base64 kontrolü | `[FAIL]` | `worker/index.js:675-696`. `list.length === list[0].total_chunks` veya ardışık `chunk_index` kontrolü yapılmıyor; `base64ToBytes` (`atob`) `try/catch` içinde olmadığından bozuk kayıt `500` fırlatır. |
| 5.8 | Yetim chunk/blob temizliği ve kota atlatma | `[FAIL]` | `worker/index.js:610-616, 635-649, 708-727`. Proje silmede blob'lar yetim kalır, GC yalnızca istemci isterse ve tek seferde en fazla 100 anahtar siler, paralel `PUT` çağrıları `MAX_BLOBS_PER_USER` sınırını TOCTOU ile aşabilir. |

---

### Alan 6: Workers AI Bütçe & Rate-Limit Tasarımı ve Atlatma Riskleri (`worker/index.js:732-1296`, `migrations/0002_ai_budget_and_cache.sql`)

| # | Denetim Maddesi | Durum | Kanıt (`dosya:satır`) & Teknik Değerlendirme |
| :-: | :--- | :---: | :--- |
| 6.1 | Durum ucu (`/api/ai/status`) hassas bilgi koruması | `[PASS]` | `worker/index.js:961-976`. Dolar toplamı, gizli anahtar veya ham IP sızdırmaz; yalnızca `aiAvailable`, `monthlyBudgetCapped` ve aktör günlük kalan hakkını döner (canlı pasif `GET /api/ai/status` ile doğrulandı). |
| 6.2 | AI yanıt şeması temizleme (`sanitizeDirectedScreenplay`) | `[PASS]` | `worker/index.js:748-760, 893-955`. LLM'den dönen `action`, `emotion`, `camera`, `scene`, `transition` ve koordinatlar izin listesi ve sayısal aralıkla sıkı biçimde kıstırılıyor. |
| 6.3 | Bütçe ve günlük kota kontrolünün atomikliği (TOCTOU yarış durumu) | `[FAIL]` | `worker/index.js:791-863, 1058-1113, 1219-1273`. 5–15 saniyelik `env.AI.run()` öncesinde rezervasyon yok; paralel istekler hem günlük kotayı hem `$19.00` tavanını deler ve bayat `billableUsd = 0` kaydeder (**Bkz. Sorun #1**). |
| 6.4 | Hata yollarında (`parse_error` / `empty_image`) faturalandırma | `[FAIL]` | `worker/index.js:1100-1104, 1260-1264`. `env.AI.run()` tamamlandıktan sonra yanıt ayrıştırılamazsa `recordAiLedger()` atlanır; tüketilen Cloudflare Neuron'ları ne kotadan ne bütçeden düşülür (**Bkz. Sorun #1**). |
| 6.5 | Gerçek Neuron maliyeti ve yük (payload) boyut/çözünürlük sınırları | `[FAIL]` | `worker/index.js:741-742, 865-875, 1079, 1124-1244`. Llama 3.3 sabit `32` Neuron varsayılırken `max_tokens: 1400` gerçekte **~305 Neuron (~9.5×)** harcayabilir; FLUX.2 `1410` tahmini 181.82 Neuron/input-MP maliyetini göz ardı eder ve `parseDataUrlBytes` piksel boyutunu/sihirli baytları kontrol etmez (`atob` hatası da yakalanmaz, `500` verir) (**Bkz. Sorun #1**). |
| 6.6 | IP tespiti (`CF-Connecting-IP` vs `X-Forwarded-For`), IPv6 & Sybil çoklu hesap atlatması | `[FAIL]` | `worker/index.js:774-789`. Canlıda `CF-Connecting-IP` öncelikli olması doğru, ancak: (1) oturumlu hesaplarda IP sınırı tamamen kalktığı için doğrulamasız kayıtla sınırsız kota elde edilir; (2) IPv6 `/64` maskelemesi yok (tek cihaz milyarlarca adres döndürebilir); (3) CF dışı ortamlarda `X-Forwarded-For` sahtelenebilir. |
| 6.7 | Fail-open vs fail-closed davranışı (`!env.DB`) | `[FAIL]` | `worker/index.js:802-804`. `if (!env.DB) return { allowed: true, ... }` — veritabanı bağlamı yoksa bütçe devre kesicisi **fail-open** açılır. |
| 6.8 | Önbellek anahtarı, doğrulamasız `creatureClass` / prompt injection & önbellek şişirme | `[FAIL]` | `worker/index.js:995-997, 1003-1019, 1129, 1143, 1146-1148, 1276-1285`. `creatureClass` izin listesiyle doğrulanmadan hem FLUX.2 istemine hem `cacheKey`'e giriyor; `byokFullTurnaround` BYOK yokken de `cacheKey`'i bölerek çift FLUX.2 çağrısına izin veriyor; `actors[].id/name/creatureClass` Llama sistem istemine doğrudan enjekte ediliyor; `ai_turnaround_cache` sınırsız büyüyor. |
| 6.9 | BYOK Gemini vekil (proxy) hız sınırı & gözlemlenebilirlik başlık riski | `[FAIL]` | `worker/index.js:1002, 1022-1051, 1134, 1172-1211`, `wrangler.jsonc:27-31`. `X-User-Gemini-Key` (uzunluk >= 20) ile kimliksiz/hız sınırsız ve zaman aşımı (`AbortSignal.timeout`) olmayan Google API vekilliği yapılıyor; üstelik `wrangler.jsonc:29-31` üzerinde `observability.traces.enabled: true` açıkken gizli API anahtarının özel HTTP başlığında taşınması gizlilik politikasındaki (*"never logged"*, `public/privacy/index.html:106`) güvenceyle çatışma riski taşır. |

---

### Alan 7: XSS / CORS / CSP & HTTP Güvenlik Başlıkları (Kaynak Kod + `public/_headers` + Canlı Pasif Gözlem)

#### Canlı `https://inktrope.com` Pasif Başlık Karşılaştırma Tablosu (`24.11.2026` `curl.exe` Gözlemi)

| Başlık | `public/_headers` (Beklenen) | Canlı `GET /` & `/privacy/` | Canlı `HEAD /assets/*.css` & `GET /sw.js` | Canlı `GET /api/auth/me` & `/api/ai/status` | Canlı `GET /api/auth/google/start` | Uyum |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `Content-Security-Policy` | Tanımlı (`unsafe-inline` zafiyetli) | **YOK** | **YOK** | **YOK** | **YOK** | `[FAIL]` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains; preload` | **YOK** | **YOK** | **YOK** | **YOK** | `[FAIL]` |
| `X-Frame-Options` | `DENY` | **YOK** | **YOK** | **YOK** | **YOK** | `[FAIL]` |
| `X-Content-Type-Options` | `nosniff` | **YOK** | **YOK** | `nosniff` | **YOK** | `[FAIL]` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | **YOK** | **YOK** | **YOK** | **YOK** | `[FAIL]` |
| `Permissions-Policy` | `camera=(self), microphone=(self), ...` | **YOK** | **YOK** | **YOK** | **YOK** | `[FAIL]` |
| `Cache-Control` | `/index.html`,`/sw.js`: `no-store`; `/assets/*`: `immutable` | `public, max-age=0, must-revalidate` | `public, max-age=0, must-revalidate` | `no-store` | `no-store` | `[FAIL]` |
| `Access-Control-Allow-Origin` | Yok (SOP) | Yok (SOP) | Yok (SOP) | Yok (SOP) | Yok (SOP) | `[PASS]` |
| HTTP→HTTPS & `www` Yönlendirme | — | `http://` → `301 https://inktrope.com/`; `www` → `301 https://inktrope.com/` | — | — | — | `[PASS]` |

| # | Denetim Maddesi | Durum | Kanıt (`dosya:satır`) & Teknik Değerlendirme |
| :-: | :--- | :---: | :--- |
| 7.1 | CORS `Origin` yansıtma ve `Access-Control-Allow-Credentials` güvenliği | `[PASS]` | `worker/index.js`, `public/_headers` ve canlı yanıtlar. Hiçbir `Access-Control-Allow-*` başlığı yok; tarayıcılar katı Same-Origin Policy uygular. |
| 7.2 | İstemci React/TS kod tabanında DOM XSS kaynakları | `[PASS]` | `src/` tamamında sıfır `dangerouslySetInnerHTML`, sıfır `innerHTML`, sıfır `outerHTML`, sıfır `document.write`, sıfır `eval`/`new Function`. `shareCodec.ts:76` renk değerlerini hex regex (`/^#[0-9a-fA-F]{3,8}$/`) ile doğrular. |
| 7.3 | HTTP→HTTPS ve `www` kanonik yönlendirmesi | `[PASS]` | Canlı pasif gözlem: `http://inktrope.com/` → `301 https://inktrope.com/` ve `https://www.inktrope.com/` → `301 https://inktrope.com/`. |
| 7.4 | Canlı statik varlıklarda `public/_headers` başlıklarının uygulanması | `[FAIL]` | `public/_headers:1-16` vs canlı `curl.exe` gözlemi. Canlıda **hiçbir** güvenlik veya önbellek başlığı servis edilmiyor (**Bkz. Sorun #4**). |
| 7.5 | Worker `/api/*` yanıtlarında güvenlik başlıkları (HSTS, XFO, CSP, Referrer-Policy) | `[FAIL]` | `worker/index.js:24-45, 697-704, 1299-1312`. `json()` yalnızca `nosniff`, `redirect()` hiçbir güvenlik başlığı eklemiyor; `_headers` Workers tarafından Worker yanıtlarına uygulanmıyor (**Bkz. Sorun #4**). |
| 7.6 | CSP direktif gücü (`script-src 'unsafe-inline' blob:`, eksik `object-src 'none'`) | `[FAIL]` | `public/_headers:7`, `index.html:43-121`. Yürütülebilir inline betik olmadığı halde `script-src 'self' 'unsafe-inline' blob:` tanımlanmış ve `object-src 'none'` eksik (**Bkz. Sorun #4**). |
| 7.7 | Sunucu yanıtlı Stored XSS (`/api/cloud/blobs/:key`) | `[FAIL]` | `worker/index.js:651, 687-704`. Kullanıcı kontrollü `text/html` / `image/svg+xml` MIME türü aynı origin'de doğrudan çalıştırılabiliyor (**Bkz. Sorun #3**). |
| 7.8 | Geçersiz `public/_redirects` kuralı & `vercel.json` yapılandırma sapması | `[FAIL]` | `public/_redirects:1` (`/* /index.html 200` — Workers Static Assets `200` rewrite desteklemez, `wrangler.jsonc:10` ile çakışık/gereksizdir) ve `vercel.json:14` (`img-src` içinde `https://lh3.googleusercontent.com` eksik). |

---

## 4. Ek Savunma Gözlemleri (Düşük / Mimari Sertleştirme Notları)

1. **`wrangler.jsonc` üzerinde `workers_dev` açık bırakılmış (`wrangler.jsonc:1-33`):** `"workers_dev": false` açıkça tanımlanmadığından `*.workers.dev` alt alan adı erişime açık kalabilir; bu ikincil origin aynı D1 veritabanını ve Workers AI bütçesini paylaşır ve `Origin === url.origin` kontrolünü kendi alt alan adında geçer. Üretimde `"workers_dev": false` eklenmelidir.
2. **İstemci `kagit25dPipeline.ts` harici GPU URL'si (`src/engine/kagit25dPipeline.ts:39-55, 115`):** `localStorage` üzerinden kullanıcı yapılandırılabilir bir `cloudUrl` (varsayılan `http://localhost:8090`) ile harici sunucuya `POST` yapılabilmektedir. CSP aktif edildiğinde `connect-src 'self' blob: data:` (`public/_headers:7`) bu yerel/özel sunucu özelliğini zaten engelleyecektir; kullanılmıyorsa kaldırılmalı veya şema doğrulaması (`https://` veya `http://localhost`) eklenmelidir.
3. **Google profil fotoğrafı URL izin listesi (`worker/index.js:470`):** `info.picture.startsWith('https://')` herhangi bir HTTPS alan adını kabul eder; oysa `public/_headers:7` CSP `img-src` yalnızca `https://lh3.googleusercontent.com` adresine izin verir. Sunucu tarafında da `new URL(pic).hostname.endsWith('.googleusercontent.com')` ile kısıtlanması tutarlılık ve SSRF/izleyici önleme sağlar.
4. **Dışa dönük `fetch` çağrılarında zaman aşımı eksikliği (`worker/index.js:434, 459, 1023, 1176`):** Google OAuth ve BYOK Gemini `fetch()` çağrılarında `AbortSignal.timeout(15_000)` bulunmamaktadır.
5. **Cloud Sync istemcisinde çoklu-aktör / 360° görünüm referans kontrolü notu:** `src/engine/db.ts:377-438` (`collectAllReferencedBlobKeys`) yalnızca yerel/bulut GC için kullanılır; ancak `POST /api/cloud/blobs/gc` sunucu tarafında `activeKeys` dizisini tamamen istemci beyanına göre silmektedir (`worker/index.js:708-727`). Tek kullanıcı kapsamlı olduğu için güvenlik açığı değildir, ancak bozuk bir istemci isteği (`activeKeys: []`) kullanıcının tüm bulut blob'larını tek seferde silebilir — sunucu tarafında `projects.meta_json` içindeki referanslarla çapraz doğrulama veri kaybı dayanıklılığını artırır.

---

## 5. Öncelikli Savunma Düzeltme Yol Haritası

### P0 — Acil (24–48 Saat İçinde, Üretim Engelleyici)
1. **Canlı Güvenlik Başlıklarını Etkinleştirin (Sorun #4):**
   - `worker/index.js` içinde tüm yanıtları `withSecurityHeaders()` ile sarmalayın (HSTS, XFO `DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, API CSP).
   - Statik varlıklar için Cloudflare Zone **Response Header Transform Rules** ekleyin veya güncel Wrangler ile `_headers` dağıtımını onarıp `curl -sI https://inktrope.com/` ile doğrulayın; `public/_headers:7` içinden `'unsafe-inline'` ve `blob:` değerlerini `script-src`'den kaldırıp `object-src 'none'` ekleyin; `public/_redirects` dosyasını silin.
2. **Blob Stored XSS'ini Kapatın (Sorun #3):**
   - `PUT /api/cloud/blobs/:key` ve `src/engine/exportEngine.ts:680` üzerinde güvenli görsel/ses MIME izin listesi uygulayın (`text/html`, `image/svg+xml`, `text/javascript` yasak!).
   - `GET /api/cloud/blobs/:key` yanıtına `Content-Disposition: attachment` ve `Content-Security-Policy: default-src 'none'; sandbox` ekleyin.
3. **Pre-Account Takeover'ı Kapatın (Sorun #2):**
   - `users` tablosuna `email_verified` kolonu ekleyin; Google OAuth mevcut doğrulanmamış kaydı eşleştirirken `password_hash = NULL` yapıp mevcut `sessions` kayıtlarını silin (ve `google_sub IS NULL` şartını koruyun).

### P1 — Yüksek Öncelik (1 Hafta İçinde)
4. **Workers AI Bütçe Korumasını Atomik ve Gerçekçi Hale Getirin (Sorun #1):**
   - `env.AI.run()` öncesinde Durable Object veya atomik koşullu D1 `UPDATE` ile en kötü durum Neuron rezervasyonu yapın; `parse_error`/`empty_image` durumlarında da tüketimi kaydetmeye devam edin; `!env.DB` durumunda fail-closed dönün.
   - Llama 3.3 gerçek token kullanımını (`aiResp.usage`) faturalandırın veya tahmini `310` Neuron'a çıkarın; FLUX.2 girdi görseli piksel boyutunu `<= 512×512` ile doğrulayıp `1550` Neuron varsayın; `creatureClass` için katı izin listesi uygulayın; `byokFullTurnaround`'ı BYOK yokken `cacheKey`'den çıkarın.
5. **Auth Rate-Limit, Toplam Depolama Kotası & Streaming Boyut Sınırı (Sorun #5):**
   - Cloudflare WAF Rate Limiting + Turnstile'ı `/api/auth/register`, `/api/auth/login` ve `/api/ai/*` (BYOK dahil) uçlarına ekleyin.
   - Kullanıcı başına toplam blob bayt kotası (ör. 100 MB) zorlayın (veya binary depolamayı R2'ye taşıyın); `readBoundedJson` ve blob yükleyicisinde akışlı (`getReader`) bayt limiti kullanın; `login` tarafında `password.length <= 128`, sabit zamanlı dummy PBKDF2 ve tek tip hata mesajı uygulayın.

### P2 — Sertleştirme (Sonraki Sprint)
6. Çerezleri `__Host-inktrope_sid` ve `__Host-inktrope_oauth` olarak yeniden adlandırın; `inktrope_oauth` çerezini sunucu gizli anahtarıyla HMAC-SHA256 imzalayın; OIDC `nonce` + `id_token` doğrulaması ekleyin.
7. PBKDF2 öncesinde sunucu tarafı `env.PASSWORD_PEPPER` (HMAC-SHA256) uygulayın; girişte eski oturumu iptal edin; "tüm cihazlardan çıkış", şifre değiştirme ve hesap silme öncesi yeniden doğrulama ekleyin.
8. `wrangler.jsonc` içine `"workers_dev": false` ekleyin; `ai_turnaround_cache` için TTL/boyut budama cron'u kurun ve BYOK anahtarını HTTP başlığı yerine istek gövdesine taşıyarak izleme (trace) loglarına düşme riskini ortadan kaldırın.
