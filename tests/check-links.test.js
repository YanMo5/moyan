/**
 * tests/check-links.test.js
 *
 * Tests for api/check-links.js — focuses on:
 *  - SSRF prevention (H-05)
 *  - Authentication gate
 *  - URL validation edge cases
 *  - Handler request/response behaviour
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

// ── Helpers ────────────────────────────────────────────────────────────────

const CSRF_TOKEN = 'check-links-csrf-token';

function makeReq({ method = 'POST', body = {}, headers = {}, cookie = '' } = {}) {
    const mergedHeaders = {
        'content-type': 'application/json',
        'origin': 'http://localhost',
        'host': 'localhost',
        cookie,
        ...headers
    };
    // Existing suite's signed fixture represents a logged-in admin; give it
    // the matching CSRF header unless a test explicitly overrides it.
    if (cookie && mergedHeaders['x-csrf-token'] === undefined) {
        mergedHeaders['x-csrf-token'] = CSRF_TOKEN;
    }
    return {
        method,
        headers: mergedHeaders,
        body
    };
}

function makeRes() {
    const res = {
        _status: 200,
        _body: null,
        _headers: {},
        status(code) { this._status = code; return this; },
        json(data) { this._body = data; return this; },
        setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; },
    };
    return res;
}

process.env.ADMIN_SESSION_SECRET = 'check-links-test-secret';
process.env.CHECK_LINKS_DNS_CHECK = '0';

const tokenPayload = Buffer.from(JSON.stringify({
    u: 'admin',
    exp: Date.now() + 60 * 60 * 1000,
    csrf: CSRF_TOKEN
})).toString('base64url');
const tokenSignature = crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(tokenPayload).digest('hex');
const SESSION_COOKIE = 'yanmo_admin_session=' + encodeURIComponent(tokenPayload + '.' + tokenSignature);

// Import the handler — mock global fetch to prevent real outbound calls
const fetchMock = vi.fn();
global.fetch = fetchMock;

const { default: handler } = await import('../api/check-links.js');

// ── Auth gate ──────────────────────────────────────────────────────────────

describe('H-05: Authentication required', () => {
    it('returns 401 without a session cookie', async () => {
        const req = makeReq({ body: { urls: ['https://example.com'] } });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(401);
    });

    it('returns 403 when the matching CSRF token is missing', async () => {
        const req = makeReq({
            body: { urls: ['https://example.com'] },
            cookie: SESSION_COOKIE,
            headers: { 'x-csrf-token': '' }
        });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(403);
    });

    it('rejects a cross-origin request', async () => {
        const req = makeReq({
            body: { urls: ['https://example.com'] },
            cookie: SESSION_COOKIE,
            headers: { origin: 'https://evil.example' }
        });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(403);
    });

    it('allows request with a session cookie and CSRF token present', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/rss+xml' },
            text: async () => '<rss><channel><item><title>Post</title><link>https://example.com/p</link></item></channel></rss>'
        });

        const req = makeReq({
            body: { urls: ['https://example.com'] },
            cookie: SESSION_COOKIE
        });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(200);
    });
});

describe('Method validation', () => {
    it('returns 405 for GET requests', async () => {
        const req = makeReq({ method: 'GET', cookie: SESSION_COOKIE });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(405);
    });
});

describe('Body validation', () => {
    it('returns 400 for empty URL list', async () => {
        const req = makeReq({ body: { urls: [] }, cookie: SESSION_COOKIE });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(400);
    });

    it('returns 400 for more than 50 URLs', async () => {
        const urls = Array.from({ length: 51 }, (_, i) => `https://example${i}.com`);
        const req = makeReq({ body: { urls }, cookie: SESSION_COOKIE });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(400);
    });
});

// ── SSRF URL validation ────────────────────────────────────────────────────

describe('H-05: SSRF URL blocklist', () => {
    const blockedUrls = [
        ['localhost', 'http://localhost/'],
        ['127.0.0.1', 'http://127.0.0.1/'],
        ['127.x.x.x', 'http://127.0.0.2/'],
        ['10.x.x.x', 'http://10.0.0.1/'],
        ['192.168.x.x', 'http://192.168.1.100/'],
        ['172.16.x.x', 'http://172.16.0.1/'],
        ['172.31.x.x', 'http://172.31.255.255/'],
        ['169.254.x.x (IMDS)', 'http://169.254.169.254/latest/meta-data/'],
        ['.local mDNS', 'http://mydevice.local/'],
        ['::1 IPv6 loopback', 'http://[::1]/'],
        ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]/'],
        ['ULA IPv6 fd', 'http://[fd00::1]/'],
        ['ULA IPv6 fc', 'http://[fc00::1]/'],
        ['non-standard port 8888', 'http://example.com:8888/'],
        ['non-standard port 22 (SSH)', 'http://example.com:22/'],
        ['non-HTTP scheme ftp', 'ftp://example.com/'],
        ['file protocol', 'file:///etc/passwd'],
        ['javascript scheme', 'javascript:alert(1)'],
    ];

    it.each(blockedUrls)('blocks %s: %s', async (_, url) => {
        fetchMock.mockClear();
        const req = makeReq({ body: { urls: [url] }, cookie: SESSION_COOKIE });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(200);
        // The URL should either be absent from results or marked as INVALID_URL
        if (res._body && res._body[url]) {
            expect(res._body[url].online).toBe(false);
            expect(res._body[url].error).toBe('INVALID_URL');
        }
        // Critically — fetch must NOT have been called with any private/blocked URL
        const fetchedUrls = fetchMock.mock.calls.map(c => c[0]);
        fetchedUrls.forEach(u => {
            expect(u).not.toMatch(/localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|::ffff:|fd00:|fc00:|\.local/i);
        });
    });

    const allowedUrls = [
        ['https allowed', 'https://example.com'],
        ['http allowed', 'http://example.com'],
        ['port 443', 'https://example.com:443'],
        ['port 8080', 'http://example.com:8080'],
        ['port 8443', 'https://example.com:8443'],
    ];

    it.each(allowedUrls)('allows %s: %s', async (_, url) => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 404,
            headers: { get: () => null },
            text: async () => ''
        });
        const req = makeReq({ body: { urls: [url] }, cookie: SESSION_COOKIE });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(200);
        // fetch should have been called for this URL (validation passed)
        expect(fetchMock).toHaveBeenCalled();
    });
});

// ── Response shape ─────────────────────────────────────────────────────────

describe('Response structure', () => {
    it('returns per-URL results keyed by URL', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => 'text/html' },
            text: async () => '<html></html>'
        });

        const req = makeReq({
            body: { urls: ['https://example.com'] },
            cookie: SESSION_COOKIE
        });
        const res = makeRes();
        await handler(req, res);
        expect(res._status).toBe(200);
        expect(typeof res._body).toBe('object');
        expect(res._body['https://example.com']).toBeDefined();
        expect(typeof res._body['https://example.com'].online).toBe('boolean');
    });

    it('returns online:true for a site with a valid RSS feed', async () => {
        const rssBody = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item><title><![CDATA[Hello World]]></title><link>https://example.com/hello</link></item>
</channel></rss>`;

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'application/rss+xml' },
            text: async () => rssBody
        });

        const req = makeReq({
            body: { urls: ['https://example.com'] },
            cookie: SESSION_COOKIE
        });
        const res = makeRes();
        await handler(req, res);
        const result = res._body['https://example.com'];
        expect(result.online).toBe(true);
        expect(result.latestPostTitle).toBe('Hello World');
        expect(result.latestPostUrl).toBe('https://example.com/hello');
    });

    it('falls back to HEAD probe when no RSS found', async () => {
        // All RSS path attempts fail (404)
        fetchMock.mockResolvedValue({
            ok: false,
            status: 404,
            headers: { get: () => null },
            text: async () => ''
        });
        // HEAD probe succeeds
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, text: async () => '' });
        // HEAD
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null } });

        const req = makeReq({
            body: { urls: ['https://no-rss-site.com'] },
            cookie: SESSION_COOKIE
        });
        const res = makeRes();
        await handler(req, res);
        const result = res._body['https://no-rss-site.com'];
        expect(result).toBeDefined();
        expect(typeof result.online).toBe('boolean');
    });
});
