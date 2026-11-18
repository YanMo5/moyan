/**
 * music-box.js — 站点音乐盒「YANMO RADIO」
 * ---------------------------------------------------------------
 * 左下角悬浮按钮 → 展开迷你播放器：
 *   · 播放 / 暂停 / 上一首 / 下一首 / 列表循环 / 单曲循环 / 随机播放
 *   · 进度条、时间、音量、静音
 *   · 系统媒体键（Media Session API）
 *   · 内置「雨声」环境音：Web Audio 实时合成，不依赖任何音频文件
 *
 * 播放列表：/assets/audio/playlist.json（缺失或为空时只保留环境音）
 * 状态持久化：localStorage 前缀「yanmo.music.」
 * 与主题系统：只读取 CSS 变量，不参与皮肤 / 明暗状态。
 */
(function (window, document) {
    'use strict';

    var PLAYLIST_URL = '/assets/audio/playlist.json';
    var STORE_PREFIX = 'yanmo.music.';

    /* ── 小工具 ─────────────────────────────────────────────────── */

    function readStore(key, fallback) {
        try {
            var raw = window.localStorage.getItem(STORE_PREFIX + key);
            return raw === null ? fallback : raw;
        } catch (err) {
            return fallback;
        }
    }

    function writeStore(key, value) {
        try {
            window.localStorage.setItem(STORE_PREFIX + key, String(value));
        } catch (err) { /* 隐私模式下忽略 */ }
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';
        var total = Math.floor(seconds);
        var rest = total % 60;
        return Math.floor(total / 60) + ':' + (rest < 10 ? '0' : '') + rest;
    }

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function isTypingContext(target) {
        if (!target) return false;
        var tag = String(target.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
    }

    /* ── 雨声环境音（Web Audio 合成，无外部文件） ───────────────── */

    var Ambient = {
        ctx: null,
        buffer: null,
        source: null,
        filter: null,
        master: null,
        lfo: null,
        playing: false,

        ensureContext: function () {
            if (this.ctx) return this.ctx;
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            try {
                this.ctx = new Ctx();
            } catch (err) {
                this.ctx = null;
            }
            return this.ctx;
        },

        /* Paul Kellet 粉红噪声近似 → 4 秒循环缓冲 */
        buildBuffer: function (ctx) {
            var length = Math.floor(ctx.sampleRate * 4);
            var buffer = ctx.createBuffer(1, length, ctx.sampleRate);
            var data = buffer.getChannelData(0);
            var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (var i = 0; i < length; i++) {
                var white = Math.random() * 2 - 1;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.96900 * b2 + white * 0.1538520;
                b3 = 0.86650 * b3 + white * 0.3104856;
                b4 = 0.55000 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.0168980;
                data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
                b6 = white * 0.115926;
            }
            return buffer;
        },

        start: function (volume) {
            var ctx = this.ensureContext();
            if (!ctx) return false;
            if (ctx.state === 'suspended') ctx.resume();

            if (this.playing) {
                this.setVolume(volume);
                return true;
            }

            if (!this.buffer) this.buffer = this.buildBuffer(ctx);

            var source = ctx.createBufferSource();
            source.buffer = this.buffer;
            source.loop = true;

            var filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 1600;
            filter.Q.value = 0.4;

            var master = ctx.createGain();
            master.gain.value = clamp(volume, 0, 1) * 0.32;

            /* 0.07Hz 的缓慢起伏，模拟雨势强弱变化 */
            var lfo = ctx.createOscillator();
            var lfoGain = ctx.createGain();
            lfo.frequency.value = 0.07;
            lfoGain.gain.value = 0.05;
            lfo.connect(lfoGain);
            lfoGain.connect(master.gain);
            lfo.start();

            source.connect(filter);
            filter.connect(master);
            master.connect(ctx.destination);
            source.start();

            this.source = source;
            this.filter = filter;
            this.master = master;
            this.lfo = lfo;
            this.playing = true;
            return true;
        },

        stop: function () {
            if (!this.playing) return;
            try { this.source.stop(); } catch (err) { /* 已停止 */ }
            try { this.lfo.stop(); } catch (err) { /* 已停止 */ }
            try {
                this.source.disconnect();
                this.filter.disconnect();
                this.master.disconnect();
            } catch (err) { /* 已断开 */ }
            this.source = null;
            this.filter = null;
            this.master = null;
            this.lfo = null;
            this.playing = false;
        },

        setVolume: function (volume) {
            if (this.master) {
                this.master.gain.value = clamp(volume, 0, 1) * 0.32;
            }
        }
    };

    /* ── 组件状态 ───────────────────────────────────────────────── */

    var state = {
        tracks: [],
        index: -1,
        mode: readStore('mode', 'list') === 'one' ? 'one' : 'list', // list | one
        shuffle: readStore('shuffle', '0') === '1',
        volume: clamp(parseFloat(readStore('volume', '0.6')) || 0.6, 0, 1),
        muted: readStore('muted', '0') === '1',
        ambient: false,
        open: false,
        seeking: false,
        playlistLoaded: false
    };

    var audio = null;
    var root = null;
    var ui = {};

    var ICON_PLAY = '▶';
    var ICON_PAUSE = '❚❚';
    var ICON_VOLUME = '🔊';
    var ICON_MUTED = '🔇';

    /* ── 骨架 ───────────────────────────────────────────────────── */

    function panelMarkup() {
        return '' +
            '<div class="mb-panel" id="music-panel" role="dialog" aria-label="音乐盒" aria-hidden="true">' +
                '<div class="mb-head">' +
                    '<span class="mb-brand">YANMO RADIO</span>' +
                    '<button type="button" class="mb-close" aria-label="收起音乐盒">✕</button>' +
                '</div>' +
                '<div class="mb-now">' +
                    '<div class="mb-now-title">未在播放</div>' +
                    '<div class="mb-now-sub" role="status" aria-live="polite">播放列表加载中…</div>' +
                '</div>' +
                '<div class="mb-progress-wrap">' +
                    '<input type="range" class="mb-progress" min="0" max="1000" step="1" value="0" aria-label="播放进度">' +
                    '<div class="mb-time"><span class="mb-cur">0:00</span><span class="mb-dur">0:00</span></div>' +
                '</div>' +
                '<div class="mb-controls">' +
                    '<button type="button" class="mb-btn mb-prev" aria-label="上一首" title="上一首">⏮</button>' +
                    '<button type="button" class="mb-btn mb-play" aria-label="播放" title="播放 / 暂停">' + ICON_PLAY + '</button>' +
                    '<button type="button" class="mb-btn mb-next" aria-label="下一首" title="下一首">⏭</button>' +
                '</div>' +
                '<div class="mb-row">' +
                    '<button type="button" class="mb-chip mb-mode" aria-pressed="false" title="列表循环 / 单曲循环">列表循环</button>' +
                    '<button type="button" class="mb-chip mb-shuffle" aria-pressed="false" title="随机播放">随机</button>' +
                    '<button type="button" class="mb-chip mb-ambient" aria-pressed="false" title="雨声环境音（无需音频文件）">雨声</button>' +
                '</div>' +
                '<div class="mb-row mb-vol-row">' +
                    '<button type="button" class="mb-btn mb-mute" aria-label="静音" title="静音">' + ICON_VOLUME + '</button>' +
                    '<input type="range" class="mb-volume" min="0" max="100" step="1" value="60" aria-label="音量">' +
                '</div>' +
                '<div class="mb-hint" role="status" aria-live="polite"></div>' +
                '<ul class="mb-list" aria-label="播放列表"></ul>' +
            '</div>' +
            '<button type="button" class="music-fab" aria-label="打开音乐盒" aria-expanded="false" aria-controls="music-panel">' +
                '<span class="mb-disc" aria-hidden="true">♪</span>' +
            '</button>';
    }

    function buildUI() {
        if (document.getElementById('music-box')) return false;

        root = document.createElement('div');
        root.id = 'music-box';
        root.className = 'music-box';
        root.innerHTML = panelMarkup();
        document.body.appendChild(root);

        ui.fab = root.querySelector('.music-fab');
        ui.panel = root.querySelector('.mb-panel');
        ui.close = root.querySelector('.mb-close');
        ui.nowTitle = root.querySelector('.mb-now-title');
        ui.nowSub = root.querySelector('.mb-now-sub');
        ui.progress = root.querySelector('.mb-progress');
        ui.cur = root.querySelector('.mb-cur');
        ui.dur = root.querySelector('.mb-dur');
        ui.play = root.querySelector('.mb-play');
        ui.prev = root.querySelector('.mb-prev');
        ui.next = root.querySelector('.mb-next');
        ui.mode = root.querySelector('.mb-mode');
        ui.shuffle = root.querySelector('.mb-shuffle');
        ui.ambient = root.querySelector('.mb-ambient');
        ui.mute = root.querySelector('.mb-mute');
        ui.volume = root.querySelector('.mb-volume');
        ui.hint = root.querySelector('.mb-hint');
        ui.list = root.querySelector('.mb-list');

        audio = new window.Audio();
        audio.preload = 'none';
        audio.volume = state.volume;
        audio.muted = state.muted;

        return true;
    }

    /* ── 渲染 ───────────────────────────────────────────────────── */

    function currentTrack() {
        return state.index >= 0 ? state.tracks[state.index] : null;
    }

    function setHint(message) {
        if (ui.hint) ui.hint.textContent = message || '';
    }

    function renderList() {
        if (!ui.list) return;
        if (!state.tracks.length) {
            ui.list.innerHTML = '<li class="mb-empty">暂无音轨：把音频放进 <code>/assets/audio/</code>，' +
                '再在 <code>/assets/audio/playlist.json</code> 里登记。也可以直接用「雨声」。</li>';
            return;
        }
        ui.list.innerHTML = state.tracks.map(function (track, i) {
            return '<li><button type="button" class="mb-track" data-index="' + i + '" aria-current="' +
                (i === state.index ? 'true' : 'false') + '">' +
                '<span class="mb-track-index">' + String(i + 1).padStart(2, '0') + '</span>' +
                '<span class="mb-track-title">' + esc(track.title) + '</span>' +
                '<span class="mb-track-artist">' + esc(track.artist) + '</span>' +
                '</button></li>';
        }).join('');
    }

    function renderNow() {
        if (!ui.nowTitle) return;

        if (state.ambient) {
            ui.nowTitle.textContent = '雨声环境音';
            ui.nowSub.textContent = 'Web Audio 实时合成 · 无需音频文件';
            return;
        }

        var track = currentTrack();
        if (track) {
            ui.nowTitle.textContent = track.title;
            ui.nowSub.textContent = track.artist || '未知来源';
            return;
        }

        ui.nowTitle.textContent = '未在播放';
        ui.nowSub.textContent = state.playlistLoaded ? '播放列表为空' : '播放列表加载中…';
    }

    function syncModeButtons() {
        var isOne = state.mode === 'one';
        ui.mode.textContent = isOne ? '单曲循环' : '列表循环';
        ui.mode.setAttribute('aria-pressed', String(isOne));
        ui.mode.setAttribute('aria-label', '播放模式：' + (isOne ? '单曲循环' : '列表循环'));
        ui.shuffle.setAttribute('aria-pressed', String(state.shuffle));
        ui.ambient.setAttribute('aria-pressed', String(state.ambient));
    }

    function syncPlayButton() {
        var playing = state.ambient || (!audio.paused && !audio.ended);
        ui.play.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
        ui.play.setAttribute('aria-label', playing ? '暂停' : '播放');
        if (root) root.classList.toggle('is-playing', playing);
    }

    function syncVolume() {
        var effective = state.muted ? 0 : state.volume;
        ui.volume.value = String(Math.round(effective * 100));
        ui.volume.style.setProperty('--mb-fill', Math.round(effective * 100) + '%');
        ui.mute.innerHTML = effective === 0 ? ICON_MUTED : ICON_VOLUME;
        ui.mute.setAttribute('aria-pressed', String(state.muted));
        ui.mute.setAttribute('aria-label', state.muted ? '取消静音' : '静音');
    }

    function syncProgress() {
        if (state.seeking) return;
        var duration = isFinite(audio.duration) ? audio.duration : 0;
        var ratio = duration > 0 ? audio.currentTime / duration : 0;
        var percent = Math.round(clamp(ratio, 0, 1) * 100);
        ui.progress.value = String(Math.round(clamp(ratio, 0, 1) * 1000));
        ui.progress.style.setProperty('--mb-fill', percent + '%');
        ui.cur.textContent = formatTime(audio.currentTime);
        ui.dur.textContent = formatTime(duration);
    }

    function syncAll() {
        syncModeButtons();
        syncPlayButton();
        syncVolume();
        syncProgress();
        renderNow();
    }

    function setPanelOpen(open) {
        state.open = !!open;
        if (!root) return;
        root.classList.toggle('is-open', state.open);
        ui.fab.setAttribute('aria-expanded', String(state.open));
        ui.fab.setAttribute('aria-label', state.open ? '收起音乐盒' : '打开音乐盒');
        ui.panel.setAttribute('aria-hidden', String(!state.open));
        if (state.open) {
            window.setTimeout(function () {
                try { ui.close.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ }
            }, 30);
        }
    }

    /* ── 播放控制 ───────────────────────────────────────────────── */

    function pickRandomIndex() {
        if (state.tracks.length < 2) return 0;
        var next = state.index;
        while (next === state.index) next = Math.floor(Math.random() * state.tracks.length);
        return next;
    }

    function updateMediaSession(title, artist) {
        if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
        try {
            navigator.mediaSession.metadata = new window.MediaMetadata({
                title: title || 'YANMO RADIO',
                artist: artist || 'YanMo Labs',
                album: 'YANMO RADIO'
            });
        } catch (err) { /* 忽略 */ }
    }

    function loadTrack(index, autoplay) {
        if (!state.tracks.length) return;
        var total = state.tracks.length;
        var next = ((index % total) + total) % total;
        state.index = next;

        var track = state.tracks[next];
        writeStore('track', next);
        audio.src = track.src;
        try { audio.load(); } catch (err) { /* 忽略 */ }

        ui.cur.textContent = '0:00';
        ui.dur.textContent = '0:00';
        ui.progress.value = '0';
        renderList();
        renderNow();
        updateMediaSession(track.title, track.artist);

        if (autoplay) startPlayback();
    }

    function startPlayback() {
        setHint('');
        var promise = audio.play();
        if (promise && typeof promise.catch === 'function') {
            promise.catch(function (err) {
                /* 只有「自动播放被拦截」才提示重试；文件缺失交给 error 事件处理 */
                if (err && err.name === 'NotAllowedError') {
                    setHint('播放被浏览器拦下了，请再点一次 ▶。');
                }
                syncPlayButton();
            });
        }
    }

    function toggleAmbient(on) {
        var next = typeof on === 'boolean' ? on : !state.ambient;

        if (next) {
            if (!audio.paused) audio.pause();
            if (!Ambient.start(state.muted ? 0 : state.volume)) {
                setHint('当前浏览器不支持 Web Audio，雨声不可用。');
                return;
            }
            state.ambient = true;
            setHint('');
            updateMediaSession('雨声环境音', 'Web Audio 合成');
        } else {
            Ambient.stop();
            state.ambient = false;
        }

        syncModeButtons();
        syncPlayButton();
        renderNow();
    }

    function togglePlay() {
        if (state.ambient) {
            toggleAmbient(false);
            return;
        }

        if (!state.tracks.length) {
            setHint('还没有音轨，先听「雨声」吧；添曲方法见 /assets/audio/README.md。');
            toggleAmbient(true);
            return;
        }

        if (audio.paused || audio.ended) {
            consecutiveFailures = 0; // 用户主动播放：重置失效计数
            if (!audio.getAttribute('src')) {
                loadTrack(state.index >= 0 ? state.index : 0, true);
                return;
            }
            startPlayback();
        } else {
            audio.pause();
        }
    }

    function step(delta) {
        if (!state.tracks.length) {
            setHint('播放列表为空，无法切歌。');
            return;
        }
        if (state.ambient) toggleAmbient(false);

        var base = state.index >= 0 ? state.index : (delta > 0 ? -1 : 0);
        var index = base + delta;
        if (delta > 0 && state.shuffle) index = pickRandomIndex();
        loadTrack(index, true);
    }

    function seekFromInput() {
        var duration = isFinite(audio.duration) ? audio.duration : 0;
        if (!duration) return;
        var ratio = clamp(parseFloat(ui.progress.value) / 1000, 0, 1);
        audio.currentTime = ratio * duration;
        ui.progress.style.setProperty('--mb-fill', Math.round(ratio * 100) + '%');
        ui.cur.textContent = formatTime(audio.currentTime);
    }

    /* ── 事件绑定 ───────────────────────────────────────────────── */

    var consecutiveFailures = 0;

    function bindEvents() {
        ui.fab.addEventListener('click', function () {
            setPanelOpen(!state.open);
        });

        ui.close.addEventListener('click', function () {
            setPanelOpen(false);
            try { ui.fab.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ }
        });

        ui.play.addEventListener('click', togglePlay);
        ui.next.addEventListener('click', function () { step(1); });
        ui.prev.addEventListener('click', function () { step(-1); });

        ui.mode.addEventListener('click', function () {
            state.mode = state.mode === 'one' ? 'list' : 'one';
            writeStore('mode', state.mode);
            syncModeButtons();
        });

        ui.shuffle.addEventListener('click', function () {
            state.shuffle = !state.shuffle;
            writeStore('shuffle', state.shuffle ? '1' : '0');
            syncModeButtons();
        });

        ui.ambient.addEventListener('click', function () { toggleAmbient(); });

        ui.mute.addEventListener('click', function () {
            state.muted = !state.muted;
            audio.muted = state.muted;
            writeStore('muted', state.muted ? '1' : '0');
            Ambient.setVolume(state.muted ? 0 : state.volume);
            syncVolume();
            syncPlayButton();
        });

        ui.volume.addEventListener('input', function () {
            var value = clamp(parseFloat(ui.volume.value) / 100, 0, 1);
            state.volume = value;
            audio.volume = value;
            if (state.muted && value > 0) {
                state.muted = false;
                audio.muted = false;
                writeStore('muted', '0');
            }
            writeStore('volume', value);
            Ambient.setVolume(value);
            syncVolume();
        });

        ui.progress.addEventListener('pointerdown', function () { state.seeking = true; });
        ui.progress.addEventListener('input', function () {
            if (state.seeking) seekFromInput();
        });
        ['pointerup', 'pointercancel', 'blur'].forEach(function (type) {
            ui.progress.addEventListener(type, function () {
                if (!state.seeking) return;
                seekFromInput();
                state.seeking = false;
            });
        });

        ui.list.addEventListener('click', function (event) {
            var btn = event.target.closest('.mb-track');
            if (!btn) return;
            var index = parseInt(btn.getAttribute('data-index'), 10);
            if (!isFinite(index)) return;
            if (state.ambient) toggleAmbient(false);
            if (index === state.index && !audio.paused) { audio.pause(); return; }
            loadTrack(index, true);
        });

        /* 点击面板外部收起 */
        document.addEventListener('click', function (event) {
            if (!state.open || !root) return;
            if (root.contains(event.target)) return;
            setPanelOpen(false);
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && state.open) {
                setPanelOpen(false);
                try { ui.fab.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ }
                return;
            }
            if (event.altKey && !event.ctrlKey && !event.metaKey &&
                (event.key === 'm' || event.key === 'M') && !isTypingContext(event.target)) {
                event.preventDefault();
                setPanelOpen(!state.open);
            }
        });

        /* ── <audio> 事件 ── */
        audio.addEventListener('timeupdate', syncProgress);
        audio.addEventListener('durationchange', syncProgress);
        audio.addEventListener('loadedmetadata', syncProgress);
        audio.addEventListener('playing', function () {
            consecutiveFailures = 0;
            syncPlayButton();
        });
        audio.addEventListener('play', syncPlayButton);
        audio.addEventListener('pause', syncPlayButton);

        audio.addEventListener('ended', function () {
            if (state.mode === 'one') {
                audio.currentTime = 0;
                startPlayback();
            } else {
                step(1);
            }
        });

        audio.addEventListener('error', function () {
            consecutiveFailures++;
            var track = currentTrack();
            var name = track ? track.title : '未知曲目';
            syncPlayButton();

            if (state.tracks.length > 1 && consecutiveFailures < state.tracks.length) {
                setHint('「' + name + '」无法播放，已跳到下一首。');
                step(1);
                return;
            }

            setHint('音轨失效：请检查 /assets/audio/ 目录与 /assets/audio/playlist.json 登记。');
            try { audio.pause(); } catch (err) { /* 忽略 */ }
            syncPlayButton();
        });

        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.setActionHandler('play', togglePlay);
                navigator.mediaSession.setActionHandler('pause', function () {
                    if (state.ambient) toggleAmbient(false);
                    else audio.pause();
                });
                navigator.mediaSession.setActionHandler('nexttrack', function () { step(1); });
                navigator.mediaSession.setActionHandler('previoustrack', function () { step(-1); });
            } catch (err) { /* 浏览器不支持则该 API 忽略 */ }
        }
    }

    /* ── 播放列表加载 ───────────────────────────────────────────── */

    async function loadPlaylist() {
        var list = [];

        try {
            var res = await window.fetch(PLAYLIST_URL, { cache: 'no-cache' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var data = await res.json();
            list = Array.isArray(data) ? data : (data && Array.isArray(data.tracks) ? data.tracks : []);
        } catch (err) {
            list = [];
        }

        state.tracks = list.filter(function (item) {
            return item && typeof item.src === 'string' && item.src.trim() !== '';
        }).map(function (item, i) {
            return {
                src: item.src.trim(),
                title: String(item.title || item.name || ('Track ' + (i + 1))),
                artist: String(item.artist || item.by || '')
            };
        });

        state.playlistLoaded = true;

        if (!state.tracks.length) {
            renderList();
            renderNow();
            setHint('未找到音轨（/assets/audio/playlist.json 为空或缺失），可先试「雨声」。');
            return;
        }

        var saved = parseInt(readStore('track', '0'), 10);
        state.index = isFinite(saved) ? Math.round(clamp(saved, 0, state.tracks.length - 1)) : 0;

        renderList();
        renderNow();
    }

    /* ── 启动 ───────────────────────────────────────────────────── */

    function boot() {
        if (!document.body) return;
        if (!buildUI()) return;

        bindEvents();
        syncAll();
        loadPlaylist();

        window.YanMoMusicBox = {
            open: function () { setPanelOpen(true); },
            close: function () { setPanelOpen(false); },
            toggle: togglePlay,
            play: function () { if (audio.paused) togglePlay(); },
            pause: function () { if (!audio.paused) audio.pause(); },
            next: function () { step(1); },
            prev: function () { step(-1); },
            ambient: toggleAmbient,
            getState: function () {
                return {
                    tracks: state.tracks.slice(),
                    index: state.index,
                    mode: state.mode,
                    shuffle: state.shuffle,
                    volume: state.volume,
                    muted: state.muted,
                    ambient: state.ambient,
                    open: state.open,
                    paused: audio ? audio.paused : true
                };
            }
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window, document);
