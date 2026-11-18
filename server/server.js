const express = require('express');
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

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

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
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'SAMEORIGIN');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
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
const adminPasswordFile = process.env.ADMIN_PASSWORD_FILE || path.join(rootDir, 'data', 'admin-password.txt');
const adminCredentialsFile = process.env.ADMIN_CREDENTIALS_FILE || path.join(rootDir, 'data', 'admin-credentials.json');
const SESSION_COOKIE_NAME = 'yanmo_admin_session';
const SESSION_TTL_MS = parseEnvInt('SESSION_TTL_MS', 12 * 60 * 60 * 1000, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const SESSION_IDLE_TTL_MS = parseEnvInt('SESSION_IDLE_TTL_MS', 2 * 60 * 60 * 1000, 5 * 60 * 1000, SESSION_TTL_MS);
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

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sid, sessionData] of adminSessions.entries()) {
        if (isSessionExpired(sessionData, now)) {
            adminSessions.delete(sid);
        }
    }
}

/** 改密后让其他已登录会话立即失效，避免旧 Cookie 长期可用。 */
function invalidateOtherAdminSessions(currentSid) {
    for (const sid of Array.from(adminSessions.keys())) {
        if (sid !== currentSid) {
            adminSessions.delete(sid);
        }
    }
}

function invalidateAllAdminSessions() {
    adminSessions.clear();
}

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
    return { sid, csrfToken };
}

function clearAdminSession(req) {
    const cookies = parseCookies(req);
    const sid = cookies[SESSION_COOKIE_NAME];
    if (sid) {
        adminSessions.delete(sid);
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

function getClientIdentifier(req) {
    // 仅当显式信任反向代理时才读取转发头，避免伪造 X-Forwarded-For 绕过限流。
    const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').trim() : '';
    if (forwarded) {
        return forwarded.split(',')[0].trim() || 'unknown';
    }
    return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
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
app.use(bodyParser.json());
// 站点入口：加载页（原根目录 index.html 已归入 src/pages/）
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'src', 'pages', 'loading.html'));
});

// 旧地址兼容：/index.html 与已移除的根目录跳转壳，301 到规范页面
const legacyPageRedirects = {
    '/index.html': '/src/pages/index.html',
    '/admin.html': '/src/pages/admin.html',
    '/admin-dashboard.html': '/src/pages/admin-dashboard.html',
    '/link-apply.html': '/src/pages/link-apply.html'
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
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            // Migrate existing messages table that predate subject / is_read columns
            const messageMigrations = [
                "ALTER TABLE messages ADD COLUMN subject TEXT DEFAULT ''",
                "ALTER TABLE messages ADD COLUMN is_read INTEGER DEFAULT 0"
            ];
            messageMigrations.forEach(sql => db.run(sql, [], () => {}));
            
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
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

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
    const { name, email, message, subject } = req.body;
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    db.run(
        'INSERT INTO messages (name, email, subject, message) VALUES (?, ?, ?, ?)',
        [name, email, subject || '', message],
        function(err) {
            if (err) {
                console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
            }
            res.status(201).json({ id: this.lastID, name, email, subject: subject || '', message });
        }
    );
});

// 处理“联系我”页面提交（带 subject 主题字段）
// 流程：先落库 → 再尝试 SMTP 通知站长 → 如实告知前端是否真的发出去了
app.post('/api/contact', (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();

    if (!name || !email || !message) {
        return res.status(400).json({ success: false, error: '请完整填写姓名、邮箱和留言内容' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: '邮箱格式不正确' });
    }
    if (message.length > 8000) {
        return res.status(400).json({ success: false, error: '留言内容过长，请控制在 8000 字以内' });
    }

    db.run(
        'INSERT INTO messages (name, email, subject, message) VALUES (?, ?, ?, ?)',
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

// 处理友链申请
app.post('/api/links', (req, res) => {
    const {
        'site-name': siteName,
        'site-url': siteUrl,
        'site-description': siteDescription,
        'site-avatar': siteAvatar
    } = req.body;
    if (!siteName || !siteUrl || !siteDescription) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    if (!isValidHttpUrl(siteUrl)) {
        return res.status(400).json({ error: 'site-url must be a valid http/https url' });
    }

    if (siteAvatar && String(siteAvatar).length > 1000000) {
        return res.status(400).json({ error: '头像文件过大，请控制在 1MB 以内' });
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
    const sql = isAdmin
        ? 'SELECT id, name, email, subject, message, is_read, created_at FROM messages ORDER BY created_at DESC'
        : 'SELECT id, name, message, created_at FROM messages ORDER BY created_at DESC';
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
        }
        res.json(rows);
    });
});

// 标记留言为已读 / 未读（管理员）
app.patch('/api/messages/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const { id } = req.params;
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
                latest_post_title, latest_post_url, created_at
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

// 审核友链
app.put('/api/links/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const { id } = req.params;
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
    const { id } = req.params;
    
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
    const { id } = req.params;
    
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
    db.all('SELECT * FROM articles ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' });
        }
        res.json(rows || []);
    });
});

// 获取单篇文章
app.get('/api/articles/:id', (req, res) => {
    const { id } = req.params;
    
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

// 创建文章
app.post('/api/articles', requireAdmin, requireAdminCsrf, (req, res) => {
    const { title, content, category } = req.body;
    
    if (!title || !content || !category) {
        return res.status(400).json({ error: 'Title, content and category are required' });
    }
    
    db.run(
        'INSERT INTO articles (title, content, category) VALUES (?, ?, ?)',
        [title, content, category],
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
            res.status(201).json({ id: this.lastID, title, content, category });
        }
    );
});

// 更新文章
app.put('/api/articles/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const { id } = req.params;
    const { title, content, category } = req.body;
    
    if (!title || !content || !category) {
        return res.status(400).json({ error: 'Title, content and category are required' });
    }
    
    db.run(
        'UPDATE articles SET title = ?, content = ?, category = ? WHERE id = ?',
        [title, content, category, id],
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
            res.json({ id, title, content, category });
        }
    );
});

// 删除文章
app.delete('/api/articles/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const { id } = req.params;
    
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
                
                res.json({
                    published_articles: articleCount.total || 0,
                    total_messages: messageCount.total || 0,
                    total_links: linkCount.total || 0
                });
            });
        });
    });
});

// 审计日志：分页 + 按动作/状态/关键词筛选（仅管理员）
app.get('/api/admin-audit-logs', requireAdmin, (req, res) => {
    const actionFilter = String(req.query.action || '').trim();
    const statusFilter = String(req.query.status || '').trim();
    const keyword = String(req.query.keyword || '').trim();
    const page = parsePositiveInt(req.query.page, 1, 1, 100000);
    const pageSize = parsePositiveInt(req.query.page_size, 20, 1, 100);

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
    const actionFilter = String(req.query.action || '').trim();
    const statusFilter = String(req.query.status || '').trim();
    const keyword = String(req.query.keyword || '').trim();

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
    const body = req.body || {};
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

    const username = String(body.username || '').trim();
    const password = String(body.password || '');
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
    const body = req.body || {};
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

    const newUsername = String(rawNewUsername || '').trim();
    const newPassword = String(rawNewPassword || '').trim();

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
    const remoteAddress = String(req.ip || req.socket.remoteAddress || '').toLowerCase();
    const isLocal =
        remoteAddress === '127.0.0.1' ||
        remoteAddress === '::1' ||
        remoteAddress === '::ffff:127.0.0.1' ||
        remoteAddress.endsWith('127.0.0.1');

    if (!isLocal) {
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
    const origin = String(req.ip || req.socket.remoteAddress || '');
    const isLocal =
        origin === '127.0.0.1' ||
        origin === '::1' ||
        origin === '::ffff:127.0.0.1' ||
        origin.endsWith('127.0.0.1');
    if (!isLocal) {
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

// 启动服务器
app.listen(port, () => {
    rssPoller.start();
});