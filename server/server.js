const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rssPoller = require('./rss-poller');

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});
const rootDir = path.join(__dirname, '..');
const adminPasswordFile = process.env.ADMIN_PASSWORD_FILE || path.join(rootDir, 'admin_password.txt');
const adminCredentialsFile = process.env.ADMIN_CREDENTIALS_FILE || path.join(rootDir, 'admin_credentials.json');
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
app.use(express.static(path.join(__dirname, '..', 'pages')));
app.use(express.static(path.join(__dirname, '..')));

// 连接数据库
const dbPath = process.env.DB_PATH || path.join(__dirname, 'blog.db');
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
app.post('/api/contact', (req, res) => {
    const { name, email, subject, message } = req.body;
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
            res.status(201).json({
                id: this.lastID,
                name,
                email,
                subject: subject || '',
                message,
                message: '消息已收到，感谢您的来信！'
            });
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
                res.json({ id, status, category: safeCategory });
            }
        );
    } else {
        db.run(
            'UPDATE links SET status = ? WHERE id = ?',
            [status, id],
            function(err) {
                if (err) { console.error('[500]', err.message); return res.status(500).json({ error: 'Internal server error' }); }
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
        const securePart = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionInfo.sid)}; Path=/; HttpOnly; SameSite=Lax${securePart}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
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