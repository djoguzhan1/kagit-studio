/**
 * INKTROPE Edge Auth & Cloud Project Vault Worker (Cloudflare Workers + D1)
 * - Strictly optional sign-in (guest mode stays 100% client-side in IndexedDB)
 * - Google OAuth 2.0 (Authorization Code + PKCE + CSRF state) + Email/Password (PBKDF2-SHA256)
 * - HttpOnly; Secure; SameSite=Lax random-token sessions (only SHA-256 hash stored in D1)
 * - Absolute per-user data isolation: every project & blob query enforces WHERE user_id = session.user_id
 */

const SESSION_COOKIE = 'inktrope_sid';
const OAUTH_COOKIE = 'inktrope_oauth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const OAUTH_TTL_SEC = 600; // 10 minutes
const PBKDF2_ITERS = 100_000;
const BLOB_CHUNK_BYTES = 210_000; // ~280 KB base64 per D1 row (safely well below 1 MB D1 row cap)
const MAX_BLOB_BYTES = 4 * 1024 * 1024; // 4 MB per single cel/audio blob
const MAX_PROJECT_JSON_BYTES = 600_000; // 600 KB metadata JSON
const MAX_PROJECTS_PER_USER = 50;
const MAX_BLOBS_PER_USER = 1000;
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]{3,90}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const enc = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
}

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToBase64(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function sha256Base64Url(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function timingSafeStringEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(ha, hb);
  }
  const ua = new Uint8Array(ha);
  const ub = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERS },
    key,
    256
  );
  return `pbkdf2_sha256$${PBKDF2_ITERS}$${bytesToHex(salt)}$${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iters = Number.parseInt(parts[1], 10);
  const salt = hexToBytes(parts[2]);
  const expectedHex = parts[3];
  if (!salt || !Number.isFinite(iters) || iters < 10_000 || iters > 250_000) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iters },
    key,
    256
  );
  const actualHex = bytesToHex(new Uint8Array(bits));
  return timingSafeStringEqual(actualHex, expectedHex);
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const map = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) map[k] = v;
  }
  return map;
}

function buildCookie(name, value, maxAgeSec, isHttps) {
  const attrs = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps) attrs.push('Secure');
  return attrs.join('; ');
}

function verifySameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin) return origin === url.origin;
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }
  return false;
}

function serializeUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url || null,
    hasGoogle: Boolean(row.google_sub),
    hasPassword: Boolean(row.password_hash),
    createdAt: row.created_at,
  };
}

async function getSessionUser(request, env) {
  const cookies = parseCookies(request);
  const rawToken = cookies[SESSION_COOKIE];
  if (!rawToken || rawToken.length < 20) return null;
  const tokenHash = await sha256Hex(rawToken);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.avatar_url, u.password_hash, u.google_sub, u.created_at, s.id AS session_id
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?
     LIMIT 1`
  )
    .bind(tokenHash, now)
    .first();
  if (!row) return null;
  return { user: row, sessionId: row.session_id };
}

async function createSessionCookie(userId, request, env, ctx, isHttps) {
  const rawToken = bytesToBase64Url(randomBytes(32));
  const tokenHash = await sha256Hex(rawToken);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  const ua = (request.headers.get('User-Agent') || '').slice(0, 180);

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, created_at, user_agent) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(tokenHash, userId, expiresAt, now, ua)
    .run();

  // Opportunistically prune expired sessions in background
  ctx.waitUntil(
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(now).run().catch(() => {})
  );

  return buildCookie(SESSION_COOKIE, rawToken, Math.floor(SESSION_TTL_MS / 1000), isHttps);
}

async function readBoundedJson(request, maxBytes) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > maxBytes) throw new ResponseError('İstek boyutu sınırı aşıldı', 413);
  const text = await request.text();
  if (enc.encode(text).byteLength > maxBytes) throw new ResponseError('İstek boyutu sınırı aşıldı', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new ResponseError('Geçersiz JSON verisi', 400);
  }
}

class ResponseError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function handleAuth(request, url, env, ctx) {
  const path = url.pathname;
  const isHttps = url.protocol === 'https:';
  const googleEnabled = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

  // GET /api/auth/me
  if (request.method === 'GET' && path === '/api/auth/me') {
    const auth = await getSessionUser(request, env);
    return json({
      user: auth ? serializeUser(auth.user) : null,
      googleEnabled,
    });
  }

  // POST /api/auth/register
  if (request.method === 'POST' && path === '/api/auth/register') {
    if (!verifySameOrigin(request, url)) return json({ error: 'Geçersiz kaynak' }, 403);
    const body = await readBoundedJson(request, 4096);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const rawName = String(body.name || '').trim();
    const name = (rawName || email.split('@')[0] || 'Çizer').slice(0, 60);

    if (!EMAIL_RE.test(email) || email.length > 120) {
      return json({ error: 'Lütfen geçerli bir e-posta adresi gir.' }, 400);
    }
    if (password.length < 8 || password.length > 128) {
      return json({ error: 'Şifre en az 8 karakter olmalı.' }, 400);
    }

    const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`).bind(email).first();
    if (existing) {
      return json({ error: 'Bu e-posta zaten kayıtlı. Giriş yapmayı dene.' }, 409);
    }

    const id = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
    const pwHash = await hashPassword(password);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, avatar_url, password_hash, google_sub, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)`
    )
      .bind(id, email, name, pwHash, now, now)
      .run();

    const cookie = await createSessionCookie(id, request, env, ctx, isHttps);
    return json(
      {
        user: {
          id,
          email,
          name,
          avatarUrl: null,
          hasGoogle: false,
          hasPassword: true,
          createdAt: now,
        },
        googleEnabled,
      },
      201,
      { 'Set-Cookie': cookie }
    );
  }

  // POST /api/auth/login
  if (request.method === 'POST' && path === '/api/auth/login') {
    if (!verifySameOrigin(request, url)) return json({ error: 'Geçersiz kaynak' }, 403);
    const body = await readBoundedJson(request, 4096);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (!EMAIL_RE.test(email) || !password) {
      return json({ error: 'E-posta ve şifre gerekli.' }, 400);
    }

    const row = await env.DB.prepare(
      `SELECT id, email, name, avatar_url, password_hash, google_sub, created_at
       FROM users WHERE email = ? LIMIT 1`
    )
      .bind(email)
      .first();

    if (!row) {
      return json({ error: 'E-posta veya şifre hatalı.' }, 401);
    }
    if (!row.password_hash) {
      return json(
        { error: 'Bu hesap Google ile açılmış. "Google ile Devam Et" butonunu kullan.' },
        401
      );
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      return json({ error: 'E-posta veya şifre hatalı.' }, 401);
    }

    const cookie = await createSessionCookie(row.id, request, env, ctx, isHttps);
    return json({ user: serializeUser(row), googleEnabled }, 200, { 'Set-Cookie': cookie });
  }

  // POST /api/auth/logout
  if (request.method === 'POST' && path === '/api/auth/logout') {
    if (!verifySameOrigin(request, url)) return json({ error: 'Geçersiz kaynak' }, 403);
    const auth = await getSessionUser(request, env);
    if (auth) {
      await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(auth.sessionId).run();
    }
    return json({ ok: true }, 200, {
      'Set-Cookie': buildCookie(SESSION_COOKIE, '', 0, isHttps),
    });
  }

  // DELETE /api/auth/account — permanent KVKK/GDPR erasure
  if (request.method === 'DELETE' && path === '/api/auth/account') {
    if (!verifySameOrigin(request, url)) return json({ error: 'Geçersiz kaynak' }, 403);
    const auth = await getSessionUser(request, env);
    if (!auth) return json({ error: 'Oturum bulunamadı.' }, 401);
    const uid = auth.user.id;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM project_blobs WHERE user_id = ?`).bind(uid),
      env.DB.prepare(`DELETE FROM projects WHERE user_id = ?`).bind(uid),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(uid),
      env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(uid),
    ]);
    return json({ ok: true }, 200, {
      'Set-Cookie': buildCookie(SESSION_COOKIE, '', 0, isHttps),
    });
  }

  // GET /api/auth/google/start
  if (request.method === 'GET' && path === '/api/auth/google/start') {
    if (!googleEnabled) {
      return redirect(`${url.origin}/?auth_error=google_not_configured`);
    }
    const state = bytesToHex(randomBytes(24));
    const verifier = bytesToBase64Url(randomBytes(32));
    const challenge = await sha256Base64Url(verifier);
    const redirectUri = `${url.origin}/api/auth/google/callback`;

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('prompt', 'select_account');

    const oauthCookie = buildCookie(OAUTH_COOKIE, `${state}.${verifier}`, OAUTH_TTL_SEC, isHttps);
    return redirect(authUrl.toString(), { 'Set-Cookie': oauthCookie });
  }

  // GET /api/auth/google/callback
  if (request.method === 'GET' && path === '/api/auth/google/callback') {
    const clearOauth = buildCookie(OAUTH_COOKIE, '', 0, isHttps);
    if (!googleEnabled) {
      return redirect(`${url.origin}/?auth_error=google_not_configured`, { 'Set-Cookie': clearOauth });
    }
    const errParam = url.searchParams.get('error');
    if (errParam) {
      return redirect(`${url.origin}/?auth_error=google_cancelled`, { 'Set-Cookie': clearOauth });
    }
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const cookies = parseCookies(request);
    const oauthVal = cookies[OAUTH_COOKIE] || '';
    const dotIdx = oauthVal.indexOf('.');
    const expectedState = dotIdx > 0 ? oauthVal.slice(0, dotIdx) : '';
    const verifier = dotIdx > 0 ? oauthVal.slice(dotIdx + 1) : '';

    if (!code || !state || !expectedState || !verifier || !(await timingSafeStringEqual(state, expectedState))) {
      return redirect(`${url.origin}/?auth_error=google_state_invalid`, { 'Set-Cookie': clearOauth });
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/auth/google/callback`,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      console.error(JSON.stringify({ event: 'google_token_error', status: tokenRes.status, errText: errText.slice(0, 300) }));
      return redirect(`${url.origin}/?auth_error=google_token_failed`, { 'Set-Cookie': clearOauth });
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      return redirect(`${url.origin}/?auth_error=google_token_failed`, { 'Set-Cookie': clearOauth });
    }

    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!infoRes.ok) {
      return redirect(`${url.origin}/?auth_error=google_userinfo_failed`, { 'Set-Cookie': clearOauth });
    }
    const info = await infoRes.json();
    const googleSub = String(info?.sub || '');
    const email = String(info?.email || '').trim().toLowerCase();
    const emailVerified = Boolean(info?.email_verified);
    const name = String(info?.name || email.split('@')[0] || 'Çizer').trim().slice(0, 60);
    const avatarUrl = typeof info?.picture === 'string' && info.picture.startsWith('https://') ? info.picture.slice(0, 500) : null;

    if (!googleSub || !email || !emailVerified) {
      return redirect(`${url.origin}/?auth_error=google_email_unverified`, { 'Set-Cookie': clearOauth });
    }

    const now = Date.now();
    let userRow = await env.DB.prepare(`SELECT id FROM users WHERE google_sub = ? LIMIT 1`)
      .bind(googleSub)
      .first();

    if (!userRow) {
      const byEmail = await env.DB.prepare(`SELECT id FROM users WHERE email = ? LIMIT 1`)
        .bind(email)
        .first();
      if (byEmail) {
        await env.DB.prepare(
          `UPDATE users SET google_sub = ?, avatar_url = COALESCE(avatar_url, ?), updated_at = ? WHERE id = ?`
        )
          .bind(googleSub, avatarUrl, now, byEmail.id)
          .run();
        userRow = byEmail;
      } else {
        const id = `usr_${crypto.randomUUID().replace(/-/g, '')}`;
        await env.DB.prepare(
          `INSERT INTO users (id, email, name, avatar_url, password_hash, google_sub, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
        )
          .bind(id, email, name, avatarUrl, googleSub, now, now)
          .run();
        userRow = { id };
      }
    } else {
      await env.DB.prepare(
        `UPDATE users SET name = ?, avatar_url = ?, updated_at = ? WHERE id = ?`
      )
        .bind(name, avatarUrl, now, userRow.id)
        .run();
    }

    const sessionCookie = await createSessionCookie(userRow.id, request, env, ctx, isHttps);
    const headers = new Headers({
      Location: `${url.origin}/?auth=ok`,
      'Cache-Control': 'no-store',
    });
    headers.append('Set-Cookie', clearOauth);
    headers.append('Set-Cookie', sessionCookie);
    return new Response(null, { status: 302, headers });
  }

  return json({ error: 'Bulunamadı' }, 404);
}

async function handleCloud(request, url, env) {
  const auth = await getSessionUser(request, env);
  if (!auth) return json({ error: 'Giriş gerekli.' }, 401);
  const uid = auth.user.id;
  const path = url.pathname;

  if (request.method !== 'GET' && !verifySameOrigin(request, url)) {
    return json({ error: 'Geçersiz kaynak' }, 403);
  }

  // GET /api/cloud/projects — list all projects & blob keys owned strictly by uid
  if (request.method === 'GET' && path === '/api/cloud/projects') {
    const [projRes, blobRes] = await Promise.all([
      env.DB.prepare(
        `SELECT id, name, updated_at, meta_json FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`
      )
        .bind(uid, MAX_PROJECTS_PER_USER)
        .all(),
      env.DB.prepare(
        `SELECT DISTINCT blob_key, byte_size FROM project_blobs WHERE user_id = ? AND chunk_index = 0`
      )
        .bind(uid)
        .all(),
    ]);

    const projects = [];
    for (const row of projRes.results || []) {
      try {
        projects.push({
          id: row.id,
          name: row.name,
          updatedAt: row.updated_at,
          project: JSON.parse(row.meta_json),
        });
      } catch {
        // skip corrupted row
      }
    }

    const blobKeys = (blobRes.results || []).map((r) => r.blob_key);
    const totalBlobBytes = (blobRes.results || []).reduce((acc, r) => acc + (Number(r.byte_size) || 0), 0);

    return json({ projects, blobKeys, totalBlobBytes });
  }

  // PUT /api/cloud/projects/:id
  const projMatch = path.match(/^\/api\/cloud\/projects\/([a-zA-Z0-9_-]{3,90})$/);
  if (projMatch && request.method === 'PUT') {
    const projectId = projMatch[1];
    const body = await readBoundedJson(request, MAX_PROJECT_JSON_BYTES);
    const project = body?.project;
    if (!project || typeof project !== 'object' || project.id !== projectId) {
      return json({ error: 'Geçersiz proje verisi.' }, 400);
    }

    // Enforce max project quota for brand-new projects
    const exists = await env.DB.prepare(`SELECT 1 FROM projects WHERE user_id = ? AND id = ? LIMIT 1`)
      .bind(uid, projectId)
      .first();
    if (!exists) {
      const countRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM projects WHERE user_id = ?`)
        .bind(uid)
        .first();
      if ((countRow?.cnt || 0) >= MAX_PROJECTS_PER_USER) {
        return json({ error: `Ücretsiz bulut sınırı (${MAX_PROJECTS_PER_USER} defter) doldu.` }, 409);
      }
    }

    const name = String(project.name || 'Defter').slice(0, 120);
    const updatedAt = typeof project.updatedAt === 'string' ? project.updatedAt : new Date().toISOString();
    const metaJson = JSON.stringify(project);

    await env.DB.prepare(
      `INSERT INTO projects (id, user_id, name, updated_at, meta_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO UPDATE SET
         name = excluded.name,
         updated_at = excluded.updated_at,
         meta_json = excluded.meta_json`
    )
      .bind(projectId, uid, name, updatedAt, metaJson)
      .run();

    return json({ ok: true, id: projectId, updatedAt });
  }

  // DELETE /api/cloud/projects/:id
  if (projMatch && request.method === 'DELETE') {
    const projectId = projMatch[1];
    await env.DB.prepare(`DELETE FROM projects WHERE user_id = ? AND id = ?`)
      .bind(uid, projectId)
      .run();
    return json({ ok: true, id: projectId });
  }

  // PUT /api/cloud/blobs/:key
  const blobMatch = path.match(/^\/api\/cloud\/blobs\/([a-zA-Z0-9_-]{3,90})$/);
  if (blobMatch && request.method === 'PUT') {
    const blobKey = blobMatch[1];
    if (!SAFE_KEY_RE.test(blobKey)) return json({ error: 'Geçersiz dosya anahtarı.' }, 400);

    const contentLen = Number(request.headers.get('Content-Length') || 0);
    if (contentLen > MAX_BLOB_BYTES) {
      return json({ error: 'Tek dosya boyutu 4 MB sınırını aşıyor.' }, 413);
    }

    const rawBuf = new Uint8Array(await request.arrayBuffer());
    if (rawBuf.byteLength === 0) return json({ error: 'Boş dosya.' }, 400);
    if (rawBuf.byteLength > MAX_BLOB_BYTES) {
      return json({ error: 'Tek dosya boyutu 4 MB sınırını aşıyor.' }, 413);
    }

    const exists = await env.DB.prepare(
      `SELECT 1 FROM project_blobs WHERE user_id = ? AND blob_key = ? AND chunk_index = 0 LIMIT 1`
    )
      .bind(uid, blobKey)
      .first();
    if (!exists) {
      const cntRow = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM project_blobs WHERE user_id = ? AND chunk_index = 0`
      )
        .bind(uid)
        .first();
      if ((cntRow?.cnt || 0) >= MAX_BLOBS_PER_USER) {
        return json({ error: 'Bulut medya kotası doldu.' }, 409);
      }
    }

    const mimeType = (request.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().slice(0, 80);
    const totalChunks = Math.max(1, Math.ceil(rawBuf.byteLength / BLOB_CHUNK_BYTES));
    const now = Date.now();

    const stmts = [
      env.DB.prepare(`DELETE FROM project_blobs WHERE user_id = ? AND blob_key = ?`).bind(uid, blobKey),
    ];
    for (let i = 0; i < totalChunks; i++) {
      const slice = rawBuf.subarray(i * BLOB_CHUNK_BYTES, Math.min(rawBuf.byteLength, (i + 1) * BLOB_CHUNK_BYTES));
      const b64 = bytesToBase64(slice);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO project_blobs (user_id, blob_key, chunk_index, total_chunks, mime_type, byte_size, data_b64, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(uid, blobKey, i, totalChunks, mimeType, rawBuf.byteLength, b64, now)
      );
    }
    await env.DB.batch(stmts);
    return json({ ok: true, blobKey, byteSize: rawBuf.byteLength, chunks: totalChunks });
  }

  // GET /api/cloud/blobs/:key
  if (blobMatch && request.method === 'GET') {
    const blobKey = blobMatch[1];
    const rows = await env.DB.prepare(
      `SELECT chunk_index, mime_type, byte_size, data_b64
       FROM project_blobs
       WHERE user_id = ? AND blob_key = ?
       ORDER BY chunk_index ASC`
    )
      .bind(uid, blobKey)
      .all();

    const list = rows.results || [];
    if (list.length === 0) return json({ error: 'Bulunamadı' }, 404);

    const mimeType = list[0].mime_type || 'application/octet-stream';
    const chunks = list.map((r) => base64ToBytes(r.data_b64));
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }

    return new Response(out, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  // POST /api/cloud/blobs/gc — remove orphaned blobs strictly for uid
  if (request.method === 'POST' && path === '/api/cloud/blobs/gc') {
    const body = await readBoundedJson(request, 200_000);
    const activeSet = new Set(Array.isArray(body?.activeKeys) ? body.activeKeys.map(String) : []);
    const existing = await env.DB.prepare(
      `SELECT DISTINCT blob_key FROM project_blobs WHERE user_id = ? AND chunk_index = 0`
    )
      .bind(uid)
      .all();
    const toDelete = (existing.results || [])
      .map((r) => r.blob_key)
      .filter((k) => !activeSet.has(k));

    if (toDelete.length > 0) {
      const batch = toDelete.slice(0, 100).map((k) =>
        env.DB.prepare(`DELETE FROM project_blobs WHERE user_id = ? AND blob_key = ?`).bind(uid, k)
      );
      await env.DB.batch(batch);
    }
    return json({ ok: true, removed: toDelete.length });
  }

  return json({ error: 'Bulunamadı' }, 404);
}

// ============================================================================
// INKTROPE V4 — CLOUDFLARE WORKERS AI STUDIO + $19.00 HARD BUDGET CIRCUIT BREAKER
// ============================================================================

export const AI_MONTHLY_HARD_CAP_USD = 19.0; // Strictly below $20.00!
export const AI_DAILY_FREE_NEURONS = 10_000;
export const AI_USD_PER_1K_NEURONS = 0.011;
export const AI_MODEL_DIRECTOR = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const AI_MODEL_SIDE_GUIDE = '@cf/black-forest-labs/flux-2-klein-9b';
export const AI_NEURONS_DIRECTOR_EST = 32; // Live benchmarked: 28.84 Neurons ($0.000317)
export const AI_NEURONS_SIDE_GUIDE_EST = 1410; // Official 1MP 1024x1024 klein-9b ($0.0155)
const AI_MAX_DIRECT_GUEST_PER_DAY = 25;
const AI_MAX_DIRECT_USER_PER_DAY = 80;
const AI_MAX_SIDE_GUEST_PER_DAY = 3;
const AI_MAX_SIDE_USER_PER_DAY = 8;

const ALLOWED_FILM_ACTIONS = new Set([
  'walk-natural', 'trot', 'gallop', 'sprint', 'sneak-tiptoe',
  'fly-flap', 'soar-glide', 'dive', 'swim-cruise', 'slither', 'roll-drive',
  'idle-breathe', 'sit-rest', 'pounce-leap', 'startle-jump', 'roar-angry',
  'laugh-joy', 'cry-sad', 'talk-expressive', 'listen-nod', 'wave-greet',
  'turn-around-360', 'pickup-prop', 'hand-over-prop', 'fall-comedic', 'sleep-breathe',
  'walk', 'run', 'jump', 'talk', 'dance', 'wave', 'celebrate', 'idle',
]);

const ALLOWED_EMOTIONS = new Set(['neutral', 'happy', 'excited', 'surprised', 'angry', 'sad']);
const ALLOWED_CAMERAS = new Set(['wide', 'medium', 'closeup', 'low-angle', 'pan-follow']);
const ALLOWED_SCENES = new Set(['desk', 'meadow', 'night-city', 'stage', 'beach', 'forest', 'space']);
const ALLOWED_TRANSITIONS = new Set(['cut', 'dissolve', 'dip-to-black']);

export function computeBillableUsdForCall(todayNeuronsBefore, callNeurons) {
  const after = todayNeuronsBefore + callNeurons;
  if (after <= AI_DAILY_FREE_NEURONS) return 0;
  const billableNeurons = Math.max(0, after - Math.max(AI_DAILY_FREE_NEURONS, todayNeuronsBefore));
  return (billableNeurons / 1000) * AI_USD_PER_1K_NEURONS;
}

function utcDayAndMonthKeys(nowMs = Date.now()) {
  const iso = new Date(nowMs).toISOString();
  return { dayKey: iso.slice(0, 10), monthKey: iso.slice(0, 7) };
}

async function resolveAiActorIdentity(request, env) {
  try {
    const sess = env.DB ? await getSessionUser(request, env) : null;
    if (sess?.user?.id) {
      return { actorKey: `u:${sess.user.id}`, signedIn: true };
    }
  } catch {
    // Fallback cleanly to hashed IP
  }
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'local-guest';
  const ipHash = (await sha256Hex(`inktrope-ai-ip:${ip}`)).slice(0, 24);
  return { actorKey: `ip:${ipHash}`, signedIn: false };
}

export async function checkAiBudgetAndQuota(env, actorKey, signedIn, feature, estNeurons) {
  const { dayKey, monthKey } = utcDayAndMonthKeys();
  const limit =
    feature === 'direct_film'
      ? signedIn
        ? AI_MAX_DIRECT_USER_PER_DAY
        : AI_MAX_DIRECT_GUEST_PER_DAY
      : signedIn
        ? AI_MAX_SIDE_USER_PER_DAY
        : AI_MAX_SIDE_GUEST_PER_DAY;

  if (!env.DB) {
    return { allowed: true, used: 0, limit, billableUsd: 0, monthUsd: 0, todayNeurons: 0, dayKey, monthKey };
  }

  const [monthRow, dayRow, actorRow] = await Promise.all([
    env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total_usd FROM ai_usage_ledger WHERE month_key = ?`)
      .bind(monthKey)
      .first(),
    env.DB.prepare(`SELECT COALESCE(SUM(neurons), 0) AS total_neurons FROM ai_usage_ledger WHERE day_key = ?`)
      .bind(dayKey)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM ai_usage_ledger WHERE day_key = ? AND actor_key = ? AND feature = ?`
    )
      .bind(dayKey, actorKey, feature)
      .first(),
  ]);

  const monthUsd = Number(monthRow?.total_usd ?? 0);
  const todayNeurons = Number(dayRow?.total_neurons ?? 0);
  const used = Number(actorRow?.cnt ?? 0);
  const billableUsd = computeBillableUsdForCall(todayNeurons, estNeurons);

  if (monthUsd + billableUsd > AI_MONTHLY_HARD_CAP_USD) {
    return {
      allowed: false,
      reason: 'budget_capped',
      used,
      limit,
      billableUsd,
      monthUsd,
      todayNeurons,
      dayKey,
      monthKey,
    };
  }
  if (used >= limit) {
    return {
      allowed: false,
      reason: 'daily_limit',
      used,
      limit,
      billableUsd,
      monthUsd,
      todayNeurons,
      dayKey,
      monthKey,
    };
  }

  return { allowed: true, used, limit, billableUsd, monthUsd, todayNeurons, dayKey, monthKey };
}

async function recordAiLedger(env, dayKey, monthKey, actorKey, feature, model, neurons, costUsd) {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO ai_usage_ledger (month_key, day_key, actor_key, feature, model, neurons, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(monthKey, dayKey, actorKey, feature, model, neurons, costUsd, Date.now())
    .run();
}

function parseDataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  const mime = header.split(';')[0] || 'image/png';
  if (!header.includes('base64')) return null;
  const b64 = dataUrl.slice(comma + 1).trim();
  if (b64.length < 32 || b64.length > 720_000) return null;
  return { mime, b64, bytes: base64ToBytes(b64) };
}

function extractFirstJsonObject(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const stripped = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitizeDirectedScreenplay(raw, actors, fallbackTitle) {
  const validActorIds = actors.map((a) => String(a.id));
  const primaryId = validActorIds[0] || 'actor-1';
  const rawShots = Array.isArray(raw?.shots) ? raw.shots.slice(0, 8) : [];
  const shots = rawShots.map((s, idx) => {
    const dur = Math.max(1.8, Math.min(8.0, Number(s?.durationSec) || 3.2));
    const cam = ALLOWED_CAMERAS.has(String(s?.camera)) ? String(s.camera) : idx === 0 ? 'wide' : 'medium';
    const scene = ALLOWED_SCENES.has(String(s?.scene)) ? String(s.scene) : 'meadow';
    const transition = ALLOWED_TRANSITIONS.has(String(s?.transition)) ? String(s.transition) : 'cut';
    const rawTracks = Array.isArray(s?.actorTracks) ? s.actorTracks : [];
    const actorTracks = {};

    for (let ai = 0; ai < validActorIds.length; ai++) {
      const aid = validActorIds[ai];
      const match =
        rawTracks.find((t) => String(t?.actorId) === aid) ||
        rawTracks[ai] ||
        null;
      const action = ALLOWED_FILM_ACTIONS.has(String(match?.action))
        ? String(match.action)
        : ai === 0
          ? 'walk-natural'
          : 'idle-breathe';
      const emotion = ALLOWED_EMOTIONS.has(String(match?.emotion)) ? String(match.emotion) : 'neutral';
      const startX = Math.max(0.12, Math.min(0.88, Number(match?.startX) || (0.28 + ai * 0.14)));
      const endX = Math.max(0.12, Math.min(0.88, Number(match?.endX) || startX));
      const groundY = Math.max(0.68, Math.min(0.90, Number(match?.groundY) || (0.79 + (ai % 3) * 0.03)));
      const viewYawDeg = Math.max(-180, Math.min(180, Number(match?.viewYawDeg) || 0));
      const lookAtActorId =
        match?.lookAtActorId && validActorIds.includes(String(match.lookAtActorId)) && String(match.lookAtActorId) !== aid
          ? String(match.lookAtActorId)
          : null;
      const dialogue = typeof match?.dialogue === 'string' ? match.dialogue.trim().slice(0, 140) : '';
      actorTracks[aid] = {
        actorId: aid,
        action,
        emotion,
        startX,
        endX,
        groundY,
        viewYawDeg,
        lookAtActorId,
        dialogue,
      };
    }

    return {
      title: typeof s?.title === 'string' && s.title.trim() ? s.title.trim().slice(0, 60) : `Plan ${idx + 1}`,
      durationSec: dur,
      scene,
      camera: cam,
      transition,
      primaryActorId: validActorIds.includes(String(s?.primaryActorId)) ? String(s.primaryActorId) : primaryId,
      narration: typeof s?.narration === 'string' ? s.narration.trim().slice(0, 160) : '',
      actorTracks,
    };
  });

  return {
    title: typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : fallbackTitle,
    shots,
  };
}

async function handleAi(request, url, env) {
  const path = url.pathname;

  // GET /api/ai/status — safe status & user daily allowance (never exposes dollar totals or secrets!)
  if (request.method === 'GET' && path === '/api/ai/status') {
    const { actorKey, signedIn } = await resolveAiActorIdentity(request, env);
    const [filmQ, sideQ] = await Promise.all([
      checkAiBudgetAndQuota(env, actorKey, signedIn, 'direct_film', AI_NEURONS_DIRECTOR_EST),
      checkAiBudgetAndQuota(env, actorKey, signedIn, 'side_guide', AI_NEURONS_SIDE_GUIDE_EST),
    ]);
    return json({
      ok: true,
      aiAvailable: Boolean(env.AI),
      monthlyBudgetCapped: filmQ.reason === 'budget_capped' || sideQ.reason === 'budget_capped',
      quotas: {
        directFilm: { used: filmQ.used, limit: filmQ.limit, remaining: Math.max(0, filmQ.limit - filmQ.used) },
        sideGuide: { used: sideQ.used, limit: sideQ.limit, remaining: Math.max(0, sideQ.limit - sideQ.used) },
      },
    });
  }

  // All mutating AI routes enforce Same-Origin CSRF protection!
  if (request.method === 'POST' && !verifySameOrigin(request, url)) {
    return json({ error: 'Geçersiz istek kaynağı' }, 403);
  }

  // POST /api/ai/direct-film — Single-Command Multi-Actor 2.5D Film Director (0 pixels altered!)
  if (request.method === 'POST' && path === '/api/ai/direct-film') {
    const body = await readBoundedJson(request, 36_000);
    const prompt = String(body?.prompt || '').trim().slice(0, 900);
    if (prompt.length < 3) {
      return json({ ok: false, error: 'Lütfen kısa bir sahne fikri yaz.' }, 400);
    }
    const locale = body?.locale === 'en' ? 'en' : 'tr';
    const rawActors = Array.isArray(body?.actors) ? body.actors.slice(0, 6) : [];
    const actors =
      rawActors.length > 0
        ? rawActors.map((a, idx) => ({
            id: String(a?.id || `actor-${idx + 1}`).slice(0, 40),
            name: String(a?.name || `Oyuncu ${idx + 1}`).slice(0, 40),
            creatureClass: String(a?.creatureClass || 'humanoid').slice(0, 28),
            viewCount: Math.max(1, Math.min(4, Number(a?.viewCount) || 1)),
          }))
        : [{ id: 'actor-1', name: 'Başrol', creatureClass: 'humanoid', viewCount: 1 }];

    const byokKey = (request.headers.get('X-User-Gemini-Key') || '').trim();
    const actorSummary = actors
      .map((a) => `${a.id} (${a.name}, type=${a.creatureClass}, views=${a.viewCount})`)
      .join('; ');

    const systemPrompt = `You are INKTROPE's 2.5D animated film director. Convert the user's story prompt into a vivid 4 to 6 shot animated screenplay JSON.
STRICT JSON ONLY — no markdown fences, no commentary.
Language for title/narration/dialogue: ${locale === 'en' ? 'English' : 'Turkish'}.
Cast: ${actorSummary}
Allowed scene values: desk, meadow, night-city, stage, beach, forest, space
Allowed camera values: wide, medium, closeup, low-angle, pan-follow
Allowed transition values: cut, dissolve, dip-to-black
Allowed emotion values: neutral, happy, excited, surprised, angry, sad
Allowed action values: walk-natural, trot, gallop, sprint, sneak-tiptoe, fly-flap, soar-glide, dive, swim-cruise, slither, roll-drive, idle-breathe, sit-rest, pounce-leap, startle-jump, roar-angry, laugh-joy, cry-sad, talk-expressive, listen-nod, wave-greet, turn-around-360, pickup-prop, hand-over-prop, fall-comedic, sleep-breathe
Match creature actions naturally (e.g. avian_winged -> fly-flap/soar-glide, quadruped -> trot/gallop/pounce-leap, aquatic_fish -> swim-cruise/dive, serpentine_tentacle -> slither, biped_tailed -> walk-natural/roar-angry, amorphous_vehicle -> roll-drive).
Use viewYawDeg (-180..180: 0=front, 90=right side, -90=left side, 180=back) to direct expressive 2.5D turns!
Schema:
{"title":"string","shots":[{"title":"string","durationSec":3.2,"scene":"meadow","camera":"wide","transition":"cut","primaryActorId":"${actors[0].id}","narration":"short line","actorTracks":[{"actorId":"${actors[0].id}","action":"walk-natural","emotion":"happy","startX":0.25,"endX":0.55,"groundY":0.80,"viewYawDeg":45,"lookAtActorId":null,"dialogue":"short speech or empty"}]}]}`;

    // Optional BYOK Gemini path ($0 server cost, key is NEVER stored or logged!)
    if (byokKey.length >= 20) {
      const gRes = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': byokKey,
          'Api-Revision': '2026-05-20',
        },
        body: JSON.stringify({
          model: 'gemini-3.8-flash-lite',
          input: `${systemPrompt}\n\nUSER STORY:\n${prompt}`,
        }),
      });
      if (!gRes.ok) {
        return json({ ok: false, code: 'byok_error', error: 'Kişisel Gemini anahtarı yanıt vermedi.' }, 502);
      }
      const gJson = await gRes.json();
      const textOut =
        gJson?.outputs?.find((o) => typeof o?.text === 'string')?.text ||
        JSON.stringify(gJson);
      const parsed = extractFirstJsonObject(textOut);
      if (!parsed || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
        return json({ ok: false, code: 'parse_error', error: 'Senaryo biçimlendirilemedi.' }, 502);
      }
      return json({
        ok: true,
        source: 'byok-gemini',
        screenplay: sanitizeDirectedScreenplay(parsed, actors, prompt.slice(0, 48)),
      });
    }

    if (!env.AI) {
      return json({ ok: false, code: 'ai_unavailable', error: 'Yerel hızlı yönetmen kullanılıyor.' }, 503);
    }

    const { actorKey, signedIn } = await resolveAiActorIdentity(request, env);
    const guard = await checkAiBudgetAndQuota(env, actorKey, signedIn, 'direct_film', AI_NEURONS_DIRECTOR_EST);
    if (!guard.allowed) {
      return json(
        {
          ok: false,
          code: guard.reason,
          error:
            locale === 'en'
              ? 'Daily AI director quota reached. Instant local film studio stays unlimited!'
              : 'Günlük AI yönetmen hakkı doldu. Yerel film yönetmeni sınırsız açık!',
        },
        429
      );
    }

    const aiResp = await env.AI.run(AI_MODEL_DIRECTOR, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1400,
      temperature: 0.45,
    });

    // Cloudflare Workers AI can return `response` as an already-parsed JSON object OR a string,
    // or OpenAI-compatible `choices[0].message.content`. Handle all three cleanly!
    let parsed = null;
    if (aiResp && typeof aiResp === 'object' && aiResp.response && typeof aiResp.response === 'object') {
      parsed = aiResp.response;
    } else if (typeof aiResp?.response === 'string') {
      parsed = extractFirstJsonObject(aiResp.response);
    } else if (typeof aiResp?.choices?.[0]?.message?.content === 'string') {
      parsed = extractFirstJsonObject(aiResp.choices[0].message.content);
    } else if (aiResp && Array.isArray(aiResp.shots)) {
      parsed = aiResp;
    } else if (typeof aiResp === 'string') {
      parsed = extractFirstJsonObject(aiResp);
    }
    if (parsed && !Array.isArray(parsed.shots) && parsed.response && Array.isArray(parsed.response.shots)) {
      parsed = parsed.response;
    }
    if (!parsed || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
      return json({ ok: false, code: 'parse_error', error: 'Senaryo ayrıştırılamadı.' }, 502);
    }

    await recordAiLedger(
      env,
      guard.dayKey,
      guard.monthKey,
      actorKey,
      'direct_film',
      AI_MODEL_DIRECTOR,
      AI_NEURONS_DIRECTOR_EST,
      guard.billableUsd
    );

    return json({
      ok: true,
      source: 'cloudflare-llama-3.3-70b',
      screenplay: sanitizeDirectedScreenplay(parsed, actors, prompt.slice(0, 48)),
    });
  }

  // POST /api/ai/side-guide — Strictly OPTIONAL Side/Back Guide (FLUX.2 Klein 9B + SHA-256 Cache + $19 Cap!)
  if (request.method === 'POST' && path === '/api/ai/side-guide') {
    const body = await readBoundedJson(request, 760_000);
    const imgParsed = parseDataUrlBytes(body?.imageDataUrl);
    if (!imgParsed) {
      return json({ ok: false, error: 'Geçerli bir karakter görseli gerekli.' }, 400);
    }
    const creatureClass = String(body?.creatureClass || 'humanoid').slice(0, 28);
    const targetAngle = ['side', 'back', 'threeQuarter'].includes(String(body?.targetAngle))
      ? String(body.targetAngle)
      : 'side';
    const byokFullTurnaround = Boolean(body?.byokFullTurnaround);
    const byokKey = (request.headers.get('X-User-Gemini-Key') || '').trim();

    const angleDesc =
      targetAngle === 'back'
        ? 'exact 180-degree rear back view standing in the exact same neutral pose, facing directly away from camera'
        : targetAngle === 'threeQuarter'
          ? 'exact 45-degree three-quarter view standing in the exact same neutral pose, facing slightly right'
          : 'exact 90-degree clean side profile view facing right, full body visible from head to feet';

    const guidePrompt = `Keep the EXACT same hand-drawn character identity, proportions, outfit, colors, ink line weight, and artistic medium from image 0. Draw ONLY the ${angleDesc} of this exact ${creatureClass.replace('_', ' ')} character on a plain solid pure white background, centered full body with matching head height and foot baseline, zero background props, zero text, zero extra characters.`;

    // 1) Check D1 SHA-256 turnaround cache FIRST (0 Neurons, $0, doesn't spend daily allowance!)
    const cacheKey = await sha256Hex(
      `v4-side-guide|${creatureClass}|${targetAngle}|${byokFullTurnaround ? '4x1' : '1x1'}|${imgParsed.b64}`
    );
    if (env.DB && !byokKey) {
      const cached = await env.DB.prepare(
        `SELECT mime_type, data_b64, model FROM ai_turnaround_cache WHERE cache_key = ? LIMIT 1`
      )
        .bind(cacheKey)
        .first();
      if (cached?.data_b64) {
        await env.DB.prepare(
          `UPDATE ai_turnaround_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?`
        )
          .bind(Date.now(), cacheKey)
          .run()
          .catch(() => {});
        return json({
          ok: true,
          cached: true,
          source: cached.model || AI_MODEL_SIDE_GUIDE,
          imageDataUrl: `data:${cached.mime_type || 'image/png'};base64,${cached.data_b64}`,
        });
      }
    }

    // 2) Optional BYOK Gemini Nano Banana 2.1 ($0 server cost, key NEVER stored or logged!)
    if (byokKey.length >= 20) {
      const nanoPrompt = byokFullTurnaround
        ? `Create a 4-panel horizontal character turnaround sheet (Front, Three-Quarter Right, Right Side Profile, Back) of this EXACT hand-drawn character, preserving every line, color, and proportion identically on pure white background with matching head and foot alignment.`
        : guidePrompt;
      const gRes = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': byokKey,
          'Api-Revision': '2026-05-20',
        },
        body: JSON.stringify({
          model: 'gemini-nano-banana-2.1',
          input: [
            { type: 'image', data: imgParsed.b64, mime_type: imgParsed.mime },
            { type: 'text', text: nanoPrompt },
          ],
          response_format: {
            type: 'image',
            aspect_ratio: byokFullTurnaround ? '4:1' : '1:1',
            image_size: byokFullTurnaround ? '2K' : '1K',
          },
        }),
      });
      if (!gRes.ok) {
        return json({ ok: false, code: 'byok_error', error: 'Kişisel Gemini görsel anahtarı yanıt vermedi.' }, 502);
      }
      const gJson = await gRes.json();
      const imgOut = (gJson?.outputs || []).find((o) => o?.type === 'image' && o?.data);
      if (!imgOut?.data) {
        return json({ ok: false, code: 'empty_image', error: 'Görsel taslak alınamadı.' }, 502);
      }
      return json({
        ok: true,
        cached: false,
        source: 'byok-gemini-nano-banana-2.1',
        isMultiSheet: byokFullTurnaround,
        imageDataUrl: `data:${imgOut.mime_type || 'image/png'};base64,${imgOut.data}`,
      });
    }

    if (!env.AI) {
      return json({ ok: false, code: 'ai_unavailable', error: 'AI taslak servisi şu an çevrimdışı.' }, 503);
    }

    // 3) Enforce fair daily cap & $19.00 HARD monthly circuit breaker!
    const { actorKey, signedIn } = await resolveAiActorIdentity(request, env);
    const guard = await checkAiBudgetAndQuota(env, actorKey, signedIn, 'side_guide', AI_NEURONS_SIDE_GUIDE_EST);
    if (!guard.allowed) {
      return json(
        {
          ok: false,
          code: guard.reason,
          error: 'Günlük AI taslak hakkı doldu. Elle çizim, çoklu poz ve film motoru sınırsız açık!',
        },
        429
      );
    }

    // 4) Call FLUX.2 Klein 9B via official Cloudflare Workers AI multipart binding
    const form = new FormData();
    form.append('input_image_0', new Blob([imgParsed.bytes], { type: imgParsed.mime }), 'character.png');
    form.append('prompt', guidePrompt);
    form.append('width', '1024');
    form.append('height', '1024');
    const formRes = new Response(form);
    const aiResp = await env.AI.run(AI_MODEL_SIDE_GUIDE, {
      multipart: {
        body: formRes.body,
        contentType: formRes.headers.get('content-type'),
      },
    });

    let outB64 = '';
    let outMime = 'image/png';
    if (aiResp && typeof aiResp.image === 'string') {
      outB64 = aiResp.image;
      outMime = outB64.startsWith('/9j/') ? 'image/jpeg' : 'image/png';
    } else if (aiResp instanceof Uint8Array || aiResp instanceof ArrayBuffer) {
      const u8 = aiResp instanceof Uint8Array ? aiResp : new Uint8Array(aiResp);
      outB64 = bytesToBase64(u8);
      outMime = u8[0] === 0xff && u8[1] === 0xd8 ? 'image/jpeg' : 'image/png';
    } else if (aiResp && typeof aiResp.getReader === 'function') {
      const buf = new Uint8Array(await new Response(aiResp).arrayBuffer());
      outB64 = bytesToBase64(buf);
      outMime = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
    }

    if (!outB64) {
      return json({ ok: false, code: 'empty_image', error: 'AI taslak üretilemedi.' }, 502);
    }

    await recordAiLedger(
      env,
      guard.dayKey,
      guard.monthKey,
      actorKey,
      'side_guide',
      AI_MODEL_SIDE_GUIDE,
      AI_NEURONS_SIDE_GUIDE_EST,
      guard.billableUsd
    );

    // Cache compactly in D1 if <= 680 KB base64 (well under D1's 1 MB row limit!)
    if (env.DB && outB64.length <= 680_000) {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT OR REPLACE INTO ai_turnaround_cache (cache_key, model, mime_type, data_b64, hit_count, created_at, last_hit_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`
      )
        .bind(cacheKey, AI_MODEL_SIDE_GUIDE, outMime, outB64, now, now)
        .run()
        .catch(() => {});
    }

    return json({
      ok: true,
      cached: false,
      source: AI_MODEL_SIDE_GUIDE,
      imageDataUrl: `data:${outMime};base64,${outB64}`,
    });
  }

  return json({ error: 'Bulunamadı' }, 404);
}

const MAX_SHARE_PAYLOAD_CHARS = 524_288; // <= 512 KB compressed base64url
const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SHARE_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
let shareTableEnsured = false;

async function ensureShareTable(env) {
  if (shareTableEnsured || !env.DB) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS shared_snapshots (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_b64 TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      ip_hash TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`
  ).run();
  shareTableEnsured = true;
}

async function handleShare(request, url, env) {
  if (!env.DB) {
    return json({ error: 'Paylaşım depolaması yapılandırılmamış.' }, 503);
  }
  await ensureShareTable(env);
  const now = Date.now();

  if (request.method === 'POST' && (url.pathname === '/api/share' || url.pathname === '/api/share/')) {
    const contentLength = Number(request.headers.get('content-length') || '0');
    if (contentLength > MAX_SHARE_PAYLOAD_CHARS + 4096) {
      return json({ error: 'Paylaşım paketi 512 KB sınırını aşıyor.' }, 413);
    }

    let body;
    try {
      const rawText = await request.text();
      if (rawText.length > MAX_SHARE_PAYLOAD_CHARS + 4096) {
        return json({ error: 'Paylaşım paketi 512 KB sınırını aşıyor.' }, 413);
      }
      body = JSON.parse(rawText);
    } catch {
      return json({ error: 'Geçersiz JSON yükü.' }, 400);
    }

    const kind = body && typeof body.kind === 'string' ? body.kind : '';
    const payloadB64 = body && typeof body.payloadB64 === 'string' ? body.payloadB64.trim() : '';
    const mimeType =
      body && typeof body.mimeType === 'string'
        ? body.mimeType.trim()
        : 'application/x-inktrope-snapshot';

    if (kind !== 'project' && kind !== 'stage-image') {
      return json({ error: 'Geçersiz paylaşım türü.' }, 400);
    }
    if (!payloadB64 || payloadB64.length < 8 || !BASE64URL_RE.test(payloadB64)) {
      return json({ error: 'Geçersiz sıkıştırılmış paylaşım verisi.' }, 400);
    }
    if (payloadB64.length > MAX_SHARE_PAYLOAD_CHARS) {
      return json({ error: 'Paylaşım paketi 512 KB sınırını aşıyor.' }, 413);
    }
    if (mimeType !== 'application/x-inktrope-snapshot') {
      return json({ error: 'İzin verilmeyen MIME türü.' }, 400);
    }

    const clientIp =
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For') ||
      'anon';
    const ipHash = (await sha256Hex('share:' + clientIp)).slice(0, 24);

    // Opportunistic expired snapshot cleanup + IP rate-limit (<= 30 creations per 10 minutes)
    await env.DB.prepare('DELETE FROM shared_snapshots WHERE expires_at < ?')
      .bind(now)
      .run()
      .catch(() => {});

    const recentRow = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM shared_snapshots WHERE ip_hash = ? AND created_at > ?'
    )
      .bind(ipHash, now - 10 * 60 * 1000)
      .first()
      .catch(() => ({ cnt: 0 }));
    if (recentRow && Number(recentRow.cnt) >= 30) {
      return json({ error: 'Çok sık paylaşım oluşturuldu — birkaç dakika sonra tekrar dene.' }, 429);
    }

    const id = bytesToBase64Url(randomBytes(8)).slice(0, 10);
    const expiresAt = now + SHARE_TTL_MS;
    const approxBytes = Math.floor((payloadB64.length * 3) / 4);

    await env.DB.prepare(
      `INSERT INTO shared_snapshots (id, kind, payload_b64, mime_type, byte_size, ip_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, kind, payloadB64, mimeType, approxBytes, ipHash, now, expiresAt)
      .run();

    return json({ ok: true, id, expiresAt }, 201);
  }

  if (request.method === 'GET' && url.pathname.startsWith('/api/share/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/share/'.length)).trim();
    if (!SHARE_ID_RE.test(id)) {
      return json({ error: 'Geçersiz paylaşım kodu.' }, 400);
    }
    const row = await env.DB.prepare(
      'SELECT id, kind, payload_b64, mime_type, byte_size, expires_at FROM shared_snapshots WHERE id = ?'
    )
      .bind(id)
      .first();

    if (!row || Number(row.expires_at) < now) {
      return json({ error: 'Paylaşım bağlantısı bulunamadı veya süresi doldu.' }, 404);
    }
    return json(
      {
        ok: true,
        id: row.id,
        kind: row.kind,
        payloadB64: row.payload_b64,
        mimeType: 'application/x-inktrope-snapshot',
        byteSize: row.byte_size,
      },
      200,
      { 'Cache-Control': 'public, max-age=3600' }
    );
  }

  return json({ error: 'Bulunamadı' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/auth/')) {
        return await handleAuth(request, url, env, ctx);
      }
      if (url.pathname.startsWith('/api/cloud/')) {
        return await handleCloud(request, url, env);
      }
      if (url.pathname.startsWith('/api/ai/')) {
        return await handleAi(request, url, env);
      }
      if (url.pathname === '/api/share' || url.pathname.startsWith('/api/share/')) {
        return await handleShare(request, url, env);
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof ResponseError) {
        return json({ error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(JSON.stringify({ event: 'worker_unhandled_error', path: url.pathname, message }));
      return json({ error: 'Sunucu hatası oluştu, lütfen tekrar dene.' }, 500);
    }
  },
};
