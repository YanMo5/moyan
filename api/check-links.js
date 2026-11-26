/**
 * /api/check-links — Vercel Serverless Function
 *
 * POST  { urls: string[] }
 * Returns { [url]: { online, latestPostTitle, latestPostUrl, checkedAt, error? } }
 *
 * Design constraints:
 *  - 10 s Vercel function timeout — all probes run concurrently via Promise.allSettled
 *  - No external dependencies: uses the global fetch() available in Node 18+ runtime
 *  - Each URL gets a 5 s per-request timeout via AbortController
 *  - RSS/Atom discovery tries 8 common feed paths; falls back to liveness HEAD probe
 *  - Response is always 200 so the frontend can diff partial failures per-URL
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const PROBE_TIMEOUT_MS = 5000;
const MAX_URLS = 50;
const SESSION_COOKIE_NAME = 'yanmo_admin_session';

// Candidate feed paths tried in order
const RSS_PATHS = [
    '/feed.xml', '/feed', '/rss.xml', '/rss', '/atom.xml',
    '/index.xml', '/feed/atom', '/blog/feed',
];

function parseCookies(req) {
    const cookieHeader = String(req.headers.cookie || '');
    const out = {};
    cookieHeader.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx <= 0) return;
        out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    });
    return out;
}

function getAdminSession(req) {
    // H-05 fix: only a cryptographically valid admin session may trigger
    // outbound probes. A cookie merely existing is not authentication.
    const secret = String(process.env.ADMIN_SESSION_SECRET || '');
    if (!secret) return null;
    const cookies = parseCookies(req);
    const token = String(cookies[SESSION_COOKIE_NAME] || '');
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts[1]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (!payload || !payload.u || Number(payload.exp || 0) <= Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

function requireAdminCsrf(req, session) {
    const provided = String(req.headers['x-csrf-token'] || '').trim();
    const expected = String(session && session.csrf || '').trim();
    if (!provided || !expected) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeAbortSignal(ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    // AbortController doesn't expose a way to cancel the timeout automatically,
    // so callers should let the timer fire — it's cheap.
    return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

/**
 * Validate and normalise a URL. Returns null if the value is not a safe
 * http/https URL, preventing SSRF against internal network ranges.
 *
 * Blocks:
 *  - RFC-1918 private ranges (10.x, 172.16-31.x, 192.168.x)
 *  - Loopback (127.x, ::1)
 *  - Link-local (169.254.x — includes AWS/GCP/Azure IMDS at 169.254.169.254)
 *  - IPv4-mapped IPv6 (::ffff:...)
 *  - ULA IPv6 (fc00::/7 — fd... and fc...)
 *  - .local mDNS names
 *  - Non-standard ports outside {80, 443, 8080, 8443}
 */
function validateUrl(raw) {
    let parsed;
    try {
        parsed = new URL(String(raw || '').trim());
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    // Node's WHATWG URL parser returns "[::1]" (with brackets) for IPv6 hostnames.
    // Strip them so our regex patterns can match the bare address.
    const rawHost = parsed.hostname.toLowerCase();
    const host = rawHost.startsWith('[') && rawHost.endsWith(']')
        ? rawHost.slice(1, -1)
        : rawHost;

    // Reject anything that looks like a decimal or octal IPv4 representation
    // before the URL parser normalises it (e.g. http://2130706433/ = 127.0.0.1)
    if (/^[\d.]+$/.test(host) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
        // non-dotted decimal (e.g. 2130706433) — reject
        return null;
    }

    if (
        host === 'localhost' ||
        host.endsWith('.local') ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||    // link-local + cloud IMDS
        /^::1$/.test(host) ||
        /^::ffff:/i.test(host) ||      // IPv4-mapped IPv6
        /^fd[0-9a-f]{2}:/i.test(host) || // ULA IPv6 fd00::/8
        /^fc[0-9a-f]{2}:/i.test(host)    // ULA IPv6 fc00::/8
    ) {
        return null;
    }

    // Only allow standard web ports
    const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
    if (![80, 443, 8080, 8443].includes(port)) return null;

    return parsed;
}

function isPrivateAddress(address) {
    const ip = String(address || '').toLowerCase();
    if (net.isIPv4(ip)) {
        return /^0\./.test(ip) ||
            /^10\./.test(ip) ||
            /^127\./.test(ip) ||
            /^169\.254\./.test(ip) ||
            /^192\.168\./.test(ip) ||
            /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip) ||
            /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(ip) ||
            /^198\.(18|19)\./.test(ip);
    }
    if (net.isIPv6(ip)) {
        if (ip === '::1' || ip === '::') return true;
        if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
        if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;
        if (/^::ffff:/i.test(ip)) return true;
        return false;
    }
    return true;
}

async function resolvesPublic(hostname) {
    try {
        const records = await dns.lookup(hostname, { all: true, verbatim: true });
        return records.length > 0 && records.every(record => !isPrivateAddress(record.address));
    } catch {
        return false;
    }
}

async function safeFetch(rawUrl, options) {
    let current = String(rawUrl || '');
    for (let hop = 0; hop < 4; hop++) {
        const parsed = validateUrl(current);
        if (!parsed) throw new Error('UNSAFE_URL');
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if (process.env.CHECK_LINKS_DNS_CHECK !== '0' && !(await resolvesPublic(host))) {
            throw new Error('UNSAFE_HOST');
        }
        const response = await fetch(parsed.href, { ...options, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) return response;
            current = new URL(location, parsed.href).href;
            continue;
        }
        return response;
    }
    throw new Error('TOO_MANY_REDIRECTS');
}

/**
 * Try to parse the first <item> or <entry> from an RSS/Atom response body.
 * Returns { title, url } or null.
 */
function parseFirstItem(xml) {
    // Atom <entry>
    const entryMatch = xml.match(/<entry[\s>][\s\S]*?<\/entry>/i);
    if (entryMatch) {
        const block = entryMatch[0];
        const titleMatch = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const linkMatch  = block.match(/<link[^>]+href="([^"]+)"/i)
                        || block.match(/<link[^>]+>([^<]+)<\/link>/i);
        const title = titleMatch ? titleMatch[1].trim() : null;
        const url   = linkMatch  ? linkMatch[1].trim()  : null;
        if (title) return { title, url };
    }

    // RSS2 <item>
    const itemMatch = xml.match(/<item[\s>][\s\S]*?<\/item>/i);
    if (itemMatch) {
        const block = itemMatch[0];
        const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const linkMatch  = block.match(/<link>([^<]+)<\/link>/i)
                        || block.match(/<guid[^>]*>([^<]+)<\/guid>/i);
        const title = titleMatch ? titleMatch[1].trim() : null;
        const url   = linkMatch  ? linkMatch[1].trim()  : null;
        if (title) return { title, url };
    }

    return null;
}

/**
 * Probe a single URL: discover RSS feed + parse latest item,
 * with fallback to plain liveness HEAD.
 */
async function probeUrl(rawUrl) {
    const parsed = validateUrl(rawUrl);
    if (!parsed) {
        return { online: false, error: 'INVALID_URL' };
    }
    const origin = parsed.origin; // e.g. https://example.com

    // Try each RSS path
    for (const feedPath of RSS_PATHS) {
        const feedUrl = origin + feedPath;
        const { signal, clear } = makeAbortSignal(PROBE_TIMEOUT_MS);
        try {
            const res = await safeFetch(feedUrl, {
                method: 'GET',
                signal,
                headers: {
                    'User-Agent': 'YanMoBlog-LinkProbe/2.0 (+https://yanmo.dev)',
                    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
                },
            });
            clear();

            if (!res.ok) continue;
            const ct = res.headers.get('content-type') || '';
            if (!/xml|rss|atom|feed/i.test(ct) && !feedPath.endsWith('.xml')) continue;

            const body = await res.text();
            if (!body.includes('<item') && !body.includes('<entry')) continue;

            const item = parseFirstItem(body);
            return {
                online:          true,
                latestPostTitle: item ? item.title : null,
                latestPostUrl:   item ? item.url   : null,
                feedUrl,
                checkedAt:       new Date().toISOString(),
            };
        } catch {
            clear();
            // timeout or network error — try next path
        }
    }

    // RSS not found — fall back to liveness HEAD on the root URL
    const { signal, clear } = makeAbortSignal(PROBE_TIMEOUT_MS);
    try {
        const res = await safeFetch(origin, {
            method: 'HEAD',
            signal,
            headers: { 'User-Agent': 'YanMoBlog-LinkProbe/2.0 (+https://yanmo.dev)' },
            redirect: 'follow',
        });
        clear();
        return {
            online:    res.ok || res.status === 405, // 405 = HEAD not allowed but server is up
            checkedAt: new Date().toISOString(),
        };
    } catch (err) {
        clear();
        return {
            online:    false,
            error:     'UNREACHABLE',
            checkedAt: new Date().toISOString(),
        };
    }
}

module.exports = async function handler(req, res) {
    // Only accept POST
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // H-05 fix: require an admin session cookie + CSRF — anonymous callers must not
    // be able to use this endpoint as an SSRF proxy.
    const session = getAdminSession(req);
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!requireAdminCsrf(req, session)) {
        return res.status(403).json({ error: 'CSRF token 无效或缺失' });
    }

    // CORS — only same-origin browser requests are allowed.
    const origin = String(req.headers['origin'] || '');
    const host = String(req.headers['host'] || '').toLowerCase();
    if (origin) {
        let originHost = '';
        try {
            originHost = new URL(origin).host.toLowerCase();
        } catch {
            return res.status(403).json({ error: 'CORS_VIOLATION' });
        }
        if (!host || originHost !== host) {
            return res.status(403).json({ error: 'CORS_VIOLATION' });
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }

    // Parse body
    let urls;
    try {
        const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
        urls = Array.isArray(body.urls) ? body.urls : [];
    } catch {
        return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // Validate and deduplicate
    const unique = [...new Set(urls.map(u => String(u || '').trim()).filter(u => u && u.length <= 2048))];
    if (unique.length === 0) {
        return res.status(400).json({ error: 'No URLs provided' });
    }
    if (unique.length > MAX_URLS) {
        return res.status(400).json({ error: `Too many URLs (max ${MAX_URLS})` });
    }

    // Probe all concurrently, collect results
    const settled = await Promise.allSettled(unique.map(url => probeUrl(url)));

    const results = {};
    unique.forEach((url, i) => {
        const outcome = settled[i];
        results[url] = outcome.status === 'fulfilled'
            ? outcome.value
            : { online: false, error: 'PROBE_EXCEPTION', checkedAt: new Date().toISOString() };
    });

    // Cache hint — clients may cache for 2 minutes
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(results);
};
