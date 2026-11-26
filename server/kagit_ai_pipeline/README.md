# KÂĞIT 2.5D Cloud GPU & Local-CV AI Pipeline

KÂĞIT Studio'nun **Faz 3** arka uç servisidir. Tek çizimden **6+ amodal parça + Depth/Normal haritası**, tek arka plandan **5-katmanlı Disney Multi-Plane paralaks seti (`Z0..Z5`)** ve doğal dil senaryosundan **çoklu plan `FilmGraph IR`** üretir.

## Hızlı Başlatma (Yerel CPU veya Bulut GPU)

```bash
cd server/kagit_ai_pipeline
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8090
```

Ardından KÂĞIT Studio → **2.5D Film** → sol paneldeki **`AI Motor & .kagit25d`** kutusuna `http://localhost:8090` (veya RunPod/Modal URL'ini) yazıp **`Bağlan`** butonuna bas.

## Opsiyonel GPU & Gemini Yönetmen Aktivasyonu
* CUDA GPU sunucuda `pip install -r requirements-gpu.txt` kurulduğunda `/health` otomatik `mode: "gpu-neural"` bildirir.
* `GEMINI_API_KEY` ortam değişkeni tanımlandığında `/api/v1/direct-film` doğrudan `gemini-2.5-flash` yapılandırılmış JSON yönetmeniyle çalışır.

## Testleri Çalıştırma

```bash
python -m unittest discover -s tests -v
```
