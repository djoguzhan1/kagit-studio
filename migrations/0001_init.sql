-- INKTROPE Cloud Accounts & Per-User Isolated Project Vault (Cloudflare D1)
-- Every project and binary blob is strictly scoped by composite PRIMARY KEY (user_id, ...).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_projects_user_upd ON projects(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_blobs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blob_key TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 1,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blob_key, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_blobs_user_key ON project_blobs(user_id, blob_key);
