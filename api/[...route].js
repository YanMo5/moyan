const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let Pool = null;

const SESSION_COOKIE_NAME = 'yanmo_admin_session';
const CSRF_HEADER_NAME = 'x-csrf-token';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PASSWORD_HASH_ITERATIONS = 210000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const rootDir = path.join(__dirname, '..');
const dataFile = path.join(rootDir, 'cloud_data.json');
const adminPasswordFile = path.join(rootDir, 'admin_password.txt');
const adminCredentialsFile = path.join(rootDir, 'admin_credentials.json');

let memoryData = null;
let memoryCredentials = null;
let dataStorageMode = 'memory';
const loginFailures = new Map();
let dbPool = null;
let dbSchemaReady = false;

function now() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function toSafeText(value) {
    return String(value || '').trim();
}

function isValidHttpUrl(value) {
    try {
        const parsed = new URL(toSafeText(value));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (error) {
        return false;
    }
}

function nextId(items) {
    return (items || []).reduce((max, item) => Math.max(max, Number(item && item.id) || 0), 0) + 1;
}

function sortByCreatedAtDesc(items) {
    return (items || []).slice().sort((a, b) => {
        return String(b && b.created_at || '').localeCompare(String(a && a.created_at || ''));
    });
}

function baseData() {
    return {
        messages: [],
        links: [],
        articles: [],
        contact_messages: [],
        stats: {
            total_views: 0
        },
        audit_logs: []
    };
}

function normalizeData(raw) {
    const safe = raw && typeof raw === 'object' ? raw : {};
    return {
        messages: Array.isArray(safe.messages) ? safe.messages : [],
        links: Array.isArray(safe.links) ? safe.links : [],
        articles: Array.isArray(safe.articles) ? safe.articles : [],
        contact_messages: Array.isArray(safe.contact_messages) ? safe.contact_messages : [],
        stats: {
            total_views: Number(safe.stats && safe.stats.total_views) || 0
        },
        audit_logs: Array.isArray(safe.audit_logs) ? safe.audit_logs : []
    };
}

function getDbPool() {
    const connectionString = toSafeText(process.env.DATABASE_URL);
    if (!connectionString) {
        return null;
    }

    if (!Pool) {
        try {
            ({ Pool } = require('pg'));
        } catch (error) {
            return null;
        }
    }

    if (!dbPool) {
        dbPool = new Pool({
            connectionString,
            ssl: { rejectUnauthorized: false }
        });
    }

    return dbPool;
}

async function ensureDbSchema(pool) {
    if (dbSchemaReady) {
        return;
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS links (
            id BIGSERIAL PRIMARY KEY,
            site_name TEXT NOT NULL,
            site_url TEXT NOT NULL,
            site_description TEXT NOT NULL,
            site_avatar TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS articles (
            id BIGSERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS contact_messages (
            id BIGSERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            subject TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id BIGSERIAL PRIMARY KEY,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            username TEXT NOT NULL,
            client_ip TEXT NOT NULL,
            detail TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS site_stats (
            id INTEGER PRIMARY KEY DEFAULT 1,
            total_views BIGINT NOT NULL DEFAULT 0
        );

        INSERT INTO site_stats (id, total_views)
        VALUES (1, 0)
        ON CONFLICT (id) DO NOTHING;
    `);

    dbSchemaReady = true;
}

async function loadData() {
    const pool = getDbPool();
    if (!pool && memoryData) {
        return memoryData;
    }

    if (pool) {
        try {
            await ensureDbSchema(pool);

            const [messagesResult, linksResult, articlesResult, contactMessagesResult, auditLogsResult, statsResult] = await Promise.all([
                pool.query('SELECT id, name, email, message, created_at FROM messages ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, site_name, site_url, site_description, site_avatar, status, created_at FROM links ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, title, content, category, created_at FROM articles ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, name, email, subject, message, created_at FROM contact_messages ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, action, status, username, client_ip, detail, created_at FROM audit_logs ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT total_views FROM site_stats WHERE id = 1 LIMIT 1')
            ]);

            const dbData = normalizeData({
                messages: messagesResult.rows,
                links: linksResult.rows,
                articles: articlesResult.rows,
                contact_messages: contactMessagesResult.rows,
                audit_logs: auditLogsResult.rows,
                stats: {
                    total_views: Number(statsResult.rows[0] && statsResult.rows[0].total_views) || 0
                }
            });

            const hasDbRows = [
                messagesResult.rows.length,
                linksResult.rows.length,
                articlesResult.rows.length,
                contactMessagesResult.rows.length,
                auditLogsResult.rows.length,
                Number(statsResult.rows[0] && statsResult.rows[0].total_views) || 0
            ].some(value => Number(value) > 0);

            if (!hasDbRows && fs.existsSync(dataFile)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
                    const fileData = normalizeData(parsed);
                    await saveData(fileData);
                    return fileData;
                } catch (error) {
                    // Fall through to empty database-backed state.
                }
            }

            memoryData = dbData;
            dataStorageMode = 'database';
            return dbData;
        } catch (error) {
            // Fall back to file storage when database initialization fails.
        }
    }

    try {
        if (fs.existsSync(dataFile)) {
            const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
            memoryData = normalizeData(parsed);
            dataStorageMode = 'file';
            return memoryData;
        }
    } catch (error) {
        // Ignore and rebuild from defaults.
    }

    memoryData = baseData();
    dataStorageMode = 'memory';
    return memoryData;
}

async function saveData(data) {
    memoryData = normalizeData(data);

    const pool = getDbPool();
    if (pool) {
        await ensureDbSchema(pool);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('TRUNCATE TABLE messages, links, articles, contact_messages, audit_logs, site_stats RESTART IDENTITY');

            for (const item of memoryData.messages) {
                await client.query(
                    'INSERT INTO messages (id, name, email, message, created_at) VALUES ($1, $2, $3, $4, $5)',
                    [Number(item.id) || null, item.name, item.email, item.message, item.created_at]
                );
            }

            for (const item of memoryData.links) {
                await client.query(
                    'INSERT INTO links (id, site_name, site_url, site_description, site_avatar, status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [Number(item.id) || null, item.site_name, item.site_url, item.site_description, item.site_avatar || '', item.status || 'pending', item.created_at]
                );
            }

            for (const item of memoryData.articles) {
                await client.query(
                    'INSERT INTO articles (id, title, content, category, created_at) VALUES ($1, $2, $3, $4, $5)',
                    [Number(item.id) || null, item.title, item.content, item.category, item.created_at]
                );
            }

            for (const item of memoryData.contact_messages) {
                await client.query(
                    'INSERT INTO contact_messages (id, name, email, subject, message, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                    [Number(item.id) || null, item.name, item.email, item.subject, item.message, item.created_at]
                );
            }

            for (const item of memoryData.audit_logs) {
                await client.query(
                    'INSERT INTO audit_logs (id, action, status, username, client_ip, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [Number(item.id) || null, item.action, item.status, item.username, item.client_ip, item.detail, item.created_at]
                );
            }

            await client.query('INSERT INTO site_stats (id, total_views) VALUES (1, $1)', [Number(memoryData.stats.total_views) || 0]);
            await client.query('COMMIT');
            dataStorageMode = 'database';
            return;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    try {
        fs.writeFileSync(dataFile, JSON.stringify(memoryData), 'utf8');
        dataStorageMode = 'file';
    } catch (error) {
        // In serverless read-only FS, keep data in memory for the warm instance.
        dataStorageMode = 'memory';
    }
}

function getCredentialsMode() {
    if (getEnvCredentials()) {
        return 'env';
    }
    if (memoryCredentials) {
        return 'memory-or-file';
    }
    return 'auto-default';
}

function hashPassword(password, saltHex, iterations = PASSWORD_HASH_ITERATIONS) {
    const salt = saltHex ? Buffer.from(String(saltHex), 'hex') : crypto.randomBytes(16);
    const digest = crypto.pbkdf2Sync(String(password), salt, Number(iterations), 32, 'sha256');
    return {
        password_salt: salt.toString('hex'),
        password_hash: digest.toString('hex'),
        password_iterations: Number(iterations)
    };
}

function verifyPassword(password, saltHex, hashHex, iterations) {
    try {
        const digest = crypto.pbkdf2Sync(
            String(password),
            Buffer.from(String(saltHex), 'hex'),
            Number(iterations),
            32,
            'sha256'
        );
        const expected = Buffer.from(String(hashHex), 'hex');
        return expected.length === digest.length && crypto.timingSafeEqual(expected, digest);
    } catch (error) {
        return false;
    }
}

function getEnvCredentials() {
    const envUsername = toSafeText(process.env.ADMIN_USERNAME);
    const envPassword = toSafeText(process.env.ADMIN_PASSWORD);
    if (!envUsername || !envPassword) {
        return null;
    }
    return {
        username: envUsername,
        ...hashPassword(envPassword)
    };
}

function getRequestHost(req) {
    const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
    return host;
}

function isLocalRequestHost(req) {
    const host = getRequestHost(req);
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function requireCloudAdminEnv(req, res) {
    if (isLocalRequestHost(req)) {
        return true;
    }

    if (getEnvCredentials()) {
        return true;
    }

    res.status(503).json({
        success: false,
        message: 'Cloud admin credentials are not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD.'
    });
    return false;
}

function clearLoginFailures(clientId) {
    loginFailures.delete(clientId);
}

function checkLoginLock(clientId) {
    const nowMs = Date.now();
    const entry = loginFailures.get(clientId);
    if (!entry) {
        return 0;
    }

    if (Number(entry.lockUntil || 0) > nowMs) {
        return Math.ceil((Number(entry.lockUntil) - nowMs) / 1000);
    }

    const attempts = (entry.attempts || []).filter(ts => nowMs - ts <= LOGIN_WINDOW_MS);
    if (attempts.length) {
        loginFailures.set(clientId, { attempts, lockUntil: 0 });
    } else {
        loginFailures.delete(clientId);
    }

    return 0;
}

function recordLoginFailure(clientId) {
    const nowMs = Date.now();
    const entry = loginFailures.get(clientId) || { attempts: [], lockUntil: 0 };
    const attempts = (entry.attempts || []).filter(ts => nowMs - ts <= LOGIN_WINDOW_MS);
    attempts.push(nowMs);

    const nextEntry = { attempts, lockUntil: 0 };
    if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
        nextEntry.lockUntil = nowMs + LOGIN_LOCK_MS;
    }
    loginFailures.set(clientId, nextEntry);
}

function readLegacyAdminPassword() {
    try {
        if (!fs.existsSync(adminPasswordFile)) {
            return 'admin';
        }
        return toSafeText(fs.readFileSync(adminPasswordFile, 'utf8')) || 'admin';
    } catch (error) {
        return 'admin';
    }
}

function saveAdminCredentials(username, passwordRecord) {
    const payload = {
        username: toSafeText(username) || 'admin',
        password_salt: String(passwordRecord.password_salt || ''),
        password_hash: String(passwordRecord.password_hash || ''),
        password_iterations: Number(passwordRecord.password_iterations || PASSWORD_HASH_ITERATIONS)
    };

    memoryCredentials = payload;

    try {
        fs.writeFileSync(adminCredentialsFile, JSON.stringify(payload), 'utf8');
        fs.writeFileSync(adminPasswordFile, 'managed_by_hash_credentials', 'utf8');
    } catch (error) {
        // Cloud/serverless environments may be read-only. Keep credentials in memory.
    }

    return payload;
}

function getAdminCredentials() {
    const envCredentials = getEnvCredentials();
    if (envCredentials) {
        return envCredentials;
    }

    if (memoryCredentials) {
        return memoryCredentials;
    }

    const defaultCredentials = {
        username: 'admin',
        ...hashPassword(readLegacyAdminPassword())
    };

    try {
        if (fs.existsSync(adminCredentialsFile)) {
            const parsed = JSON.parse(fs.readFileSync(adminCredentialsFile, 'utf8'));
            const username = toSafeText(parsed && parsed.username) || defaultCredentials.username;
            const passwordSalt = toSafeText(parsed && parsed.password_salt);
            const passwordHash = toSafeText(parsed && parsed.password_hash);
            const passwordIterations = Number(parsed && parsed.password_iterations) || PASSWORD_HASH_ITERATIONS;

            if (passwordSalt && passwordHash) {
                memoryCredentials = {
                    username,
                    password_salt: passwordSalt,
                    password_hash: passwordHash,
                    password_iterations: passwordIterations
                };
                return memoryCredentials;
            }

            const legacyPassword = toSafeText(parsed && parsed.password) || readLegacyAdminPassword();
            return saveAdminCredentials(username, hashPassword(legacyPassword));
        }
    } catch (error) {
        // Ignore parse/read errors and fall back to defaults.
    }

    return saveAdminCredentials(defaultCredentials.username, defaultCredentials);
}

function parseCookies(req) {
    const cookieHeader = String(req.headers.cookie || '');
    const pairs = cookieHeader.split(';').map(item => item.trim()).filter(Boolean);
    const out = {};
    pairs.forEach(pair => {
        const index = pair.indexOf('=');
        if (index <= 0) {
            return;
        }
        const key = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        out[key] = decodeURIComponent(value);
    });
    return out;
}

function sessionSecret() {
    return String(process.env.ADMIN_SESSION_SECRET || 'yanmo-session-secret-change-me');
}

function signToken(content) {
    return crypto.createHmac('sha256', sessionSecret()).update(content).digest('hex');
}

function createSessionToken(username) {
    const payload = {
        u: String(username),
        exp: Date.now() + SESSION_TTL_MS,
        csrf: crypto.randomBytes(24).toString('hex')
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return {
        token: `${encoded}.${signToken(encoded)}`,
        csrf: payload.csrf
    };
}

function verifySessionToken(token) {
    if (!token || typeof token !== 'string') {
        return null;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
        return null;
    }

    const [encoded, signature] = parts;
    if (signToken(encoded) !== signature) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!payload || Number(payload.exp || 0) <= Date.now()) {
            return null;
        }
        return payload;
    } catch (error) {
        return null;
    }
}

function setSessionCookie(res, token) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getAdminSession(req) {
    const cookies = parseCookies(req);
    return verifySessionToken(cookies[SESSION_COOKIE_NAME]);
}

function requireAdmin(req, res) {
    const session = getAdminSession(req);
    if (!session) {
        res.status(401).json({ error: 'Unauthorized' });
        return null;
    }
    return session;
}

function requireAdminCsrf(req, res, session) {
    const provided = toSafeText(req.headers[CSRF_HEADER_NAME]);
    const expected = toSafeText(session && session.csrf);
    if (!expected || !provided || provided !== expected) {
        res.status(403).json({ error: 'CSRF token 无效或缺失' });
        return false;
    }
    return true;
}

function readBody(req) {
    const raw = req.body;
    if (!raw) {
        return {};
    }
    if (typeof raw === 'object') {
        return raw;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (error) {
            return {};
        }
    }
    return {};
}

function getRoutePath(req) {
    const route = req.query && req.query.route;
    if (Array.isArray(route)) {
        return '/' + route.map(part => String(part || '').trim()).filter(Boolean).join('/');
    }
    if (typeof route === 'string' && route.trim()) {
        return '/' + route.trim();
    }
    // Fallback: try to parse from req.url if route is not set
    if (req.url) {
        const urlPath = String(req.url).split('?')[0];
        const cleanPath = urlPath.replace(/^\/api\//i, '').replace(/^\/api$/i, '') || urlPath.replace(/^\//, '');
        if (cleanPath && cleanPath !== '/' && cleanPath !== '/api') {
            return cleanPath.startsWith('/') ? cleanPath : ('/' + cleanPath);
        }
    }
    return '/';
}

function writeAuditLog(data, action, status, clientIp, username, detail) {
    const logs = Array.isArray(data.audit_logs) ? data.audit_logs : [];
    logs.unshift({
        id: nextId(logs),
        action: String(action || '').slice(0, 120),
        status: String(status || '').slice(0, 20),
        username: String(username || '').slice(0, 80),
        client_ip: String(clientIp || '').slice(0, 80),
        detail: String(detail || '').slice(0, 500),
        created_at: now()
    });
    data.audit_logs = logs.slice(0, 5000);
}

function parsePositiveInt(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function toCsvLine(values) {
    return values.map(value => {
        const text = String(value == null ? '' : value);
        return `"${text.replace(/"/g, '""')}"`;
    }).join(',');
}

module.exports = async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const method = String(req.method || 'GET').toUpperCase();
    const routePath = getRoutePath(req);
    const body = readBody(req);
    const clientIp = String(req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
    const data = await loadData();

    if (routePath === '/' || routePath === '') {
        return res.status(200).json({
            ok: true,
            mode: 'server-api',
            route: '/api',
            method,
            message: 'Cloud API is active. [v' + new Date().getTime() + ']'
        });
    }

    if (routePath === '/health' && method === 'GET') {
            if (routePath === '/debug') {
                return res.status(200).json({
                    req_url: req.url,
                    req_query_route: req.query && req.query.route,
                    route_path: routePath,
                    method: method
                });
            }

        return res.status(200).json({
            ok: true,
            mode: 'server-api',
            host: getRequestHost(req) || 'unknown',
            storage_mode: dataStorageMode,
            credentials_mode: getCredentialsMode(),
            env_admin_configured: Boolean(getEnvCredentials()),
            login_lock_policy: {
                window_seconds: Math.floor(LOGIN_WINDOW_MS / 1000),
                max_attempts: LOGIN_MAX_ATTEMPTS,
                lock_seconds: Math.floor(LOGIN_LOCK_MS / 1000)
            },
            timestamp: new Date().toISOString()
        });
    }

    if (routePath === '/messages' && method === 'GET') {
        return res.status(200).json(sortByCreatedAtDesc(data.messages));
    }

    if (routePath === '/messages' && method === 'POST') {
        const name = toSafeText(body.name);
        const email = toSafeText(body.email);
        const message = toSafeText(body.message);

        if (!name || !email || !message) {
            return res.status(400).json({ error: '请完整填写留言信息' });
        }

        const item = {
            id: nextId(data.messages),
            name,
            email,
            message,
            created_at: now()
        };
        data.messages.unshift(item);
        await saveData(data);
        return res.status(201).json(item);
    }

    if (routePath === '/links' && method === 'GET') {
        return res.status(200).json(sortByCreatedAtDesc(data.links));
    }

    if (routePath === '/links' && method === 'POST') {
        const siteName = toSafeText(body['site-name'] || body.site_name || body.siteName);
        const siteUrl = toSafeText(body['site-url'] || body.site_url || body.siteUrl);
        const siteDescription = toSafeText(body['site-description'] || body.site_description || body.siteDescription);
        const siteAvatar = toSafeText(body['site-avatar'] || body.site_avatar || body.siteAvatar);

        if (!siteName || !siteUrl || !siteDescription) {
            return res.status(400).json({ error: '请完整填写友链信息' });
        }

        if (!isValidHttpUrl(siteUrl)) {
            return res.status(400).json({ error: '请输入有效的网站链接' });
        }

        if (siteAvatar && !siteAvatar.startsWith('data:image/')) {
            return res.status(400).json({ error: '头像格式不合法' });
        }

        if (siteAvatar && siteAvatar.length > 1000000) {
            return res.status(400).json({ error: '头像文件过大，请控制在 1MB 以内' });
        }

        const item = {
            id: nextId(data.links),
            site_name: siteName,
            site_url: siteUrl,
            site_description: siteDescription,
            site_avatar: siteAvatar,
            status: 'pending',
            created_at: now()
        };
        data.links.unshift(item);
        await saveData(data);
        return res.status(201).json(item);
    }

    if (routePath === '/articles' && method === 'GET') {
        return res.status(200).json(sortByCreatedAtDesc(data.articles));
    }

    if (routePath === '/articles' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }

        const title = toSafeText(body.title);
        const content = toSafeText(body.content);
        const category = toSafeText(body.category);

        if (!title || !content || !category) {
            return res.status(400).json({ error: '请完整填写文章信息' });
        }

        const item = {
            id: nextId(data.articles),
            title,
            content,
            category,
            created_at: now()
        };
        data.articles.unshift(item);
        writeAuditLog(data, 'article_create', 'success', clientIp, session.u, `article_id=${item.id}`);
        await saveData(data);
        return res.status(201).json(item);
    }

    if (routePath === '/stats' && method === 'GET') {
        const pendingLinks = data.links.filter(item => item.status === 'pending').length;
        return res.status(200).json({
            pending_links: pendingLinks,
            published_articles: data.articles.length,
            total_views: Number(data.stats.total_views || 0)
        });
    }

    if (routePath === '/login' && method === 'POST') {
        if (!requireCloudAdminEnv(req, res)) {
            return;
        }

        const lockRemaining = checkLoginLock(clientIp);
        if (lockRemaining > 0) {
            return res.status(429).json({
                success: false,
                message: `Too many attempts. Retry after ${lockRemaining}s.`
            });
        }

        const username = toSafeText(body.username);
        const password = String(body.password || '');
        const credentials = getAdminCredentials();

        const valid = username === credentials.username && verifyPassword(
            password,
            credentials.password_salt,
            credentials.password_hash,
            credentials.password_iterations
        );

        if (!valid) {
            recordLoginFailure(clientIp);
            writeAuditLog(data, 'admin_login', 'failed', clientIp, username, 'invalid_credentials');
            await saveData(data);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        clearLoginFailures(clientIp);

        const sessionInfo = createSessionToken(credentials.username);
        setSessionCookie(res, sessionInfo.token);
        writeAuditLog(data, 'admin_login', 'success', clientIp, credentials.username, 'login_success');
        await saveData(data);

        return res.status(200).json({
            success: true,
            message: 'Login successful',
            csrf_token: sessionInfo.csrf,
            username: credentials.username
        });
    }

    if (routePath === '/logout' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }
        clearSessionCookie(res);
        writeAuditLog(data, 'admin_logout', 'success', clientIp, session.u, 'logout_success');
        await saveData(data);
        return res.status(200).json({ success: true, message: 'Logged out' });
    }

    if (routePath === '/change-password' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }

        if (getEnvCredentials()) {
            return res.status(400).json({
                success: false,
                message: 'Credentials are managed by environment variables and cannot be changed from panel.'
            });
        }

        const credentials = getAdminCredentials();
        const currentPassword = String(body.current_password || '');
        const newUsername = toSafeText(body.new_username);
        const newPassword = toSafeText(body.new_password);

        if (!verifyPassword(currentPassword, credentials.password_salt, credentials.password_hash, credentials.password_iterations)) {
            writeAuditLog(data, 'credentials_change', 'failed', clientIp, session.u, 'current_password_invalid');
            await saveData(data);
            return res.status(401).json({ success: false, message: 'Current password is incorrect' });
        }

        if (!newUsername && !newPassword) {
            return res.status(400).json({ success: false, message: 'No updates were provided' });
        }

        const finalUsername = newUsername || credentials.username;
        const finalPassword = newPassword ? hashPassword(newPassword) : {
            password_salt: credentials.password_salt,
            password_hash: credentials.password_hash,
            password_iterations: credentials.password_iterations
        };

        const saved = saveAdminCredentials(finalUsername, finalPassword);
        writeAuditLog(data, 'credentials_change', 'success', clientIp, session.u, `username=${saved.username}`);
        await saveData(data);
        return res.status(200).json({ success: true, message: 'Credentials updated successfully', username: saved.username });
    }

    if (routePath === '/reset-admin-credentials' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }

        if (!isLocalRequestHost(req)) {
            return res.status(403).json({
                success: false,
                message: 'Only localhost can reset admin credentials.'
            });
        }

        if (getEnvCredentials()) {
            return res.status(400).json({
                success: false,
                message: 'Credentials are managed by environment variables and cannot be reset from panel.'
            });
        }

        const confirmText = toSafeText(body.confirm_text);
        if (confirmText !== 'RESET_ADMIN') {
            writeAuditLog(data, 'credentials_reset', 'failed', clientIp, session.u, 'invalid_confirm_text');
            await saveData(data);
            return res.status(400).json({ success: false, message: 'Invalid confirmation text' });
        }

        saveAdminCredentials('admin', hashPassword('admin'));
        writeAuditLog(data, 'credentials_reset', 'success', clientIp, session.u, 'reset_to_default');
        await saveData(data);
        return res.status(200).json({ success: true, message: 'Credentials reset to default', username: 'admin' });
    }

    if (routePath === '/contact' && method === 'POST') {
        const name = toSafeText(body.name);
        const email = toSafeText(body.email);
        const subject = toSafeText(body.subject);
        const message = toSafeText(body.message);

        if (!name || !email || !subject || !message) {
            return res.status(400).json({ error: '请完整填写联系表单' });
        }

        data.contact_messages.unshift({
            id: nextId(data.contact_messages),
            name,
            email,
            subject,
            message,
            created_at: now()
        });
        await saveData(data);
        return res.status(201).json({ success: true, message: '消息已发送' });
    }

    if (routePath === '/contact' && method === 'GET') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        return res.status(200).json(sortByCreatedAtDesc(data.contact_messages));
    }

    if (routePath === '/admin-audit-logs' && method === 'GET') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }

        const action = toSafeText(req.query.action);
        const status = toSafeText(req.query.status);
        const keyword = toSafeText(req.query.keyword).toLowerCase();
        const page = parsePositiveInt(req.query.page, 1, 1, 100000);
        const pageSize = parsePositiveInt(req.query.page_size, 20, 1, 200);

        let items = sortByCreatedAtDesc(data.audit_logs);
        if (action) {
            items = items.filter(item => String(item.action || '') === action);
        }
        if (status) {
            items = items.filter(item => String(item.status || '') === status);
        }
        if (keyword) {
            items = items.filter(item => {
                const haystack = [item.username, item.client_ip, item.detail, item.action, item.status].join(' ').toLowerCase();
                return haystack.includes(keyword);
            });
        }

        const total = items.length;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, totalPages);
        const start = (safePage - 1) * pageSize;
        const paged = items.slice(start, start + pageSize);

        return res.status(200).json({
            items: paged,
            total,
            page: safePage,
            page_size: pageSize,
            total_pages: totalPages
        });
    }

    if (routePath === '/admin-audit-logs/export' && method === 'GET') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }

        const action = toSafeText(req.query.action);
        const status = toSafeText(req.query.status);
        const keyword = toSafeText(req.query.keyword).toLowerCase();

        let items = sortByCreatedAtDesc(data.audit_logs);
        if (action) {
            items = items.filter(item => String(item.action || '') === action);
        }
        if (status) {
            items = items.filter(item => String(item.status || '') === status);
        }
        if (keyword) {
            items = items.filter(item => {
                const haystack = [item.username, item.client_ip, item.detail, item.action, item.status].join(' ').toLowerCase();
                return haystack.includes(keyword);
            });
        }

        const csvLines = [
            toCsvLine(['id', 'action', 'status', 'username', 'client_ip', 'detail', 'created_at'])
        ];

        items.slice(0, 1000).forEach(item => {
            csvLines.push(toCsvLine([
                item.id,
                item.action,
                item.status,
                item.username,
                item.client_ip,
                item.detail,
                item.created_at
            ]));
        });

        const filename = `admin-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(`\uFEFF${csvLines.join('\n')}`);
    }

    const linkIdMatch = routePath.match(/^\/links\/(\d+)$/);
    if (linkIdMatch) {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }

        const linkId = Number(linkIdMatch[1]);
        const index = data.links.findIndex(item => Number(item.id) === linkId);
        if (index < 0) {
            return res.status(404).json({ error: 'link not found' });
        }

        if (method === 'PUT') {
            const status = toSafeText(body.status);
            if (!['pending', 'approved', 'rejected'].includes(status)) {
                return res.status(400).json({ error: 'invalid status' });
            }
            data.links[index].status = status;
            writeAuditLog(data, 'link_status_update', 'success', clientIp, session.u, `link_id=${linkId},status=${status}`);
            await saveData(data);
            return res.status(200).json({ id: linkId, status });
        }

        if (method === 'DELETE') {
            data.links.splice(index, 1);
            writeAuditLog(data, 'link_delete', 'success', clientIp, session.u, `link_id=${linkId}`);
            await saveData(data);
            return res.status(200).json({ id: linkId, deleted: true });
        }
    }

    const messageIdMatch = routePath.match(/^\/messages\/(\d+)$/);
    if (messageIdMatch && method === 'DELETE') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }

        const messageId = Number(messageIdMatch[1]);
        const index = data.messages.findIndex(item => Number(item.id) === messageId);
        if (index < 0) {
            return res.status(404).json({ error: 'message not found' });
        }

        data.messages.splice(index, 1);
        writeAuditLog(data, 'message_delete', 'success', clientIp, session.u, `message_id=${messageId}`);
        await saveData(data);
        return res.status(200).json({ id: messageId, deleted: true });
    }

    const articleIdMatch = routePath.match(/^\/articles\/(\d+)$/);
    if (articleIdMatch) {
        const articleId = Number(articleIdMatch[1]);

        if (method === 'GET') {
            const article = data.articles.find(item => Number(item.id) === articleId);
            if (!article) {
                return res.status(404).json({ error: 'article not found' });
            }
            return res.status(200).json(article);
        }

        if (method === 'DELETE') {
            const session = requireAdmin(req, res);
            if (!session) {
                return;
            }
            if (!requireAdminCsrf(req, res, session)) {
                return;
            }

            const index = data.articles.findIndex(item => Number(item.id) === articleId);
            if (index < 0) {
                return res.status(404).json({ error: 'article not found' });
            }

            data.articles.splice(index, 1);
            writeAuditLog(data, 'article_delete', 'success', clientIp, session.u, `article_id=${articleId}`);
            await saveData(data);
            return res.status(200).json({ id: articleId, deleted: true });
        }
    }

    return res.status(404).json({ error: 'API route not found', route: `/api${routePath}`, method });
};
