(function (window) {
    'use strict';

    if (typeof window === 'undefined' || typeof window.fetch !== 'function') {
        return;
    }

    var CONFIG = {
        STORAGE_KEY: 'yanmo.site.data.v1',
        SESSION_KEY: 'yanmo.site.admin.session.v1',
        REAL_SESSION_KEY: 'yanmo.site.admin.real-session.v1',
        ADMIN_CSRF_TOKEN_KEY: 'yanmo.site.admin.csrf.v1',
        API_MODE_KEY: 'yanmo.site.api.mode.v1',
        VISIT_KEY_PREFIX: 'yanmo.site.visit.',
        MESSAGE_CACHE_KEY: 'yanmo.site.messages.cache.v1',
        MESSAGE_TIMESTAMP_KEY: 'yanmo.site.messages.timestamp.v1',
        CONTACT_NAME_KEY: 'contact_name',
        CONTACT_EMAIL_KEY: 'contact_email',
        CACHE_TTL: 5 * 60 * 1000,
        API_BASE_URL: '/api'
    };

    var nativeFetch = window.fetch.bind(window);

    function isLocalDevHost() {
        var host = String(window.location.hostname || '').toLowerCase();
        // Check for localhost addresses
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
            return true;
        }
        // Check for file:// protocol (direct file access)
        if (window.location.protocol === 'file:') {
            return true;
        }
        return false;
    }

    function getApiMode() {
        var explicitMode = String(window.localStorage.getItem(CONFIG.API_MODE_KEY) || '').toLowerCase();
        if (explicitMode === 'server') {
            return explicitMode;
        }

        if (explicitMode === 'local') {
            // Prevent cloud/browser-local isolation by limiting local mode to local development only.
            if (isLocalDevHost()) {
                return 'local';
            }
            window.localStorage.setItem(CONFIG.API_MODE_KEY, 'server');
            return 'server';
        }

        // Default to server mode for better reliability with backend server
        // Local mode can be enabled explicitly via localStorage
        return 'server';
    }

    var useLocalApi = false;

    var INITIAL_DATA = {
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
                content: '随着LLM的普及，AI安全已成为新的战场。我们将分析提示词注入的多种模式，探讨如何构建稳健的过滤层，并揭露目前AI应用中常见的供应链安全风险。\n\n提示词注入(Prompt Injection)是目前AI系统面临的首要威胁。攻击者可以通过巧妙设计的指令，诱导模型忽略原有的系统约束，从而泄露敏感数据或执行非预期的指令。我们将演示几种经典的“越狱”模式。\n\n除了指令层面的漏洞，我们还需要关注模型参数层面的后门。通过在微调阶段注入特定触发器(Trigger)，攻击者可以控制模型在特定输入下的输出。这种隐蔽的攻击方式对现代AI供应链构成了严峻挑战。\n\n应对这些挑战，需要从模型鲁棒性训练、输入输出审查以及沙箱化执行三个维度建立全方位的防御体系。',
                category: 'AI安全',
                created_at: '2026-04-05 09:15:00'
            },
            {
                id: 3,
                title: '企业级零信任架构(Zero Trust)实践方案',
                content: '传统的边界防御已经失效。本文分析了零信任的核心思想“从不信任，始终验证”，并提供了在混合云环境下实现身份感知代理(IAP)的技术路径。\n\n零信任不是一种产品，而是一种安全哲学。它要求无论是在内部网络还是外部，任何访问请求都必须经过动态、严格的身份验证。这需要我们将安全边界从网络层面迁移到身份和应用层面。\n\n在落地实践中，身份感知代理(Identity-Aware Proxy)是核心组件。它通过拦截所有内部系统的流量，集中进行身份核验和权限管控，从而实现了对核心业务系统的极细粒度保护。本文详细记录了我们在某大型分布式架构中的迁移经验。',
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
        contact_messages: [],
        stats: {
            total_views: 1200
        },
        admin: {
            username: 'admin',
            // C-05 fix: no plaintext password in source. The default credential
            // is set only on first initialisation and the user should change it
            // immediately via /api/change-password in local mode.
            password: null
        }
    };

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function now() {
        return new Date().toISOString().slice(0, 19).replace('T', ' ');
    }

    function normalizeText(value) {
        return String(value || '').trim();
    }

    function parseJson(value) {
        if (!value) {
            return {};
        }

        try {
            return JSON.parse(value);
        } catch (error) {
            return {};
        }
    }

    function isValidUrl(value) {
        try {
            var url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch (error) {
            return false;
        }
    }

    function nextId(items) {
        return items.reduce(function (maxId, item) {
            return Math.max(maxId, Number(item.id) || 0);
        }, 0) + 1;
    }

    function sortByCreatedAtDesc(items) {
        return items.slice().sort(function (left, right) {
            return String(right.created_at).localeCompare(String(left.created_at));
        });
    }

    function normalizeData(rawData) {
        var safeData = rawData && typeof rawData === 'object' ? rawData : {};
        var data = {
            messages: Array.isArray(safeData.messages) ? safeData.messages : clone(INITIAL_DATA.messages),
            links: Array.isArray(safeData.links) ? safeData.links : clone(INITIAL_DATA.links),
            articles: Array.isArray(safeData.articles) ? safeData.articles : clone(INITIAL_DATA.articles),
            contact_messages: Array.isArray(safeData.contact_messages) ? safeData.contact_messages : [],
            stats: {
                total_views: Number(
                    safeData.stats && safeData.stats.total_views
                ) || INITIAL_DATA.stats.total_views
            },
            admin: {
                username: normalizeText(safeData.admin && safeData.admin.username) || INITIAL_DATA.admin.username,
                password: (safeData.admin && safeData.admin.password != null)
                    ? normalizeText(safeData.admin.password)
                    : null
            }
        };

        return data;
    }

    function readData() {
        var rawValue = window.localStorage.getItem(STORAGE_KEY);
        var parsedData = normalizeData(parseJson(rawValue));

        if (!rawValue) {
            saveData(parsedData);
        }

        return parsedData;
    }

    function saveData(data) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        return data;
    }

    function isAdminLoggedIn() {
        return (
            window.sessionStorage.getItem(SESSION_KEY) === '1' ||
            window.sessionStorage.getItem(REAL_SESSION_KEY) === '1'
        );
    }

    function setAdminLoggedIn(loggedIn) {
        if (loggedIn) {
            window.sessionStorage.setItem(SESSION_KEY, '1');
            window.sessionStorage.setItem(REAL_SESSION_KEY, '1');
        } else {
            window.sessionStorage.removeItem(SESSION_KEY);
            window.sessionStorage.removeItem(REAL_SESSION_KEY);
            window.sessionStorage.removeItem(ADMIN_CSRF_TOKEN_KEY);
        }
    }

    function requireAdmin() {
        if (!isAdminLoggedIn()) {
            return jsonResponse({ error: '请先登录管理员账户' }, 401);
        }

        return null;
    }

    function jsonResponse(payload, statusCode) {
        return Promise.resolve(
            new Response(JSON.stringify(payload), {
                status: statusCode || 200,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8'
                }
            })
        );
    }

    async function getRequestDetails(input, init) {
        var requestInit = init || {};
        var requestUrl;
        var requestMethod = 'GET';
        var rawBody = requestInit.body;

        if (input instanceof Request) {
            requestUrl = new URL(input.url, window.location.origin);
            requestMethod = requestInit.method || input.method || 'GET';
            if (rawBody === undefined && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
                try {
                    rawBody = await input.clone().text();
                } catch (error) {
                    rawBody = '';
                }
            }
        } else {
            requestUrl = new URL(String(input), window.location.origin);
            requestMethod = requestInit.method || 'GET';
        }

        return {
            url: requestUrl,
            method: String(requestMethod).toUpperCase(),
            body: parseRequestBody(rawBody)
        };
    }

    function parseRequestBody(rawBody) {
        if (!rawBody) {
            return {};
        }

        if (typeof rawBody === 'string') {
            return parseJson(rawBody);
        }

        if (rawBody instanceof FormData) {
            return Object.fromEntries(rawBody.entries());
        }

        if (typeof rawBody === 'object') {
            return rawBody;
        }

        return {};
    }

    function trackVisit() {
        try {
            var visitKey = VISIT_KEY_PREFIX + window.location.pathname;
            if (window.sessionStorage.getItem(visitKey)) {
                return;
            }

            var data = readData();
            data.stats.total_views += 1;
            saveData(data);
            window.sessionStorage.setItem(visitKey, '1');
        } catch (error) {
            // Ignore storage errors so the rest of the page can still run.
        }
    }

    function getArticles(data) {
        return sortByCreatedAtDesc(data.articles);
    }

    function getMessages(data) {
        return sortByCreatedAtDesc(data.messages);
    }

    function getLinks(data) {
        return sortByCreatedAtDesc(data.links);
    }

    function findItem(items, id) {
        var numericId = Number(id);
        return items.find(function (item) {
            return Number(item.id) === numericId;
        });
    }

    async function handleApiRequest(input, init) {
        if (!useLocalApi) {
            return null;
        }

        var request = await getRequestDetails(input, init);
        var pathname = request.url.pathname;

        if (request.url.origin !== window.location.origin || !pathname.startsWith('/api/')) {
            return null;
        }

        var data = readData();
        var body = request.body;
        var messageIdMatch = pathname.match(/^\/api\/messages\/(\d+)(?:\/status)?$/);
        var linkIdMatch = pathname.match(/^\/api\/links\/(\d+)(?:\/status)?$/);
        var articleIdMatch = pathname.match(/^\/api\/articles\/(\d+)$/);

        if (pathname === '/api/messages' && request.method === 'GET') {
            return jsonResponse(getMessages(data));
        }

        if (pathname === '/api/messages' && request.method === 'POST') {
            var name = normalizeText(body.name);
            var email = normalizeText(body.email);
            var message = normalizeText(body.message);

            if (!name || !email || !message) {
                return jsonResponse({ error: '请完整填写留言信息' }, 400);
            }

            var newMessage = {
                id: nextId(data.messages),
                name: name,
                email: email,
                message: message,
                created_at: now()
            };
            data.messages.unshift(newMessage);
            saveData(data);
            return jsonResponse(newMessage, 201);
        }

        if (messageIdMatch && request.method === 'DELETE') {
            var deleteMessageAuth = requireAdmin();
            if (deleteMessageAuth) {
                return deleteMessageAuth;
            }

            var messageId = Number(messageIdMatch[1]);
            data.messages = data.messages.filter(function (item) {
                return Number(item.id) !== messageId;
            });
            saveData(data);
            return jsonResponse({ id: messageId, deleted: true });
        }

        if (pathname === '/api/links' && request.method === 'GET') {
            return jsonResponse(getLinks(data));
        }

        if (pathname === '/api/links' && request.method === 'POST') {
            var siteName = normalizeText(body['site-name'] || body.site_name || body.siteName);
            var siteUrl = normalizeText(body['site-url'] || body.site_url || body.siteUrl);
            var siteDescription = normalizeText(body['site-description'] || body.site_description || body.siteDescription);
            var siteAvatar = normalizeText(body['site-avatar'] || body.site_avatar || body.siteAvatar);

            if (!siteName || !siteUrl || !siteDescription) {
                return jsonResponse({ error: '请完整填写友链信息' }, 400);
            }

            if (!isValidUrl(siteUrl)) {
                return jsonResponse({ error: '请输入有效的网站链接' }, 400);
            }

            if (siteAvatar && !siteAvatar.startsWith('data:image/')) {
                return jsonResponse({ error: '头像格式不合法' }, 400);
            }

            if (siteAvatar && siteAvatar.length > 1000000) {
                return jsonResponse({ error: '头像文件过大，请控制在 1MB 以内' }, 400);
            }

            var newLink = {
                id: nextId(data.links),
                site_name: siteName,
                site_url: siteUrl,
                site_description: siteDescription,
                site_avatar: siteAvatar,
                status: 'pending',
                created_at: now()
            };
            data.links.unshift(newLink);
            saveData(data);
            return jsonResponse(newLink, 201);
        }

        if (linkIdMatch && request.method === 'PUT') {
            var updateLinkAuth = requireAdmin();
            if (updateLinkAuth) {
                return updateLinkAuth;
            }

            var targetLink = findItem(data.links, linkIdMatch[1]);
            if (!targetLink) {
                return jsonResponse({ error: '友链不存在' }, 404);
            }

            targetLink.status = normalizeText(body.status) || targetLink.status;
            saveData(data);
            return jsonResponse(targetLink);
        }

        if (linkIdMatch && request.method === 'DELETE') {
            var deleteLinkAuth = requireAdmin();
            if (deleteLinkAuth) {
                return deleteLinkAuth;
            }

            var linkId = Number(linkIdMatch[1]);
            data.links = data.links.filter(function (item) {
                return Number(item.id) !== linkId;
            });
            saveData(data);
            return jsonResponse({ id: linkId, deleted: true });
        }

        if (pathname === '/api/articles' && request.method === 'GET') {
            return jsonResponse(getArticles(data));
        }

        if (pathname === '/api/articles' && request.method === 'POST') {
            var createArticleAuth = requireAdmin();
            if (createArticleAuth) {
                return createArticleAuth;
            }

            var title = normalizeText(body.title);
            var content = normalizeText(body.content);
            var category = normalizeText(body.category);

            if (!title || !content || !category) {
                return jsonResponse({ error: '请完整填写文章信息' }, 400);
            }

            var newArticle = {
                id: nextId(data.articles),
                title: title,
                content: content,
                category: category,
                created_at: now()
            };
            data.articles.unshift(newArticle);
            saveData(data);
            return jsonResponse(newArticle, 201);
        }

        if (articleIdMatch && request.method === 'GET') {
            var article = findItem(data.articles, articleIdMatch[1]);
            if (!article) {
                return jsonResponse({ error: '文章不存在' }, 404);
            }

            return jsonResponse(article);
        }

        if (articleIdMatch && request.method === 'PUT') {
            var updateArticleAuth = requireAdmin();
            if (updateArticleAuth) {
                return updateArticleAuth;
            }

            var targetArticle = findItem(data.articles, articleIdMatch[1]);
            if (!targetArticle) {
                return jsonResponse({ error: '文章不存在' }, 404);
            }

            targetArticle.title = normalizeText(body.title) || targetArticle.title;
            targetArticle.content = normalizeText(body.content) || targetArticle.content;
            targetArticle.category = normalizeText(body.category) || targetArticle.category;
            saveData(data);
            return jsonResponse(targetArticle);
        }

        if (articleIdMatch && request.method === 'DELETE') {
            var deleteArticleAuth = requireAdmin();
            if (deleteArticleAuth) {
                return deleteArticleAuth;
            }

            var articleId = Number(articleIdMatch[1]);
            data.articles = data.articles.filter(function (item) {
                return Number(item.id) !== articleId;
            });
            saveData(data);
            return jsonResponse({ id: articleId, deleted: true });
        }

        if (pathname === '/api/stats' && request.method === 'GET') {
            return jsonResponse({
                pending_links: data.links.filter(function (item) {
                    return item.status === 'pending';
                }).length,
                published_articles: data.articles.length,
                total_views: data.stats.total_views
            });
        }

        if (pathname === '/api/login' && request.method === 'POST') {
            var username = normalizeText(body.username);
            var password = normalizeText(body.password);
            var storedPassword = data.admin.password;

            // On first use the password field is null — accept only if a
            // non-empty password is presented, then persist it as the new credential.
            if (storedPassword === null || storedPassword === '') {
                if (!password) {
                    return jsonResponse({ success: false, message: '请先设置管理员密码' }, 401);
                }
                // Bootstrap: store whatever the user provides as the initial password.
                data.admin.username = username || data.admin.username;
                data.admin.password = password;
                saveData(data);
                setAdminLoggedIn(true);
                return jsonResponse({ success: true, message: '初始密码已设置，登录成功' });
            }

            if (username === data.admin.username && password === storedPassword) {
                setAdminLoggedIn(true);
                return jsonResponse({ success: true, message: '登录成功' });
            }

            return jsonResponse({ success: false, message: '用户名或密码错误' }, 401);
        }

        if (pathname === '/api/change-password' && request.method === 'POST') {
            var changePasswordAuth = requireAdmin();
            if (changePasswordAuth) {
                return changePasswordAuth;
            }

            var currentPassword = normalizeText(body.current_password);
            var newUsername = normalizeText(body.new_username);
            var newPassword = normalizeText(body.new_password);

            if (currentPassword !== data.admin.password) {
                return jsonResponse({ success: false, message: '当前密码不正确' }, 401);
            }

            if (!newUsername && !newPassword) {
                return jsonResponse({ success: false, message: '请至少修改一项' }, 400);
            }

            if (newUsername) {
                data.admin.username = newUsername;
            }
            if (newPassword) {
                data.admin.password = newPassword;
            }
            saveData(data);
            return jsonResponse({
                success: true,
                message: '账号信息修改成功',
                username: data.admin.username
            });
        }

        if (pathname === '/api/reset-admin-credentials' && request.method === 'POST') {
            // C-06 fix: require admin session before allowing credential reset
            var resetAuth = requireAdmin();
            if (resetAuth) {
                return resetAuth;
            }

            var resetConfirmText = normalizeText(body.confirm_text);
            if (resetConfirmText !== 'RESET_ADMIN') {
                return jsonResponse({ success: false, message: '确认口令不正确' }, 400);
            }

            data.admin.username = 'admin';
            data.admin.password = null; // force re-bootstrap on next login
            saveData(data);
            setAdminLoggedIn(false);

            return jsonResponse({
                success: true,
                message: '管理员账号已重置，请重新登录并设置新密码',
                username: 'admin'
            });
        }

        if (pathname === '/api/contact' && request.method === 'POST') {
            var contactName = normalizeText(body.name);
            var contactEmail = normalizeText(body.email);
            var contactSubject = normalizeText(body.subject);
            var contactMessage = normalizeText(body.message);

            if (!contactName || !contactEmail || !contactSubject || !contactMessage) {
                return jsonResponse({ error: '请完整填写联系表单' }, 400);
            }

            data.contact_messages.unshift({
                id: nextId(data.contact_messages),
                name: contactName,
                email: contactEmail,
                subject: contactSubject,
                message: contactMessage,
                created_at: now()
            });
            saveData(data);
            return jsonResponse({ success: true, message: '消息已发送' }, 201);
        }

        if (pathname === '/api/contact' && request.method === 'GET') {
            var contactAuth = requireAdmin();
            if (contactAuth) {
                return contactAuth;
            }

            return jsonResponse(sortByCreatedAtDesc(data.contact_messages));
        }

        return jsonResponse({ error: '接口不存在' }, 404);
    }

    function isInjectedTrackerRequest(url) {
        if (!url) {
            return false;
        }

        var host = String(url.hostname || '').toLowerCase();
        var pathname = String(url.pathname || '').toLowerCase();

        // 某些浏览器插件会向页面注入统计上报请求，这里在开发环境静默吞掉以减少调试噪声。
        if (pathname.indexOf('/hybridaction/') === 0) {
            return true;
        }

        if (host === 'www.daxuesoutijiang.com' && pathname.indexOf('/api/log') === 0) {
            return true;
        }

        return false;
    }

    window.fetch = async function (input, init) {
        var request = await getRequestDetails(input, init);
        if (isInjectedTrackerRequest(request.url)) {
            return new Response(null, { status: 204 });
        }

        var handledResponse = await handleApiRequest(input, init);
        if (handledResponse) {
            return handledResponse;
        }

        return nativeFetch(input, init);
    };

    window.SiteLocalApi = {
        CONFIG: CONFIG,
        isAdminLoggedIn: isAdminLoggedIn,
        isUsingLocalApi: function () {
            return useLocalApi;
        },
        logout: async function () {
            var csrfToken = window.sessionStorage.getItem(CONFIG.ADMIN_CSRF_TOKEN_KEY);
            if (!useLocalApi) {
                try {
                    var headers = {
                        'Content-Type': 'application/json'
                    };
                    if (csrfToken) {
                        headers['X-CSRF-Token'] = csrfToken;
                    }

                    await nativeFetch(CONFIG.API_BASE_URL + '/logout', {
                        method: 'POST',
                        headers: headers
                    });
                } catch (error) {
                    // Ignore logout network errors and continue local cleanup.
                }
            }
            setAdminLoggedIn(false);
        },
        setApiMode: function (mode) {
            var normalizedMode = String(mode || '').toLowerCase();
            if (normalizedMode !== 'local' && normalizedMode !== 'server') {
                return false;
            }

            if (normalizedMode === 'local' && !isLocalDevHost()) {
                return false;
            }

            window.localStorage.setItem(CONFIG.API_MODE_KEY, normalizedMode);
            return true;
        },
        reset: function () {
            saveData(clone(INITIAL_DATA));
            setAdminLoggedIn(false);
        },
        getData: function () {
            return clone(readData());
        },
        getConfig: function () {
            return clone(CONFIG);
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        var logoutLink = document.querySelector('.logout');
        if (logoutLink) {
            logoutLink.addEventListener('click', async function (event) {
                event.preventDefault();
                await window.SiteLocalApi.logout();
                if (window.location.pathname.indexOf('/pages/') === 0) {
                    window.location.href = 'admin.html';
                } else {
                    window.location.href = '/pages/admin.html';
                }
            });
        }
    });

    if (useLocalApi) {
        trackVisit();
    }
})();
