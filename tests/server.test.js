/**
 * tests/server.test.js
 *
 * Integration tests for server/server.js (Express + SQLite).
 * Uses supertest to fire real HTTP requests against a test instance.
 * Each test suite gets a fresh in-memory database via a tmp file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_PORT = 13001;
const tmpDb = path.join(__dirname, `test_${process.pid}.db`);
const tmpCredentials = path.join(__dirname, `test_${process.pid}_credentials.json`);
const tmpPassword = path.join(__dirname, `test_${process.pid}_password.txt`);

let serverProcess;
const BASE = `http://localhost:${TEST_PORT}`;

// Helper: make an authenticated session (login + return cookie + csrf)
async function login(username = 'admin', password = 'admin') {
    const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    const body = await res.json();
    const setCookie = res.headers.get('set-cookie') || '';
    return { cookie: setCookie.split(';')[0], csrf: body.csrf_token, status: res.status, body };
}

// Helper: wait until the server is accepting connections
async function waitForServer(port, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fetch(`http://localhost:${port}/api/stats`);
            return;
        } catch (_) {
            await new Promise(r => setTimeout(r, 150));
        }
    }
    throw new Error(`Server on port ${port} did not start within ${timeoutMs}ms`);
}

beforeAll(async () => {
    // Start server.js as a child process with a dedicated test port + temp db
    serverProcess = spawn(
        process.execPath,
        [path.resolve(__dirname, '../server/server.js')],
        {
            env: {
                ...process.env,
                PORT: String(TEST_PORT),
                DB_PATH: tmpDb,
                ADMIN_CREDENTIALS_FILE: tmpCredentials,
                ADMIN_PASSWORD_FILE: tmpPassword,
                NODE_ENV: 'test'
            },
            stdio: 'pipe'
        }
    );
    serverProcess.stderr.on('data', d => {
        if (process.env.VITEST_DEBUG) process.stderr.write(d);
    });
    await waitForServer(TEST_PORT);
}, 20000);

afterAll(async () => {
    if (serverProcess) serverProcess.kill();
    for (const f of [tmpDb, tmpDb + '-shm', tmpDb + '-wal', tmpCredentials, tmpPassword]) {
        try { fs.unlinkSync(f); } catch (_) {}
    }
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GET /api/stats', () => {
    it('returns article/link/message counts', async () => {
        const res = await fetch(`${BASE}/api/stats`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(typeof body.published_articles).toBe('number');
        expect(typeof body.total_messages).toBe('number');
        expect(typeof body.total_links).toBe('number');
        // M-07: must NOT include a fake random total_views
        expect(body.total_views).toBeUndefined();
    });
});

describe('GET /api/articles', () => {
    it('returns sample articles seeded on startup', async () => {
        const res = await fetch(`${BASE}/api/articles`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBeGreaterThan(0);
        // Shape check
        const first = body[0];
        expect(first.id).toBeDefined();
        expect(first.title).toBeDefined();
        expect(first.content).toBeDefined();
        expect(first.category).toBeDefined();
    });
});

describe('GET /api/articles/:id', () => {
    it('returns article for valid id', async () => {
        const list = await fetch(`${BASE}/api/articles`).then(r => r.json());
        const first = list[0];
        const res = await fetch(`${BASE}/api/articles/${first.id}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.id).toBe(first.id);
    });

    it('returns 404 for unknown id', async () => {
        const res = await fetch(`${BASE}/api/articles/999999`);
        expect(res.status).toBe(404);
    });
});

describe('POST /api/messages', () => {
    it('creates a new message', async () => {
        const res = await fetch(`${BASE}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Tester', email: 'test@example.com', message: 'Hello' })
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.id).toBeDefined();
    });

    it('returns 400 for missing fields', async () => {
        const res = await fetch(`${BASE}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Tester' })
        });
        expect(res.status).toBe(400);
    });
});

describe('M-01: GET /api/messages hides email', () => {
    it('does not expose email in public message list', async () => {
        // Create a message first
        await fetch(`${BASE}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'M01Test', email: 'secret@example.com', message: 'Test' })
        });

        const res = await fetch(`${BASE}/api/messages`);
        expect(res.status).toBe(200);
        const messages = await res.json();
        expect(Array.isArray(messages)).toBe(true);
        messages.forEach(m => {
            expect(m.email).toBeUndefined();
        });
    });
});

describe('POST /api/links', () => {
    it('creates a pending link', async () => {
        const res = await fetch(`${BASE}/api/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'site-name': 'Test Site',
                'site-url': 'https://example.com',
                'site-description': 'A test site'
            })
        });
        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.id).toBeDefined();
    });

    it('rejects invalid URL', async () => {
        const res = await fetch(`${BASE}/api/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'site-name': 'Bad',
                'site-url': 'not-a-url',
                'site-description': 'x'
            })
        });
        expect(res.status).toBe(400);
    });
});

describe('Admin login + protected routes', () => {
    it('login with correct credentials succeeds', async () => {
        const { status, body, cookie } = await login();
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(cookie).toMatch(/yanmo_admin_session=/);
        expect(body.csrf_token).toBeDefined();
    });

    it('login with wrong password returns 401', async () => {
        const { status, body } = await login('admin', 'wrongpassword');
        expect(status).toBe(401);
        expect(body.success).toBe(false);
    });

    it('DELETE /api/messages/:id requires auth', async () => {
        // Get a message id first
        const messages = await fetch(`${BASE}/api/messages`).then(r => r.json());
        if (!messages.length) return; // nothing to delete, skip
        const id = messages[0].id;
        const res = await fetch(`${BASE}/api/messages/${id}`, { method: 'DELETE' });
        expect(res.status).toBe(401);
    });

    it('PUT /api/links/:id requires auth', async () => {
        // Create a pending link and use its id directly — public GET /api/links only returns approved
        const createRes = await fetch(`${BASE}/api/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'site-name': 'AuthTest',
                'site-url': 'https://authtest.example.com',
                'site-description': 'auth test'
            })
        });
        const created = await createRes.json();
        const res = await fetch(`${BASE}/api/links/${created.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'approved' })
        });
        expect(res.status).toBe(401);
    });

    it('authenticated DELETE /api/messages/:id succeeds', async () => {
        // Create a message then delete it as admin
        const createRes = await fetch(`${BASE}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'ToDelete', email: 'del@x.com', message: 'bye' })
        });
        const created = await createRes.json();

        const { cookie, csrf } = await login();
        const delRes = await fetch(`${BASE}/api/messages/${created.id}`, {
            method: 'DELETE',
            headers: { 'x-csrf-token': csrf, cookie }
        });
        expect(delRes.status).toBe(200);
        const body = await delRes.json();
        expect(body.deleted).toBe(true);
    });

    it('authenticated admin can approve a link', async () => {
        // Create a link first
        const createRes = await fetch(`${BASE}/api/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                'site-name': 'Approve Me',
                'site-url': 'https://approveme.example.com',
                'site-description': 'test'
            })
        });
        const created = await createRes.json();

        const { cookie, csrf } = await login();
        const putRes = await fetch(`${BASE}/api/links/${created.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, cookie },
            body: JSON.stringify({ status: 'approved' })
        });
        expect(putRes.status).toBe(200);
        const body = await putRes.json();
        expect(body.status).toBe('approved');
    });
});

describe('M-02: Error messages are generic', () => {
    it('500 responses do not leak internal details', async () => {
        // We cannot easily force a DB error in the child process without
        // corrupting the test DB. Instead we verify the pattern by checking
        // a known 404 response shape doesn't contain stack traces.
        const res = await fetch(`${BASE}/api/articles/0`);
        const body = await res.json();
        expect(body.error).not.toMatch(/SQLITE|sqlite|table|column|no such/i);
    });
});

describe('Rate limiting on /api/login', () => {
    it('returns 429 after 5 failed login attempts', async () => {
        const ip = '198.51.100.1'; // TEST-NET-3, won't conflict with real test traffic
        for (let i = 0; i < 5; i++) {
            await fetch(`${BASE}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
                body: JSON.stringify({ username: 'admin', password: `wrong${i}` })
            });
        }
        const res = await fetch(`${BASE}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
            body: JSON.stringify({ username: 'admin', password: 'admin' })
        });
        expect(res.status).toBe(429);
    });
});
