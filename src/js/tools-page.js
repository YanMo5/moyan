/* ── Tool library ──────────────────────────────────────────────────────── */

(function () {
    'use strict';

    const grid = document.getElementById('tools-grid');
    const empty = document.getElementById('tools-empty');
    const search = document.getElementById('tool-search');
    const cats = document.getElementById('tool-categories');
    const countEl = document.getElementById('tool-count');
    const catCountEl = document.getElementById('category-count');

    if (!grid || !search || !cats) return;

    let data = { tools: [], categories: ['全部'] };
    let activeCategory = '全部';
    let query = '';

    const escapeHtml = (value) => String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const normalized = (value) => String(value || '').toLowerCase();

    function downloadInfo(tool) {
        const panUrl = String(tool.panUrl || '').trim();
        const officialUrl = String(tool.downloadUrl || '').trim();
        const isPan = Boolean(panUrl);
        const raw = panUrl || officialUrl;
        // 只允许 http(s) 链接，避免配置文件被写入 javascript: 等危险协议
        const href = /^https?:\/\//i.test(raw) ? raw : '';
        return {
            href,
            label: isPan ? '网盘下载' : '官方下载',
            source: isPan ? 'NETDISK' : (tool.source || 'SOURCE')
        };
    }

    function cardHtml(tool) {
        const dl = downloadInfo(tool);
        const disabled = !dl.href;
        const code = String(tool.panCode || '').trim();
        return [
            '<article class="tool-card" data-id="' + escapeHtml(tool.id) + '">',
            '  <div class="tool-card-top">',
            '    <span class="tool-glyph" data-tone="' + escapeHtml(tool.tone || 'blue') + '" aria-hidden="true">' + escapeHtml(tool.glyph || (tool.name || '?').slice(0, 2).toUpperCase()) + '</span>',
            '    <div class="tool-card-name">',
            '      <h3>' + escapeHtml(tool.name) + '</h3>',
            '      <span class="tool-version">' + escapeHtml(tool.version || 'latest') + '</span>',
            '    </div>',
            '  </div>',
            '  <p class="tool-card-description">' + escapeHtml(tool.description || '暂无描述。') + '</p>',
            '  <div class="tool-card-meta">',
            '    <span>' + escapeHtml(tool.category || '未分类') + '</span>',
            '    <span>' + escapeHtml(dl.source) + '</span>',
            '  </div>',
            '  <div class="tool-card-meta">',
            '    <span>' + escapeHtml(tool.size || '—') + '</span>',
            '    <span>' + escapeHtml(tool.updatedAt || '—') + '</span>',
            '  </div>',
            code ? '  <button type="button" class="tool-code" data-code="' + escapeHtml(code) + '">提取码 ' + escapeHtml(code) + ' · 复制</button>' : '',
            disabled
                ? '  <span class="tool-download is-disabled">待上传</span>'
                : '  <a class="tool-download" href="' + escapeHtml(dl.href) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(dl.label) + ' ↗</a>',
            '</article>'
        ].filter(Boolean).join('\n');
    }

    function visibleTools() {
        return data.tools.filter((tool) => {
            const categoryOk = activeCategory === '全部' || tool.category === activeCategory;
            const haystack = normalized([tool.name, tool.description, tool.category, tool.version, tool.source].join(' '));
            return categoryOk && (!query || haystack.includes(query));
        });
    }

    function render() {
        const tools = visibleTools();
        grid.innerHTML = tools.length ? tools.map(cardHtml).join('\n') : '';
        grid.setAttribute('aria-busy', 'false');
        empty.hidden = tools.length > 0;
        countEl.textContent = String(data.tools.length).padStart(2, '0');
        catCountEl.textContent = String(Math.max(0, (data.categories || []).filter((c) => c !== '全部').length)).padStart(2, '0');
    }

    function renderCategories() {
        cats.innerHTML = (data.categories || ['全部']).map((category) => {
            const active = category === activeCategory ? ' is-active' : '';
            return '<button type="button" class="tool-category' + active + '" data-category="' + escapeHtml(category) + '">' + escapeHtml(category) + '</button>';
        }).join('');
    }

    cats.addEventListener('click', (event) => {
        const button = event.target.closest('.tool-category');
        if (!button) return;
        activeCategory = button.dataset.category || '全部';
        renderCategories();
        render();
    });

    search.addEventListener('input', () => {
        query = normalized(search.value.trim());
        render();
    });

    grid.addEventListener('click', async (event) => {
        const button = event.target.closest('.tool-code');
        if (!button) return;
        const code = button.dataset.code || '';
        try {
            await navigator.clipboard.writeText(code);
            const old = button.textContent;
            button.textContent = '已复制 ✓';
            window.setTimeout(() => { button.textContent = old; }, 1400);
        } catch (error) {
            button.textContent = code;
        }
    });

    const DEFAULT_CATEGORIES = ['计算机网络', '网络安全', '开发环境', '网络代理', '实用工具', '移动应用'];

    function normalizePayload(payload) {
        const tools = Array.isArray(payload) ? payload : (Array.isArray(payload && payload.tools) ? payload.tools : []);
        const sourceCategories = Array.isArray(payload && payload.categories) ? payload.categories : [];
        const categories = ['全部'];
        [...DEFAULT_CATEGORIES, ...sourceCategories, ...tools.map((tool) => tool.category)].forEach((category) => {
            const value = String(category || '').trim();
            if (value && !categories.includes(value)) categories.push(value);
        });
        return { tools, categories };
    }

    async function readJson(url) {
        const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
    }

    async function loadTools() {
        try {
            data = normalizePayload(await readJson('/api/tools'));
        } catch (apiError) {
            try {
                data = normalizePayload(await readJson('/src/data/tools.json'));
            } catch (staticError) {
                grid.innerHTML = '<div class="tools-empty"><span aria-hidden="true">◌</span><h2>工具数据加载失败</h2><p>请检查后端 /api/tools 或 src/data/tools.json，然后刷新页面重试。</p></div>';
                grid.setAttribute('aria-busy', 'false');
                console.error('[tools]', apiError, staticError);
                return;
            }
        }
        renderCategories();
        render();
    }

    loadTools();
})();
