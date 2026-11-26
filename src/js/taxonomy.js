(function () {
    'use strict';

    const view = document.body.getAttribute('data-taxonomy-view');
    if (!view) return;

    const $ = (sel) => document.querySelector(sel);
    const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
    const parseDate = (value) => {
        if (!value) return null;
        const date = new Date(String(value).replace(' ', 'T'));
        return Number.isNaN(date.getTime()) ? null : date;
    };
    const formatDate = (value) => (typeof window.formatLocalDate === 'function'
        ? window.formatLocalDate(value)
        : String(value || '').slice(0, 10));
    const articleTags = (article) => {
        const raw = Array.isArray(article.tags) ? article.tags : String(article.tags || '').split(',');
        const tags = raw.map((tag) => String(tag || '').trim()).filter(Boolean);
        if (!tags.length && article.category) tags.push(String(article.category).trim());
        return [...new Set(tags)];
    };
    const categoryOf = (article) => String(article.category || '未分类').trim() || '未分类';
    const countBy = (articles, keyFn) => {
        const map = new Map();
        articles.forEach((article) => {
            keyFn(article).forEach((key) => {
                if (!key) return;
                map.set(key, (map.get(key) || 0) + 1);
            });
        });
        return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'));
    };
    const truncate = (text, max) => {
        const value = String(text || '');
        return value.length > max ? value.slice(0, max - 1) + '…' : value;
    };
    const palette = ['#6ea8fe', '#a78bfa', '#34d399', '#f472b6', '#fbbf24', '#22d3ee', '#fb7185', '#93c5fd', '#c084fc', '#4ade80'];
    let articles = [];

    const showError = (message) => {
        const target = $('#taxonomy-summary') || $('#stats-summary') || $('#rss-feed');
        if (target) target.textContent = '数据加载失败：' + message;
    };

    const renderCategories = () => {
        const entries = countBy(articles, (article) => [categoryOf(article)]);
        const summary = $('#taxonomy-summary');
        const cloud = $('#taxonomy-cloud');
        if (summary) summary.innerHTML = '共 <strong>' + entries.length + '</strong> 个分类 · <strong>' + articles.length + '</strong> 篇文章';
        if (!cloud) return;
        cloud.className = 'taxonomy-cloud taxonomy-cloud--categories';
        cloud.innerHTML = entries.length
            ? entries.map(([name, count]) => '<a class="taxonomy-chip" href="/src/pages/articles.html?category=' + encodeURIComponent(name) + '"><span class="taxonomy-hash">#</span><span class="taxonomy-name">' + esc(name) + '</span><em>' + count + '</em></a>').join('')
            : '<div class="taxonomy-empty">// 暂无分类数据</div>';
    };

    const renderTags = () => {
        const entries = countBy(articles, articleTags);
        const summary = $('#taxonomy-summary');
        const cloud = $('#taxonomy-cloud');
        if (summary) summary.innerHTML = '共 <strong>' + entries.length + '</strong> 个标签 · <strong>' + articles.length + '</strong> 篇文章';
        if (!cloud) return;
        cloud.className = 'taxonomy-cloud taxonomy-cloud--tags';
        cloud.innerHTML = entries.length
            ? entries.map(([name, count]) => '<a class="taxonomy-chip" href="/src/pages/articles.html?tag=' + encodeURIComponent(name) + '"><span class="taxonomy-hash">#</span><span class="taxonomy-name">' + esc(name) + '</span><em>' + count + '</em></a>').join('')
            : '<div class="taxonomy-empty">// 暂无标签数据</div>';
    };

    const monthKey = (date) => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    const monthLabel = (date) => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');

    const renderPublishChart = () => {
        const mount = $('#chart-publish');
        if (!mount) return;
        const dates = articles.map((a) => parseDate(a.created_at)).filter(Boolean).sort((a, b) => a - b);
        if (!dates.length) { mount.innerHTML = '<div class="taxonomy-empty">// 暂无发布时间数据</div>'; return; }
        const latest = dates[dates.length - 1];
        const months = [];
        for (let i = 11; i >= 0; i -= 1) {
            const date = new Date(latest.getFullYear(), latest.getMonth() - i, 1);
            months.push({ key: monthKey(date), label: monthLabel(date) });
        }
        const values = months.map((month) => articles.filter((article) => {
            const date = parseDate(article.created_at);
            return date && monthKey(date) === month.key;
        }).length);

        const W = 980; const H = 300; const PL = 48; const PR = 22; const PT = 24; const PB = 42;
        const innerW = W - PL - PR; const innerH = H - PT - PB;
        const max = Math.max(...values, 1);
        const yMax = Math.max(4, Math.ceil(max / 4) * 4);
        const x = (index) => PL + (values.length <= 1 ? innerW / 2 : index * innerW / (values.length - 1));
        const y = (value) => PT + innerH - (value / yMax) * innerH;
        const linePath = values.map((value, index) => (index ? 'L' : 'M') + x(index).toFixed(1) + ' ' + y(value).toFixed(1)).join(' ');
        const areaPath = linePath + ' L ' + x(values.length - 1).toFixed(1) + ' ' + (PT + innerH) + ' L ' + x(0).toFixed(1) + ' ' + (PT + innerH) + ' Z';
        const grid = [0, 1, 2, 3, 4].map((step) => {
            const value = yMax * step / 4;
            const yy = y(value).toFixed(1);
            return '<line x1="' + PL + '" y1="' + yy + '" x2="' + (W - PR) + '" y2="' + yy + '" class="chart-grid-line"></line>' +
                '<text x="' + (PL - 8) + '" y="' + (Number(yy) + 3) + '" text-anchor="end" class="chart-axis">' + value + '</text>';
        }).join('');
        const labels = months.map((month, index) => {
            if (index % 2 !== 0 && index !== months.length - 1) return '';
            return '<text x="' + x(index).toFixed(1) + '" y="' + (H - 14) + '" text-anchor="middle" class="chart-axis">' + month.label + '</text>';
        }).join('');
        const dots = values.map((value, index) => '<circle cx="' + x(index).toFixed(1) + '" cy="' + y(value).toFixed(1) + '" r="2.6" class="chart-dot"><title>' + months[index].label + ' · ' + value + ' 篇</title></circle>').join('');

        mount.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="文章发布统计图">' +
            '<defs><linearGradient id="publishFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6ea8fe" stop-opacity="0.42"></stop><stop offset="100%" stop-color="#6ea8fe" stop-opacity="0"></stop></linearGradient></defs>' +
            grid +
            '<path d="' + areaPath + '" fill="url(#publishFill)" class="chart-area"></path>' +
            '<path d="' + linePath + '" class="chart-line"></path>' +
            dots + labels +
            '</svg>';
    };

    const renderTagChart = () => {
        const mount = $('#chart-tags');
        if (!mount) return;
        const entries = countBy(articles, articleTags).slice(0, 10);
        if (!entries.length) { mount.innerHTML = '<div class="taxonomy-empty">// 暂无标签数据</div>'; return; }
        const W = 980; const H = 320; const PL = 42; const PR = 20; const PT = 30; const PB = 64;
        const innerW = W - PL - PR; const innerH = H - PT - PB;
        const max = Math.max(entries[0][1], 1);
        const yMax = Math.max(4, Math.ceil(max / 4) * 4);
        const slot = innerW / entries.length;
        const barWidth = Math.min(46, slot * 0.52);
        const bars = entries.map(([name, count], index) => {
            const cx = PL + slot * index + slot / 2;
            const barHeight = Math.max(2, (count / max) * innerH);
            const x = cx - barWidth / 2;
            const yBar = PT + innerH - barHeight;
            return '<rect x="' + x.toFixed(1) + '" y="' + yBar.toFixed(1) + '" width="' + barWidth.toFixed(1) + '" height="' + barHeight.toFixed(1) + '" rx="4" class="chart-bar"><title>' + esc(name) + ' · ' + count + ' 篇</title></rect>' +
                '<text x="' + cx.toFixed(1) + '" y="' + (yBar - 7).toFixed(1) + '" text-anchor="middle" class="chart-value">' + count + '</text>' +
                '<text x="' + cx.toFixed(1) + '" y="' + (PT + innerH + 18) + '" text-anchor="middle" class="chart-axis">' + esc(truncate(name, 9)) + '</text>';
        }).join('');
        const grid = [0, 1, 2, 3, 4].map((step) => {
            const value = yMax * step / 4;
            const yy = (PT + innerH - (value / yMax) * innerH).toFixed(1);
            return '<line x1="' + PL + '" y1="' + yy + '" x2="' + (W - PR) + '" y2="' + yy + '" class="chart-grid-line"></line>' +
                '<text x="' + (PL - 8) + '" y="' + (Number(yy) + 3) + '" text-anchor="end" class="chart-axis">' + Math.round(value) + '</text>';
        }).join('');
        mount.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Top 10 标签统计图">' +
            '<defs><linearGradient id="tagBarFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#34d399" stop-opacity="0.95"></stop><stop offset="100%" stop-color="#6ea8fe" stop-opacity="0.45"></stop></linearGradient></defs>' +
            grid + bars + '</svg>';
    };

    const renderCategoryDonut = () => {
        const mount = $('#chart-categories');
        if (!mount) return;
        const entries = countBy(articles, (article) => [categoryOf(article)]);
        const total = entries.reduce((sum, entry) => sum + entry[1], 0) || 1;
        if (!entries.length) { mount.innerHTML = '<div class="taxonomy-empty">// 暂无分类数据</div>'; return; }
        const radius = 78;
        const circumference = 2 * Math.PI * radius;
        let offset = 0;
        const segments = entries.map(([name, count], index) => {
            const dash = count / total * circumference;
            const segment = '<circle cx="110" cy="110" r="' + radius + '" fill="none" stroke="' + palette[index % palette.length] + '" stroke-width="26" stroke-dasharray="' + dash.toFixed(2) + ' ' + (circumference - dash).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 110 110)"><title>' + esc(name) + ' · ' + count + ' 篇</title></circle>';
            offset += dash;
            return segment;
        }).join('');
        const legend = entries.map(([name, count], index) => '<li><span class="donut-dot" style="background:' + palette[index % palette.length] + '"></span><span class="donut-name">' + esc(name) + '</span><em>' + count + '</em></li>').join('');
        mount.innerHTML = '<div class="donut-wrap"><svg class="donut-svg" viewBox="0 0 220 220" role="img" aria-label="文章分类统计图">' +
            '<circle cx="110" cy="110" r="' + radius + '" fill="none" stroke="rgba(255,255,255,0.055)" stroke-width="26"></circle>' +
            segments +
            '<text x="110" y="106" text-anchor="middle" class="donut-total">' + total + '</text>' +
            '<text x="110" y="126" text-anchor="middle" class="donut-caption">篇文章</text>' +
            '</svg><ul class="donut-legend">' + legend + '</ul></div>';
    };

    const renderStats = () => {
        const categories = countBy(articles, (article) => [categoryOf(article)]);
        const tags = countBy(articles, articleTags);
        const years = new Set(articles.map((article) => {
            const date = parseDate(article.created_at);
            return date ? String(date.getFullYear()) : '';
        }).filter(Boolean));
        const summary = $('#stats-summary');
        if (summary) {
            summary.innerHTML = '<span>文章 <strong>' + articles.length + '</strong></span>' +
                '<span>分类 <strong>' + categories.length + '</strong></span>' +
                '<span>标签 <strong>' + tags.length + '</strong></span>' +
                '<span>年份 <strong>' + years.size + '</strong></span>';
        }
        renderPublishChart();
        renderTagChart();
        renderCategoryDonut();
    };

    const renderRss = () => {
        const feed = $('#rss-feed');
        const feedUrl = window.location.origin + '/rss.xml';
        const encoded = encodeURIComponent(feedUrl);
        const services = {
            feedly: 'https://feedly.com/i/subscription/feed/' + encoded,
            inoreader: 'https://www.inoreader.com/?add_feed=' + encoded,
            newsblur: 'https://newsblur.com/?url=' + encoded,
            follow: 'https://app.follow.is/share/feeds/' + encoded
        };
        document.querySelectorAll('[data-rss-service]').forEach((link) => {
            const service = link.getAttribute('data-rss-service');
            if (services[service]) {
                link.href = services[service];
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
        });
        const urlEl = $('#rss-url');
        if (urlEl) urlEl.textContent = feedUrl;
        const copyBtn = $('#rss-copy');
        if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(feedUrl);
                    copyBtn.textContent = '已复制';
                    setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1600);
                } catch (error) {
                    copyBtn.textContent = '复制失败';
                }
            });
        }
        if (!feed) return;
        const sorted = articles.slice().sort((a, b) => {
            const ta = parseDate(a.created_at); const tb = parseDate(b.created_at);
            return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
        });
        feed.innerHTML = sorted.length
            ? sorted.map((article) => {
                const tags = articleTags(article).map((tag) => '<span class="rss-tag">#' + esc(tag) + '</span>').join('');
                return '<a class="rss-item" href="/post/' + encodeURIComponent(article.id) + '">' +
                    '<div class="rss-item-head"><h2>' + esc(article.title) + '</h2><time>' + formatDate(article.created_at) + '</time></div>' +
                    '<div class="rss-item-meta"><span class="rss-category">' + esc(categoryOf(article)) + '</span>' + tags + '</div>' +
                    '</a>';
            }).join('')
            : '<div class="taxonomy-empty">// 暂无文章</div>';
    };

    fetch('/api/articles?limit=50', { headers: { Accept: 'application/json' } })
        .then((response) => {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
        })
        .then((data) => {
            articles = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : []);
            if (view === 'categories') renderCategories();
            else if (view === 'tags') renderTags();
            else if (view === 'stats') renderStats();
            else if (view === 'rss') renderRss();
        })
        .catch((error) => showError(error && error.message ? error.message : '未知错误'));
})();
