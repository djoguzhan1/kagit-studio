-- INKTROPE Short Share Snapshots (Cloudflare D1)
-- Stores compressed <= 512 KB stage/project snapshots with 30-day automatic TTL.

CREATE TABLE IF NOT EXISTS shared_snapshots (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_b64 TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_snapshots_exp ON shared_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS idx_shared_snapshots_ip_created ON shared_snapshots(ip_hash, created_at);
