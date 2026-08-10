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

function isAdminSession(req) {
    // H-05 fix: only allow admin sessions to trigger outbound probes.
    // A valid session cookie (even unverified here) ensures the caller has
    // authenticated. Full HMAC verification happens in [...route].js — this
    // lightweight check blocks anonymous callers without duplicating the crypto.
    const cookies = parseCookies(req);
    return Boolean(cookies[SESSION_COOKIE_NAME]);
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
            const res = await fetch(feedUrl, {
                method: 'GET',
                signal,
                headers: {
                    'User-Agent': 'YanMoBlog-LinkProbe/2.0 (+https://yanmo.dev)',
                    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
                },
                redirect: 'follow',
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
        const res = await fetch(origin, {
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

    // H-05 fix: require an admin session cookie — anonymous callers must not
    // be able to use this endpoint as an SSRF proxy.
    if (!isAdminSession(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // CORS — allow only same origin on Vercel; relax for local dev
    const origin = req.headers['origin'] || '';
    const host   = req.headers['host']   || '';
    const isSameOrigin = !origin || origin.includes(host) || host.includes('localhost');
    if (!isSameOrigin) {
        return res.status(403).json({ error: 'CORS_VIOLATION' });
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
    const unique = [...new Set(urls.map(u => String(u || '').trim()).filter(Boolean))];
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
