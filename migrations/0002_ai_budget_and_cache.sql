-- INKTROPE V4 — AI Budget Hard Circuit Breaker ($19.00/mo cap), Fair Daily Allowance & SHA-256 Turnaround Cache (Cloudflare D1)
-- Guarantees monthly Cloudflare Workers AI spend NEVER exceeds $19.00 while maximizing the 10,000 free daily Neurons.

CREATE TABLE IF NOT EXISTS ai_usage_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month_key TEXT NOT NULL,
  day_key TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  neurons REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_ledger_month ON ai_usage_ledger(month_key);
CREATE INDEX IF NOT EXISTS idx_ai_ledger_day_actor ON ai_usage_ledger(day_key, actor_key, feature);
CREATE INDEX IF NOT EXISTS idx_ai_ledger_day ON ai_usage_ledger(day_key);

CREATE TABLE IF NOT EXISTS ai_turnaround_cache (
  cache_key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data_b64 TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_hit_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_cache_last_hit ON ai_turnaround_cache(last_hit_at);
