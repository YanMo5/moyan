const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('../lib/mailer.cjs');
const moderation = require('../lib/moderation.cjs');
const validation = require('../lib/validation.cjs');
const rateLimit = require('../lib/rate-limit.cjs');

let Pool = null;

const SESSION_COOKIE_NAME = 'yanmo_admin_session';
const CSRF_HEADER_NAME = 'x-csrf-token';
const SESSION_TTL_MS = parseEnvInt('SESSION_TTL_MS', 12 * 60 * 60 * 1000, 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
const PASSWORD_HASH_ITERATIONS = parseEnvInt('PASSWORD_HASH_ITERATIONS', 600000, 100000, 2000000);
const LOGIN_WINDOW_MS = parseEnvInt('LOGIN_WINDOW_MS', 10 * 60 * 1000, 60 * 1000, 60 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = parseEnvInt('LOGIN_MAX_ATTEMPTS', 5, 3, 20);
const LOGIN_LOCK_MS = parseEnvInt('LOGIN_LOCK_MS', 15 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
const MAX_LOGIN_USERNAME_LENGTH = 64;
const MAX_LOGIN_PASSWORD_LENGTH = 256;
const MIN_ADMIN_PASSWORD_LENGTH = 10;
const MAX_ADMIN_PASSWORD_LENGTH = 128;
const DAILY_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DAILY_IMAGE_MAX_BYTES = 300000;
const DAILY_CAPTION_MAX = 1000;
const ARTICLE_COVER_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const ARTICLE_COVER_MAX_BYTES = 240000;

const rootDir = path.join(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dataFile = path.join(dataDir, 'cloud-data.json');
const adminPasswordFile = path.join(dataDir, 'admin-password.txt');
const adminCredentialsFile = path.join(dataDir, 'admin-credentials.json');

let memoryData = null;
let memoryCredentials = null;
let dataStorageMode = 'memory';
const loginFailures = new Map();
let dbPool = null;
let dbSchemaReady = false;
let envCredentialsCache = null;
let envCredentialsCacheKey = '';

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

function now() {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function toSafeText(value) {
    return String(value || '').trim();
}

/** 常量时间比较，避免通过响应时间推断用户名 / 签名 / CSRF Token。 */
function safeCompareStrings(left, right) {
    const a = Buffer.from(String(left == null ? '' : left));
    const b = Buffer.from(String(right == null ? '' : right));
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(a, b);
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

function normalizeArticleCover(value) {
    const cover = toSafeText(value);
    if (!cover) return '';
    if (!ARTICLE_COVER_PATTERN.test(cover) || cover.length > ARTICLE_COVER_MAX_BYTES) return null;
    return cover;
}

function sortByCreatedAtDesc(items) {
    return (items || []).slice().sort((a, b) => {
        return String(b && b.created_at || '').localeCompare(String(a && a.created_at || ''));
    });
}

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
        downloadUrl: row.download_url || row.downloadUrl || '',
        panUrl: row.pan_url || row.panUrl || '',
        panCode: row.pan_code || row.panCode || '',
        source: row.source,
        updatedAt: row.updated_at || row.updatedAt || '',
        sortOrder: Number(row.sort_order != null ? row.sort_order : row.sortOrder) || 0
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

function resolveAlbumId(data, rawId) {
    const parsed = Number(rawId);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
        const found = data.daily_albums.find((album) => Number(album.id) === parsed);
        return found ? found.id : null;
    }
    if (!data.daily_albums.length) {
        data.daily_albums.push({
            id: nextId(data.daily_albums),
            title: '默认相册',
            description: '未分类的日常照片',
            created_at: now()
        });
    }
    return data.daily_albums[0].id;
}

function albumWithCounts(data, album) {
    const photos = (data.daily_posts || []).filter((post) => Number(post.album_id) === Number(album.id));
    return {
        ...album,
        photo_count: photos.length,
        cover_image: photos.length ? photos[0].image_data : null
    };
}

function readToolsSeed() {
    try {
        return require('../src/data/tools.json');
    } catch (error) {
        return null;
    }
}

function loadSeedTools() {
    try {
        const parsed = readToolsSeed();
        const items = parsed && Array.isArray(parsed.tools) ? parsed.tools : [];
        return items.map((tool, index) => ({
            id: index + 1,
            name: toSafeText(tool.name),
            category: toSafeText(tool.category),
            version: toSafeText(tool.version),
            size: toSafeText(tool.size),
            description: toSafeText(tool.description),
            glyph: toSafeText(tool.glyph),
            tone: toSafeText(tool.tone) || 'blue',
            downloadUrl: toSafeText(tool.downloadUrl),
            panUrl: toSafeText(tool.panUrl),
            panCode: toSafeText(tool.panCode),
            source: toSafeText(tool.source),
            updatedAt: toSafeText(tool.updatedAt),
            sortOrder: index
        }));
    } catch (error) {
        return [];
    }
}

function baseData() {
    return {
        messages: [
            {
                id: 1,
                name: '夜航',
                email: 'visitor@example.com',
                message: '站点风格很酷，安全文章也很有参考价值。',
                created_at: '2026-04-08 20:30:00'
            }
        ],
        links: [
            {
                id: 1,
                site_name: 'OpenAI',
                site_url: 'https://openai.com',
                site_description: '人工智能研究与产品团队。',
                site_avatar: '',
                status: 'approved',
                created_at: '2026-04-07 09:00:00'
            }
        ],
        articles: [
            {
                id: 1,
                title: 'Web应用渗透测试深度指南 (2026版)',
                content: '在这个数字化时代，Web安全是企业的生命线。本文将深入探讨OWASP Top 10漏洞，并结合实战工具，手把手教你如何通过模拟攻击来防御真实威胁。\n\n首先，信息收集是所有攻击的基础。我们需要利用Nmap进行端口扫描，使用Dirsearch探测目录，并利用Whois工具了解目标的组织架构。每一个微小的细节都可能成为突破口。\n\n其次，我们将聚焦于SQL注入和XSS这两种经典但依然常见的漏洞。通过手动构造Payload，我们可以绕过简单的WAF（Web应用防火墙）防护。本文提供了最新的Bypass技巧，帮助你在合法合规的渗透测试中突破防线。\n\n最后，报告的编写同样重要。一份专业的渗透测试报告不仅要指出漏洞，更要给出可落地的修复方案，帮助开发团队从根本上消除安全隐患。',
                category: '渗透测试',
                created_at: '2026-04-10 14:30:00'
            },
            {
                id: 2,
                title: '生成式AI系统的安全边界：从Prompt Injection到后门攻击',
                content: '随着LLM的普及，AI安全已成为新的战场。我们将分析提示词注入的多种模式，探讨如何构建稳健的过滤层，并揭露目前AI应用中常见的供应链安全风险。\n\n提示词注入(Prompt Injection)是目前AI系统面临的首要威胁。攻击者可以通过巧妙设计的指令，诱导模型忽略原有的系统约束，从而泄露敏感数据或执行非预期的指令。我们将演示几种经典的"越狱"模式。\n\n除了指令层面的漏洞，我们还需要关注模型参数层面的后门。通过在微调阶段注入特定触发器(Trigger)，攻击者可以控制模型在特定输入下的输出。这种隐蔽的攻击方式对现代AI供应链构成了严峻挑战。\n\n应对这些挑战，需要从模型鲁棒性训练、输入输出审查以及沙箱化执行三个维度建立全方位的防御体系。',
                category: 'AI安全',
                created_at: '2026-04-05 09:15:00'
            },
            {
                id: 3,
                title: '企业级零信任架构(Zero Trust)实践方案',
                content: '传统的边界防御已经失效。本文分析了零信任的核心思想"从不信任，始终验证"，并提供了在混合云环境下实现身份感知代理(IAP)的技术路径。\n\n零信任不是一种产品，而是一种安全哲学。它要求无论是在内部网络还是外部，任何访问请求都必须经过动态、严格的身份验证。这需要我们将安全边界从网络层面迁移到身份和应用层面。\n\n在落地实践中，身份感知代理(Identity-Aware Proxy)是核心组件。它通过拦截所有内部系统的流量，集中进行身份核验和权限管控，从而实现了对核心业务系统的极细粒度保护。本文详细记录了我们在某大型分布式架构中的迁移经验。',
                category: '企业安全',
                created_at: '2026-03-30 11:00:00'
            },
            {
                id: 4,
                title: '基于Python的自动化弱点扫描器开发实战',
                content: '学会如何利用Python开发一个轻量级的分布式扫描框架。涵盖异步并发请求、指纹识别算法以及漏洞库的动态集成方案。',
                category: 'Python安全',
                created_at: '2026-03-22 16:45:00'
            },
            {
                id: 5,
                title: '硬件安全浅谈：侧信道攻击与防御',
                content: '不仅是软件，硬件层面同样存在致命弱点。本文通过功耗分析和电磁辐射泄露的案例，带你进入物理层安全研究的奇妙世界。',
                category: '硬件安全',
                created_at: '2026-03-15 10:20:00'
            },
            {
                id: 6,
                title: '企业网络安全架构设计',
                content: '总结企业在边界防护、身份管理和日志审计上的常见设计策略。',
                category: '企业安全',
                created_at: '2026-03-10 10:00:00'
            }
        ],
        daily_posts: [],
        daily_albums: [],
        tools: [],
        contact_messages: [],
        stats: {
            total_views: 1200
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
        daily_posts: Array.isArray(safe.daily_posts) ? safe.daily_posts : [],
        daily_albums: Array.isArray(safe.daily_albums) ? safe.daily_albums : [],
        tools: Array.isArray(safe.tools) ? safe.tools : [],
        contact_messages: Array.isArray(safe.contact_messages) ? safe.contact_messages : [],
        stats: {
            total_views: Number(safe.stats && safe.stats.total_views) || 0
        },
        audit_logs: Array.isArray(safe.audit_logs) ? safe.audit_logs : []
    };
}

function getDbPool() {
    let connectionString = toSafeText(process.env.DATABASE_URL);
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
        const parsedUrl = new URL(connectionString);
        if (!parsedUrl.searchParams.has('sslmode')) {
            parsedUrl.searchParams.set('sslmode', 'verify-full');
            connectionString = parsedUrl.toString();
        }
        
        dbPool = new Pool({
            connectionString,
            ssl: { rejectUnauthorized: true }
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
            subject TEXT DEFAULT '',
            message TEXT NOT NULL,
            is_read BOOLEAN NOT NULL DEFAULT FALSE,
            source TEXT DEFAULT 'guestbook',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE messages ADD COLUMN IF NOT EXISTS subject TEXT DEFAULT '';
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'guestbook';

        CREATE TABLE IF NOT EXISTS tools (
            id BIGSERIAL PRIMARY KEY,
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
            updated_at TEXT DEFAULT '',
            sort_order INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS daily_albums (
            id BIGSERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT DEFAULT '',
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
            cover_image TEXT DEFAULT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE articles ADD COLUMN IF NOT EXISTS cover_image TEXT DEFAULT NULL;

        CREATE TABLE IF NOT EXISTS daily_posts (
            id BIGSERIAL PRIMARY KEY,
            caption TEXT NOT NULL DEFAULT '',
            image_data TEXT NOT NULL,
            album_id BIGINT DEFAULT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE daily_posts ADD COLUMN IF NOT EXISTS album_id BIGINT DEFAULT NULL;

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

            let [messagesResult, linksResult, articlesResult, dailyResult, contactMessagesResult, auditLogsResult, statsResult, toolsResult, albumsResult] = await Promise.all([
                pool.query('SELECT id, name, email, subject, message, is_read, source, created_at FROM messages ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, site_name, site_url, site_description, site_avatar, status, created_at FROM links ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, title, content, category, cover_image, created_at FROM articles ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, caption, image_data, album_id, created_at FROM daily_posts ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, name, email, subject, message, created_at FROM contact_messages ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT id, action, status, username, client_ip, detail, created_at FROM audit_logs ORDER BY created_at DESC, id DESC'),
                pool.query('SELECT total_views FROM site_stats WHERE id = 1 LIMIT 1'),
                pool.query('SELECT * FROM tools ORDER BY sort_order ASC, id ASC'),
                pool.query('SELECT id, title, description, created_at FROM daily_albums ORDER BY created_at DESC, id DESC')
            ]);

            if (!toolsResult.rows.length) {
                const seed = readToolsSeed();
                const seedItems = seed && Array.isArray(seed.tools) ? seed.tools : [];
                try {
                    for (let i = 0; i < seedItems.length; i += 1) {
                        const tool = seedItems[i] || {};
                        await pool.query(
                            'INSERT INTO tools (name, category, version, size, description, glyph, tone, download_url, pan_url, pan_code, source, updated_at, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
                            [
                                toSafeText(tool.name), toSafeText(tool.category), toSafeText(tool.version), toSafeText(tool.size),
                                toSafeText(tool.description), toSafeText(tool.glyph), toSafeText(tool.tone) || 'blue',
                                toSafeText(tool.downloadUrl), toSafeText(tool.panUrl), toSafeText(tool.panCode),
                                toSafeText(tool.source), toSafeText(tool.updatedAt) || new Date().toISOString().slice(0, 10), i
                            ]
                        );
                    }
                    toolsResult = await pool.query('SELECT * FROM tools ORDER BY sort_order ASC, id ASC');
                } catch (seedError) {
                    // 播种失败不阻断读取
                }
            }

            const dbData = normalizeData({
                messages: messagesResult.rows,
                links: linksResult.rows,
                articles: articlesResult.rows,
                daily_posts: dailyResult.rows,
                daily_albums: albumsResult.rows,
                tools: toolsResult.rows,
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
                dailyResult.rows.length,
                contactMessagesResult.rows.length,
                auditLogsResult.rows.length,
                Number(statsResult.rows[0] && statsResult.rows[0].total_views) || 0,
                toolsResult.rows.length,
                albumsResult.rows.length
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
            if (!memoryData.tools.length) memoryData.tools = loadSeedTools();
            dataStorageMode = 'file';
            return memoryData;
        }
    } catch (error) {
        // Ignore and rebuild from defaults.
    }

    memoryData = baseData();
    if (!memoryData.tools.length) memoryData.tools = loadSeedTools();
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
            await client.query('TRUNCATE TABLE messages, links, articles, daily_posts, daily_albums, tools, contact_messages, audit_logs, site_stats RESTART IDENTITY');

            for (const item of memoryData.messages) {
                await client.query(
                    'INSERT INTO messages (id, name, email, subject, message, is_read, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
                    [Number(item.id) || null, item.name, item.email, item.subject || '', item.message, item.is_read === true, item.source || 'guestbook', item.created_at]
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
                    'INSERT INTO articles (id, title, content, category, cover_image, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
                    [Number(item.id) || null, item.title, item.content, item.category, item.cover_image || null, item.created_at]
                );
            }

            for (const item of memoryData.daily_posts) {
                await client.query(
                    'INSERT INTO daily_posts (id, caption, image_data, album_id, created_at) VALUES ($1, $2, $3, $4, $5)',
                    [Number(item.id) || null, item.caption || '', item.image_data, item.album_id == null ? null : Number(item.album_id), item.created_at]
                );
            }

            for (const item of memoryData.daily_albums) {
                await client.query(
                    'INSERT INTO daily_albums (id, title, description, created_at) VALUES ($1, $2, $3, $4)',
                    [Number(item.id) || null, item.title, item.description || '', item.created_at || new Date().toISOString()]
                );
            }

            for (const item of memoryData.tools) {
                await client.query(
                    'INSERT INTO tools (id, name, category, version, size, description, glyph, tone, download_url, pan_url, pan_code, source, updated_at, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
                    [Number(item.id) || null, item.name, item.category || '', item.version || '', item.size || '', item.description || '', item.glyph || '', item.tone || 'blue', item.downloadUrl || item.download_url || '', item.panUrl || item.pan_url || '', item.panCode || item.pan_code || '', item.source || '', item.updatedAt || item.updated_at || '', Number(item.sortOrder != null ? item.sortOrder : item.sort_order) || 0]
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
        envCredentialsCache = null;
        envCredentialsCacheKey = '';
        return null;
    }

    // 环境变量凭据也缓存哈希结果，避免每次登录/鉴权都重复执行 PBKDF2。
    const cacheKey = `${envUsername}\u0000${envPassword}`;
    if (envCredentialsCache && envCredentialsCacheKey === cacheKey) {
        return envCredentialsCache;
    }
    envCredentialsCache = {
        username: envUsername,
        ...hashPassword(envPassword),
        // 环境变量密码在冷启动后会生成新的随机盐，用确定性的指纹保证已签名 Cookie 跨实例仍可校验。
        credential_version: crypto.createHash('sha256')
            .update(`${envUsername}\u0000${envPassword}`)
            .digest('hex')
            .slice(0, 16)
    };
    envCredentialsCacheKey = cacheKey;
    return envCredentialsCache;
}

/** 凭据指纹写入签名 Cookie；改密/改账号后旧 Token 自动失效。 */
function getCredentialVersion(credentials) {
    if (credentials && credentials.credential_version) {
        return String(credentials.credential_version);
    }
    return crypto.createHash('sha256')
        .update(`${String(credentials.username || '')}\u0000${String(credentials.password_hash || '')}\u0000${Number(credentials.password_iterations || 0)}`)
        .digest('hex')
        .slice(0, 16);
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

// C-01 fix: local-mode detection is based solely on the runtime environment,
// never on per-request headers which an attacker can spoof.
const IS_LOCAL_MODE = !process.env.VERCEL && process.env.NODE_ENV !== 'production';

function getRequestHost(req) {
    const host = String(req.headers.host || '').split(':')[0].trim().toLowerCase();
    return host;
}

function requireCloudAdminEnv(req, res) {
    if (IS_LOCAL_MODE) {
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
        const legacyPassword = toSafeText(fs.readFileSync(adminPasswordFile, 'utf8'));
        if (!legacyPassword || legacyPassword === 'managed_by_hash_credentials') {
            return 'admin';
        }
        return legacyPassword;
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
        fs.writeFileSync(adminCredentialsFile, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
        try {
            fs.chmodSync(adminCredentialsFile, 0o600);
        } catch (chmodError) {
            // Windows / read-only filesystems may not support chmod.
        }
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

    try {
        if (fs.existsSync(adminCredentialsFile)) {
            const parsed = JSON.parse(fs.readFileSync(adminCredentialsFile, 'utf8'));
            const username = toSafeText(parsed && parsed.username) || 'admin';
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

    const defaultCredentials = {
        username: 'admin',
        ...hashPassword(readLegacyAdminPassword())
    };
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
        try {
            out[key] = decodeURIComponent(value);
        } catch (error) {
            out[key] = value;
        }
    });
    return out;
}

// C-02 fix: use env var if configured, otherwise auto-generate a per-instance secret.
// A randomly-generated secret means admin sessions won't survive cold starts,
// but public routes (GET /links, /articles, /messages) work without any env setup.
const _SESSION_SECRET = (() => {
    const s = String(process.env.ADMIN_SESSION_SECRET || '').trim();
    if (s && s !== 'yanmo-session-secret-change-me') {
        return s;
    }
    // Auto-generate a per-instance fallback secret
    const fallback = crypto.randomBytes(32).toString('hex');
    console.warn('[WARN] ADMIN_SESSION_SECRET not set — using per-instance random secret. Admin sessions will not survive cold starts.');
    return fallback;
})();

function sessionSecret() {
    return _SESSION_SECRET;
}

function signToken(content) {
    return crypto.createHmac('sha256', sessionSecret()).update(content).digest('hex');
}

function createSessionToken(username, credentialVersion) {
    const payload = {
        u: String(username),
        v: String(credentialVersion || ''),
        iat: Date.now(),
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
    if (!safeCompareStrings(signToken(encoded), signature)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (!payload || Number(payload.exp || 0) <= Date.now()) {
            return null;
        }

        // 签名有效还不够：Token 必须仍对应当前凭据，改密/改账号后旧 Token 立即失效。
        const credentials = getAdminCredentials();
        if (!payload.u || !safeCompareStrings(payload.u, credentials.username)) {
            return null;
        }
        if (!payload.v || !safeCompareStrings(payload.v, getCredentialVersion(credentials))) {
            return null;
        }
        return payload;
    } catch (error) {
        return null;
    }
}

function setSessionCookie(res, token) {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    const secure = IS_LOCAL_MODE ? '' : '; Secure';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
    const secure = IS_LOCAL_MODE ? '' : '; Secure';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
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
    if (!expected || !provided || !safeCompareStrings(provided, expected)) {
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

function enforceRateLimit(req, res, action, limit, windowMs, clientIp) {
    const result = rateLimit.hit(action + '|' + clientIp, limit, windowMs);
    if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfter || 60));
        res.status(429).json({ error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' });
        return false;
    }
    return true;
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
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (!IS_LOCAL_MODE) {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }

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
        return res.status(200).json({ ok: true, ts: new Date().toISOString() });
    }

    if (routePath === '/messages' && method === 'GET') {
        // M-01: strip email from public response — email is PII and only the admin should see it
        const publicMessages = sortByCreatedAtDesc(data.messages).map(({ email: _email, ...rest }) => rest);
        return res.status(200).json(publicMessages);
    }

    if (routePath === '/messages' && method === 'POST') {
        if (!enforceRateLimit(req, res, 'message', 12, 10 * 60 * 1000, clientIp)) return;
        if (!validation.isPlainObject(body)) {
            return res.status(400).json({ error: '请求格式不正确' });
        }

        const name = validation.trimmed(body.name, 80);
        const email = validation.trimmed(body.email, 200);
        const message = validation.trimmed(body.message, 2000);
        const subject = validation.trimmed(body.subject, 200);

        if (!name || !email || !message) {
            return res.status(400).json({ error: '请完整填写留言信息' });
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

        const item = {
            id: nextId(data.messages),
            name,
            email,
            subject,
            message,
            is_read: false,
            source: 'guestbook',
            moderation: 'auto-passed',
            created_at: now()
        };
        data.messages.unshift(item);
        await saveData(data);
        return res.status(201).json(item);
    }

    if (routePath === '/links' && method === 'GET') {
        // 公开接口只返回已通过友链，不能把待审核/已拒绝数据暴露出去。
        return res.status(200).json(sortByCreatedAtDesc(
            data.links.filter((item) => item && item.status === 'approved')
        ));
    }

    if (routePath === '/links' && method === 'POST') {
        if (!enforceRateLimit(req, res, 'link-apply', 10, 60 * 60 * 1000, clientIp)) return;
        if (!validation.isPlainObject(body)) {
            return res.status(400).json({ error: '请求格式不正确' });
        }

        const siteName = validation.trimmed(body['site-name'] || body.site_name || body.siteName, 100);
        const siteUrl = validation.httpUrl(body['site-url'] || body.site_url || body.siteUrl, 2048);
        const siteDescription = validation.trimmed(body['site-description'] || body.site_description || body.siteDescription, 500);
        const siteAvatar = validation.imageDataUrl(body['site-avatar'] || body.site_avatar || body.siteAvatar, 300000);

        if (!siteName || !siteUrl || !siteDescription) {
            return res.status(400).json({ error: '请完整填写有效的友链信息' });
        }
        if (siteAvatar === null) {
            return res.status(400).json({ error: '头像格式无效或文件过大' });
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

    if (routePath === '/daily' && method === 'GET') {
        const limit = Math.min(12, Math.max(1, parsePositiveInt(req.query && req.query.limit, 12, 1, 12)));
        const offset = Math.max(0, parsePositiveInt(req.query && req.query.offset, 0, 0, 10000));
        return res.status(200).json(sortByCreatedAtDesc(data.daily_posts).slice(offset, offset + limit));
    }

    if (routePath === '/daily' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;

        if (!validation.isPlainObject(body)) {
            return res.status(400).json({ error: '请求格式不正确' });
        }
        const caption = validation.trimmed(body.caption, DAILY_CAPTION_MAX);
        const imageData = validation.imageDataUrl(body.image, DAILY_IMAGE_MAX_BYTES);

        if (imageData === null) {
            return res.status(400).json({ error: '图片压缩后仍然过大，请换一张更小的图片' });
        }
        if (!imageData) {
            return res.status(400).json({ error: '请上传有效的图片文件' });
        }

        const albumId = resolveAlbumId(data, body.album_id);
        if (!albumId) {
            return res.status(400).json({ error: '相册不存在，请先创建相册' });
        }

        const item = {
            id: nextId(data.daily_posts),
            caption,
            image_data: imageData,
            album_id: albumId,
            created_at: now()
        };
        data.daily_posts.unshift(item);
        writeAuditLog(data, 'daily_create', 'success', clientIp, session.u || 'admin', 'daily_id=' + item.id);
        await saveData(data);
        return res.status(201).json(item);
    }

    if (routePath === '/articles' && method === 'GET') {
        const limit = parsePositiveInt(req.query && req.query.limit, 0, 0, 50);
        const articles = sortByCreatedAtDesc(data.articles);
        return res.status(200).json(limit ? articles.slice(0, limit) : articles);
    }

    if (routePath === '/articles' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }

        if (!validation.isPlainObject(body)) {
            return res.status(400).json({ error: '请求格式不正确' });
        }
        const title = validation.trimmed(body.title, 200);
        const content = validation.text(body.content, 200000).trim();
        const category = validation.trimmed(body.category, 80);
        const coverImage = normalizeArticleCover(body.cover_image);
        if (coverImage === null) {
            return res.status(400).json({ error: '封面图格式无效或体积过大' });
        }

        if (!title || !content || !category) {
            return res.status(400).json({ error: '请完整填写文章信息' });
        }

        const item = {
            id: nextId(data.articles),
            title,
            content,
            category,
            cover_image: coverImage,
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
        if (!validation.isPlainObject(body)) {
            return res.status(400).json({ success: false, message: '请求格式不正确' });
        }

        const lockRemaining = checkLoginLock(clientIp);
        if (lockRemaining > 0) {
            writeAuditLog(data, 'admin_login', 'blocked', clientIp, toSafeText(body.username), `retry_after=${lockRemaining}`);
            await saveData(data);
            res.setHeader('Retry-After', String(lockRemaining));
            return res.status(429).json({
                success: false,
                message: `Too many attempts. Retry after ${lockRemaining}s.`,
                retry_after_seconds: lockRemaining
            });
        }

        const username = validation.trimmed(body.username, MAX_LOGIN_USERNAME_LENGTH);
        const password = String(body.password == null ? '' : body.password);
        const fieldsValid = username.length > 0
            && username.length <= MAX_LOGIN_USERNAME_LENGTH
            && password.length > 0
            && password.length <= MAX_LOGIN_PASSWORD_LENGTH;

        if (!fieldsValid) {
            recordLoginFailure(clientIp);
            writeAuditLog(data, 'admin_login', 'failed', clientIp, username, 'invalid_field_length');
            await saveData(data);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        let credentials = getAdminCredentials();
        // 用户名与密码都做常量时间比较；密码校验不因用户名错误而短路。
        const usernameMatches = safeCompareStrings(username, credentials.username);
        const passwordMatches = verifyPassword(
            password,
            credentials.password_salt,
            credentials.password_hash,
            credentials.password_iterations
        );
        const valid = usernameMatches && passwordMatches;

        if (!valid) {
            recordLoginFailure(clientIp);
            writeAuditLog(data, 'admin_login', 'failed', clientIp, username, 'invalid_credentials');
            await saveData(data);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        clearLoginFailures(clientIp);

        // 旧凭据使用较低迭代次数时，趁登录成功透明升级哈希强度（环境变量凭据除外）。
        if (!credentials.credential_version && Number(credentials.password_iterations || 0) < PASSWORD_HASH_ITERATIONS) {
            credentials = saveAdminCredentials(credentials.username, hashPassword(password));
        }

        const sessionInfo = createSessionToken(credentials.username, getCredentialVersion(credentials));
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

        if (newUsername && newUsername.length > MAX_LOGIN_USERNAME_LENGTH) {
            writeAuditLog(data, 'credentials_change', 'failed', clientIp, session.u, 'username_too_long');
            await saveData(data);
            return res.status(400).json({ success: false, message: `管理员账号不能超过 ${MAX_LOGIN_USERNAME_LENGTH} 位` });
        }

        if (newPassword) {
            const strengthError = validateAdminPasswordStrength(newPassword, newUsername || credentials.username);
            if (strengthError) {
                writeAuditLog(data, 'credentials_change', 'failed', clientIp, session.u, 'weak_password');
                await saveData(data);
                return res.status(400).json({ success: false, message: strengthError });
            }
        }

        const finalUsername = newUsername || credentials.username;
        const finalPassword = newPassword ? hashPassword(newPassword) : {
            password_salt: credentials.password_salt,
            password_hash: credentials.password_hash,
            password_iterations: credentials.password_iterations
        };

        const saved = saveAdminCredentials(finalUsername, finalPassword);
        // 旧签名 Cookie 因凭据指纹变化而失效；立即给当前浏览器签发新 Token，避免改密后被登出。
        const sessionInfo = createSessionToken(saved.username, getCredentialVersion(saved));
        setSessionCookie(res, sessionInfo.token);
        writeAuditLog(data, 'credentials_change', 'success', clientIp, session.u, `username=${saved.username}`);
        await saveData(data);
        return res.status(200).json({
            success: true,
            message: 'Credentials updated successfully',
            username: saved.username,
            csrf_token: sessionInfo.csrf
        });
    }

    if (routePath === '/reset-admin-credentials' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }

        if (!IS_LOCAL_MODE) {
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
        clearSessionCookie(res);
        writeAuditLog(data, 'credentials_reset', 'success', clientIp, session.u, 'reset_to_default');
        await saveData(data);
        return res.status(200).json({ success: true, message: 'Credentials reset to default', username: 'admin' });
    }

    if (routePath === '/contact' && method === 'POST') {
        if (!enforceRateLimit(req, res, 'contact', 8, 10 * 60 * 1000, clientIp)) return;
        if (!validation.isPlainObject(body)) {
            return res.status(400).json({ error: '请求格式不正确' });
        }
        const name = validation.trimmed(body.name, 80);
        const email = validation.trimmed(body.email, 200);
        const subject = validation.trimmed(body.subject, 200);
        const message = validation.trimmed(body.message, 8000);

        if (!name || !email || !subject || !message) {
            return res.status(400).json({ error: '请完整填写联系表单' });
        }
        if (!validation.isEmail(email)) {
            return res.status(400).json({ error: '邮箱格式不正确' });
        }

        const inserted = {
            id: nextId(data.contact_messages),
            name,
            email,
            subject,
            message,
            created_at: now()
        };
        data.contact_messages.unshift(inserted);
        await saveData(data);

        const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
        const mailResult = await mailer.sendContactNotification({
            name,
            email,
            subject,
            message,
            received_at: inserted.created_at,
            client_ip: forwarded
        });

        return res.status(201).json({
            success: true,
            id: inserted.id,
            mailed: mailResult.ok === true,
            mail_reason: mailResult.ok ? null : (mailResult.reason || 'send_failed'),
            message: mailResult.ok
                ? '消息已发送到站长邮箱，感谢您的来信！'
                : '留言已保存到站内，但站点的邮件通知暂未开启。'
        });
    }

    if (routePath === '/mail-status' && method === 'GET') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        return res.status(200).json(mailer.getStatus());
    }

    if (routePath === '/mail-test' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) {
            return;
        }
        if (!requireAdminCsrf(req, res, session)) {
            return;
        }
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
        return res.json({
            ok: true,
            to: status.to || status.user || null,
            message_id: result.messageId || null,
            at: new Date().toISOString()
        });
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

        const action = validation.trimmed(req.query.action, 80);
        let status = validation.trimmed(req.query.status, 20);
        if (status && !['success', 'failed', 'denied', 'blocked'].includes(status)) status = '';
        const keyword = validation.trimmed(req.query.keyword, 100).toLowerCase();
        const page = parsePositiveInt(req.query.page, 1, 1, 100000);
        const pageSize = parsePositiveInt(req.query.page_size, 20, 1, 100);

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

        const action = validation.trimmed(req.query.action, 80);
        let status = validation.trimmed(req.query.status, 20);
        if (status && !['success', 'failed', 'denied', 'blocked'].includes(status)) status = '';
        const keyword = validation.trimmed(req.query.keyword, 100).toLowerCase();

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

    if (routePath === '/admin/links' && method === 'GET') {
        const session = requireAdmin(req, res);
        if (!session) return;
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(sortByCreatedAtDesc(data.links));
    }

    if (routePath === '/admin/visitors' && method === 'GET') {
        const session = requireAdmin(req, res);
        if (!session) return;
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({
            total: 0,
            unique_ips: 0,
            today_total: 0,
            today_unique: 0,
            top_regions: [],
            items: [],
            page: 1,
            page_size: 10,
            total_pages: 1,
            note: 'Vercel 部署不采集逐条访客日志，该功能仅本地 Node 部署可用'
        });
    }

    if (routePath === '/tools' && method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        const tools = (data.tools || []).slice().sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || Number(a.id) - Number(b.id));
        return res.status(200).json(tools.map(mapToolRow));
    }

    if (routePath === '/tools' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;
        const parsed = parseToolPayload(body);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const item = Object.assign({ id: nextId(data.tools), sortOrder: data.tools.length }, parsed.value);
        data.tools.push(item);
        writeAuditLog(data, 'tool_create', 'success', clientIp, session.u || 'admin', 'tool_id=' + item.id);
        await saveData(data);
        return res.status(201).json(mapToolRow(item));
    }

    const toolIdMatch = routePath.match(/^\/tools\/(\d+)$/);
    if (toolIdMatch) {
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;
        const toolId = Number(toolIdMatch[1]);
        const index = data.tools.findIndex((item) => Number(item.id) === toolId);
        if (index < 0) return res.status(404).json({ error: 'tool not found' });
        if (method === 'PUT') {
            const parsed = parseToolPayload(body);
            if (parsed.error) return res.status(400).json({ error: parsed.error });
            data.tools[index] = Object.assign({}, data.tools[index], parsed.value, { id: toolId });
            writeAuditLog(data, 'tool_update', 'success', clientIp, session.u || 'admin', 'tool_id=' + toolId);
            await saveData(data);
            return res.status(200).json(mapToolRow(data.tools[index]));
        }
        if (method === 'DELETE') {
            data.tools.splice(index, 1);
            writeAuditLog(data, 'tool_delete', 'success', clientIp, session.u || 'admin', 'tool_id=' + toolId);
            await saveData(data);
            return res.status(200).json({ id: toolId, deleted: true });
        }
    }

    if (routePath === '/albums' && method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json((data.daily_albums || []).map((album) => albumWithCounts(data, album)));
    }

    if (routePath === '/albums' && method === 'POST') {
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;
        if (!validation.isPlainObject(body)) return res.status(400).json({ error: '请求格式不正确' });
        const title = validation.trimmed(body.title, 80);
        const description = validation.trimmed(body.description, 600);
        if (!title) return res.status(400).json({ error: '相册名称不能为空' });
        const item = { id: nextId(data.daily_albums), title, description, created_at: now() };
        data.daily_albums.unshift(item);
        writeAuditLog(data, 'album_create', 'success', clientIp, session.u || 'admin', 'album_id=' + item.id);
        await saveData(data);
        return res.status(201).json(albumWithCounts(data, item));
    }

    const albumIdMatch = routePath.match(/^\/albums\/(\d+)$/);
    if (albumIdMatch) {
        const albumId = Number(albumIdMatch[1]);
        const albumIndex = data.daily_albums.findIndex((item) => Number(item.id) === albumId);
        if (albumIndex < 0) return res.status(404).json({ error: 'album not found' });
        if (method === 'GET') {
            const photos = (data.daily_posts || []).filter((post) => Number(post.album_id) === albumId);
            return res.status(200).json({ album: albumWithCounts(data, data.daily_albums[albumIndex]), photos });
        }
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;
        if (method === 'PUT') {
            if (!validation.isPlainObject(body)) return res.status(400).json({ error: '请求格式不正确' });
            const title = validation.trimmed(body.title, 80);
            const description = validation.trimmed(body.description, 600);
            if (!title) return res.status(400).json({ error: '相册名称不能为空' });
            data.daily_albums[albumIndex] = Object.assign({}, data.daily_albums[albumIndex], { title, description });
            writeAuditLog(data, 'album_update', 'success', clientIp, session.u || 'admin', 'album_id=' + albumId);
            await saveData(data);
            return res.status(200).json(albumWithCounts(data, data.daily_albums[albumIndex]));
        }
        if (method === 'DELETE') {
            data.daily_posts = data.daily_posts.filter((post) => Number(post.album_id) !== albumId);
            data.daily_albums.splice(albumIndex, 1);
            writeAuditLog(data, 'album_delete', 'success', clientIp, session.u || 'admin', 'album_id=' + albumId);
            await saveData(data);
            return res.status(200).json({ id: albumId, deleted: true });
        }
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
    if (messageIdMatch && method === 'PATCH') {
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;
        if (!validation.isPlainObject(body)) return res.status(400).json({ error: '请求格式不正确' });
        const messageId = Number(messageIdMatch[1]);
        const item = data.messages.find((msg) => Number(msg.id) === messageId);
        if (!item) return res.status(404).json({ error: 'message not found' });
        const raw = body.is_read;
        const isRead = raw === true || raw === 1 || raw === '1' || raw === 'true';
        item.is_read = isRead;
        writeAuditLog(data, 'message_read', 'success', clientIp, session.u || 'admin', 'message_id=' + messageId);
        await saveData(data);
        return res.status(200).json(item);
    }

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

    const dailyIdMatch = routePath.match(/^\/daily\/(\d+)$/);
    if (dailyIdMatch && method === 'PUT') {
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;

        const dailyId = Number(dailyIdMatch[1]);
        const index = data.daily_posts.findIndex(item => Number(item.id) === dailyId);
        if (index < 0) {
            return res.status(404).json({ error: 'daily post not found' });
        }

        data.daily_posts[index] = {
            ...data.daily_posts[index],
            caption: validation.trimmed(body.caption, DAILY_CAPTION_MAX)
        };
        writeAuditLog(data, 'daily_update', 'success', clientIp, session.u, 'daily_id=' + dailyId);
        await saveData(data);
        return res.status(200).json(data.daily_posts[index]);
    }

    if (dailyIdMatch && method === 'DELETE') {
        const session = requireAdmin(req, res);
        if (!session) return;
        if (!requireAdminCsrf(req, res, session)) return;

        const dailyId = Number(dailyIdMatch[1]);
        const index = data.daily_posts.findIndex(item => Number(item.id) === dailyId);
        if (index < 0) {
            return res.status(404).json({ error: 'daily post not found' });
        }

        data.daily_posts.splice(index, 1);
        writeAuditLog(data, 'daily_delete', 'success', clientIp, session.u, 'daily_id=' + dailyId);
        await saveData(data);
        return res.status(200).json({ id: dailyId, deleted: true });
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

        if (method === 'PUT') {
            const session = requireAdmin(req, res);
            if (!session) return;
            if (!requireAdminCsrf(req, res, session)) return;

            const index = data.articles.findIndex(item => Number(item.id) === articleId);
            if (index < 0) {
                return res.status(404).json({ error: 'article not found' });
            }

            if (!validation.isPlainObject(body)) {
                return res.status(400).json({ error: '请求格式不正确' });
            }
            const title = validation.trimmed(body.title, 200);
            const content = validation.text(body.content, 200000).trim();
            const category = validation.trimmed(body.category, 80);
            const coverImage = normalizeArticleCover(body.cover_image);
            if (coverImage === null) {
                return res.status(400).json({ error: '封面图格式无效或体积过大' });
            }
            if (!title || !content || !category) {
                return res.status(400).json({ error: '请完整填写文章信息' });
            }

            data.articles[index] = {
                ...data.articles[index],
                title,
                content,
                category,
                cover_image: coverImage
            };
            writeAuditLog(data, 'article_update', 'success', clientIp, session.u, 'article_id=' + articleId);
            await saveData(data);
            return res.status(200).json(data.articles[index]);
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
