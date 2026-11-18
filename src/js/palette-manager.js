/**
 * palette-manager.js — 个性化设置「界面层」
 * ---------------------------------------------------------------
 * 升级说明：颜色/皮肤/明暗的状态读写与应用已全部迁移到 theme-boot.js
 * （window.YanMoTheme）。本文件只负责渲染与事件绑定：
 *
 *   · 右下角设置浮钮 + 个性化抽屉（皮肤 / 明暗 / 背景色 / 文字色 / 字体）
 *   · 顶栏那枚原本没有绑定任何事件的 .theme-toggle 按钮
 *
 * 保持向后兼容：window.ThemeManager / window.PaletteManager 依旧可用。
 */
(function (window, document) {
    'use strict';

    var THEME = window.YanMoTheme;

    /* theme-boot.js 是本模块的唯一数据源，缺失时宁可不渲染也不要造出第二份状态 */
    if (!THEME) {
        if (window.console && console.warn) {
            console.warn('[palette] theme-boot.js 未加载，个性化设置已跳过。');
        }
        return;
    }

    var TOGGLE_SELECTOR = '.theme-toggle';

    function q(selector, scope) {
        return (scope || document).querySelector(selector);
    }

    function qa(selector, scope) {
        return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
    }

    /* ── 设置浮钮 ────────────────────────────────────────────────────── */

    function buildFab() {
        if (document.getElementById('settings-fab')) return;

        var fab = document.createElement('button');
        fab.id = 'settings-fab';
        fab.className = 'settings-fab';
        fab.type = 'button';
        fab.setAttribute('aria-label', '打开个性化设置');
        fab.setAttribute('aria-expanded', 'false');
        fab.setAttribute('aria-controls', 'settings-drawer');
        fab.innerHTML = '<span class="fab-icon" aria-hidden="true">⚙</span>';
        document.body.appendChild(fab);
    }

    /* ── 抽屉 ────────────────────────────────────────────────────────── */

    function drawerMarkup(state) {
        return '' +
            '<div class="drawer-header">' +
                '<span class="drawer-title">个性化设置</span>' +
                '<button type="button" class="drawer-close" aria-label="关闭个性化设置">✕</button>' +
            '</div>' +

            '<div class="drawer-section">' +
                '<div class="drawer-label" id="lm-skin-label">外观风格</div>' +
                '<div class="lm-segmented" role="group" aria-labelledby="lm-skin-label">' +
                    '<button type="button" class="skin-option" data-skin="lumina" aria-pressed="false">现代</button>' +
                    '<button type="button" class="skin-option" data-skin="cyber" aria-pressed="false">赛博</button>' +
                '</div>' +
                '<div class="drawer-hint">赛博模式保留终端语义，同时使用稳定的现代布局。</div>' +
            '</div>' +

            '<div class="drawer-section">' +
                '<div class="drawer-label" id="lm-scheme-label">明暗模式</div>' +
                '<div class="lm-segmented" role="group" aria-labelledby="lm-scheme-label">' +
                    '<button type="button" class="scheme-option" data-scheme="dark" aria-pressed="false">暗色</button>' +
                    '<button type="button" class="scheme-option" data-scheme="light" aria-pressed="false">亮色</button>' +
                '</div>' +
            '</div>' +

            '<div class="drawer-section">' +
                '<div class="drawer-label">背景颜色</div>' +
                '<div class="picker-row">' +
                    '<input type="color" class="bg-color-picker color-swatch" value="' + state.bg + '" aria-label="背景颜色">' +
                    '<span class="picker-hint">整个网站的背景色</span>' +
                    '<button type="button" class="picker-reset" data-target="bg" aria-label="重置背景颜色">↺</button>' +
                '</div>' +
            '</div>' +

            '<div class="drawer-section">' +
                '<div class="drawer-label">文字颜色</div>' +
                '<div class="picker-row">' +
                    '<input type="color" class="text-color-picker color-swatch" value="' + state.text + '" aria-label="文字颜色">' +
                    '<span class="picker-hint">标题与正文的主色</span>' +
                    '<button type="button" class="picker-reset" data-target="text" aria-label="重置文字颜色">↺</button>' +
                '</div>' +
            '</div>' +

            '<div class="drawer-section">' +
                '<div class="drawer-label">字体风格</div>' +
                '<button type="button" class="font-mode-toggle" aria-pressed="false">切换赛博字体</button>' +
                '<div class="drawer-hint font-mode-hint">赛博字体：Press Start 2P + Orbitron</div>' +
            '</div>';
    }

    function buildDrawer() {
        if (document.getElementById('settings-drawer')) return;

        var drawer = document.createElement('div');
        drawer.id = 'settings-drawer';
        drawer.className = 'settings-drawer';
        drawer.setAttribute('aria-hidden', 'true');
        drawer.setAttribute('role', 'dialog');
        drawer.setAttribute('aria-label', '个性化设置');
        drawer.innerHTML = drawerMarkup(THEME.getState());
        document.body.appendChild(drawer);
    }

    /* ── 状态 → 界面 ─────────────────────────────────────────────────── */

    function syncToggleButtons(state) {
        var isLight = state.scheme === 'light';

        qa(TOGGLE_SELECTOR).forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(isLight));
            btn.setAttribute('aria-label', isLight ? '切换到暗色模式（当前亮色）' : '切换到亮色模式（当前暗色）');
            btn.setAttribute('title', isLight ? '切换到暗色模式' : '切换到亮色模式');
            btn.innerHTML = '<span class="lm-toggle-icon" aria-hidden="true">' + (isLight ? '☀' : '☾') + '</span>' +
                '<span class="lm-toggle-label">' + (isLight ? '亮色' : '暗色') + '</span>';
        });
    }

    function syncDrawer(state) {
        qa('.skin-option').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.getAttribute('data-skin') === state.skin));
        });

        qa('.scheme-option').forEach(function (btn) {
            btn.setAttribute('aria-pressed', String(btn.getAttribute('data-scheme') === state.scheme));
        });

        qa('.font-mode-toggle').forEach(function (btn) {
            var isCyberFont = state.fontMode === 'cyberpunk';
            btn.setAttribute('aria-pressed', String(isCyberFont));
            btn.textContent = isCyberFont ? '切换普通字体' : '切换赛博字体';
        });

        qa('.bg-color-picker').forEach(function (input) { input.value = state.bg; });
        qa('.text-color-picker').forEach(function (input) { input.value = state.text; });
    }

    function syncAll(state) {
        syncToggleButtons(state);
        syncDrawer(state);
    }

    /* ── 事件绑定 ────────────────────────────────────────────────────── */

    function bindDrawer() {
        var fab = document.getElementById('settings-fab');
        var drawer = document.getElementById('settings-drawer');
        if (!fab || !drawer || drawer.dataset.bound === 'true') return;
        drawer.dataset.bound = 'true';

        var lastFocused = null;

        function open() {
            lastFocused = document.activeElement;
            drawer.setAttribute('aria-hidden', 'false');
            fab.setAttribute('aria-expanded', 'true');
            fab.classList.add('open');
            var closeBtn = q('.drawer-close', drawer);
            if (closeBtn) closeBtn.focus({ preventScroll: true });
        }

        function close() {
            if (drawer.getAttribute('aria-hidden') === 'true') return;
            drawer.setAttribute('aria-hidden', 'true');
            fab.setAttribute('aria-expanded', 'false');
            fab.classList.remove('open');
            /* 关闭后焦点回到浮钮，键盘用户不会「掉」到页面顶部 */
            if (lastFocused && typeof lastFocused.focus === 'function') {
                lastFocused.focus({ preventScroll: true });
            }
        }

        fab.addEventListener('click', function (event) {
            event.stopPropagation();
            if (drawer.getAttribute('aria-hidden') === 'false') {
                close();
            } else {
                open();
            }
        });

        q('.drawer-close', drawer).addEventListener('click', close);

        document.addEventListener('click', function (event) {
            if (!fab.contains(event.target) && !drawer.contains(event.target)) close();
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') close();
        });

        /* 皮肤 / 明暗：分段控件 */
        qa('.skin-option', drawer).forEach(function (btn) {
            btn.addEventListener('click', function () {
                THEME.setSkin(btn.getAttribute('data-skin'));
            });
        });

        qa('.scheme-option', drawer).forEach(function (btn) {
            btn.addEventListener('click', function () {
                THEME.setScheme(btn.getAttribute('data-scheme'));
            });
        });

        /* 调色板（input 事件 = 拖动取色时实时预览） */
        var bgPicker = q('.bg-color-picker', drawer);
        var textPicker = q('.text-color-picker', drawer);

        if (bgPicker) {
            bgPicker.addEventListener('input', function () { THEME.setColor('bg', bgPicker.value); });
        }
        if (textPicker) {
            textPicker.addEventListener('input', function () { THEME.setColor('text', textPicker.value); });
        }

        qa('.picker-reset', drawer).forEach(function (btn) {
            btn.addEventListener('click', function () { THEME.resetColor(btn.dataset.target); });
        });

        var fontToggle = q('.font-mode-toggle', drawer);
        if (fontToggle) {
            fontToggle.addEventListener('click', function () { THEME.toggleFontMode(); });
        }
    }

    function bindHeaderToggles() {
        qa(TOGGLE_SELECTOR).forEach(function (btn) {
            if (btn.dataset.themeBound === 'true') return;
            btn.dataset.themeBound = 'true';
            btn.setAttribute('type', 'button');
            btn.addEventListener('click', function () { THEME.toggleScheme(); });
        });
    }

    /* ── 启动 ────────────────────────────────────────────────────────── */

    function init() {
        buildFab();
        buildDrawer();
        bindDrawer();
        bindHeaderToggles();
        syncAll(THEME.getState());
        THEME.subscribe(syncAll);
    }

    /* 兼容旧 API：其他脚本/页面可能直接调用这些方法 */
    window.ThemeManager = {
        applyBgColor: function (hex) { THEME.setColor('bg', hex); },
        applyTextColor: function (hex) { THEME.setColor('text', hex); },
        applyFontMode: function (mode) { THEME.setFontMode(mode); },
        toggleFontMode: function () { THEME.toggleFontMode(); },
        setSkin: function (skin) { THEME.setSkin(skin); },
        setScheme: function (scheme) { THEME.setScheme(scheme); },
        getState: function () { return THEME.getState(); },
        DEFAULTS: THEME.PRESETS.lumina.dark
    };
    window.PaletteManager = window.ThemeManager;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window, document);
