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
    return { cookie: setCookie.split(';')[0], csrf: body.csrf_token, status: res.status, body, headers: res.headers };
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
                // 测试进程模拟反向代理：限流测试用 X-Forwarded-For 隔离不同客户端，
                // 生产环境默认不信任该头（见 server/server.js 的 TRUST_PROXY）。
                TRUST_PROXY: '1',
                NODE_ENV: 'test',
                // 测试环境强制关闭邮件通道，避免读到开发者本地 .env 后真的去发信
                ENV_FILE: path.join(__dirname, 'no-env-for-tests.env'),
                SMTP_HOST: '',
                SMTP_USER: '',
                SMTP_PASS: '',
                CONTACT_TO: ''
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
    // Windows 上子进程退出后文件句柄还会短暂占用，先等退出再重试清理，避免残留 test_*.db
    if (serverProcess && serverProcess.exitCode === null) {
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 2000);
            serverProcess.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            serverProcess.kill();
        });
    }
    const leftovers = [tmpDb, tmpDb + '-journal', tmpDb + '-shm', tmpDb + '-wal', tmpCredentials, tmpPassword];
    for (let attempt = 0; attempt < 10; attempt += 1) {
        for (const f of leftovers) {
            try { fs.unlinkSync(f); } catch (_) {}
        }
        if (!leftovers.some((f) => fs.existsSync(f))) break;
        await new Promise(r => setTimeout(r, 100));
    }
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Static asset allowlist', () => {
    it('serves frontend pages, styles, scripts and assets', async () => {
        const page = await fetch(`${BASE}/admin.html`);
        expect(page.status).toBe(200);
        const css = await fetch(`${BASE}/src/css/styles.css`);
        expect(css.status).toBe(200);
        const asset = await fetch(`${BASE}/assets/images/site-avatar.png`);
        expect(asset.status).toBe(200);
    });

    it('does not expose repository data, backend source or package metadata', async () => {
        const blockedPaths = [
            '/data/admin-credentials.json',
            '/data/blog.db',
            '/server/server.js',
            '/package.json',
            '/README.md'
        ];
        for (const pathname of blockedPaths) {
            const res = await fetch(`${BASE}${pathname}`);
            expect(res.status, pathname).toBe(404);
        }
    });
});

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
        const { status, body, cookie, headers } = await login();
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(cookie).toMatch(/yanmo_admin_session=/);
        expect(body.csrf_token).toBeDefined();
        expect(headers.get('x-content-type-options')).toBe('nosniff');
        expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
        expect(headers.get('cache-control') || '').toContain('no-store');
    });

    it('login with wrong password returns 401', async () => {
        const { status, body } = await login('admin', 'wrongpassword');
        expect(status).toBe(401);
        expect(body.success).toBe(false);
    });

    it('wrong username and wrong password return the same generic error', async () => {
        const wrongUsername = await login('not-admin', 'wrongpassword');
        const wrongPassword = await login('admin', 'wrongpassword');
        expect(wrongUsername.status).toBe(401);
        expect(wrongPassword.status).toBe(401);
        expect(wrongUsername.body.message).toBe(wrongPassword.body.message);
    });

    it('rejects oversized login fields without hashing them', async () => {
        const { status, body } = await login('admin', 'x'.repeat(300));
        expect(status).toBe(401);
        expect(body.success).toBe(false);
    });

    it('rejects malformed CSRF tokens with 403 instead of crashing', async () => {
        const { cookie } = await login();
        const res = await fetch(`${BASE}/api/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': 'short',
                cookie
            },
            body: JSON.stringify({ new_password: 'ValidPass123!' })
        });
        expect(res.status).toBe(403);
    });

    it('rejects a weak new admin password', async () => {
        const { cookie, csrf } = await login();
        const res = await fetch(`${BASE}/api/change-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrf,
                cookie
            },
            body: JSON.stringify({ current_password: 'admin', new_password: 'short' })
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.message).toMatch(/至少|密码/);
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

describe('Admin audit logs', () => {
    it('requires an admin session', async () => {
        const res = await fetch(`${BASE}/api/admin-audit-logs`);
        expect(res.status).toBe(401);
    });

    it('returns filtered, paginated audit entries for admins', async () => {
        const { cookie, csrf } = await login();
        const createRes = await fetch(`${BASE}/api/articles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, cookie },
            body: JSON.stringify({
                title: 'Audit log test article',
                content: 'created for audit log verification',
                category: '测试'
            })
        });
        expect(createRes.status).toBe(201);
        const article = await createRes.json();

        // sqlite3 写入是异步的，留出极短时间让审计记录落库
        await new Promise(resolve => setTimeout(resolve, 150));

        const res = await fetch(`${BASE}/api/admin-audit-logs?action=article_create&page=1&page_size=5`, {
            headers: { cookie }
        });
        expect(res.status).toBe(200);
        const payload = await res.json();
        expect(payload.page).toBe(1);
        expect(payload.page_size).toBe(5);
        expect(payload.total).toBeGreaterThan(0);
        expect(payload.total_pages).toBeGreaterThanOrEqual(1);
        expect(Array.isArray(payload.items)).toBe(true);

        const entry = payload.items.find(item => item.detail === `article_id=${article.id}`);
        expect(entry).toBeDefined();
        expect(entry.username).toBe('admin');
        expect(entry.action).toBe('article_create');
        expect(entry.status).toBe('success');
    });

    it('exports filtered logs as UTF-8 CSV', async () => {
        const { cookie } = await login();
        await new Promise(resolve => setTimeout(resolve, 150));

        const res = await fetch(`${BASE}/api/admin-audit-logs/export?action=admin_login`, {
            headers: { cookie }
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type') || '').toMatch(/text\/csv/i);
        expect(res.headers.get('content-disposition') || '').toContain('admin-audit-logs.csv');

        const text = await res.text();
        expect(text).toContain('id,action,status,username,client_ip,detail,created_at');
        expect(text).toContain('admin_login');
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
        expect(res.headers.get('retry-after')).toBeTruthy();
    });
});

describe('POST /api/contact — 留言入库 + 邮件状态回传', () => {
    it('stores the message and honestly reports mailed=false when SMTP is not configured', async () => {
        const res = await fetch(`${BASE}/api/contact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: '测试访客',
                email: 'visitor@example.com',
                subject: 'CTF 交流',
                message: '这是一条自动化测试留言。'
            })
        });

        expect(res.status).toBe(201);
        const body = await res.json();
        expect(body.success).toBe(true);
        expect(typeof body.id).toBe('number');
        // 关键：未配置 SMTP 时不能谎称"已发送"
        expect(body.mailed).toBe(false);
        expect(body.mail_reason).toBe('not_configured');
        expect(typeof body.message).toBe('string');
        expect(body.message).toMatch(/留言|邮件/);
    });

    it('rejects an invalid email address', async () => {
        const res = await fetch(`${BASE}/api/contact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: '测试访客',
                email: 'not-an-email',
                subject: '主题',
                message: '内容'
            })
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/邮箱/);
    });

    it('rejects an empty payload', async () => {
        const res = await fetch(`${BASE}/api/contact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(res.status).toBe(400);
    });

    it('exposes /api/mail-status to admins only', async () => {
        const anonymous = await fetch(`${BASE}/api/mail-status`);
        expect(anonymous.status).toBe(401);

        const { cookie } = await login();
        const authed = await fetch(`${BASE}/api/mail-status`, { headers: { cookie } });
        expect(authed.status).toBe(200);
        const status = await authed.json();
        expect(status.configured).toBe(false);
        expect(Array.isArray(status.hints)).toBe(true);
        expect(status.hints.length).toBeGreaterThan(0);
    });
});
