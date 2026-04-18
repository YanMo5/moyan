const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const port = 3000;
const rootDir = path.join(__dirname, '..');
const adminPasswordFile = path.join(rootDir, 'admin_password.txt');
const adminCredentialsFile = path.join(rootDir, 'admin_credentials.json');
const SESSION_COOKIE_NAME = 'yanmo_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CSRF_HEADER_NAME = 'x-csrf-token';
const PASSWORD_HASH_ITERATIONS = 210000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const adminSessions = new Map();
const loginFailures = new Map();

function isValidHttpUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (error) {
        return false;
    }
}

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sid, sessionData] of adminSessions.entries()) {
        if (!sessionData || Number(sessionData.expiresAt || 0) <= now) {
            adminSessions.delete(sid);
        }
    }
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
        parsed[key] = decodeURIComponent(value);
    }
    return parsed;
}

function createAdminSession() {
    cleanupExpiredSessions();
    const sid = crypto.randomBytes(24).toString('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    adminSessions.set(sid, {
        expiresAt: Date.now() + SESSION_TTL_MS,
        csrfToken: csrfToken
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
        return res.status(401).json({ error: '请先登录管理员账户' });
    }
    const sessionData = adminSessions.get(sid);
    if (!sessionData || Number(sessionData.expiresAt || 0) <= Date.now()) {
        adminSessions.delete(sid);
        return res.status(401).json({ error: '请先登录管理员账户' });
    }

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
    if (!provided || !expected || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
        return res.status(403).json({ error: 'CSRF token 无效或缺失' });
    }

    return next();
}

function getClientIdentifier(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').trim();
    if (forwarded) {
        return forwarded.split(',')[0].trim() || 'unknown';
    }
    return String(req.ip || req.socket.remoteAddress || 'unknown');
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
    return legacyPassword || 'admin';
}

function saveAdminCredentials(username, password) {
    const payload = {
        username,
        password_salt: String(password.password_salt || ''),
        password_hash: String(password.password_hash || ''),
        password_iterations: Number(password.password_iterations || PASSWORD_HASH_ITERATIONS)
    };
    fs.writeFileSync(adminCredentialsFile, JSON.stringify(payload), 'utf8');
    fs.writeFileSync(adminPasswordFile, 'managed_by_hash_credentials', 'utf8');
}

function getAdminCredentials() {
    const defaultCredentials = {
        username: 'admin',
        ...hashPassword(readLegacyAdminPassword())
    };

    if (fs.existsSync(adminCredentialsFile)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(adminCredentialsFile, 'utf8'));
            const username = String((parsed && parsed.username) || '').trim() || defaultCredentials.username;
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

    saveAdminCredentials(defaultCredentials.username, defaultCredentials);
    return defaultCredentials;
}

// 配置中间件
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '.')));

// 连接数据库
const db = new sqlite3.Database('./blog.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        // 创建表
        db.run(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                site_name TEXT NOT NULL,
                site_url TEXT NOT NULL,
                site_description TEXT NOT NULL,
                site_avatar TEXT DEFAULT '',
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        db.run(`ALTER TABLE links ADD COLUMN site_avatar TEXT DEFAULT ''`, (alterErr) => {
            if (alterErr && !String(alterErr.message || '').includes('duplicate column name')) {
                console.error('Error altering links table:', alterErr.message);
            }
        });
        db.run(`
            CREATE TABLE IF NOT EXISTS articles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }
});

// 处理留言提交
app.post('/api/messages', (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    
    db.run(
        'INSERT INTO messages (name, email, message) VALUES (?, ?, ?)',
        [name, email, message],
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ id: this.lastID, name, email, message });
        }
    );
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
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ id: this.lastID, siteName, siteUrl, siteDescription, siteAvatar: siteAvatar || '' });
        }
    );
});

// 获取留言列表
app.get('/api/messages', requireAdmin, (req, res) => {
    db.all('SELECT * FROM messages ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 获取友链列表
app.get('/api/links', (req, res) => {
    db.all('SELECT * FROM links ORDER BY created_at DESC', [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 审核友链
app.put('/api/links/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'approved', 'rejected'].includes(String(status || ''))) {
        return res.status(400).json({ error: 'invalid status' });
    }
    
    db.run(
        'UPDATE links SET status = ? WHERE id = ?',
        [status, id],
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ id, status });
        }
    );
});

// 删除留言
app.delete('/api/messages/:id', requireAdmin, requireAdminCsrf, (req, res) => {
    const { id } = req.params;
    
    db.run(
        'DELETE FROM messages WHERE id = ?',
        id,
        function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
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
                return res.status(500).json({ error: err.message });
            }
            res.json({ id, deleted: true });
        }
    );
});

// 管理员登录
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const credentials = getAdminCredentials();
    const clientId = getClientIdentifier(req);

    const retryAfter = checkLoginLock(clientId);
    if (retryAfter > 0) {
        return res.status(429).json({
            success: false,
            message: '登录失败次数过多，请稍后再试',
            retry_after_seconds: retryAfter
        });
    }

    const isValid = (
        String(username || '') === credentials.username
        && verifyPassword(
            String(password || ''),
            credentials.password_salt,
            credentials.password_hash,
            credentials.password_iterations
        )
    );

    if (isValid) {
        clearLoginFailures(clientId);
        const sessionInfo = createAdminSession();
        res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionInfo.sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
        res.json({
            success: true,
            message: 'Login successful',
            csrf_token: sessionInfo.csrfToken,
            username: credentials.username
        });
    } else {
        recordLoginFailure(clientId);
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.post('/api/change-password', requireAdmin, requireAdminCsrf, (req, res) => {
    const { current_password: currentPassword, new_username: rawNewUsername, new_password: rawNewPassword } = req.body;
    const credentials = getAdminCredentials();

    if (!verifyPassword(
        String(currentPassword || ''),
        credentials.password_salt,
        credentials.password_hash,
        credentials.password_iterations
    )) {
        return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const newUsername = String(rawNewUsername || '').trim();
    const newPassword = String(rawNewPassword || '').trim();

    if (!newUsername && !newPassword) {
        return res.status(400).json({ success: false, message: 'No updates were provided' });
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

    return res.json({ success: true, message: 'Credentials updated successfully', username: finalUsername });
});

app.post('/api/logout', requireAdmin, requireAdminCsrf, (req, res) => {
    clearAdminSession(req);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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
        return res.status(403).json({ success: false, message: 'Only localhost is allowed' });
    }

    const confirmText = String((req.body && req.body.confirm_text) || '').trim();
    if (confirmText !== 'RESET_ADMIN') {
        return res.status(400).json({ success: false, message: 'Invalid confirmation text' });
    }

    saveAdminCredentials('admin', hashPassword('admin'));
    return res.json({ success: true, message: 'Credentials reset to default', username: 'admin' });
});

// 启动服务器
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});