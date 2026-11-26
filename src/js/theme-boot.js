/**
 * theme-boot.js — YanMo 主题引擎
 * ---------------------------------------------------------------
 * 职责（纯逻辑，无 UI）：
 *   1. 皮肤（lumina / cyber）、明暗（dark / light）、调色板、字体模式的
 *      读取 / 校验 / 持久化
 *   2. 首屏同步注入 CSS 变量与 <html> 属性，避免闪烁（FOUC）
 *   3. 把状态变化广播给 UI 层（palette-manager.js）
 *
 * 之所以独立成文件：升级前每个页面都在 <head> 里内联了一份 1.3KB 的防闪烁
 * 脚本（8 份副本，彼此已经出现细微差异），无法缓存、无法测试、难以维护。
 *
 * 对外 API：window.YanMoTheme
 */
(function (window, document) {
    'use strict';

    var STORAGE = {
        skin: 'yanmo.site.skin',
        scheme: 'yanmo.site.scheme',
        bg: 'yanmo.site.bg-color',
        text: 'yanmo.site.text-color',
        font: 'yanmo.site.font-mode'
    };

    /* 页面间交接标记：点击站内链接时写入，新页面在首屏绘制前读取 */
    var NAV_TRANSITION_KEY = 'yanmo.site.nav-transition';

    var PRESETS = {
        lumina: {
            label: '现代',
            dark: { bg: '#0b0f17', text: '#e8eef9' },
            light: { bg: '#f6f8fc', text: '#101828' }
        },
        cyber: {
            label: '赛博',
            dark: { bg: '#0b0f17', text: '#e8eef9' },
            light: { bg: '#f6f8fc', text: '#101828' }
        }
    };

    var SCHEME_LABELS = { dark: '暗色', light: '亮色' };

    /* 旧版本把默认文字色写进 localStorage，升级后应视为「未设置」 */
    var LEGACY_TEXT_DEFAULT = '#e0e8f0';

    var root = document.documentElement;
    var subscribers = [];

    /* ── 存储工具 ────────────────────────────────────────────────────── */

    function read(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function write(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (e) {
            /* 隐私模式 / 存储已满时静默降级 */
        }
    }

    function remove(key) {
        try {
            window.localStorage.removeItem(key);
        } catch (e) { /* noop */ }
    }

    function readJSON(key, fallback) {
        var raw = read(key);
        if (!raw) return fallback;
        try {
            var value = JSON.parse(raw);
            return value === null || value === undefined ? fallback : value;
        } catch (e) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        write(key, JSON.stringify(value));
    }

    /* 兼容三种历史格式：字符串、{cyber,dark,light} 对象、非法值 */
    function unpick(value) {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
            return value.cyber || value.dark || value.light || null;
        }
        return null;
    }

    function normalizeHex(raw) {
        if (typeof raw !== 'string') return null;
        var value = raw.trim().toLowerCase();
        if (!value) return null;
        if (value.charAt(0) !== '#') value = '#' + value;
        if (/^#[0-9a-f]{3}$/.test(value)) {
            value = '#' + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
        }
        return /^#[0-9a-f]{6}$/.test(value) ? value : null;
    }

    function hexToRgb(hex) {
        var h = hex.replace('#', '');
        return {
            r: parseInt(h.substring(0, 2), 16),
            g: parseInt(h.substring(2, 4), 16),
            b: parseInt(h.substring(4, 6), 16)
        };
    }

    function rgba(hex, alpha) {
        var c = hexToRgb(hex);
        return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
    }

    function luminance(hex) {
        var c = hexToRgb(hex);
        return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    }

    /* 颜色按「皮肤 + 明暗」分槽存储，互不污染 */
    function colorKey(kind, skin, scheme) {
        return STORAGE[kind] + '.' + skin + '.' + scheme;
    }

    /* ── 状态解析 ────────────────────────────────────────────────────── */

    var state = {
        skin: 'lumina',
        scheme: 'dark',
        bg: '',
        text: '',
        fontMode: 'normal'
    };

    function resolveSkin() {
        var stored = unpick(readJSON(STORAGE.skin, null)) || '';
        var value = String(stored).trim().toLowerCase();
        return Object.prototype.hasOwnProperty.call(PRESETS, value) ? value : 'lumina';
    }

    function resolveScheme() {
        var value = String(readJSON(STORAGE.scheme, '') || '').trim().toLowerCase();
        return value === 'light' ? 'light' : 'dark';
    }

    function resolveFontMode() {
        return read(STORAGE.font) === 'cyberpunk' ? 'cyberpunk' : 'normal';
    }

    function preset(skin, scheme) {
        var group = PRESETS[skin] || PRESETS.lumina;
        return group[scheme] || group.dark;
    }

    function resolveColor(kind, skin, scheme) {
        var scoped = normalizeHex(unpick(readJSON(colorKey(kind, skin, scheme), null)));
        if (scoped) {
            /* 清理旧赛博默认值，避免升级后继续恢复黑底青字的错位旧皮肤。 */
            var oldCyberDefault = (kind === 'bg' && scoped === '#05050a') ||
                (kind === 'text' && scoped === '#00ffff');
            if (!(skin === 'cyber' && oldCyberDefault)) return scoped;
            remove(colorKey(kind, skin, scheme));
        }

        /* 迁移：cyber 暗色的旧键位没有作用域后缀，读一次并搬进新键 */
        if (skin === 'cyber' && scheme === 'dark') {
            var legacy = normalizeHex(unpick(readJSON(STORAGE[kind], null)));
            if (legacy && legacy !== LEGACY_TEXT_DEFAULT) {
                writeJSON(colorKey(kind, skin, scheme), legacy);
                return legacy;
            }
            if (legacy === LEGACY_TEXT_DEFAULT) remove(STORAGE[kind]);
        }

        return preset(skin, scheme)[kind];
    }

    /* ── 变量注入 ────────────────────────────────────────────────────── */

    function setVar(name, value) {
        root.style.setProperty(name, value);
    }

    function applyChannels(name, hex) {
        var c = hexToRgb(hex);
        setVar('--' + name, hex);
        setVar('--' + name + '-r', String(c.r));
        setVar('--' + name + '-g', String(c.g));
        setVar('--' + name + '-b', String(c.b));
    }

    /* 让遗留的 --theme-* / --p-* / --surface-* 令牌跟随调色板 */
    function applyDerivedBackground(hex) {
        var c = hexToRgb(hex);
        var delta = luminance(hex) > 0.5 ? -8 : 8;
        var shade = 'rgb(' + Math.max(0, Math.min(255, c.r + delta)) + ',' +
            Math.max(0, Math.min(255, c.g + delta)) + ',' +
            Math.max(0, Math.min(255, c.b + delta)) + ')';

        setVar('--theme-bg', hex);
        setVar('--theme-bg-2', shade);
        setVar('--theme-surface', rgba(hex, 0.92));
        setVar('--theme-surface-hover', rgba(hex, 0.98));
        setVar('--cyber-dark', hex);
        setVar('--terminal-bg', hex);
        setVar('--card-bg', rgba(hex, 0.92));
        setVar('--card-bg-hover', rgba(hex, 0.98));
        setVar('--cyber-card-bg', rgba(hex, 0.92));
        setVar('--p-bg', hex);
        setVar('--p-bg-2', shade);
        setVar('--p-card', rgba(hex, 0.92));
        setVar('--p-card-hover', rgba(hex, 0.98));
        setVar('--surface-98', rgba(hex, 0.98));
        setVar('--surface-95', rgba(hex, 0.95));
        setVar('--surface-90', rgba(hex, 0.90));
        setVar('--surface-85', rgba(hex, 0.85));
        setVar('--surface-80', rgba(hex, 0.80));
        setVar('--surface-70', rgba(hex, 0.70));
        setVar('--surface-20', rgba(hex, 0.20));
        setVar('--surface-10', rgba(hex, 0.10));
    }

    function applyDerivedText(hex) {
        var c = hexToRgb(hex);
        var muted = rgba(hex, 0.65);

        setVar('--primary-color', hex);
        setVar('--primary-color-r', String(c.r));
        setVar('--primary-color-g', String(c.g));
        setVar('--primary-color-b', String(c.b));
        setVar('--p-primary', hex);
        setVar('--p-primary-r', String(c.r));
        setVar('--p-primary-g', String(c.g));
        setVar('--p-primary-b', String(c.b));
        setVar('--theme-text', hex);
        setVar('--theme-text-muted', muted);
        setVar('--text-secondary', muted);
        setVar('--text-muted', muted);
        setVar('--p-text', hex);
        setVar('--p-text-muted', muted);
        setVar('--neon-cyan', hex);
        setVar('--cyber-cyan', hex);
    }

    /* 两种皮肤共用稳定的 Lumina 布局，避免赛博模式回退到旧版错位骨架。 */
    function toggleSkinStylesheet(skin) {
        var link = document.getElementById('skin-stylesheet');
        if (!link) return;
        var shouldDisable = false;
        if (link.disabled !== shouldDisable) link.disabled = shouldDisable;
    }

    function syncFontMode(mode) {
        var isCyberFont = mode === 'cyberpunk';
        root.classList.toggle('cyberpunk-mode', isCyberFont);
        if (document.body) document.body.classList.toggle('cyberpunk-mode', isCyberFont);
    }

    function syncThemeColorMeta() {
        var meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', 'theme-color');
            (document.head || root).appendChild(meta);
        }
        meta.setAttribute('content', state.bg);
    }

    /* ── 应用 + 广播 ─────────────────────────────────────────────────── */

    function snapshot() {
        return {
            skin: state.skin,
            scheme: state.scheme,
            skinLabel: PRESETS[state.skin].label,
            schemeLabel: SCHEME_LABELS[state.scheme],
            bg: state.bg,
            text: state.text,
            fontMode: state.fontMode,
            defaults: preset(state.skin, state.scheme)
        };
    }

    function notify(source) {
        var detail = snapshot();
        detail.source = source || 'api';
        subscribers.slice().forEach(function (fn) {
            try {
                fn(detail);
            } catch (e) {
                /* 单个订阅者出错不应中断渲染 */
                if (window.console && console.error) console.error('[theme]', e);
            }
        });
        try {
            document.dispatchEvent(new CustomEvent('yanmo:themechange', { detail: detail }));
        } catch (e) { /* 老浏览器没有 CustomEvent 构造器 */ }
    }

    function apply(source) {
        var skin = state.skin;
        var scheme = state.scheme;

        // 两种皮肤共用 Lumina 布局：data-skin 固定为 lumina，让 aurora.css 生效；
        // 赛博差异由 data-visual=cyber 单独提供，避免回退到旧版错位骨架。
        root.setAttribute('data-skin', 'lumina');
        root.setAttribute('data-visual', skin === 'cyber' ? 'cyber' : 'lumina');
        root.setAttribute('data-scheme', scheme);
        root.style.colorScheme = scheme;
        /* cyber-mode 是遗留 CSS 的结构性基类，两种皮肤都保留。 */
        root.classList.add('cyber-mode');
        root.classList.add('lumina-mode');
        if (document.body) document.body.classList.add('cyber-mode');

        applyChannels('bg-color', state.bg);
        applyChannels('text-color', state.text);
        applyDerivedBackground(state.bg);
        applyDerivedText(state.text);
        toggleSkinStylesheet(skin);
        syncFontMode(state.fontMode);
        syncThemeColorMeta();
        notify(source);
    }

    function adoptColors() {
        state.bg = resolveColor('bg', state.skin, state.scheme);
        state.text = resolveColor('text', state.skin, state.scheme);
    }

    function persist() {
        writeJSON(STORAGE.skin, state.skin);
        writeJSON(STORAGE.scheme, state.scheme);
    }

    /* ── 公共 API ────────────────────────────────────────────────────── */

    function setSkin(skin) {
        var next = String(skin || '').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(PRESETS, next) || next === state.skin) return;
        state.skin = next;
        adoptColors();
        persist();
        apply('skin');
    }

    function setScheme(scheme) {
        var next = scheme === 'light' ? 'light' : 'dark';
        if (next === state.scheme) return;
        state.scheme = next;
        adoptColors();
        persist();
        apply('scheme');
    }

    function toggleScheme() {
        setScheme(state.scheme === 'dark' ? 'light' : 'dark');
    }

    function toggleSkin() {
        setSkin(state.skin === 'lumina' ? 'cyber' : 'lumina');
    }

    function setColor(kind, hex) {
        if (kind !== 'bg' && kind !== 'text') return false;
        var value = normalizeHex(hex);
        if (!value) return false;
        state[kind] = value;
        writeJSON(colorKey(kind, state.skin, state.scheme), value);
        apply('color');
        return true;
    }

    function resetColor(kind) {
        if (kind !== 'bg' && kind !== 'text') return;
        remove(colorKey(kind, state.skin, state.scheme));
        if (state.skin === 'cyber' && state.scheme === 'dark') remove(STORAGE[kind]);
        state[kind] = preset(state.skin, state.scheme)[kind];
        apply('color');
    }

    function setFontMode(mode) {
        state.fontMode = mode === 'cyberpunk' ? 'cyberpunk' : 'normal';
        write(STORAGE.font, state.fontMode);
        syncFontMode(state.fontMode);
        notify('font');
    }

    function toggleFontMode() {
        setFontMode(state.fontMode === 'cyberpunk' ? 'normal' : 'cyberpunk');
    }

    function subscribe(fn) {
        if (typeof fn !== 'function') return function () {};
        subscribers.push(fn);
        fn(snapshot());
        return function () {
            subscribers = subscribers.filter(function (item) { return item !== fn; });
        };
    }

    function getState() {
        return snapshot();
    }

    /* ── 无障碍：跳过导航链接 ─────────────────────────────────────────── */

    function mountSkipLink() {
        var main = document.querySelector('main') || document.querySelector('#main-content');
        if (!main) return;
        if (!main.id) main.id = 'main-content';
        if (document.querySelector('.lm-skip-link')) return;

        var link = document.createElement('a');
        link.className = 'lm-skip-link';
        link.href = '#' + main.id;
        link.textContent = '跳到主要内容';
        document.body.insertBefore(link, document.body.firstChild);

        /* 键盘激活后把焦点交给主内容区，读屏才会跟随 */
        link.addEventListener('click', function () {
            main.setAttribute('tabindex', '-1');
            main.focus({ preventScroll: true });
        });
    }

    /* ── 启动（在 <head> 同步执行，避免闪烁） ─────────────────────────── */

    /* 默认 Lumina 使用系统字体，避免 Google Fonts 在部分网络下阻塞首屏；
       只有切换到赛博皮肤时才按需加载复古显示字体。 */
    function ensureCyberFonts() {
        if (root.dataset.visual !== 'cyber' && root.dataset.skin !== 'cyber') return;
        if (document.getElementById('yanmo-cyber-fonts')) return;
        var fontLink = document.createElement('link');
        fontLink.id = 'yanmo-cyber-fonts';
        fontLink.rel = 'stylesheet';
        fontLink.href = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Press+Start+2P&display=swap';
        document.head.appendChild(fontLink);
    }

    state.skin = resolveSkin();
    state.scheme = resolveScheme();
    state.fontMode = resolveFontMode();
    adoptColors();
    apply('boot');
    ensureCyberFonts();
    document.addEventListener('yanmo:themechange', ensureCyberFonts);

    /* 上一页点击了站内链接：在新页面首屏前显示同风格的交接遮罩 */
    var navPending = false;
    try {
        navPending = window.sessionStorage.getItem(NAV_TRANSITION_KEY) === '1';
        if (navPending) window.sessionStorage.removeItem(NAV_TRANSITION_KEY);
    } catch (e) {
        navPending = false;
    }
    // 小转场只使用上一页顶部的小胶囊；不再给新页面加全屏交接遮罩。
    // navPending 仍需读取并清理，避免旧的 sessionStorage 标记残留。
    if (navPending) {
        root.classList.remove('ym-entering', 'ym-enter-done');
    }

    function onReady() {
        syncFontMode(state.fontMode);
        mountSkipLink();
        root.classList.add('yanmo-ready');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }

    window.YanMoTheme = {
        PRESETS: PRESETS,
        STORAGE: STORAGE,
        setSkin: setSkin,
        toggleSkin: toggleSkin,
        setScheme: setScheme,
        toggleScheme: toggleScheme,
        setColor: setColor,
        resetColor: resetColor,
        setFontMode: setFontMode,
        toggleFontMode: toggleFontMode,
        subscribe: subscribe,
        getState: getState
    };


})(window, document);
