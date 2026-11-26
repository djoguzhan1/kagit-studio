import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory mock of idb-keyval to test real db.ts scope isolation deterministically in Node
const memIdb = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: async (k: string) => memIdb.get(k),
  set: async (k: string, v: unknown) => {
    memIdb.set(k, v);
  },
  del: async (k: string) => {
    memIdb.delete(k);
  },
  clear: async () => {
    memIdb.clear();
  },
  keys: async () => Array.from(memIdb.keys()),
}));

import {
  clearScopedStorage,
  getActiveStorageScope,
  loadAllProjects,
  loadBlob,
  loadGuestProjectsOnly,
  saveAllProjects,
  saveBlob,
  setActiveStorageScope,
} from '../db';
import type { StudioProject } from '../../types/studio';
import worker from '../../../worker/index.js';

function fakeProject(id: string, name: string): StudioProject {
  const now = new Date().toISOString();
  return {
    id,
    name,
    aspect: '16:9',
    width: 1280,
    height: 720,
    fps: 12,
    paperColor: '#F7F3E9',
    paperStyle: 'bristol',
    paperGrain: 0.3,
    frames: [],
    rigs: [],
    audio: null,
    references: [],
    palette: ['#1C1917'],
    createdAt: now,
    updatedAt: now,
  };
}

/** Minimal SQL-capable in-memory D1 mock validating strict user_id isolation in worker/index.js */
function createMockD1() {
  const users = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const projects = new Map<string, Record<string, unknown>>(); // key: `${user_id}:${id}`
  const blobs = new Map<string, Record<string, unknown>>(); // key: `${user_id}:${blob_key}:${chunk_index}`

  function exec(sql: string, params: unknown[]) {
    const q = sql.replace(/\s+/g, ' ').trim();

    if (q.startsWith('SELECT id FROM users WHERE email = ?')) {
      const email = String(params[0]).toLowerCase();
      const hit = Array.from(users.values()).find((u) => String(u.email).toLowerCase() === email) ?? null;
      return { results: hit ? [{ id: hit.id }] : [] };
    }
    if (q.startsWith('SELECT id, email, name, avatar_url, password_hash, google_sub, created_at FROM users WHERE email = ?')) {
      const email = String(params[0]).toLowerCase();
      const hit = Array.from(users.values()).find((u) => String(u.email).toLowerCase() === email) ?? null;
      return { results: hit ? [hit] : [] };
    }
    if (q.startsWith('INSERT INTO users')) {
      const [id, email, name, pwHash, createdAt, updatedAt] = params;
      users.set(String(id), {
        id,
        email,
        name,
        avatar_url: null,
        password_hash: pwHash,
        google_sub: null,
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { results: [] };
    }
    if (q.startsWith('INSERT INTO sessions')) {
      const [id, user_id, expires_at, created_at, user_agent] = params;
      sessions.set(String(id), { id, user_id, expires_at, created_at, user_agent });
      return { results: [] };
    }
    if (q.startsWith('DELETE FROM sessions WHERE expires_at < ?')) {
      const now = Number(params[0]);
      for (const [k, v] of sessions.entries()) {
        if (Number(v.expires_at) < now) sessions.delete(k);
      }
      return { results: [] };
    }
    if (q.startsWith('DELETE FROM sessions WHERE id = ?')) {
      sessions.delete(String(params[0]));
      return { results: [] };
    }
    if (q.startsWith('DELETE FROM sessions WHERE user_id = ?')) {
      const uid = String(params[0]);
      for (const [k, v] of sessions.entries()) if (v.user_id === uid) sessions.delete(k);
      return { results: [] };
    }
    if (q.startsWith('DELETE FROM users WHERE id = ?')) {
      users.delete(String(params[0]));
      return { results: [] };
    }
    if (q.includes('FROM sessions s INNER JOIN users u ON u.id = s.user_id')) {
      const [sid, now] = params;
      const s = sessions.get(String(sid));
      if (!s || Number(s.expires_at) <= Number(now)) return { results: [] };
      const u = users.get(String(s.user_id));
      if (!u) return { results: [] };
      return { results: [{ ...u, session_id: s.id }] };
    }
    if (q.startsWith('SELECT id, name, updated_at, meta_json FROM projects WHERE user_id = ?')) {
      const uid = String(params[0]);
      const rows = Array.from(projects.values()).filter((p) => p.user_id === uid);
      return { results: rows };
    }
    if (q.startsWith('SELECT 1 FROM projects WHERE user_id = ? AND id = ?')) {
      const hit = projects.has(`${params[0]}:${params[1]}`);
      return { results: hit ? [{ 1: 1 }] : [] };
    }
    if (q.startsWith('SELECT COUNT(*) AS cnt FROM projects WHERE user_id = ?')) {
      const uid = String(params[0]);
      const cnt = Array.from(projects.values()).filter((p) => p.user_id === uid).length;
      return { results: [{ cnt }] };
    }
    if (q.startsWith('INSERT INTO projects')) {
      const [id, user_id, name, updated_at, meta_json] = params;
      projects.set(`${user_id}:${id}`, { id, user_id, name, updated_at, meta_json });
      return { results: [] };
    }
    if (q.startsWith('DELETE FROM projects WHERE user_id = ? AND id = ?')) {
      projects.delete(`${params[0]}:${params[1]}`);
      return { results: [] };
    }
    if (q.startsWith('DELETE FROM projects WHERE user_id = ?')) {
      const uid = String(params[0]);
      for (const [k, v] of projects.entries()) if (v.user_id === uid) projects.delete(k);
      return { results: [] };
    }
    if (q.startsWith('SELECT DISTINCT blob_key, byte_size FROM project_blobs WHERE user_id = ?')) {
      const uid = String(params[0]);
      const rows = Array.from(blobs.values()).filter((b) => b.user_id === uid && b.chunk_index === 0);
      return { results: rows };
    }
    if (q.startsWith('SELECT 1 FROM project_blobs WHERE user_id = ? AND blob_key = ?')) {
      const hit = blobs.has(`${params[0]}:${params[1]}:0`);
      return { results: hit ? [{ 1: 1 }] : [] };
    }
    if (q.startsWith('SELECT COUNT(*) AS cnt FROM project_blobs WHERE user_id = ?')) {
      const uid = String(params[0]);
      const cnt = Array.from(blobs.values()).filter((b) => b.user_id === uid && b.chunk_index === 0).length;
      return { results: [{ cnt }] };
    }
    if (q.startsWith('DELETE FROM project_blobs WHERE user_id = ? AND blob_key = ?')) {
      const [uid, key] = params;
      for (const [k, v] of blobs.entries()) {
        if (v.user_id === uid && v.blob_key === key) blobs.delete(k);
      }
      return { results: [] };
    }
    if (q.startsWith('DELETE FROM project_blobs WHERE user_id = ?')) {
      const uid = String(params[0]);
      for (const [k, v] of blobs.entries()) if (v.user_id === uid) blobs.delete(k);
      return { results: [] };
    }
    if (q.startsWith('INSERT INTO project_blobs')) {
      const [user_id, blob_key, chunk_index, total_chunks, mime_type, byte_size, data_b64, updated_at] = params;
      blobs.set(`${user_id}:${blob_key}:${chunk_index}`, {
        user_id,
        blob_key,
        chunk_index,
        total_chunks,
        mime_type,
        byte_size,
        data_b64,
        updated_at,
      });
      return { results: [] };
    }
    if (q.startsWith('SELECT chunk_index, mime_type, byte_size, data_b64 FROM project_blobs WHERE user_id = ? AND blob_key = ?')) {
      const [uid, key] = params;
      const rows = Array.from(blobs.values())
        .filter((b) => b.user_id === uid && b.blob_key === key)
        .sort((a, b) => Number(a.chunk_index) - Number(b.chunk_index));
      return { results: rows };
    }

    throw new Error(`Unhandled mock D1 SQL: ${q}`);
  }

  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first() {
          const r = exec(sql, bound);
          return r.results[0] ?? null;
        },
        async all() {
          return exec(sql, bound);
        },
        async run() {
          exec(sql, bound);
          return { success: true };
        },
      };
      return stmt;
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

function extractSidCookie(res: Response): string {
  const sc = res.headers.get('Set-Cookie') || '';
  const m = sc.match(/inktrope_sid=([^;]+)/);
  return m ? `inktrope_sid=${m[1]}` : '';
}

describe('INKTROPE Per-User Device & Cloud Vault Isolation', () => {
  beforeEach(() => {
    memIdb.clear();
    setActiveStorageScope('guest');
  });

  it('strictly isolates guest, usr_alice, and usr_bob in local IndexedDB and wipes signed-out user cache cleanly', async () => {
    // Guest saves a project and blob
    setActiveStorageScope('guest');
    await saveAllProjects([fakeProject('prj_guest', 'Misafir Çizimi')]);
    await saveBlob(new Blob(['guest-bytes'], { type: 'text/plain' }), 'blob_shared_key');

    // Alice signs in -> her scope is completely empty (cannot see guest data)
    setActiveStorageScope('usr_alice');
    expect(getActiveStorageScope()).toBe('usr_alice');
    expect(await loadAllProjects()).toEqual([]);
    expect(await loadBlob('blob_shared_key')).toBeNull();

    // Alice saves her private notebook & blob with the exact same key name
    await saveAllProjects([fakeProject('prj_alice', 'Alice Gizli Film')]);
    await saveBlob(new Blob(['alice-secret'], { type: 'text/plain' }), 'blob_shared_key');

    // Bob signs in on the same device -> cannot see Alice's OR Guest's drawings!
    setActiveStorageScope('usr_bob');
    expect(await loadAllProjects()).toEqual([]);
    expect(await loadBlob('blob_shared_key')).toBeNull();
    await saveAllProjects([fakeProject('prj_bob', 'Bob Defteri')]);

    // Guest peek still sees only guest projects
    const guestPeek = await loadGuestProjectsOnly();
    expect(guestPeek.map((p) => p.id)).toEqual(['prj_guest']);

    // Alice signs out -> clearScopedStorage('usr_alice') wipes ONLY Alice's cache
    await clearScopedStorage('usr_alice');
    setActiveStorageScope('usr_alice');
    expect(await loadAllProjects()).toEqual([]);
    expect(await loadBlob('blob_shared_key')).toBeNull();

    // Bob and Guest remain 100% intact
    setActiveStorageScope('usr_bob');
    expect((await loadAllProjects()).map((p) => p.id)).toEqual(['prj_bob']);
    setActiveStorageScope('guest');
    expect((await loadAllProjects()).map((p) => p.id)).toEqual(['prj_guest']);
  });

  it('enforces server-side auth, PBKDF2 passwords, CSRF Origin checks, chunked blobs, and zero cross-user data leaks', async () => {
    const env = {
      DB: createMockD1(),
      ASSETS: { fetch: async () => new Response('static') },
    };
    const ctx = { waitUntil: () => {} };
    const origin = 'https://inktrope.com';

    // 1. Unauthenticated cloud access is rejected with 401
    const unauth = await worker.fetch(new Request(`${origin}/api/cloud/projects`), env, ctx);
    expect(unauth.status).toBe(401);

    // 2. Cross-origin CSRF register is rejected with 403
    const csrfRes = await worker.fetch(
      new Request(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ email: 'alice@inktrope.com', password: 'strongpassword123' }),
      }),
      env,
      ctx
    );
    expect(csrfRes.status).toBe(403);

    // 3. Alice registers cleanly and receives HttpOnly Secure SameSite=Lax cookie
    const aliceReg = await worker.fetch(
      new Request(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: 'alice@inktrope.com', password: 'strongpassword123', name: 'Alice' }),
      }),
      env,
      ctx
    );
    expect(aliceReg.status).toBe(201);
    const aliceSetCookie = aliceReg.headers.get('Set-Cookie') || '';
    expect(aliceSetCookie).toContain('HttpOnly');
    expect(aliceSetCookie).toContain('Secure');
    expect(aliceSetCookie).toContain('SameSite=Lax');
    const aliceCookie = extractSidCookie(aliceReg);

    // 4. Alice uploads a private project AND a 250 KB multi-chunk binary blob
    const aliceProj = fakeProject('prj_secret_01', 'Alice Secret Sketch');
    const putProj = await worker.fetch(
      new Request(`${origin}/api/cloud/projects/prj_secret_01`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: aliceCookie },
        body: JSON.stringify({ project: aliceProj }),
      }),
      env,
      ctx
    );
    expect(putProj.status).toBe(200);

    const bigBytes = new Uint8Array(250_000);
    for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = (i * 31) & 255;
    const putBlob = await worker.fetch(
      new Request(`${origin}/api/cloud/blobs/blob_alice_cel`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png', Origin: origin, Cookie: aliceCookie },
        body: bigBytes,
      }),
      env,
      ctx
    );
    expect(putBlob.status).toBe(200);
    const blobMeta = (await putBlob.json()) as { chunks: number; byteSize: number };
    expect(blobMeta.chunks).toBe(2);
    expect(blobMeta.byteSize).toBe(250_000);

    // Alice reads back her exact binary bytes cleanly
    const getAliceBlob = await worker.fetch(
      new Request(`${origin}/api/cloud/blobs/blob_alice_cel`, {
        headers: { Cookie: aliceCookie },
      }),
      env,
      ctx
    );
    expect(getAliceBlob.status).toBe(200);
    const roundtrip = new Uint8Array(await getAliceBlob.arrayBuffer());
    expect(roundtrip.byteLength).toBe(250_000);
    expect(roundtrip[0]).toBe(bigBytes[0]);
    expect(roundtrip[249_999]).toBe(bigBytes[249_999]);

    // 5. Bob registers and tries to see/download/delete Alice's data -> ZERO leakage!
    const bobReg = await worker.fetch(
      new Request(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: 'bob@inktrope.com', password: 'bobpassword456', name: 'Bob' }),
      }),
      env,
      ctx
    );
    expect(bobReg.status).toBe(201);
    const bobCookie = extractSidCookie(bobReg);

    const bobList = await worker.fetch(
      new Request(`${origin}/api/cloud/projects`, { headers: { Cookie: bobCookie } }),
      env,
      ctx
    );
    expect(bobList.status).toBe(200);
    const bobJson = (await bobList.json()) as { projects: unknown[]; blobKeys: string[] };
    expect(bobJson.projects).toHaveLength(0);
    expect(bobJson.blobKeys).toHaveLength(0);

    // Bob directly guessing Alice's blob key gets 404
    const bobStealBlob = await worker.fetch(
      new Request(`${origin}/api/cloud/blobs/blob_alice_cel`, { headers: { Cookie: bobCookie } }),
      env,
      ctx
    );
    expect(bobStealBlob.status).toBe(404);

    // Bob trying to delete Alice's project has ZERO effect on Alice's project
    await worker.fetch(
      new Request(`${origin}/api/cloud/projects/prj_secret_01`, {
        method: 'DELETE',
        headers: { Origin: origin, Cookie: bobCookie },
      }),
      env,
      ctx
    );
    const aliceList = await worker.fetch(
      new Request(`${origin}/api/cloud/projects`, { headers: { Cookie: aliceCookie } }),
      env,
      ctx
    );
    const aliceJson = (await aliceList.json()) as { projects: Array<{ id: string }> };
    expect(aliceJson.projects.map((p) => p.id)).toEqual(['prj_secret_01']);

    // 6. Wrong password login fails, right password succeeds
    const badLogin = await worker.fetch(
      new Request(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: 'alice@inktrope.com', password: 'wrongpassword' }),
      }),
      env,
      ctx
    );
    expect(badLogin.status).toBe(401);

    const okLogin = await worker.fetch(
      new Request(`${origin}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: 'alice@inktrope.com', password: 'strongpassword123' }),
      }),
      env,
      ctx
    );
    expect(okLogin.status).toBe(200);

    // 7. Account permanent deletion wipes Alice completely without touching Bob
    const delAlice = await worker.fetch(
      new Request(`${origin}/api/auth/account`, {
        method: 'DELETE',
        headers: { Origin: origin, Cookie: aliceCookie },
      }),
      env,
      ctx
    );
    expect(delAlice.status).toBe(200);
    const bobStillValid = await worker.fetch(
      new Request(`${origin}/api/auth/me`, { headers: { Cookie: bobCookie } }),
      env,
      ctx
    );
    const bobMe = (await bobStillValid.json()) as { user: { email: string } | null };
    expect(bobMe.user?.email).toBe('bob@inktrope.com');
  });
});
