const express = require('express');
const compression = require('compression');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rssPoller = require('./rss-poller');

/**
 * 轻量 .env 加载（无第三方依赖）。
 * 本地开发时从项目根目录 .env 读取 SMTP_* 等配置；已存在的真实环境变量优先。
 */
function loadEnvFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        const raw = fs.readFileSync(filePath, 'utf8');
        raw.split(/\r?\n/).forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) return;
            const key = trimmed.slice(0, eq).trim();
            let value = trimmed.slice(eq + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1);
            }
            if (key && process.env[key] === undefined) {
                process.env[key] = value;
            }
        });
        console.log('[env] 已加载 ' + filePath);
    } catch (error) {
        console.warn('[env] 读取 .env 失败：' + error.message);
    }
}

loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '..', '.env'));

const mailer = require('../lib/mailer.cjs');
const moderation = require('../lib/moderation.cjs');
const validation = require('../lib/validation.cjs');
const rateLimit = require('../lib/rate-limit.cjs');

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

// 对 HTML/CSS/JS/JSON 启用 gzip，显著降低首屏传输体积
app.use(compression());

/**
 * 只有显式开启 TRUST_PROXY 时才信任 X-Forwarded-For。
 * 否则攻击者可以伪造该头，为每次请求换一个“IP”，从而绕过登录限流。
 */
const TRUST_PROXY = isTruthyEnv(process.env.TRUST_PROXY);
const SESSION_COOKIE_SECURE = isTruthyEnv(process.env.SESSION_COOKIE_SECURE) || process.env.NODE_ENV === 'production';
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');

const AUTH_NO_STORE_PATHS = new Set([
    '/api/login',
    '/api/logout',
    '/api/change-password',
    '/api/reset-admin-credentials'
]);

app.use((req, res, next) => {
    // CORS：只允许与当前 Host 完全一致的同源浏览器请求，避免通配 Origin。
    const requestOrigin = String(req.headers.origin || '');
    const requestHost = String(req.headers.host || '').toLowerCase();
    if (requestOrigin) {
        let originHost = '';
        try {
            originHost = new URL(requestOrigin).host.toLowerCase();
        } catch (error) {
            return res.status(403).json({ error: 'Origin not allowed' });
        }
        if (!requestHost || originHost !== requestHost) {
            return res.status(403).json({ error: 'Origin not allowed' });
        }
        res.header('Access-Control-Allow-Origin', requestOrigin);
        res.header('Vary', 'Origin');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    }
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' https:; " +
        "connect-src 'self' https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'"
    );
    if (SESSION_COOKIE_SECURE) {
        res.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    // 认证/管理响应绝不缓存，避免共享设备或代理缓存泄露 CSRF token、审计日志等敏感信息。
    const requestPath = String(req.path || '').toLowerCase().replace(/\/+$/, '') || '/';
    const needsNoStore = AUTH_NO_STORE_PATHS.has(requestPath)
        || requestPath.startsWith('/api/admin')
        || requestPath === '/api/mail-status';
    if (needsNoStore) {
        res.header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.header('Pragma', 'no-cache');
        res.header('Expires', '0');
    }
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

const rootDir = path.join(__dirname, '..');
const TOOLS_DATA_FILE = path.join(rootDir, 'src', 'data', 'tools.json');
const adminPasswordFile = process.env.ADMIN_PASSWORD_FILE || path.join(rootDir, 'data', 'admin-password.txt');
const adminCredentialsFile = process.env.ADMIN_CREDENTIALS_FILE || path.join(rootDir, 'data', 'admin-credentials.json');
const SESSION_COOKIE_NAME = 'yanmo_admin_session';
const SESSION_TTL_MS = parseEnvInt('SESSION_TTL_MS', 24 * 60 * 60 * 1000, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const SESSION_IDLE_TTL_MS = parseEnvInt('SESSION_IDLE_TTL_MS', 12 * 60 * 60 * 1000, 5 * 60 * 1000, SESSION_TTL_MS);
const CSRF_HEADER_NAME = 'x-csrf-token';
const PASSWORD_HASH_ITERATIONS = parseEnvInt('PASSWORD_HASH_ITERATIONS', 600000, 100000, 2000000);
const LOGIN_WINDOW_MS = parseEnvInt('LOGIN_WINDOW_MS', 10 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = parseEnvInt('LOGIN_MAX_ATTEMPTS', 5, 3, 20);
const LOGIN_LOCK_MS = parseEnvInt('LOGIN_LOCK_MS', 15 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
const MAX_LOGIN_USERNAME_LENGTH = 64;
const MAX_LOGIN_PASSWORD_LENGTH = 256;
const MIN_ADMIN_PASSWORD_LENGTH = 10;
const MAX_ADMIN_PASSWORD_LENGTH = 128;
const adminSessions = new Map();
const ADMIN_SESSIONS_FILE = process.env.ADMIN_SESSIONS_FILE || path.join(rootDir, 'data', 'admin-sessions.json');
const loginFailures = new Map();

function isTruthyEnv(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parseEnvInt(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

/** 常量时间比较，避免通过响应时间判断用户名/Token 的前缀。 */
function safeCompareStrings(left, right) {
    const a = Buffer.from(String(left == null ? '' : left));
    const b = Buffer.from(String(right == null ? '' : right));
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function buildSessionCookie(value, maxAgeSeconds) {
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax` +
        `${SESSION_COOKIE_SECURE ? '; Secure' : ''}; Max-Age=${maxAgeSeconds}`;
}

function isValidHttpUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (error) {
        return false;
    }
}

function isSessionExpired(sessionData, at = Date.now()) {
    if (!sessionData) {
        return true;
    }
    if (Number(sessionData.expiresAt || 0) <= at) {
        return true;
    }
    const lastSeenAt = Number(sessionData.lastSeenAt || sessionData.createdAt || 0);
    return lastSeenAt > 0 && at - lastSeenAt > SESSION_IDLE_TTL_MS;
}

let adminSessionPersistTimer = null;
let adminSessionPersistDirty = false;

/** 把有效会话原子写入磁盘，服务重启后仍保持登录。 */
function persistAdminSessions() {
    try {
        const now = Date.now();
        const serialized = {};
        for (const [sid, sessionData] of adminSessions.entries()) {
            if (!isSessionExpired(sessionData, now)) {
                serialized[sid] = sessionData;
            }
        }
        const dir = path.dirname(ADMIN_SESSIONS_FILE);
        fs.mkdirSync(dir, { recursive: true });
        const tempFile = ADMIN_SESSIONS_FILE + '.tmp';
        fs.writeFileSync(tempFile, JSON.stringify(serialized), { encoding: 'utf8', mode: 0o600 });
        try {
            fs.renameSync(tempFile, ADMIN_SESSIONS_FILE);
        } catch (renameError) {
            try { fs.unlinkSync(ADMIN_SESSIONS_FILE); } catch (ignore) { /* noop */ }
            fs.renameSync(tempFile, ADMIN_SESSIONS_FILE);
        }
        adminSessionPersistDirty = false;
    } catch (error) {
        console.error('[session] 持久化失败:', error.message);
    }
}

function scheduleAdminSessionPersist() {
    adminSessionPersistDirty = true;
    if (adminSessionPersistTimer) {
        return;
    }
    adminSessionPersistTimer = setTimeout(() => {
        adminSessionPersistTimer = null;
        if (adminSessionPersistDirty) {
            persistAdminSessions();
        }
    }, 30000);
    if (adminSessionPersistTimer.unref) {
        adminSessionPersistTimer.unref();
    }
}

function loadAdminSessions() {
    try {
        if (!fs.existsSync(ADMIN_SESSIONS_FILE)) {
            return;
        }
        const raw = fs.readFileSync(ADMIN_SESSIONS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return;
        }
        const now = Date.now();
        let restored = 0;
        Object.entries(parsed).forEach(([sid, sessionData]) => {
            if (sid && sessionData && typeof sessionData === 'object' && !isSessionExpired(sessionData, now)) {
                adminSessions.set(sid, sessionData);
                restored++;
            }
        });
        if (restored) {
            console.log('[session] 恢复管理员会话:', restored);
        }
    } catch (error) {
        console.error('[session] 读取会话文件失败:', error.message);
    }
}

function cleanupExpiredSessions() {
    const now = Date.now();
    let removed = false;
    for (const [sid, sessionData] of adminSessions.entries()) {
        if (isSessionExpired(sessionData, now)) {
            adminSessions.delete(sid);
            removed = true;
        }
    }
    if (removed) {
        scheduleAdminSessionPersist();
    }
}

/** 改密后让其他已登录会话立即失效，避免旧 Cookie 长期可用。 */
function invalidateOtherAdminSessions(currentSid) {
    for (const sid of Array.from(adminSessions.keys())) {
        if (sid !== currentSid) {
            adminSessions.delete(sid);
        }
    }
    persistAdminSessions();
}

function invalidateAllAdminSessions() {
    adminSessions.clear();
    persistAdminSessions();
}

// 启动时恢复上次服务进程留下的有效会话
loadAdminSessions();

/**
 * 管理员新密码强度校验。
 * 返回空字符串表示通过，否则返回可直接展示给用户的中文提示。
 */
function validateAdminPasswordStrength(password, username) {
    const value = String(password || '');
    const normalizedUsername = String(username || '').trim().toLowerCase();
    if (value.length < MIN_ADMIN_PASSWORD_LENGTH) {
        return `新密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 位`;
    }
    if (value.length > MAX_ADMIN_PASSWORD_LENGTH) {
        return `新密码不能超过 ${MAX_ADMIN_PASSWORD_LENGTH} 位`;
    }
    if (value.toLowerCase() === 'admin') {
        return '不能使用默认密码';
    }
    if (normalizedUsername && value.toLowerCase() === normalizedUsername) {
        return '新密码不能与管理员账号相同';
    }
    const classes = [
        /[a-z]/,
        /[A-Z]/,
        /\d/,
        /[^A-Za-z0-9]/
    ].filter(pattern => pattern.test(value)).length;
    if (classes < 3) {
        return '新密码需包含大写字母、小写字母、数字、符号中的至少三类';
    }
    return '';
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
        const computed = crypto.pbkdf2Sync(
            String(password),
            Buffer.from(String(saltHex), 'hex'),
            Number(iterations),
            32,
            'sha256'
        ).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(String(hashHex)));
    } catch (error) {
        return false;
    }
}

function parseCookies(req) {
    const source = String(req.headers.cookie || '');
    const pairs = source.split(';').map(item => item.trim()).filter(Boolean);
    const parsed = {};
    for (const pair of pairs) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) {
            continue;
        }
        const key = pair.slice(0, eqIdx).trim();
        const value = pair.slice(eqIdx + 1).trim();
        try {
            parsed[key] = decodeURIComponent(value);
        } catch (error) {
            parsed[key] = value;
        }
    }
    return parsed;
}

function createAdminSession(username) {
    cleanupExpiredSessions();
    const now = Date.now();
    const sid = crypto.randomBytes(24).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    adminSessions.set(sid, {
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + SESSION_TTL_MS,
        csrfToken: csrfToken,
        username: String(username || '')
    });
    persistAdminSessions();
    return { sid, csrfToken };
}

function clearAdminSession(req) {
    const cookies = parseCookies(req);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (sid) {
        adminSessions.delete(sid);
        persistAdminSessions();
    }
}

function requireAdmin(req, res, next) {
    cleanupExpiredSessions();
    const cookies = parseCookies(req);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (!sid) {
        writeAdminAuditLog({
            action: 'admin_auth_required',
            status: 'denied',
            clientIp: getClientIdentifier(req),
            detail: 'missing_or_expired_session'
        });
        return res.status(401).json({ error: '请先登录管理员账户' });
    }
    const sessionData = adminSessions.get(sid);
    if (isSessionExpired(sessionData)) {
        adminSessions.delete(sid);
        scheduleAdminSessionPersist();
        writeAdminAuditLog({
            action: 'admin_auth_required',
            status: 'denied',
            clientIp: getClientIdentifier(req),
            detail: 'missing_or_expired_session'
        });
        return res.status(401).json({ error: '请先登录管理员账户' });
    }

    // 滑动续期：每次请求刷新空闲计时，但绝对过期时间保持不变。
    sessionData.lastSeenAt = Date.now();
    scheduleAdminSessionPersist();
    req.adminSession = sessionData;
    req.adminSessionId = sid;
    return next();
}

function requireAdminCsrf(req, res, next) {
    if (!req.adminSession) {
        return res.status(401).json({ error: '请先登录管理员账户' });
    }

    const provided = String(req.headers[CSRF_HEADER_NAME] || '').trim();
    const expected = String(req.adminSession.csrfToken || '').trim();
    const tokenMatches = provided.length > 0
        && expected.length > 0
        && safeCompareStrings(provided, expected);
    if (!tokenMatches) {
        writeAdminAuditLog({
            action: 'csrf_check',
            status: 'denied',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: 'invalid_or_missing_token'
        });
        return res.status(403).json({ error: 'CSRF token 无效或缺失' });
    }

    return next();
}

function publicRateLimit(req, action, limit, windowMs) {
    const key = action + '|' + getClientIdentifier(req);
    const result = rateLimit.hit(key, limit, windowMs);
    if (!result.allowed) {
        return { allowed: false, retryAfter: result.retryAfter };
    }
    return { allowed: true, retryAfter: 0 };
}

function rejectRateLimited(res, result) {
    res.setHeader('Retry-After', String(result.retryAfter || 60));
    return res.status(429).json({ error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' });
}

function isLoopbackRequest(req) {
    const remote = String(req.socket && req.socket.remoteAddress || '').toLowerCase();
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote.endsWith('127.0.0.1');
}

function getClientIdentifier(req) {
    // 仅当显式信任反向代理时才读取转发头，避免伪造 X-Forwarded-For 绕过限流。
    const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').trim() : '';
    if (forwarded) {
        return forwarded.split(',')[0].trim() || 'unknown';
    }
    return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

const visitorGeoCache = new Map();

function normalizeVisitorIp(ip) {
    return String(ip || 'unknown').replace(/^::ffff:/i, '').trim() || 'unknown';
}

function isPrivateVisitorIp(ip) {
    const value = normalizeVisitorIp(ip).toLowerCase();
    if (!value || value === 'unknown') return true;
    if (value === '::1' || value === '127.0.0.1' || value === 'localhost') return true;
    if (value.startsWith('10.') || value.startsWith('192.168.') || value.startsWith('169.254.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(value)) return true;
    if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
    return false;
}

async function lookupVisitorRegion(ip) {
    const value = normalizeVisitorIp(ip);
    if (isPrivateVisitorIp(value)) return '本地 / 内网';
    const cached = visitorGeoCache.get(value);
    if (cached && cached.expiresAt > Date.now()) return cached.region;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
        const response = await fetch('https://ipwho.is/' + encodeURIComponent(value) + '?lang=zh-CN', {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error('geo HTTP ' + response.status);
        const data = await response.json();
        if (!data || data.success === false) throw new Error('geo lookup failed');
        const parts = [data.country, data.region, data.city].filter(Boolean);
        const region = parts.join(' / ') || '未知';
        visitorGeoCache.set(value, { region: region, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
        if (visitorGeoCache.size > 1000) {
            const oldest = visitorGeoCache.keys().next().value;
            visitorGeoCache.delete(oldest);
        }
        return region;
    } catch (error) {
        return '未知';
    } finally {
        clearTimeout(timer);
    }
}

function cleanupRetention() {
    // 与隐私协议保持一致：访客记录 180 天、审计日志 12 个月
    db.run("DELETE FROM visitors WHERE created_at < datetime('now', '-180 days')", [], function (err) {
        if (err) console.error('[retention] visitors cleanup failed:', err.message);
        else if (this && this.changes) console.log('[retention] removed visitors:', this.changes);
    });
    db.run("DELETE FROM admin_audit_logs WHERE created_at < datetime('now', '-365 days')", [], function (err) {
        if (err) console.error('[retention] audit cleanup failed:', err.message);
        else if (this && this.changes) console.log('[retention] removed audit logs:', this.changes);
    });
}

function recordVisitor(req) {
    const ip = normalizeVisitorIp(getClientIdentifier(req));
    const path = String(req.originalUrl || req.path || '/').slice(0, 500);
    const ua = String(req.headers['user-agent'] || '').slice(0, 500);
    const referrer = String(req.headers.referer || '').slice(0, 500);
    lookupVisitorRegion(ip).then((region) => {
        db.run(
            'INSERT INTO visitors (ip, region, path, user_agent, referrer) VALUES (?, ?, ?, ?, ?)',
            [ip, region, path, ua, referrer],
            (err) => {
                if (err) console.error('[visitor] 写入失败:', err.message);
            }
        );
    });
}

function clearLoginFailures(clientId) {
    loginFailures.delete(clientId);
}

function checkLoginLock(clientId) {
    const now = Date.now();
    const entry = loginFailures.get(clientId);
    if (!entry) {
        return 0;
    }

    if (Number(entry.lockUntil || 0) > now) {
        return Math.ceil((entry.lockUntil - now) / 1000);
    }

    const attempts = (entry.attempts || []).filter(ts => now - ts <= LOGIN_WINDOW_MS);
    if (attempts.length) {
        loginFailures.set(clientId, { attempts: attempts, lockUntil: 0 });
    } else {
        loginFailures.delete(clientId);
    }
    return 0;
}

function recordLoginFailure(clientId) {
    const now = Date.now();
    const entry = loginFailures.get(clientId) || { attempts: [], lockUntil: 0 };
    const attempts = (entry.attempts || []).filter(ts => now - ts <= LOGIN_WINDOW_MS);
    attempts.push(now);
    const nextEntry = { attempts: attempts, lockUntil: 0 };
    if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
        nextEntry.lockUntil = now + LOGIN_LOCK_MS;
    }
    loginFailures.set(clientId, nextEntry);
}

function readLegacyAdminPassword() {
    if (!fs.existsSync(adminPasswordFile)) {
        return 'admin';
    }

    const legacyPassword = fs.readFileSync(adminPasswordFile, 'utf8').trim();
    if (!legacyPassword || legacyPassword === 'managed_by_hash_credentials') {
        return 'admin';
    }
    return legacyPassword;
}

function saveAdminCredentials(username, password) {
    const payload = {
        username,
        password_salt: String(password.password_salt || ''),
        password_hash: String(password.password_hash || ''),
        password_iterations: Number(password.password_iterations || PASSWORD_HASH_ITERATIONS)
    };
    fs.writeFileSync(adminCredentialsFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    try {
        fs.chmodSync(adminCredentialsFile, 0o600);
    } catch (error) {
        // Windows / read-only filesystems may not support chmod.
    }
    fs.writeFileSync(adminPasswordFile, 'managed_by_hash_credentials', 'utf8');
}

function getAdminCredentials() {
    if (fs.existsSync(adminCredentialsFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(adminCredentialsFile, 'utf8'));
            const username = String((parsed && parsed.username) || '').trim() || 'admin';
            const passwordSalt = String((parsed && parsed.password_salt) || '').trim();
            const passwordHash = String((parsed && parsed.password_hash) || '').trim();
            const passwordIterations = Number((parsed && parsed.password_iterations) || PASSWORD_HASH_ITERATIONS);

            if (passwordSalt && passwordHash) {
                return {
                    username,
                    password_salt: passwordSalt,
                    password_hash: passwordHash,
                    password_iterations: passwordIterations
                };
            }

            const legacyPassword = String((parsed && parsed.password) || '').trim() || readLegacyAdminPassword();
            const migrated = hashPassword(legacyPassword);
            saveAdminCredentials(username, migrated);
            return { username, ...migrated };
        } catch (error) {
            // Ignore parse errors and recreate file with default credentials.
        }
    }

    // 仅在确实需要回退时计算默认凭据的哈希，避免每次登录都做一次无用的 PBKDF2。
    const defaultCredentials = {
        username: 'admin',
        ...hashPassword(readLegacyAdminPassword())
    };
    saveAdminCredentials(defaultCredentials.username, defaultCredentials);
    return defaultCredentials;
}

// 配置中间件
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '2mb' }));
// 站点入口：加载页（原根目录 index.html 已归入 src/pages/）
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'src', 'pages', 'loading.html'));
});

// 旧地址兼容：/index.html 与已移除的根目录跳转壳，301 到规范页面
const legacyPageRedirects = {
    '/index.html': '/src/pages/index.html',
    '/admin.html': '/src/pages/admin.html',
    '/admin-dashboard.html': '/src/pages/admin-dashboard.html',
    '/link-apply.html': '/src/pages/link-apply.html',
    '/message-apply.html': '/src/pages/message-apply.html'
};
app.get(Object.keys(legacyPageRedirects), (req, res) => {
    res.redirect(301, legacyPageRedirects[req.path]);
});

// 旧地址兼容：/pages/* 重定向到 /src/pages/*（页面已统一收纳到 src/）
app.use('/pages', (req, res) => {
    const suffix = req.originalUrl.replace(/^\/pages/, '');
    res.redirect(301, '/src/pages' + suffix);
});

// 站点根目录即仓库根目录，但静态资源只暴露前端目录：
//   /src/pages/**  业务页面（同时通过根级页面静态目录提供 /admin.html 等短地址）
//   /src/css/**    样式
//   /src/js/**     前端脚本
//   /assets/**     图片 / 音频 / 第三方库
// 绝不能把仓库根目录整体 static 暴露，否则 /data/admin-credentials.json、/server/server.js 等会被直接下载。

// 记录公开页面的 HTML 访问，用于后台访客统计。管理页、API 与静态资源不计入。
app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    const pathName = String(req.path || '');
    if (
        pathName.startsWith('/api/') ||
        pathName.startsWith('/assets/') ||
        pathName.startsWith('/src/css/') ||
        pathName.startsWith('/src/js/') ||
        pathName.startsWith('/data/') ||
        /admin/i.test(pathName)
    ) {
        return next();
    }
    res.on('finish', () => {
        const contentType = String(res.getHeader('Content-Type') || '');
        if (res.statusCode === 200 && contentType.includes('text/html')) {
            recordVisitor(req);
        }
    });
    next();
});

app.use(express.static(path.join(__dirname, '..', 'src', 'pages')));
app.use('/src', express.static(path.join(__dirname, '..', 'src')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

/*
 * 文章详情：一个标题一个页面 —— /post/<id>
 * 模板仍是 src/pages/post.html（前端从路径里取 id），
 * 同时保留旧的 /post.html?id=<id> 地址以兼容外链。
 */
app.get(['/post/:key', '/post/:key/'], (req, res) => {
    const key = String(req.params.key || '');
    // 只接受数字 id。像 /post/about.html 这种（旧版相对链接残留、手输错误）
    // 一律回文章列表，避免"点首页却还是文章页"的错乱。
    if (!/^\d+$/.test(key)) {
        return res.redirect(302, '/src/pages/articles.html');
    }
    res.sendFile(path.join(__dirname, '..', 'src', 'pages', 'post.html'));
});

// 只有 /post 没有编号时，回到文章列表
app.get('/post', (req, res) => {
    res.redirect('/src/pages/articles.html');
});

// 连接数据库
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'blog.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        db.serialize(() => {
            // 创建表
            db.run(`
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL,
                    subject TEXT DEFAULT '',
                    message TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    source TEXT DEFAULT 'guestbook',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            // Migrate existing messages table that predate subject / is_read / source columns
            db.run("ALTER TABLE messages ADD COLUMN subject TEXT DEFAULT ''", [], () => {});
            db.run("ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0", [], () => {});
            db.run("ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'guestbook'", [], (sourceError) => {
                if (!sourceError) {
                    // One-time backfill: old contact-form rows used a subject or the [主题] prefix.
                    db.run(
                        "UPDATE messages SET source = 'contact' WHERE TRIM(COALESCE(subject, '')) <> '' OR message LIKE '[主题]%' OR message LIKE '[接口联调]%'",
                        [],
                        () => {}
                    );
                }
            });

            // 访客访问记录：IP、地区、页面、UA 和来源。仅管理员可见。
            db.run(`
                CREATE TABLE IF NOT EXISTS visitors (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ip TEXT NOT NULL,
                    region TEXT DEFAULT '',
                    path TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    referrer TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            db.run('CREATE INDEX IF NOT EXISTS idx_visitors_created_at ON visitors(created_at)');
            db.run('CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip)');
            
            db.run(`
                CREATE TABLE IF NOT EXISTS links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    site_name TEXT NOT NULL,
                    site_url TEXT NOT NULL,
                    site_description TEXT NOT NULL,
                    site_avatar TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    category TEXT DEFAULT 'PEER_CLUSTER',
                    is_online INTEGER DEFAULT 0,
                    last_checked TEXT DEFAULT NULL,
                    latest_post_title TEXT DEFAULT NULL,
                    latest_post_url TEXT DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            // Migrate existing tables that predate these columns
            const linkMigrations = [
                "ALTER TABLE links ADD COLUMN category TEXT DEFAULT 'PEER_CLUSTER'",
                "ALTER TABLE links ADD COLUMN is_online INTEGER DEFAULT 0",
                "ALTER TABLE links ADD COLUMN last_checked TEXT DEFAULT NULL",
                "ALTER TABLE links ADD COLUMN latest_post_title TEXT DEFAULT NULL",
                "ALTER TABLE links ADD COLUMN latest_post_url TEXT DEFAULT NULL"
            ];
            linkMigrations.forEach(sql => db.run(sql, [], () => {}));
            
            db.run(`
                CREATE TABLE IF NOT EXISTS articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    category TEXT NOT NULL,
                    cover_image TEXT DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // 兼容旧库：封面图为后加字段
            db.run('ALTER TABLE articles ADD COLUMN cover_image TEXT DEFAULT NULL', [], () => {});

            db.run(`
                CREATE TABLE IF NOT EXISTS daily_posts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    caption TEXT NOT NULL DEFAULT '',
                    image_data TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS daily_albums (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL,
                    description TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            // 兼容旧库：照片归属相册为后加字段；旧照片归入默认相册
            db.run('ALTER TABLE daily_posts ADD COLUMN album_id INTEGER DEFAULT NULL', [], () => {});
            db.get('SELECT COUNT(*) AS count FROM daily_posts WHERE album_id IS NULL', [], (err, row) => {
                if (err || !row || !row.count) return;
                db.get('SELECT id FROM daily_albums ORDER BY id ASC LIMIT 1', [], (albumErr, album) => {
                    if (albumErr) return;
                    if (album) {
                        db.run('UPDATE daily_posts SET album_id = ? WHERE album_id IS NULL', [album.id]);
                        return;
                    }
                    db.run(
                        'INSERT INTO daily_albums (title, description) VALUES (?, ?)',
                        ['默认相册', '历史日常照片'],
                        function (insertErr) {
                            if (!insertErr) {
                                db.run('UPDATE daily_posts SET album_id = ? WHERE album_id IS NULL', [this.lastID]);
                            }
                        }
                    );
                });
            });

            db.run(`
                CREATE TABLE IF NOT EXISTS tools (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT '',
                    version TEXT DEFAULT '',
                    size TEXT DEFAULT '',
                    description TEXT DEFAULT '',
                    glyph TEXT DEFAULT '',
                    tone TEXT DEFAULT 'blue',
                    download_url TEXT DEFAULT '',
                    pan_url TEXT DEFAULT '',
                    pan_code TEXT DEFAULT '',
                    source TEXT DEFAULT '',
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    sort_order INTEGER DEFAULT 0
                )
            `);

            db.get('SELECT COUNT(*) AS count FROM tools', [], (err, row) => {
                if (err || !row || row.count > 0) return;
                try {
                    const parsed = JSON.parse(fs.readFileSync(TOOLS_DATA_FILE, 'utf8'));
                    const items = Array.isArray(parsed.tools) ? parsed.tools : [];
                    items.forEach((tool, index) => {
                        db.run(
                            'INSERT INTO tools (name, category, version, size, description, glyph, tone, download_url, pan_url, pan_code, source, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                            [
                                validation.trimmed(tool.name, 120),
                                validation.trimmed(tool.category, 40),
                                validation.trimmed(tool.version, 40),
                                validation.trimmed(tool.size, 40),
                                validation.trimmed(tool.description, 600),
                                validation.trimmed(tool.glyph, 4),
                                validation.trimmed(tool.tone, 20) || 'blue',
                                validation.trimmed(tool.downloadUrl, 2048),
                                validation.trimmed(tool.panUrl, 2048),
                                validation.trimmed(tool.panCode, 40),
                                validation.trimmed(tool.source, 40),
                                validation.trimmed(tool.updatedAt, 40) || new Date().toISOString().slice(0, 10),
                                index
                            ]
                        );
                    });
                } catch (error) {
                    console.warn('[tools] seed skipped:', error.message);
                }
            });

            db.run(`
                CREATE TABLE IF NOT EXISTS admin_audit_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    action TEXT NOT NULL,
                    status TEXT NOT NULL,
                    username TEXT DEFAULT '',
                    client_ip TEXT DEFAULT '',
                    detail TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // 插入示例文章数据
            db.get('SELECT COUNT(*) as count FROM articles', [], (err, row) => {
                if (!err && row && row.count === 0) {
                    const sampleArticles = [
                        {
                            title: 'Web应用渗透测试深度指南 (2026版)',
                            content: '在这个数字化时代，Web安全是企业的生命线。本文将深入探讨OWASP Top 10漏洞，并结合实战工具，手把手教你如何通过模拟攻击来防御真实威胁。\n\n首先，信息收集是所有攻击的基础。我们需要利用Nmap进行端口扫描，使用Dirsearch探测目录，并利用Whois工具了解目标的组织架构。每一个微小的细节都可能成为突破口。\n\n其次，我们将聚焦于SQL注入和XSS这两种经典但依然常见的漏洞。通过手动构造Payload，我们可以绕过简单的WAF（Web应用防火墙）防护。本文提供了最新的Bypass技巧，帮助你在合法合规的渗透测试中突破防线。\n\n最后，报告的编写同样重要。一份专业的渗透测试报告不仅要指出漏洞，更要给出可落地的修复方案，帮助开发团队从根本上消除安全隐患。',
                            category: '渗透测试'
                        },
                        {
                            title: '生成式AI系统的安全边界：从Prompt Injection到后门攻击',
                            content: '随着LLM的普及，AI安全已成为新的战场。我们将分析提示词注入的多种模式，探讨如何构建稳健的过滤层，并揭露目前AI应用中常见的供应链安全风险。\n\n提示词注入(Prompt Injection)是目前AI系统面临的首要威胁。攻击者可以通过巧妙设计的指令，诱导模型忽略原有的系统约束，从而泄露敏感数据或执行非预期的指令。我们将演示几种经典的"越狱"模式。\n\n除了指令层面的漏洞，我们还需要关注模型参数层面的后门。通过在微调阶段注入特定触发器(Trigger)，攻击者可以控制模型在特定输入下的输出。这种隐蔽的攻击方式对现代AI供应链构成了严峻挑战。\n\n应对这些挑战，需要从模型鲁棒性训练、输入输出审查以及沙箱化执行三个维度建立全方位的防御体系。',
                            category: 'AI安全'
                        },
                        {
                            title: '企业级零信任架构(Zero Trust)实践方案',
                            content: '传统的边界防御已经失效。本文分析了零信任的核心思想"从不信任，始终验证"，并提供了在混合云环境下实现身份感知代理(IAP)的技术路径。\n\n零信任不是一种产品，而是一种安全哲学。它要求无论是在内部网络还是外部，任何访问请求都必须经过动态、严格的身份验证。这需要我们将安全边界从网络层面迁移到身份和应用层面。\n\n在落地实践中，身份感知代理(Identity-Aware Proxy)是核心组件。它通过拦截所有内部系统的流量，集中进行身份核验和权限管控，从而实现了对核心业务系统的极细粒度保护。本文详细记录了我们在某大型分布式架构中的迁移经验。',
                            category: '企业安全'
                        },
                        {
                            title: '基于Python的自动化弱点扫描器开发实战',
                            content: '学会如何利用Python开发一个轻量级的分布式扫描框架。涵盖异步并发请求、指纹识别算法以及漏洞库的动态集成方案。',
                            category: 'Python安全'
                        },
                        {
                            title: '硬件安全浅谈：侧信道攻击与防御',
                            content: '不仅是软件，硬件层面同样存在致命弱点。本文通过功耗分析和电磁辐射泄露的案例，带你进入物理层安全研究的奇妙世界。',
                            category: '硬件安全'
                        },
                        {
                            title: '企业网络安全架构设计',
                            content: '总结企业在边界防护、身份管理和日志审计上的常见设计策略。',
                            category: '企业安全'
                        }
                    ];
                    
                    sampleArticles.forEach(article => {
                        db.run(
                            'INSERT INTO articles (title, content, category) VALUES (?, ?, ?)',
                            [article.title, article.content, article.category]
                        );
                    });
                }
            });
        });
    }
});

function parsePositiveInt(value, fallback, minValue, maxValue) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(maxValue, Math.max(minValue, parsed));
}

function writeAdminAuditLog({ action, status, username = '', clientIp = '', detail = '' }) {
    db.run(
        'INSERT INTO admin_audit_logs (action, status, username, client_ip, detail) VALUES (?, ?, ?, ?, ?)',
        [
            String(action || '').slice(0, 120),
            String(status || '').slice(0, 20),
            String(username || '').slice(0, 80),
            String(clientIp || '').slice(0, 80),
            String(detail || '').slice(0, 500)
        ],
        (err) => {
            if (err) {
                console.error('[audit]', err.message);
            }
        }
    );
}

function csvEscape(value) {
    let text = value === null || value === undefined ? '' : String(value);
    // 防止 Excel / 表格软件把用户可控字段当成公式执行
    if (/^[=+\-@\t\r]/.test(text)) {
        text = "'" + text;
    }
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// 处理留言提交
app.post('/api/messages', (req, res) => {
    const limited = publicRateLimit(req, 'message', 12, 10 * 60 * 1000);
    if (!limited.allowed) return rejectRateLimited(res, limited);

    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const name = validation.trimmed(req.body.name, 80);
    const email = validation.trimmed(req.body.email, 200);
    const message = validation.trimmed(req.body.message, 2000);
    const subject = validation.trimmed(req.body.subject, 200);

    if (!name || !email || !message) {
        return res.status(400).json({ error: '请完整填写称呼、邮箱和留言内容' });
    }
    if (!validation.isEmail(email)) {
        return res.status(400).json({ error: '邮箱格式不正确' });
    }

    const verdict = moderation.checkMessage({ name, message });
    if (!verdict.ok) {
        return res.status(400).json({
            error: '留言包含不当内容或垃圾信息，请修改后重试',
            code: 'MESSAGE_REJECTED'
        });
    }

    db.run(
        'INSERT INTO messages (name, email, subject, message) VALUES (?, ?, ?, ?)',
        [name, email, subject, message],
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            res.status(201).json({ id: this.lastID, name, email, subject, message, moderation: 'auto-passed' });
        }
    );
});

// 处理“联系我”页面提交（带 subject 主题字段）
// 流程：先落库 → 再尝试 SMTP 通知站长 → 如实告知前端是否真的发出去了
app.post('/api/contact', (req, res) => {
    const limited = publicRateLimit(req, 'contact', 8, 10 * 60 * 1000);
    if (!limited.allowed) return rejectRateLimited(res, limited);

    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ success: false, error: '请求格式不正确' });
    }
    const body = req.body;
    const name = validation.trimmed(body.name, 80);
    const email = validation.trimmed(body.email, 200);
    const subject = validation.trimmed(body.subject, 200);
    const message = validation.trimmed(body.message, 8000);

    if (!name || !email || !message) {
        return res.status(400).json({ success: false, error: '请完整填写姓名、邮箱和留言内容' });
    }
    if (!validation.isEmail(email)) {
        return res.status(400).json({ success: false, error: '邮箱格式不正确' });
    }

    db.run(
        "INSERT INTO messages (name, email, subject, message, source) VALUES (?, ?, ?, ?, 'contact')",
        [name, email, subject, message],
        async function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ success: false, error: 'Internal server error' });
            }

            const insertedId = this.lastID;
            const mailResult = await mailer.sendContactNotification({
                name,
                email,
                subject,
                message,
                received_at: new Date().toISOString(),
                client_ip: getClientIdentifier(req)
            });

            return res.status(201).json({
                success: true,
                id: insertedId,
                mailed: mailResult.ok === true,
                mail_reason: mailResult.ok ? null : (mailResult.reason || 'send_failed'),
                message: mailResult.ok
                    ? '消息已发送到站长邮箱，感谢您的来信！'
                    : '留言已保存到站内，但站点的邮件通知暂未开启。'
            });
        }
    );
});

// 邮件通道自检（仅管理员）：快速确认 SMTP 是否配好、能否连上
app.get('/api/mail-status', requireAdmin, async (req, res) => {
    const status = mailer.getStatus();
    res.status(200).json(status);
});

// 发送一封测试邮件（仅管理员 + CSRF）
app.post('/api/mail-test', requireAdmin, requireAdminCsrf, async (req, res) => {
    const status = mailer.getStatus();
    if (!status.configured) {
        return res.status(400).json({
            ok: false,
            error: 'SMTP 尚未配置，请先完成 SMTP_HOST / SMTP_USER / SMTP_PASS / CONTACT_TO',
            reason: 'not_configured'
        });
    }

    const result = await mailer.sendContactNotification({
        name: 'SMTP 自检',
        email: status.to || status.user || '',
        subject: 'YanMo 博客 SMTP 测试',
        message: '这是一封来自后台「邮件通道自检」的测试邮件。收到即表示 SMTP 配置可用。'
    });

    if (!result || result.ok !== true) {
        return res.status(502).json({
            ok: false,
            error: (result && (result.error || result.reason)) || '发送失败',
            reason: (result && result.reason) || 'send_failed'
        });
    }

    res.json({
        ok: true,
        to: status.to || status.user || null,
        message_id: result.messageId || null,
        at: new Date().toISOString()
    });
});

// 处理友链申请
app.post('/api/links', (req, res) => {
    const limited = publicRateLimit(req, 'link-apply', 10, 60 * 60 * 1000);
    if (!limited.allowed) return rejectRateLimited(res, limited);

    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }

    const siteName = validation.trimmed(req.body['site-name'], 100);
    const siteUrl = validation.httpUrl(req.body['site-url'], 2048);
    const siteDescription = validation.trimmed(req.body['site-description'], 500);
    const siteAvatar = validation.imageDataUrl(req.body['site-avatar'], 300000);

    if (!siteName || !siteUrl || !siteDescription) {
        return res.status(400).json({ error: '请完整填写站点名称、地址和简介' });
    }
    if (!siteUrl) {
        return res.status(400).json({ error: 'site-url must be a valid http/https url' });
    }
    if (siteAvatar === null) {
        return res.status(400).json({ error: '头像格式无效或文件过大' });
    }
    
    db.run(
        'INSERT INTO links (site_name, site_url, site_description, site_avatar) VALUES (?, ?, ?, ?)',
        [siteName, siteUrl, siteDescription, siteAvatar || ''],
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            res.status(201).json({ id: this.lastID, siteName, siteUrl, siteDescription, siteAvatar: siteAvatar || '' });
        }
    );
});

// 获取留言列表（公开内容仅含基本信息；管理员可见全部字段）
app.get('/api/messages', (req, res) => {
    // 通过 cookie 判断是否为管理员（管理员页面调用时自动带 cookie）
    let isAdmin = false;
    try {
        const sid = parseCookies(req)[SESSION_COOKIE_NAME];
        const sessionData = sid ? adminSessions.get(sid) : null;
        if (sessionData && Number(sessionData.expiresAt || 0) > Date.now()) isAdmin = true;
    } catch (_) {}

    const source = String(req.query.source || '').trim();
    let where = " WHERE COALESCE(source, 'guestbook') = 'guestbook'";
    if (isAdmin) {
        if (source === 'contact') where = " WHERE source = 'contact'";
        else if (source === 'guestbook') where = " WHERE COALESCE(source, 'guestbook') = 'guestbook'";
        else where = '';
    }
    const select = isAdmin
        ? 'SELECT id, name, email, subject, message, is_read, source, created_at FROM messages'
        : 'SELECT id, name, message, created_at FROM messages';
    const sql = select + where + ' ORDER BY created_at DESC';
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
        }
        res.json(rows);
    });
});

// 管理端邮件列表（联系表单的站内副本）
app.get('/api/contact', requireAdmin, (req, res) => {
    db.all(
        "SELECT id, name, email, subject, message, is_read, created_at FROM messages WHERE source = 'contact' ORDER BY created_at DESC",
        [],
        (err, rows) => {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            res.json(rows || []);
        }
    );
});

// 标记留言为已读 / 未读（管理员）
app.patch('/api/messages/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Message not found' });
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const { is_read } = req.body;
    if (typeof is_read !== 'boolean' && !['true', 'false', 0, 1, '0', '1'].includes(is_read)) {
        return res.status(400).json({ error: 'invalid is_read' });
    }
    const value = (is_read === true || is_read === 'true' || is_read === 1 || is_read === '1') ? 1 : 0;
    db.run(
        'UPDATE messages SET is_read = ? WHERE id = ?',
        [value, id],
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            res.json({ id: Number(id), is_read: value, updated: true });
        }
    );
});

// 获取友链列表
app.get('/api/links', (req, res) => {
    db.all(
        `SELECT id, site_name, site_url, site_description, site_avatar,
                category, is_online, last_checked,
                latest_post_title, latest_post_url, created_at,
                'approved' AS status
         FROM links WHERE status = 'approved' ORDER BY created_at DESC`,
        [],
        (err, rows) => {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            res.json(rows);
        }
    );
});

// 管理端获取全部友链（含待审核 / 已拒绝）
app.get('/api/admin/links', requireAdmin, (req, res) => {
    db.all('SELECT * FROM links ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            console.error('[500]', err.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
        res.json(rows || []);
    });
});

// 访客统计（仅管理员）
app.get('/api/admin/visitors', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size, 10) || 10));
    const ip = validation.trimmed(req.query.ip, 100);
    const region = validation.trimmed(req.query.region, 100);

    const filters = [];
    const params = [];
    if (ip) {
        filters.push('ip LIKE ?');
        params.push('%' + ip + '%');
    }
    if (region) {
        filters.push('region LIKE ?');
        params.push('%' + region + '%');
    }
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const todayClause = (filters.length ? where + ' AND ' : ' WHERE ') + "date(created_at, 'localtime') = date('now', 'localtime')";

    db.get('SELECT COUNT(*) AS total, COUNT(DISTINCT ip) AS unique_ips FROM visitors' + where, params, (countError, countRow) => {
        if (countError) {
            console.error('[500]', countError.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
        const total = Number(countRow && countRow.total) || 0;
        const uniqueIps = Number(countRow && countRow.unique_ips) || 0;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const currentPage = Math.min(page, totalPages);
        const offset = (currentPage - 1) * pageSize;

        db.all(
            'SELECT id, ip, region, path, user_agent, referrer, created_at FROM visitors' + where + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
            params.concat([pageSize, offset]),
            (listError, rows) => {
                if (listError) {
                    console.error('[500]', listError.message);
                    return res.status(500).json({ error: 'Internal server error' });
                }
                db.get(
                    'SELECT COUNT(*) AS today_total, COUNT(DISTINCT ip) AS today_unique FROM visitors' + todayClause,
                    params,
                    (todayError, todayRow) => {
                        if (todayError) {
                            console.error('[500]', todayError.message);
                            return res.status(500).json({ error: 'Internal server error' });
                        }
                        db.all(
                            'SELECT region, COUNT(*) AS count FROM visitors GROUP BY region ORDER BY count DESC, region ASC LIMIT 8',
                            [],
                            (regionError, regionRows) => {
                                if (regionError) {
                                    console.error('[500]', regionError.message);
                                    return res.status(500).json({ error: 'Internal server error' });
                                }
                                res.json({
                                    page: currentPage,
                                    page_size: pageSize,
                                    total: total,
                                    total_pages: totalPages,
                                    unique_ips: uniqueIps,
                                    today_total: Number(todayRow && todayRow.today_total) || 0,
                                    today_unique: Number(todayRow && todayRow.today_unique) || 0,
                                    items: rows || [],
                                    top_regions: regionRows || []
                                });
                            }
                        );
                    }
                );
            }
        );
    });
});

// 审核友链
app.put('/api/links/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Link not found' });
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const { status, category } = req.body;

    if (!['pending', 'approved', 'rejected'].includes(String(status || ''))) {
        return res.status(400).json({ error: 'invalid status' });
    }

    const VALID_CATEGORIES = ['ROOT_NODE', 'PEER_CLUSTER', 'ORG_COLLECTIVE'];
    const safeCategory = VALID_CATEGORIES.includes(String(category || ''))
        ? String(category)
        : null;

    if (safeCategory) {
        db.run(
            'UPDATE links SET status = ?, category = ? WHERE id = ?',
            [status, safeCategory, id],
            function(err) {
                if (err) { console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' }); }
                writeAdminAuditLog({
                    action: 'link_status_update',
                    status: 'success',
                    username: req.adminSession.username,
                    clientIp: getClientIdentifier(req),
                    detail: `link_id=${id},status=${status}`
                });
                res.json({ id, status, category: safeCategory });
            }
        );
    } else {
        db.run(
            'UPDATE links SET status = ? WHERE id = ?',
            [status, id],
            function(err) {
                if (err) { console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' }); }
                writeAdminAuditLog({
                    action: 'link_status_update',
                    status: 'success',
                    username: req.adminSession.username,
                    clientIp: getClientIdentifier(req),
                    detail: `link_id=${id},status=${status}`
                });
                res.json({ id, status });
            }
        );
    }
});

// 删除留言
app.delete('/api/messages/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Message not found' });
    
    db.run(
        'DELETE FROM messages WHERE id = ?',
        id,
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            writeAdminAuditLog({
                action: 'message_delete',
                status: 'success',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: `message_id=${id}`
            });
            res.json({ id, deleted: true });
        }
    );
});

// 删除友链
app.delete('/api/links/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Link not found' });
    
    db.run(
        'DELETE FROM links WHERE id = ?',
        id,
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            writeAdminAuditLog({
                action: 'link_delete',
                status: 'success',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: `link_id=${id}`
            });
            res.json({ id, deleted: true });
        }
    );
});

// 获取文章列表
app.get('/api/articles', (req, res) => {
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(50, rawLimit) : 0;
    const sql = limit
        ? 'SELECT * FROM articles ORDER BY created_at DESC LIMIT ?'
        : 'SELECT * FROM articles ORDER BY created_at DESC';
    db.all(sql, limit ? [limit] : [], (err, rows) => {
        if (err) {
            console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
        }
        // 列表不返回内联 Base64 图片，避免归档页/后台表格被大图拖慢；
        // 单篇文章接口仍返回完整正文。
        const safeRows = (rows || []).map((row) => ({
            ...row,
            content: String(row.content || '').replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/gi, '![$1](pasted-image)')
        }));
        res.json(safeRows);
    });
});

// 获取单篇文章
app.get('/api/articles/:id', (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Article not found' });
    
    db.get('SELECT * FROM articles WHERE id = ?', [id], (err, row) => {
        if (err) {
            console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
        }
        if (!row) {
            return res.status(404).json({ error: 'Article not found' });
        }
        res.json(row);
    });
});

function normalizeArticleCover(value) {
    return validation.imageDataUrl(value, ARTICLE_COVER_MAX_BYTES);
}

// 创建文章
app.post('/api/articles', requireAdmin, requireAdminCsrf, (req, res) => {
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const title = validation.trimmed(req.body.title, 200);
    const content = validation.text(req.body.content, 1500000).trim();
    const category = validation.trimmed(req.body.category, 80);
    const coverImage = normalizeArticleCover(req.body.cover_image);
    if (coverImage === null) {
        return res.status(400).json({ error: '封面图格式无效或体积过大' });
    }
    
    if (!title || !content || !category) {
        return res.status(400).json({ error: 'Title, content and category are required' });
    }
    
    db.run(
        'INSERT INTO articles (title, content, category, cover_image) VALUES (?, ?, ?, ?)',
        [title, content, category, coverImage],
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            writeAdminAuditLog({
                action: 'article_create',
                status: 'success',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: `article_id=${this.lastID}`
            });
            res.status(201).json({ id: this.lastID, title, content, category, cover_image: coverImage });
        }
    );
});

// 更新文章
app.put('/api/articles/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Article not found' });
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const title = validation.trimmed(req.body.title, 200);
    const content = validation.text(req.body.content, 1500000).trim();
    const category = validation.trimmed(req.body.category, 80);
    const coverImage = normalizeArticleCover(req.body.cover_image);
    if (coverImage === null) {
        return res.status(400).json({ error: '封面图格式无效或体积过大' });
    }
    
    if (!title || !content || !category) {
        return res.status(400).json({ error: 'Title, content and category are required' });
    }
    
    db.run(
        'UPDATE articles SET title = ?, content = ?, category = ?, cover_image = ? WHERE id = ?',
        [title, content, category, coverImage, id],
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            writeAdminAuditLog({
                action: 'article_update',
                status: 'success',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: `article_id=${id}`
            });
            res.json({ id, title, content, category, cover_image: coverImage });
        }
    );
});

// 删除文章
app.delete('/api/articles/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Article not found' });
    
    db.run('DELETE FROM articles WHERE id = ?', [id], function(err) {
        if (err) {
            console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
        }
        writeAdminAuditLog({
            action: 'article_delete',
            status: 'success',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: `article_id=${id}`
        });
        res.json({ id, deleted: true });
    });
});

// ── 日常相册集 ─────────────────────────────────────────────────────────
const ALBUM_TITLE_MAX = 80;
const ALBUM_DESC_MAX = 600;

function resolveAlbumId(rawAlbumId, callback) {
    const albumId = validation.parseId(rawAlbumId);
    if (albumId) {
        db.get('SELECT id FROM daily_albums WHERE id = ?', [albumId], (err, row) => {
            if (err) return callback(err);
            callback(null, row ? albumId : null);
        });
        return;
    }

    // 兼容旧客户端：没有 album_id 时放入第一个相册；没有相册则建默认相册。
    db.get('SELECT id FROM daily_albums ORDER BY id ASC LIMIT 1', [], (err, row) => {
        if (err) return callback(err);
        if (row) return callback(null, row.id);
        db.run(
            'INSERT INTO daily_albums (title, description) VALUES (?, ?)',
            ['默认相册', '未分类的日常照片'],
            function (insertErr) {
                if (insertErr) return callback(insertErr);
                callback(null, this.lastID);
            }
        );
    });
}

app.get('/api/albums', (req, res) => {
    db.all(
        `SELECT a.id, a.title, a.description, a.created_at,
            (SELECT COUNT(*) FROM daily_posts p WHERE p.album_id = a.id) AS photo_count,
            (SELECT p.image_data FROM daily_posts p WHERE p.album_id = a.id ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS cover_image
         FROM daily_albums a
         ORDER BY a.created_at DESC, a.id DESC`,
        [],
        (err, rows) => {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            res.json(rows || []);
        }
    );
});

app.get('/api/albums/:id', (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Album not found' });

    db.get(
        `SELECT a.id, a.title, a.description, a.created_at,
            (SELECT COUNT(*) FROM daily_posts p WHERE p.album_id = a.id) AS photo_count
         FROM daily_albums a WHERE a.id = ?`,
        [id],
        (err, album) => {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            if (!album) return res.status(404).json({ error: 'Album not found' });

            db.all(
                'SELECT id, album_id, caption, image_data, created_at FROM daily_posts WHERE album_id = ? ORDER BY created_at DESC, id DESC',
                [id],
                (photosErr, photos) => {
                    if (photosErr) {
                        console.error('[500]', photosErr.message);
                        return res.status(500).json({ error: 'Internal server error' });
                    }
                    res.json({ album, photos: photos || [] });
                }
            );
        }
    );
});

app.post('/api/albums', requireAdmin, requireAdminCsrf, (req, res) => {
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const title = validation.trimmed(req.body.title, ALBUM_TITLE_MAX);
    if (!title) return res.status(400).json({ error: '相册名称不能为空' });
    const description = validation.trimmed(req.body.description, ALBUM_DESC_MAX);

    db.run(
        'INSERT INTO daily_albums (title, description) VALUES (?, ?)',
        [title, description],
        function (err) {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            const albumId = this.lastID;
            db.get(
                `SELECT a.id, a.title, a.description, a.created_at, 0 AS photo_count, NULL AS cover_image
                 FROM daily_albums a WHERE a.id = ?`,
                [albumId],
                (readErr, row) => {
                    if (readErr) {
                        console.error('[500]', readErr.message);
                        return res.status(500).json({ error: 'Internal server error' });
                    }
                    writeAdminAuditLog({
                        action: 'album_create',
                        status: 'success',
                        username: req.adminSession.username,
                        clientIp: getClientIdentifier(req),
                        detail: 'album_id=' + albumId
                    });
                    res.status(201).json(row);
                }
            );
        }
    );
});

app.put('/api/albums/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Album not found' });
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const title = validation.trimmed(req.body.title, ALBUM_TITLE_MAX);
    if (!title) return res.status(400).json({ error: '相册名称不能为空' });
    const description = validation.trimmed(req.body.description, ALBUM_DESC_MAX);

    db.run(
        'UPDATE daily_albums SET title = ?, description = ? WHERE id = ?',
        [title, description, id],
        function (err) {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            if (!this.changes) return res.status(404).json({ error: 'Album not found' });
            writeAdminAuditLog({
                action: 'album_update',
                status: 'success',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: 'album_id=' + id
            });
            res.json({ id, title, description });
        }
    );
});

app.delete('/api/albums/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Album not found' });

    db.get('SELECT id, title FROM daily_albums WHERE id = ?', [id], (err, album) => {
        if (err) {
            console.error('[500]', err.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
        if (!album) return res.status(404).json({ error: 'Album not found' });

        db.serialize(() => {
            db.run('DELETE FROM daily_posts WHERE album_id = ?', [id]);
            db.run('DELETE FROM daily_albums WHERE id = ?', [id], function (deleteErr) {
                if (deleteErr) {
                    console.error('[500]', deleteErr.message);
                    return res.status(500).json({ error: 'Internal server error' });
                }
                writeAdminAuditLog({
                    action: 'album_delete',
                    status: 'success',
                    username: req.adminSession.username,
                    clientIp: getClientIdentifier(req),
                    detail: 'album_id=' + id
                });
                res.json({ id, deleted: true });
            });
        });
    });
});

// ── 日常照片流 ─────────────────────────────────────────────────────────
const DAILY_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DAILY_IMAGE_MAX_BYTES = 300000;
const DAILY_CAPTION_MAX = 1000;
const ARTICLE_COVER_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const ARTICLE_COVER_MAX_BYTES = 240000;

// 获取日常列表（公开）
app.get('/api/daily', (req, res) => {
    const limit = validation.intInRange(req.query.limit, 12, 1, 12);
    const offset = validation.intInRange(req.query.offset, 0, 0, 100000);
    db.all(
        'SELECT id, album_id, caption, image_data, created_at FROM daily_posts ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        [limit, offset],
        (err, rows) => {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            res.json(rows || []);
        }
    );
});

// 发布日常（需要管理员 + CSRF）
app.post('/api/daily', requireAdmin, requireAdminCsrf, (req, res) => {
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const caption = validation.trimmed(req.body.caption, DAILY_CAPTION_MAX);
    const imageData = validation.imageDataUrl(req.body.image, DAILY_IMAGE_MAX_BYTES);

    if (imageData === null) {
        return res.status(400).json({ error: '图片压缩后仍然过大，请换一张更小的图片' });
    }
    if (!imageData) {
        return res.status(400).json({ error: '请上传有效的图片文件' });
    }

    resolveAlbumId(req.body.album_id, (albumErr, albumId) => {
        if (albumErr) {
            console.error('[500]', albumErr.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
        if (!albumId) {
            return res.status(400).json({ error: '相册不存在，请先创建相册' });
        }

        db.run(
            'INSERT INTO daily_posts (caption, image_data, album_id) VALUES (?, ?, ?)',
            [caption, imageData, albumId],
            function(err) {
                if (err) {
                    console.error('[500]', err.message);
                    return res.status(500).json({ error: 'Internal server error' });
                }
                const dailyId = this.lastID;
                db.get('SELECT id, album_id, caption, image_data, created_at FROM daily_posts WHERE id = ?', [dailyId], (err2, row) => {
                    if (err2) {
                        console.error('[500]', err2.message);
                        return res.status(500).json({ error: 'Internal server error' });
                    }
                    writeAdminAuditLog({
                        action: 'daily_create',
                        status: 'success',
                        username: req.adminSession.username,
                        clientIp: getClientIdentifier(req),
                        detail: 'daily_id=' + dailyId + ' album_id=' + albumId
                    });
                    res.status(201).json(row);
                });
            }
        );
    });
});

// 修改日常说明（需要管理员 + CSRF）
app.put('/api/daily/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Daily post not found' });
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ error: '请求格式不正确' });
    }
    const caption = validation.trimmed(req.body.caption, DAILY_CAPTION_MAX);

    db.run(
        'UPDATE daily_posts SET caption = ? WHERE id = ?',
        [caption, id],
        function(err) {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            if (!this.changes) {
                return res.status(404).json({ error: 'Daily post not found' });
            }
            db.get('SELECT id, album_id, caption, image_data, created_at FROM daily_posts WHERE id = ?', [id], (err2, row) => {
                if (err2) {
                    console.error('[500]', err2.message);
                    return res.status(500).json({ error: 'Internal server error' });
                }
                writeAdminAuditLog({
                    action: 'daily_update',
                    status: 'success',
                    username: req.adminSession.username,
                    clientIp: getClientIdentifier(req),
                    detail: 'daily_id=' + id
                });
                res.json(row);
            });
        }
    );
});

// 删除日常（需要管理员 + CSRF）
app.delete('/api/daily/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Daily post not found' });
    db.run('DELETE FROM daily_posts WHERE id = ?', [id], function(err) {
        if (err) {
            console.error('[500]', err.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
        if (!this.changes) {
            return res.status(404).json({ error: 'Daily post not found' });
        }
        writeAdminAuditLog({
            action: 'daily_delete',
            status: 'success',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: 'daily_id=' + id
        });
        res.json({ id, deleted: true });
    });
});

// 工具库
const TOOL_TONES = ['blue', 'cyan', 'green', 'orange', 'purple', 'gray'];

function mapToolRow(row) {
    return {
        id: row.id,
        name: row.name,
        category: row.category,
        version: row.version,
        size: row.size,
        description: row.description,
        glyph: row.glyph,
        tone: row.tone,
        downloadUrl: row.download_url,
        panUrl: row.pan_url,
        panCode: row.pan_code,
        source: row.source,
        updatedAt: row.updated_at,
        sortOrder: row.sort_order
    };
}

function parseToolPayload(body) {
    if (!validation.isPlainObject(body)) return { error: '请求格式不正确' };

    const name = validation.trimmed(body.name, 120);
    const category = validation.trimmed(body.category, 40);
    if (!name || !category) return { error: '工具名称和分类不能为空' };

    const readUrl = (value, label) => {
        const raw = validation.trimmed(value, 2048);
        if (!raw) return '';
        const parsed = validation.httpUrl(raw, 2048);
        if (!parsed) return { error: label + '必须是有效的 http/https 公网地址' };
        return parsed;
    };

    const downloadUrl = readUrl(body.downloadUrl, '官方下载地址');
    if (downloadUrl && typeof downloadUrl === 'object') return downloadUrl;
    const panUrl = readUrl(body.panUrl, '网盘地址');
    if (panUrl && typeof panUrl === 'object') return panUrl;

    const tone = validation.trimmed(body.tone, 20);
    return {
        value: {
            name,
            category,
            version: validation.trimmed(body.version, 40),
            size: validation.trimmed(body.size, 40),
            description: validation.trimmed(body.description, 600),
            glyph: validation.trimmed(body.glyph, 4),
            tone: TOOL_TONES.includes(tone) ? tone : 'blue',
            downloadUrl,
            panUrl,
            panCode: validation.trimmed(body.panCode, 40),
            source: validation.trimmed(body.source, 40),
            updatedAt: validation.trimmed(body.updatedAt, 40) || new Date().toISOString().slice(0, 10)
        }
    };
}

// 获取工具列表（公开）
app.get('/api/tools', (req, res) => {
    db.all('SELECT * FROM tools ORDER BY sort_order ASC, id ASC', [], (err, rows) => {
        if (err) {
            console.error('[500]', err.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
        res.setHeader('Cache-Control', 'no-store');
        res.json((rows || []).map(mapToolRow));
    });
});

// 新增工具
app.post('/api/tools', requireAdmin, requireAdminCsrf, (req, res) => {
    const parsed = parseToolPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const tool = parsed.value;

    db.run(
        'INSERT INTO tools (name, category, version, size, description, glyph, tone, download_url, pan_url, pan_code, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tool.name, tool.category, tool.version, tool.size, tool.description, tool.glyph, tool.tone, tool.downloadUrl, tool.panUrl, tool.panCode, tool.source, tool.updatedAt],
        function (err) {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            writeAdminAuditLog({
                action: 'tool_create',
                status: 'success',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: 'tool_id=' + this.lastID
            });
            db.get('SELECT * FROM tools WHERE id = ?', [this.lastID], (readErr, row) => {
                if (readErr) return res.status(500).json({ error: 'Internal server error' });
                res.status(201).json(mapToolRow(row));
            });
        }
    );
});

// 更新工具
app.put('/api/tools/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Tool not found' });
    const parsed = parseToolPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const tool = parsed.value;

    db.run(
        'UPDATE tools SET name = ?, category = ?, version = ?, size = ?, description = ?, glyph = ?, tone = ?, download_url = ?, pan_url = ?, pan_code = ?, source = ?, updated_at = ? WHERE id = ?',
        [tool.name, tool.category, tool.version, tool.size, tool.description, tool.glyph, tool.tone, tool.downloadUrl, tool.panUrl, tool.panCode, tool.source, tool.updatedAt, id],
        function (err) {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }
            if (!this.changes) return res.status(404).json({ error: 'Tool not found' });
            writeAdminAuditLog({
                action: 'tool_update',
                status: 'success',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: 'tool_id=' + id
            });
            db.get('SELECT * FROM tools WHERE id = ?', [id], (readErr, row) => {
                if (readErr) return res.status(500).json({ error: 'Internal server error' });
                res.json(mapToolRow(row));
            });
        }
    );
});

// 删除工具
app.delete('/api/tools/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const id = validation.parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Tool not found' });

    db.run('DELETE FROM tools WHERE id = ?', [id], function (err) {
        if (err) {
            console.error('[500]', err.message);
            return res.status(500).json({ error: 'Internal server error' });
        }
        if (!this.changes) return res.status(404).json({ error: 'Tool not found' });
        writeAdminAuditLog({
            action: 'tool_delete',
            status: 'success',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: 'tool_id=' + id
        });
        res.json({ id, deleted: true });
    });
});

// 获取统计数据
app.get('/api/stats', (req, res) => {
    db.get('SELECT COUNT(*) as total FROM articles', [], (err, articleCount) => {
        if (err) {
            console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
        }
        
        db.get('SELECT COUNT(*) as total FROM messages', [], (err, messageCount) => {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            
            db.get('SELECT COUNT(*) as total FROM links WHERE status = ?', ['approved'], (err, linkCount) => {
                if (err) {
                    console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
                }
                
                db.get('SELECT COUNT(*) as total FROM links WHERE status = ?', ['pending'], (pendingErr, pendingCount) => {
                    if (pendingErr) {
                        console.error('[500]', pendingErr.message);
                        return res.status(500).json({ error: 'Internal server error' });
                    }
                    res.json({
                        published_articles: articleCount.total || 0,
                        total_messages: messageCount.total || 0,
                        total_links: linkCount.total || 0,
                        pending_links: pendingCount.total || 0
                    });
                });
            });
        });
    });
});

// 审计日志：分页 + 按动作/状态/关键词筛选（仅管理员）
app.get('/api/admin-audit-logs', requireAdmin, (req, res) => {
    const actionFilter = validation.trimmed(req.query.action, 80);
    let statusFilter = validation.trimmed(req.query.status, 20);
    if (statusFilter && !['success', 'failed', 'denied', 'blocked'].includes(statusFilter)) statusFilter = '';
    const keyword = validation.trimmed(req.query.keyword, 100);
    const page = validation.intInRange(req.query.page, 1, 1, 100000);
    const pageSize = validation.intInRange(req.query.page_size, 20, 1, 100);

    const whereClauses = [];
    const whereValues = [];
    if (actionFilter) {
        whereClauses.push('action = ?');
        whereValues.push(actionFilter);
    }
    if (statusFilter) {
        whereClauses.push('status = ?');
        whereValues.push(statusFilter);
    }
    if (keyword) {
        whereClauses.push('(username LIKE ? OR client_ip LIKE ? OR detail LIKE ? OR action LIKE ? OR status LIKE ?)');
        const likeValue = `%${keyword}%`;
        whereValues.push(likeValue, likeValue, likeValue, likeValue, likeValue);
    }
    const whereSql = whereClauses.length ? ` WHERE ${whereClauses.join(' AND ')}` : '';

    db.get(`SELECT COUNT(*) AS total FROM admin_audit_logs${whereSql}`, whereValues, (countErr, countRow) => {
        if (countErr) {
            console.error('[500]', countErr.message);
            return res.status(500).json({ error: 'Internal server error' });
        }

        const total = Number(countRow && countRow.total) || 0;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const safePage = Math.min(page, totalPages);
        const offset = (safePage - 1) * pageSize;
        db.all(
            `SELECT id, action, status, username, client_ip, detail, created_at
             FROM admin_audit_logs${whereSql}
             ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...whereValues, pageSize, offset],
            (queryErr, rows) => {
                if (queryErr) {
                    console.error('[500]', queryErr.message);
                    return res.status(500).json({ error: 'Internal server error' });
                }
                res.json({
                    items: rows || [],
                    page: safePage,
                    page_size: pageSize,
                    total,
                    total_pages: totalPages
                });
            }
        );
    });
});

// 审计日志 CSV 导出（仅管理员，最多 1000 条，UTF-8 BOM 方便 Excel 打开）
app.get('/api/admin-audit-logs/export', requireAdmin, (req, res) => {
    const actionFilter = validation.trimmed(req.query.action, 80);
    let statusFilter = validation.trimmed(req.query.status, 20);
    if (statusFilter && !['success', 'failed', 'denied', 'blocked'].includes(statusFilter)) statusFilter = '';
    const keyword = validation.trimmed(req.query.keyword, 100);

    const whereClauses = [];
    const whereValues = [];
    if (actionFilter) {
        whereClauses.push('action = ?');
        whereValues.push(actionFilter);
    }
    if (statusFilter) {
        whereClauses.push('status = ?');
        whereValues.push(statusFilter);
    }
    if (keyword) {
        whereClauses.push('(username LIKE ? OR client_ip LIKE ? OR detail LIKE ? OR action LIKE ? OR status LIKE ?)');
        const likeValue = `%${keyword}%`;
        whereValues.push(likeValue, likeValue, likeValue, likeValue, likeValue);
    }
    const whereSql = whereClauses.length ? ` WHERE ${whereClauses.join(' AND ')}` : '';

    db.all(
        `SELECT id, action, status, username, client_ip, detail, created_at
         FROM admin_audit_logs${whereSql}
         ORDER BY id DESC LIMIT 1000`,
        whereValues,
        (err, rows) => {
            if (err) {
                console.error('[500]', err.message);
                return res.status(500).json({ error: 'Internal server error' });
            }

            const header = ['id', 'action', 'status', 'username', 'client_ip', 'detail', 'created_at'];
            const lines = [header.map(csvEscape).join(',')];
            (rows || []).forEach(row => {
                lines.push(header.map(key => csvEscape(row[key])).join(','));
            });

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="admin-audit-logs.csv"');
            res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
        }
    );
});

// 管理员登录
app.post('/api/login', (req, res) => {
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ success: false, message: '请求格式不正确' });
    }
    const body = req.body;
    const clientId = getClientIdentifier(req);

    const retryAfter = checkLoginLock(clientId);
    if (retryAfter > 0) {
        writeAdminAuditLog({
            action: 'admin_login',
            status: 'blocked',
            username: String(body.username || ''),
            clientIp: clientId,
            detail: `retry_after=${retryAfter}`
        });
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
            success: false,
            message: '登录失败次数过多，请稍后再试',
            retry_after_seconds: retryAfter
        });
    }

    const username = validation.trimmed(body.username, MAX_LOGIN_USERNAME_LENGTH);
    const password = String(body.password == null ? '' : body.password);
    const fieldsValid = username.length > 0
        && username.length <= MAX_LOGIN_USERNAME_LENGTH
        && password.length > 0
        && password.length <= MAX_LOGIN_PASSWORD_LENGTH;

    if (!fieldsValid) {
        recordLoginFailure(clientId);
        writeAdminAuditLog({
            action: 'admin_login',
            status: 'failed',
            username,
            clientIp: clientId,
            detail: 'invalid_field_length'
        });
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const credentials = getAdminCredentials();
    // 用户名与密码都做常量时间比较；密码校验不因用户名错误而短路，
    // 避免攻击者通过响应耗时判断管理员账号是否存在。
    const usernameMatches = safeCompareStrings(username, credentials.username);
    const passwordMatches = verifyPassword(
        password,
        credentials.password_salt,
        credentials.password_hash,
        credentials.password_iterations
    );
    const isValid = usernameMatches && passwordMatches;

    if (isValid) {
        clearLoginFailures(clientId);
        // 旧凭据使用较低迭代次数时，趁登录成功透明升级哈希强度。
        if (Number(credentials.password_iterations || 0) < PASSWORD_HASH_ITERATIONS) {
            try {
                saveAdminCredentials(credentials.username, hashPassword(password));
            } catch (error) {
                console.warn('[auth] 凭据哈希升级失败：' + error.message);
            }
        }
        const sessionInfo = createAdminSession(credentials.username);
        res.setHeader('Set-Cookie', buildSessionCookie(sessionInfo.sid, Math.floor(SESSION_TTL_MS / 1000)));
        writeAdminAuditLog({
            action: 'admin_login',
            status: 'success',
            username: credentials.username,
            clientIp: clientId,
            detail: 'login_ok'
        });
        res.json({
            success: true,
            message: 'Login successful',
            csrf_token: sessionInfo.csrfToken,
            username: credentials.username
        });
    } else {
        recordLoginFailure(clientId);
        writeAdminAuditLog({
            action: 'admin_login',
            status: 'failed',
            username,
            clientIp: clientId,
            detail: 'invalid_credentials'
        });
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.post('/api/change-password', requireAdmin, requireAdminCsrf, (req, res) => {
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ success: false, message: '请求格式不正确' });
    }
    const body = req.body;
    const { current_password: currentPassword, new_username: rawNewUsername, new_password: rawNewPassword } = body;
    const credentials = getAdminCredentials();

    if (!verifyPassword(
        String(currentPassword || ''),
        credentials.password_salt,
        credentials.password_hash,
        credentials.password_iterations
    )) {
        writeAdminAuditLog({
            action: 'credentials_change',
            status: 'failed',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: 'current_password_incorrect'
        });
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const newUsername = validation.trimmed(rawNewUsername, MAX_LOGIN_USERNAME_LENGTH);
    const newPassword = String(rawNewPassword == null ? '' : rawNewPassword).trim();

    if (!newUsername && !newPassword) {
        return res.status(400).json({ success: false, message: 'No updates were provided' });
    }

    if (newUsername && newUsername.length > MAX_LOGIN_USERNAME_LENGTH) {
        writeAdminAuditLog({
            action: 'credentials_change',
            status: 'failed',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: 'username_too_long'
        });
        return res.status(400).json({ success: false, message: `管理员账号不能超过 ${MAX_LOGIN_USERNAME_LENGTH} 位` });
    }

    if (newPassword) {
        const strengthError = validateAdminPasswordStrength(newPassword, newUsername || credentials.username);
        if (strengthError) {
            writeAdminAuditLog({
                action: 'credentials_change',
                status: 'failed',
                username: req.adminSession.username,
                clientIp: getClientIdentifier(req),
                detail: 'weak_password'
            });
            return res.status(400).json({ success: false, message: strengthError });
        }
    }

    const finalUsername = newUsername || credentials.username;
    const finalPassword = newPassword
        ? hashPassword(newPassword)
        : {
            password_salt: credentials.password_salt,
            password_hash: credentials.password_hash,
            password_iterations: credentials.password_iterations
        };
    saveAdminCredentials(finalUsername, finalPassword);
    // 凭据修改后，其他设备上的旧会话立即失效；当前会话保留并同步新账号名。
    invalidateOtherAdminSessions(req.adminSessionId);
    req.adminSession.username = finalUsername;
    // 轮换 CSRF Token，避免改密前泄露的 Token 继续可用。
    const newCsrfToken = crypto.randomBytes(24).toString('hex');
    req.adminSession.csrfToken = newCsrfToken;
    persistAdminSessions();
    writeAdminAuditLog({
        action: 'credentials_change',
        status: 'success',
        username: finalUsername,
        clientIp: getClientIdentifier(req),
        detail: `new_username=${finalUsername}`
    });

    return res.json({
        success: true,
        message: 'Credentials updated successfully',
        username: finalUsername,
        csrf_token: newCsrfToken
    });
});

app.post('/api/logout', requireAdmin, requireAdminCsrf, (req, res) => {
    writeAdminAuditLog({
        action: 'admin_logout',
        status: 'success',
        username: req.adminSession.username,
        clientIp: getClientIdentifier(req),
        detail: 'logout_ok'
    });
    clearAdminSession(req);
    res.setHeader('Set-Cookie', buildSessionCookie('', 0));
    res.json({ success: true, message: 'Logged out' });
});

app.post('/api/reset-admin-credentials', requireAdmin, requireAdminCsrf, (req, res) => {
    if (!validation.isPlainObject(req.body)) {
        return res.status(400).json({ success: false, message: '请求格式不正确' });
    }
    if (!isLoopbackRequest(req)) {
        writeAdminAuditLog({
            action: 'credentials_reset',
            status: 'denied',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: 'non_local_request'
        });
        return res.status(403).json({ success: false, message: 'Only localhost is allowed' });
    }

    const confirmText = String((req.body && req.body.confirm_text) || '').trim();
    if (confirmText !== 'RESET_ADMIN') {
        writeAdminAuditLog({
            action: 'credentials_reset',
            status: 'failed',
            username: req.adminSession.username,
            clientIp: getClientIdentifier(req),
            detail: 'invalid_confirmation_text'
        });
        return res.status(400).json({ success: false, message: 'Invalid confirmation text' });
    }

    saveAdminCredentials('admin', hashPassword('admin'));
    invalidateAllAdminSessions();
    res.setHeader('Set-Cookie', buildSessionCookie('', 0));
    writeAdminAuditLog({
        action: 'credentials_reset',
        status: 'success',
        username: req.adminSession.username,
        clientIp: getClientIdentifier(req),
        detail: 'reset_to_default'
    });
    return res.json({ success: true, message: 'Credentials reset to default', username: 'admin' });
});

// RSS 探针更新接口（仅内部 poller 调用）
app.post('/api/link-status', (req, res) => {
    if (!isLoopbackRequest(req)) {
        return res.status(403).json({ error: 'forbidden' });
    }

    const updates = req.body;
    if (!Array.isArray(updates) || !updates.length) {
        return res.status(400).json({ error: 'expected array of updates' });
    }

    const now = new Date().toISOString();
    let pending = updates.length;
    const errors = [];

    updates.forEach(u => {
        db.run(
            `UPDATE links SET
                is_online = ?,
                last_checked = ?,
                latest_post_title = ?,
                latest_post_url = ?
             WHERE id = ?`,
            [
                u.is_online ? 1 : 0,
                now,
                String(u.latest_post_title || ''),
                String(u.latest_post_url || ''),
                u.id
            ],
            function(err) {
                if (err) errors.push({ id: u.id, error: err.message });
                pending--;
                if (pending === 0) {
                    res.json({ updated: updates.length - errors.length, errors });
                }
            }
        );
    });
});

// ── SEO 基础文件：robots / sitemap / RSS ──────────────────────────────
function siteBaseUrl(req) {
    const configured = String(process.env.SITE_URL || '').trim().replace(/\/$/, '');
    if (configured) return configured;
    return req.protocol + '://' + req.get('host');
}

function escapeXml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function stripMarkdown(value) {
    return String(value || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[#>*_`~]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
        'User-agent: *\n' +
        'Allow: /\n' +
        'Disallow: /api/\n' +
        'Disallow: /src/pages/admin\n' +
        'Disallow: /src/pages/admin-dashboard\n' +
        'Sitemap: ' + siteBaseUrl(req) + '/sitemap.xml\n'
    );
});

app.get('/sitemap.xml', (req, res) => {
    const base = siteBaseUrl(req);
    const staticPages = [
        ['/src/pages/index.html', '1.0', 'weekly'],
        ['/src/pages/articles.html', '0.9', 'weekly'],
        ['/src/pages/daily.html', '0.7', 'weekly'],
        ['/src/pages/about.html', '0.7', 'monthly'],
        ['/src/pages/contact.html', '0.6', 'monthly'],
        ['/src/pages/guestbook.html', '0.5', 'monthly'],
        ['/src/pages/links.html', '0.5', 'monthly'],
        ['/src/pages/link-apply.html', '0.4', 'monthly'],
        ['/src/pages/policy.html', '0.2', 'yearly'],
        ['/src/pages/privacy.html', '0.2', 'yearly'],
        ['/src/pages/cookies.html', '0.2', 'yearly'],
        ['/src/pages/version.html', '0.2', 'yearly'],
        ['/src/pages/tools.html', '0.6', 'weekly']
    ];

    db.all('SELECT id, created_at FROM articles ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            console.error('[sitemap]', err.message);
            rows = [];
        }
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        staticPages.forEach(([page, priority, frequency]) => {
            xml += '  <url><loc>' + escapeXml(base + page) + '</loc><changefreq>' + frequency + '</changefreq><priority>' + priority + '</priority></url>\n';
        });
        (rows || []).forEach((article) => {
            xml += '  <url><loc>' + escapeXml(base + '/post/' + article.id) + '</loc>';
            if (article.created_at) xml += '<lastmod>' + escapeXml(String(article.created_at).slice(0, 10)) + '</lastmod>';
            xml += '<changefreq>monthly</changefreq><priority>0.8</priority></url>\n';
        });
        xml += '</urlset>\n';
        res.type('application/xml').send(xml);
    });
});

app.get('/rss.xml', (req, res) => {
    const base = siteBaseUrl(req);
    db.all('SELECT id, title, content, category, created_at FROM articles ORDER BY created_at DESC LIMIT 20', [], (err, rows) => {
        if (err) {
            console.error('[rss]', err.message);
            rows = [];
        }
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<rss version="2.0"><channel>\n';
        xml += '<title>YanMo Labs</title>\n';
        xml += '<link>' + escapeXml(base) + '</link>\n';
        xml += '<description>YanMo 的安全研究笔记：Web 渗透、漏洞复现、蓝队运营与 AI 安全。</description>\n';
        xml += '<language>zh-CN</language>\n';
        xml += '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n';
        (rows || []).forEach((article) => {
            const link = base + '/post/' + article.id;
            const summary = stripMarkdown(article.content).slice(0, 260);
            xml += '<item>\n';
            xml += '<title>' + escapeXml(article.title) + '</title>\n';
            xml += '<link>' + escapeXml(link) + '</link>\n';
            xml += '<guid isPermaLink="true">' + escapeXml(link) + '</guid>\n';
            if (article.created_at) xml += '<pubDate>' + new Date(article.created_at).toUTCString() + '</pubDate>\n';
            if (article.category) xml += '<category>' + escapeXml(article.category) + '</category>\n';
            xml += '<description>' + escapeXml(summary) + '</description>\n';
            xml += '</item>\n';
        });
        xml += '</channel></rss>\n';
        res.type('application/rss+xml').send(xml);
    });
});

// 统一处理请求体解析错误，避免把 Express 默认 HTML 错误页暴露给前端
app.use((err, req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
    }
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        return res.status(400).json({ error: '请求体 JSON 格式不正确' });
    }
    return next(err);
});

// 启动服务器
app.listen(port, () => {
    // 测试进程不启动外部 RSS 探测，避免测试期间访问外网/写入开发库
    if (process.env.NODE_ENV !== 'test') {
        rssPoller.start();
        // 启动后延迟清理一次，之后每 24 小时按隐私协议删除过期访客/审计记录
        const retentionTimer = setInterval(cleanupRetention, 24 * 60 * 60 * 1000);
        if (retentionTimer.unref) retentionTimer.unref();
        setTimeout(cleanupRetention, 8000).unref?.();
    }
});