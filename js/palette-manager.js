(function(window) {
    'use strict';

    const BG_KEY    = 'yanmo.site.bg-color';
    const TEXT_KEY  = 'yanmo.site.text-color';
    const FONT_KEY  = 'yanmo.site.font-mode';

    const DEFAULTS = {
        bg: '#05050a',
        text: '#00ffff',
    };

    // 旧默认文字色——升级到新默认（青色主色）时需要清除
    const LEGACY_TEXT_DEFAULT = '#e0e8f0';

    function migrateColor(raw) {
        if (!raw) return null;
        const val = JSON.parse(raw);
        if (typeof val === 'string') return val;
        if (val && typeof val === 'object') {
            return val.cyber || val.dark || val.light || null;
        }
        return null;
    }

    function getSavedColors() {
        try {
            const bg   = migrateColor(localStorage.getItem(BG_KEY));
            let   text = migrateColor(localStorage.getItem(TEXT_KEY));

            // 迁移：旧默认文字色 #e0e8f0 升级为新默认青色主色 #00ffff
            if (text && text.toLowerCase() === LEGACY_TEXT_DEFAULT) {
                localStorage.removeItem(TEXT_KEY);
                text = null;
            }

            if (bg)   saveColor(BG_KEY, bg);
            if (text) saveColor(TEXT_KEY, text);
            return {
                bg:   bg   || DEFAULTS.bg,
                text: text || DEFAULTS.text,
            };
        } catch(_) {
            return { bg: DEFAULTS.bg, text: DEFAULTS.text };
        }
    }

    function saveColor(key, hex) {
        localStorage.setItem(key, JSON.stringify(hex));
    }

    function getFontMode() {
        return localStorage.getItem(FONT_KEY) || 'normal';
    }

    function applyBgColor(hex) {
        setVar('--bg-color', hex);
        applyBgDerived(hex);
        saveColor(BG_KEY, hex);
        syncBgPicker(hex);
    }

    function applyTextColor(hex) {
        setVar('--text-color', hex);
        applyTextDerived(hex);
        saveColor(TEXT_KEY, hex);
        syncTextPicker(hex);
    }

    function applyFontMode(fontMode) {
        document.body.classList.toggle('cyberpunk-mode', fontMode === 'cyberpunk');
        localStorage.setItem(FONT_KEY, fontMode);
        syncFontToggle(fontMode);
    }

    function toggleFontMode() {
        applyFontMode(document.body.classList.contains('cyberpunk-mode') ? 'normal' : 'cyberpunk');
    }

    function setVar(prop, val) {
        document.documentElement.style.setProperty(prop, val);
    }

    function hexToRgb(hex) {
        const h = hex.replace('#', '');
        return {
            r: parseInt(h.substring(0, 2), 16),
            g: parseInt(h.substring(2, 4), 16),
            b: parseInt(h.substring(4, 6), 16)
        };
    }

    function rgba(hex, alpha) {
        const { r, g, b } = hexToRgb(hex);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    function luminance(hex) {
        const { r, g, b } = hexToRgb(hex);
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }

    function deriveBg2(hex) {
        const { r, g, b } = hexToRgb(hex);
        const lum = luminance(hex);
        if (lum > 0.5) {
            return `rgb(${Math.max(0, r - 8)},${Math.max(0, g - 8)},${Math.max(0, b - 8)})`;
        } else {
            return `rgb(${Math.min(255, r + 8)},${Math.min(255, g + 8)},${Math.min(255, b + 8)})`;
        }
    }

    function deriveSurface(hex) {
        return rgba(hex, 0.92);
    }

    function deriveSurfaceHover(hex) {
        return rgba(hex, 0.98);
    }

    function deriveTextMuted(hex) {
        return rgba(hex, 0.65);
    }

    function applyBgDerived(hex) {
        const { r, g, b } = hexToRgb(hex);
        setVar('--bg-color-r', r);
        setVar('--bg-color-g', g);
        setVar('--bg-color-b', b);
        setVar('--theme-bg', hex);
        setVar('--theme-bg-2', deriveBg2(hex));
        setVar('--theme-surface', deriveSurface(hex));
        setVar('--theme-surface-hover', deriveSurfaceHover(hex));
        setVar('--cyber-dark', hex);
        setVar('--terminal-bg', hex);
        setVar('--card-bg', deriveSurface(hex));
        setVar('--card-bg-hover', deriveSurfaceHover(hex));
        setVar('--cyber-card-bg', deriveSurface(hex));
        setVar('--p-bg', hex);
        setVar('--p-bg-2', deriveBg2(hex));
        setVar('--p-card', deriveSurface(hex));
        setVar('--p-card-hover', deriveSurfaceHover(hex));
        setVar('--surface-98', rgba(hex, 0.98));
        setVar('--surface-95', rgba(hex, 0.95));
        setVar('--surface-90', rgba(hex, 0.90));
        setVar('--surface-85', rgba(hex, 0.85));
        setVar('--surface-80', rgba(hex, 0.80));
        setVar('--surface-70', rgba(hex, 0.70));
        setVar('--surface-10', rgba(hex, 0.10));
        setVar('--surface-20', rgba(hex, 0.20));
    }

    function applyTextDerived(hex) {
        const { r, g, b } = hexToRgb(hex);
        setVar('--text-color-r', r);
        setVar('--text-color-g', g);
        setVar('--text-color-b', b);
        // 同步更新 --primary-color 及其 RGB 分量，让所有使用 primary/p-primary/cyber-cyan/neon-cyan 的元素跟随调色板
        setVar('--primary-color', hex);
        setVar('--primary-color-r', r);
        setVar('--primary-color-g', g);
        setVar('--primary-color-b', b);
        setVar('--p-primary', hex);
        setVar('--p-primary-r', r);
        setVar('--p-primary-g', g);
        setVar('--p-primary-b', b);
        setVar('--theme-text', hex);
        setVar('--theme-text-muted', deriveTextMuted(hex));
        setVar('--text-secondary', deriveTextMuted(hex));
        setVar('--text-muted', deriveTextMuted(hex));
        setVar('--p-text', hex);
        setVar('--p-text-muted', deriveTextMuted(hex));
    }

    function syncBgPicker(hex) {
        document.querySelectorAll('.bg-color-picker').forEach(el => { el.value = hex; });
    }

    function syncTextPicker(hex) {
        document.querySelectorAll('.text-color-picker').forEach(el => { el.value = hex; });
    }

    function syncPickers(bg, text) {
        syncBgPicker(bg);
        syncTextPicker(text);
    }

    function syncFontToggle(fontMode) {
        const isCyber = fontMode === 'cyberpunk';
        const label = isCyber ? '切换普通字体' : '切换赛博字体';
        document.querySelectorAll('.font-mode-toggle').forEach(btn => {
            btn.textContent = label;
            btn.classList.toggle('active', isCyber);
        });
    }

    function buildDrawer() {
        if (document.getElementById('settings-drawer')) return;

        const fab = document.createElement('button');
        fab.id = 'settings-fab';
        fab.className = 'settings-fab';
        fab.type = 'button';
        fab.setAttribute('aria-label', '打开设置面板');
        fab.setAttribute('aria-expanded', 'false');
        fab.innerHTML = '<span class="fab-icon">⚙</span>';

        const drawer = document.createElement('div');
        drawer.id = 'settings-drawer';
        drawer.className = 'settings-drawer';
        drawer.setAttribute('aria-hidden', 'true');

        const colors = getSavedColors();

        drawer.innerHTML = `
            <div class="drawer-header">
                <span class="drawer-title">个性化设置</span>
                <button type="button" class="drawer-close" aria-label="关闭">✕</button>
            </div>

            <div class="drawer-section">
                <div class="drawer-label">背景颜色</div>
                <div class="picker-row">
                    <input type="color" class="bg-color-picker color-swatch"
                           value="${colors.bg}" aria-label="背景颜色">
                    <span class="picker-hint">整个网站的背景色</span>
                    <button type="button" class="picker-reset" data-target="bg" aria-label="重置背景色">↺</button>
                </div>
            </div>

            <div class="drawer-section">
                <div class="drawer-label">文字颜色</div>
                <div class="picker-row">
                    <input type="color" class="text-color-picker color-swatch"
                           value="${colors.text}" aria-label="文字颜色">
                    <span class="picker-hint">整个网站的文字色</span>
                    <button type="button" class="picker-reset" data-target="text" aria-label="重置文字色">↺</button>
                </div>
            </div>

            <div class="drawer-section">
                <div class="drawer-label">字体风格</div>
                <button type="button" class="font-mode-toggle">切换赛博字体</button>
                <div class="font-mode-hint">赛博字体：Press Start 2P + Orbitron</div>
            </div>
        `;

        document.body.appendChild(fab);
        document.body.appendChild(drawer);
        bindDrawer(fab, drawer);

        syncFontToggle(getFontMode());
    }

    function bindDrawer(fab, drawer) {
        const open  = () => { drawer.setAttribute('aria-hidden','false'); fab.setAttribute('aria-expanded','true');  fab.classList.add('open'); };
        const close = () => { drawer.setAttribute('aria-hidden','true');  fab.setAttribute('aria-expanded','false'); fab.classList.remove('open'); };

        fab.addEventListener('click', e => { e.stopPropagation(); drawer.getAttribute('aria-hidden') === 'false' ? close() : open(); });
        drawer.querySelector('.drawer-close').addEventListener('click', close);
        document.addEventListener('click', e => { if (!fab.contains(e.target) && !drawer.contains(e.target)) close(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

        drawer.querySelector('.bg-color-picker').addEventListener('input', e => applyBgColor(e.target.value));
        drawer.querySelector('.text-color-picker').addEventListener('input', e => applyTextColor(e.target.value));

        drawer.querySelectorAll('.picker-reset').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.target === 'bg') {
                    applyBgColor(DEFAULTS.bg);
                } else {
                    applyTextColor(DEFAULTS.text);
                }
            });
        });

        drawer.querySelector('.font-mode-toggle').addEventListener('click', toggleFontMode);
    }

    function init() {
        document.documentElement.classList.add('cyber-mode');
        document.body.classList.add('cyber-mode');

        const colors = getSavedColors();
        applyBgColor(colors.bg);
        applyTextColor(colors.text);
        applyFontMode(getFontMode());
        buildDrawer();
    }

    window.ThemeManager = { applyBgColor, applyTextColor, applyFontMode, toggleFontMode, DEFAULTS };
    window.PaletteManager = window.ThemeManager;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window);