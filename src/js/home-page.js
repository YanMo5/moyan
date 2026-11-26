/**
 * home-page.js — YanMo Cyber Gateway
 * Sections:
 *   1. Canvas Background (Matrix Rain + Neon Grid hybrid)
 *   2. Hero Typewriter (rotating hacker slogans)
 *   3. CLI Terminal Navigation
 *   4. GitHub Arsenal Widget
 *   5. Zero-Day / CVE Feed Widgets
 *   6. Boot sequence & init
 */

(function (window) {
    'use strict';

    /* ═══════════════════════════════════════════════════════════
       1. CANVAS BACKGROUND — Matrix Rain + Neon Grid
       Performance: single rAF loop, throttled resize, low opacity
    ═══════════════════════════════════════════════════════════ */
    const CanvasBG = {
        canvas: null,
        ctx: null,
        width: 0,
        height: 0,
        drops: [],
        fontSize: 13,
        frameCount: 0,
        raf: null,
        resizeTimer: null,

        CHARS: '01アイウエオカキクケコサシスセソタチツテトナニヌネノ#$%@!?><{}[]ABCDEF'.split(''),

        // Cache of CSS variable RGB channels — refreshed each frame so
        // palette changes propagate to the canvas immediately.
        bgRgb:   { r: 5,   g: 5,   b: 10  },
        mainRgb: { r: 0,   g: 255, b: 255 },

        readRgb(prefix) {
            const cs = getComputedStyle(document.documentElement);
            return {
                r: parseInt(cs.getPropertyValue(prefix + '-r').trim(), 10) || 0,
                g: parseInt(cs.getPropertyValue(prefix + '-g').trim(), 10) || 0,
                b: parseInt(cs.getPropertyValue(prefix + '-b').trim(), 10) || 0,
            };
        },

        refreshVars() {
            this.bgRgb   = this.readRgb('--bg-color');
            this.mainRgb = this.readRgb('--primary-color');
        },

        init() {
            this.canvas = document.getElementById('cyber-canvas');
            if (!this.canvas) return;
            this.ctx = this.canvas.getContext('2d');
            this.refreshVars();
            this.resize();
            window.addEventListener('resize', () => {
                clearTimeout(this.resizeTimer);
                this.resizeTimer = setTimeout(() => this.resize(), 200);
            });
            this.loop();
        },

        resize() {
            this.width = this.canvas.width = window.innerWidth;
            this.height = this.canvas.height = window.innerHeight;
            const cols = Math.floor(this.width / this.fontSize);
            this.drops = Array.from({ length: cols }, () => Math.random() * -50);
        },

        drawGrid() {
            const ctx = this.ctx;
            const { r, g, b } = this.mainRgb;
            ctx.strokeStyle = `rgba(${r},${g},${b},0.035)`;
            ctx.lineWidth = 0.5;
            const step = 60;
            ctx.beginPath();
            for (let x = 0; x < this.width; x += step) {
                ctx.moveTo(x, 0); ctx.lineTo(x, this.height);
            }
            for (let y = 0; y < this.height; y += step) {
                ctx.moveTo(0, y); ctx.lineTo(this.width, y);
            }
            ctx.stroke();
        },

        drawRain() {
            const ctx = this.ctx;
            const { r, g, b } = this.mainRgb;
            ctx.font = this.fontSize + 'px "Roboto Mono", monospace';

            for (let i = 0; i < this.drops.length; i++) {
                const char = this.CHARS[Math.floor(Math.random() * this.CHARS.length)];
                const x = i * this.fontSize;
                const y = this.drops[i] * this.fontSize;

                // bright head character
                ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
                ctx.fillText(char, x, y);

                // dimmer trail (previous position)
                ctx.fillStyle = `rgba(${r},${g},${b},0.22)`;
                ctx.fillText(
                    this.CHARS[Math.floor(Math.random() * this.CHARS.length)],
                    x, y - this.fontSize
                );

                if (y > this.height && Math.random() > 0.972) {
                    this.drops[i] = 0;
                }
                this.drops[i] += 0.55;
            }
        },

        loop() {
            const ctx = this.ctx;

            const tick = () => {
                this.raf = requestAnimationFrame(tick);
                this.frameCount++;

                // refresh CSS-derived colors every frame so palette
                // changes are reflected immediately on the canvas.
                this.refreshVars();

                // fade trail — uses bg-color RGB so the canvas overlay
                // follows the background palette instead of hard-coding
                // a dark color that would mask the body background.
                const { r, g, b } = this.bgRgb;
                ctx.fillStyle = `rgba(${r},${g},${b},0.10)`;
                ctx.fillRect(0, 0, this.width, this.height);

                // draw grid every 3rd frame (static-ish, cheap)
                if (this.frameCount % 3 === 0) this.drawGrid();

                this.drawRain();
            };

            // Pause when tab is hidden — eliminates background GPU work
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
                } else if (!this.raf) {
                    tick();
                }
            });

            tick();
        }
    };

    /* ═══════════════════════════════════════════════════════════
       2. HERO TYPEWRITER — rotating hacker-manifesto slogans
    ═══════════════════════════════════════════════════════════ */
    const Typewriter = {
        slogans: [
            'REVERSE THE BINARY. READ THE MEMORY. OWN THE BOX.',
            'RED TEAM BY DAY. ZERO-DAY BY NIGHT. PATCH? NOT YOUR PROBLEM.',
            'THE PERIMETER IS A LIE — EVERY TRUST BOUNDARY IS AN ATTACK SURFACE.'
        ],
        el: null,
        cursorEl: null,
        idx: 0,
        charIdx: 0,
        deleting: false,
        pauseTicks: 0,
        PAUSE: 48,   // frames to hold before deleting
        TYPE_SPEED: 55,   // ms per char
        DEL_SPEED: 22,    // ms per char delete
        timer: null,

        init() {
            this.el = document.getElementById('hero-slogan');
            this.cursorEl = document.getElementById('hero-cursor');
            if (!this.el) return;

            // 减少动态效果：直接给出完整标语，不跑打字机、不显示光标
            if (MotionPref.matches) {
                this.el.textContent = this.slogans[0];
                if (this.cursorEl) this.cursorEl.style.display = 'none';
                return;
            }

            if (MotionPref.addEventListener) {
                MotionPref.addEventListener('change', (event) => {
                    if (!event.matches) return;
                    clearTimeout(this.timer);
                    this.el.textContent = this.slogans[this.idx];
                    if (this.cursorEl) this.cursorEl.style.display = 'none';
                });
            }

            this.tick();
        },

        tick() {
            const slogan = this.slogans[this.idx];

            if (!this.deleting) {
                this.el.textContent = slogan.slice(0, this.charIdx + 1);
                this.charIdx++;
                if (this.charIdx >= slogan.length) {
                    this.pauseTicks++;
                    if (this.pauseTicks >= this.PAUSE) {
                        this.deleting = true;
                        this.pauseTicks = 0;
                    }
                    this.timer = setTimeout(() => this.tick(), 80);
                    return;
                }
                this.timer = setTimeout(() => this.tick(), this.TYPE_SPEED);
            } else {
                this.el.textContent = slogan.slice(0, this.charIdx - 1);
                this.charIdx--;
                if (this.charIdx <= 0) {
                    this.deleting = false;
                    this.idx = (this.idx + 1) % this.slogans.length;
                    this.timer = setTimeout(() => this.tick(), 400);
                    return;
                }
                this.timer = setTimeout(() => this.tick(), this.DEL_SPEED);
            }
        }
    };

    /* ═══════════════════════════════════════════════════════════
       3. CLI TERMINAL NAVIGATION
       Commands: help, posts, about, articles, contact, links,
                 guestbook, github, cve, clear, whoami, exit
       Hotkeys: Ctrl+K to focus, Escape to close, Tab autocomplete
    ═══════════════════════════════════════════════════════════ */
    const CLI = {
        el: null,
        input: null,
        output: null,
        history: [],
        histIdx: -1,
        overlay: null,
        isOpen: false,

        ROUTES: {
            home:       '/src/pages/index.html',
            posts:      '/src/pages/articles.html',
            articles:   '/src/pages/articles.html',
            about:      '/src/pages/about.html',
            contact:    '/src/pages/contact.html',
            links:      '/src/pages/links.html',
            guestbook:  '/src/pages/guestbook.html'
        },

        HELP_TEXT: `
<span class="cli-comment">┌─── YANMO TERMINAL v2.1 ─────────────────────────────────┐</span>
<span class="cli-comment">│  Navigation:                                             │</span>
<span class="cli-key">│  posts</span>         <span class="cli-val">Browse all articles</span>                      │
<span class="cli-key">│  about</span>         <span class="cli-val">About YanMo</span>                              │
<span class="cli-key">│  contact</span>       <span class="cli-val">Get in touch</span>                             │
<span class="cli-key">│  links</span>         <span class="cli-val">Friend links</span>                             │
<span class="cli-key">│  guestbook</span>     <span class="cli-val">Leave a message</span>                          │
<span class="cli-key">│  github</span>        <span class="cli-val">Open GitHub profile</span>                      │
<span class="cli-comment">│  Filesystem:                                             │</span>
<span class="cli-key">│  ls</span>            <span class="cli-val">List available files</span>                     │
<span class="cli-key">│  cat about.md</span>  <span class="cli-val">Read operator profile</span>                    │
<span class="cli-key">│  cat skills.txt</span><span class="cli-val">Read skill tree</span>                          │
<span class="cli-comment">│  Utilities:                                              │</span>
<span class="cli-key">│  whoami</span>        <span class="cli-val">Identify current user</span>                    │
<span class="cli-key">│  uname</span>         <span class="cli-val">System info</span>                              │
<span class="cli-key">│  ping &lt;host&gt;</span>   <span class="cli-val">Probe a target</span>                           │
<span class="cli-key">│  clear</span>         <span class="cli-val">Clear terminal</span>                           │
<span class="cli-key">│  exit</span>          <span class="cli-val">Close terminal (Esc)</span>                     │
<span class="cli-comment">│  Hotkeys: Ctrl+K open · Esc close · Tab autocomplete    │</span>
<span class="cli-comment">│           ↑↓ command history                            │</span>
<span class="cli-comment">└─────────────────────────────────────────────────────────┘</span>`,

        CMDS: ['help', 'posts', 'articles', 'about', 'contact', 'links',
            'guestbook', 'github', 'whoami', 'clear', 'exit', 'home',
            'cat about.md', 'cat skills.txt', 'ls', 'uname', 'ping'],

        CAT_FILES: {
            'about.md': `<span class="cli-comment"># YanMo — Cyber Operator</span>
<span class="cli-val">Role   :</span> <span class="cli-key">Security Researcher · CTF Player · Red Team Learner</span>
<span class="cli-val">Stack  :</span> <span class="cli-key">Python · Bash · C · JavaScript · x86 ASM</span>
<span class="cli-val">Focus  :</span> <span class="cli-key">Web Exploitation · Binary RE · Network Forensics</span>
<span class="cli-val">CTF    :</span> <span class="cli-key">pwn / web / misc — solo & team</span>
<span class="cli-muted">[ type 'about' to navigate to full profile ]</span>`,
            'skills.txt': `<span class="cli-comment">// OFFENSIVE</span>
<span class="cli-key">Web</span>     <span class="cli-val">SQLi · XSS · SSRF · IDOR · Auth-bypass · Deserialization</span>
<span class="cli-key">Infra</span>   <span class="cli-val">Port-scan · Service enum · Priv-esc · Lateral movement</span>
<span class="cli-key">RE</span>      <span class="cli-val">IDA Free · Ghidra · gdb-pwndbg · pwntools</span>
<span class="cli-comment">// DEFENSIVE</span>
<span class="cli-key">SIEM</span>    <span class="cli-val">Log analysis · Threat hunting · IOC extraction</span>
<span class="cli-key">Secure</span>  <span class="cli-val">CSP · HSTS · WAF · Zero-trust concepts</span>`
        },

        init() {
            this.overlay = document.getElementById('cli-overlay');
            this.el = document.getElementById('cli-terminal');
            this.input = document.getElementById('cli-input');
            this.output = document.getElementById('cli-output');
            if (!this.overlay) return;

            // open button
            document.getElementById('cli-open-btn')?.addEventListener('click', () => this.open());

            // close button
            document.getElementById('cli-close-btn')?.addEventListener('click', () => this.close());

            // overlay backdrop click
            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) this.close();
            });

            // input events
            this.input?.addEventListener('keydown', (e) => this.handleKey(e));

            // global hotkeys
            window.addEventListener('keydown', (e) => {
                if (e.ctrlKey && e.key === 'k') { e.preventDefault(); this.open(); }
                if (e.key === 'Escape' && this.isOpen) this.close();
            });

            this.print(this.HELP_TEXT);
        },

        open() {
            if (!this.overlay) return;
            this.isOpen = true;
            this.overlay.classList.add('active');
            setTimeout(() => this.input?.focus(), 80);
            this.scrollBottom();
        },

        close() {
            this.isOpen = false;
            this.overlay?.classList.remove('active');
            this.input?.blur();
        },

        print(html, cls = '') {
            if (!this.output) return;
            const line = document.createElement('div');
            line.className = 'cli-line ' + cls;
            line.innerHTML = html;
            this.output.appendChild(line);
            this.scrollBottom();
        },

        scrollBottom() {
            if (this.output) this.output.scrollTop = this.output.scrollHeight;
        },

        handleKey(e) {
            if (e.key === 'Enter') {
                const cmd = this.input.value.trim();
                if (cmd) {
                    this.history.unshift(cmd);
                    this.histIdx = -1;
                    this.print('<span class="cli-prompt">yanmo@cyber:~$</span> ' + this.escHtml(cmd));
                    this.run(cmd.toLowerCase());
                }
                this.input.value = '';
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.histIdx < this.history.length - 1) {
                    this.histIdx++;
                    this.input.value = this.history[this.histIdx] || '';
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.histIdx > 0) {
                    this.histIdx--;
                    this.input.value = this.history[this.histIdx] || '';
                } else {
                    this.histIdx = -1;
                    this.input.value = '';
                }
            } else if (e.key === 'Tab') {
                e.preventDefault();
                this.autocomplete();
            }
        },

        autocomplete() {
            const val = this.input.value.trim().toLowerCase();
            if (!val) return;
            const matches = this.CMDS.filter(c => c.startsWith(val));
            if (matches.length === 1) {
                this.input.value = matches[0];
            } else if (matches.length > 1) {
                this.print('<span class="cli-muted">' + matches.join('  ') + '</span>');
            }
        },

        escHtml(s) {
            return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },

        run(cmd) {
            const parts = cmd.split(/\s+/);
            const base = parts[0];
            const arg  = parts.slice(1).join(' ').trim();

            if (this.ROUTES[base]) {
                this.print('<span class="cli-ok">→ Navigating to ' + base + '...</span>');
                setTimeout(() => { window.location.href = this.ROUTES[base]; }, 600);
                return;
            }

            switch (base) {
                case 'help':
                    this.print(this.HELP_TEXT); break;
                case 'clear':
                    this.output.innerHTML = ''; break;
                case 'exit':
                    this.close(); break;
                case 'github':
                    this.print('<span class="cli-ok">→ Opening GitHub...</span>');
                    setTimeout(() => window.open('https://github.com/YanMo5', '_blank', 'noopener,noreferrer'), 400);
                    break;
                case 'whoami':
                    this.print('<span class="cli-val">GUEST_USER // IP: ' + this.escHtml(this.fakeIp()) + ' // CLEARANCE: PUBLIC</span>');
                    break;
                case 'ls':
                    this.print(
                        '<span class="cli-key">about.md</span>  ' +
                        '<span class="cli-key">skills.txt</span>  ' +
                        '<span class="cli-muted">posts/</span>  ' +
                        '<span class="cli-muted">projects/</span>'
                    );
                    break;
                case 'cat': {
                    const content = this.CAT_FILES[arg];
                    if (content) {
                        this.print(content);
                    } else if (!arg) {
                        this.print('<span class="cli-err">usage: cat &lt;filename&gt;</span>');
                    } else {
                        this.print('<span class="cli-err">cat: ' + this.escHtml(arg) + ': No such file</span>');
                        this.print('<span class="cli-muted">Try: cat about.md · cat skills.txt  (or run ls)</span>');
                    }
                    break;
                }
                case 'uname':
                    this.print('<span class="cli-val">YANMO-OS 2.6.37-cyber-hardened #1 SMP x86_64 GNU/Linux</span>');
                    break;
                case 'ping': {
                    const target = this.escHtml(arg || 'localhost');
                    this.print('<span class="cli-muted">PING ' + target + ' — sending ICMP ECHO...</span>');
                    [64, 64, 64].forEach((bytes, i) => {
                        setTimeout(() => {
                            const ms = (Math.random() * 12 + 1).toFixed(3);
                            this.print('<span class="cli-ok">' + bytes + ' bytes from ' + target + ': icmp_seq=' + (i + 1) + ' ttl=64 time=' + ms + ' ms</span>');
                        }, (i + 1) * 420);
                    });
                    break;
                }
                default:
                    this.print('<span class="cli-err">command not found: ' + this.escHtml(base) + ' — type <b>help</b></span>');
            }
        },

        fakeIp() {
            return [
                Math.floor(Math.random() * 200 + 10),
                Math.floor(Math.random() * 255),
                Math.floor(Math.random() * 255),
                Math.floor(Math.random() * 255)
            ].join('.');
        }
    };

    /* ═══════════════════════════════════════════════════════════
       4. GITHUB ARSENAL WIDGET
       Fetches public repos from GitHub API, shows top 6 by stars
    ═══════════════════════════════════════════════════════════ */
    const GitHubWidget = {
        USERNAME: 'YanMo5',
        el: null,

        async init() {
            this.el = document.getElementById('github-arsenal');
            if (!this.el) return;
            this.el.innerHTML = '<div class="widget-loading">[ FETCHING REPOS... ]</div>';
            try {
                const res = await fetch(
                    'https://api.github.com/users/' + this.USERNAME + '/repos?sort=pushed&per_page=6',
                    { headers: { Accept: 'application/vnd.github.v3+json' } }
                );
                if (!res.ok) throw new Error('GitHub API ' + res.status);
                const repos = await res.json();
                this.render(repos);
            } catch (e) {
                this.renderFallback();
            }
        },

        render(repos) {
            if (!repos || repos.length === 0) { this.renderFallback(); return; }
            const sorted = [...repos].sort((a, b) => (b.stargazers_count - a.stargazers_count));
            this.el.innerHTML = sorted.slice(0, 6).map(r => `
                <a class="repo-card" href="${r.html_url}" target="_blank" rel="noopener">
                    <div class="repo-name"><span class="repo-icon">⬡</span> ${this.esc(r.name)}</div>
                    <div class="repo-desc">${this.esc(r.description || 'No description')}</div>
                    <div class="repo-meta">
                        <span class="repo-lang">${this.esc(r.language || '—')}</span>
                        <span class="repo-stars">★ ${r.stargazers_count}</span>
                        <span class="repo-forks">⑂ ${r.forks_count}</span>
                    </div>
                </a>
            `).join('');
        },

        renderFallback() {
            this.el.innerHTML = `
                <a class="repo-card" href="https://github.com/YanMo5" target="_blank" rel="noopener">
                    <div class="repo-name"><span class="repo-icon">⬡</span> yanmo-ctf-notes</div>
                    <div class="repo-desc">CTF writeups & exploit research notes</div>
                    <div class="repo-meta"><span class="repo-lang">Python</span><span class="repo-stars">★ —</span></div>
                </a>
                <a class="repo-card" href="https://github.com/YanMo5" target="_blank" rel="noopener">
                    <div class="repo-name"><span class="repo-icon">⬡</span> web-sec-toolkit</div>
                    <div class="repo-desc">Personal web security automation scripts</div>
                    <div class="repo-meta"><span class="repo-lang">Python</span><span class="repo-stars">★ —</span></div>
                </a>`;
        },

        esc(s) {
            return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
    };

    /* ═══════════════════════════════════════════════════════════
       5. ZERO-DAY / VULNERABILITY ALERT WIDGET
       Pulls from NVD NIST recent CVEs (no key needed, CORS-friendly)
       Falls back to curated static data if API unavailable
    ═══════════════════════════════════════════════════════════ */
    const ZeroDayWidget = {
        el: null,
        STATIC: [
            { id: 'CVE-2025-21298', score: 9.8, desc: 'Windows OLE Remote Code Execution via crafted RTF document', vendor: 'Microsoft' },
            { id: 'CVE-2025-0282',  score: 9.0, desc: 'Ivanti Connect Secure stack-based buffer overflow (0-day in wild)', vendor: 'Ivanti' },
            { id: 'CVE-2024-55591', score: 9.6, desc: 'FortiOS authentication bypass via crafted Node.js WebSocket', vendor: 'Fortinet' },
            { id: 'CVE-2025-21333', score: 7.8, desc: 'Windows Hyper-V NT Kernel heap overflow — LPE', vendor: 'Microsoft' },
        ],

        CACHE_KEY: 'yanmo.nvd.cache.v3',
        CACHE_TTL: 30 * 60 * 1000,

        readCache() {
            try {
                const raw = localStorage.getItem(this.CACHE_KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return null;
                return parsed;
            } catch (_) {
                return null;
            }
        },

        writeCache(items) {
            try {
                localStorage.setItem(this.CACHE_KEY, JSON.stringify({ at: Date.now(), items }));
            } catch (_) { /* storage full / private mode */ }
        },

        stamp(at, prefix) {
            const source = document.querySelector('.nvd-source');
            if (!source) return;
            const time = new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            source.textContent = 'SOURCE: NIST NVD · ' + prefix + ' ' + time;
        },

        async init() {
            this.el = document.getElementById('zeroday-feed');
            if (!this.el) return;

            const cached = this.readCache();
            if (cached) {
                this.render(cached.items);
                const fresh = Date.now() - cached.at < this.CACHE_TTL;
                this.stamp(cached.at, fresh ? 'UPDATED' : 'CACHED');
                if (fresh) return;
            } else {
                // 首屏直接显示可读的示例情报，避免面板长时间空转
                this.render(this.STATIC);
                this.stamp(Date.now(), 'SAMPLE');
            }

            try {
                const end = new Date();
                const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
                const fmt = (d) => d.toISOString().slice(0, 23);
                const url = 'https://services.nvd.nist.gov/rest/json/cves/2.0?cvssV3Severity=CRITICAL&resultsPerPage=4'
                    + '&pubStartDate=' + encodeURIComponent(fmt(start))
                    + '&pubEndDate=' + encodeURIComponent(fmt(end));
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 5000);
                const res = await fetch(url, { signal: ctrl.signal });
                clearTimeout(timer);
                if (!res.ok) throw new Error('NVD ' + res.status);
                const data = await res.json();
                const items = (data.vulnerabilities || []).map(v => ({
                    id: v.cve.id,
                    score: v.cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore
                        || v.cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseScore
                        || '?',
                    desc: v.cve.descriptions?.find(d => d.lang === 'en')?.value || '—',
                    vendor: v.cve.id.split('-')[1] || '—'
                }));
                if (items.length) {
                    this.render(items);
                    this.writeCache(items);
                    this.stamp(Date.now(), 'UPDATED');
                } else {
                    this.render(this.STATIC);
                    this.stamp(Date.now(), 'SAMPLE');
                }
            } catch (_) {
                if (!cached) {
                    this.render(this.STATIC);
                    this.stamp(Date.now(), 'SAMPLE');
                } else {
                    this.stamp(cached.at, 'CACHED');
                }
            }
        },

        render(items) {
            this.el.innerHTML = items.map(item => {
                const score = parseFloat(item.score);
                const sev = score >= 9 ? 'crit' : score >= 7 ? 'high' : 'med';
                const desc = String(item.desc || '—');
                const truncDesc = desc.slice(0, 110) + (desc.length > 110 ? '…' : '');
                return '<div class="alert-item sev-' + sev + '">' +
                    '<div class="alert-header">' +
                        '<span class="alert-id">' + this.esc(item.id) + '</span>' +
                        '<span class="alert-score sev-badge-' + sev + '">' + item.score + '</span>' +
                    '</div>' +
                    '<div class="alert-desc">' + this.esc(truncDesc) + '</div>' +
                '</div>';
            }).join('');
        },

        esc(s) {
            return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
    };

    /* ═══════════════════════════════════════════════════════════
       6. CVE WALL OF FAME
       Static curated list of landmark/famous CVEs
    ═══════════════════════════════════════════════════════════ */
    const CVEWall = {
        HALL: [
            { id: 'CVE-2017-0144', name: 'EternalBlue', score: 9.3, year: 2017, note: 'SMBv1 RCE — WannaCry / NotPetya vector' },
            { id: 'CVE-2021-44228', name: 'Log4Shell',  score: 10.0, year: 2021, note: 'Log4j JNDI injection — instant RCE via log' },
            { id: 'CVE-2014-0160', name: 'Heartbleed',  score: 7.5, year: 2014, note: 'OpenSSL memory leak — 640KB of secrets/req' },
            { id: 'CVE-2021-26084', name: 'Confluence OGNL', score: 9.8, year: 2021, note: 'Atlassian OGNL injection in Confluence' },
            { id: 'CVE-2022-22965', name: 'Spring4Shell', score: 9.8, year: 2022, note: 'Spring MVC data-binding RCE via ClassLoader' },
            { id: 'CVE-2023-44487', name: 'HTTP/2 Rapid Reset', score: 7.5, year: 2023, note: 'Protocol-level DDoS amplification at scale' },
        ],

        init() {
            const el = document.getElementById('cve-wall');
            if (!el) return;
            el.innerHTML = this.HALL.map(c => `
                <div class="cve-entry">
                    <div class="cve-top">
                        <span class="cve-name">${this.esc(c.name)}</span>
                        <span class="cve-score ${c.score >= 9.5 ? 'score-red' : c.score >= 7 ? 'score-orange' : 'score-yellow'}">${c.score}</span>
                    </div>
                    <div class="cve-id">${this.esc(c.id)} · ${c.year}</div>
                    <div class="cve-note">${this.esc(c.note)}</div>
                </div>
            `).join('');
        },

        esc(s) {
            return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
    };

    /* ═══════════════════════════════════════════════════════════
       7. HERO VIDEO — 多场景轮播 / 暂停 / reduced-motion
    ═══════════════════════════════════════════════════════════ */
    const HeroVideo = {
        init() {
            const videos = Array.from(document.querySelectorAll('.hero-video'));
            if (!videos.length) return;

            const PRELOAD_LEAD = 5000;
            let switching = false;
            const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const quoteEl = document.getElementById('hero-video-quote');
            const quoteText = quoteEl && quoteEl.querySelector('blockquote');
            const quoteCite = quoteEl && quoteEl.querySelector('figcaption');
            const badgeEl = document.getElementById('site-video-badge');
            let index = 0;

            const render = (video) => {
                if (badgeEl) badgeEl.textContent = video.dataset.badge || '';
                const isQuote = video.classList.contains('hero-video--quote');
                const stage = document.querySelector('.site-video-bg');
                if (stage) stage.classList.toggle('is-quote-scene', isQuote);
                document.body.classList.toggle('hero-quote-scene', isQuote);
                if (!quoteEl) return;
                const quote = video.dataset.quote || '';
                quoteEl.classList.toggle('is-hidden', !quote);
                quoteEl.setAttribute('aria-hidden', quote ? 'false' : 'true');
                if (quote) {
                    if (quoteText) quoteText.textContent = '“' + quote + '”';
                    if (quoteCite) quoteCite.textContent = video.dataset.cite || '';
                }
            };

            const primeNext = () => {
                const next = videos[(index + 1) % videos.length];
                if (!next || next === videos[index] || next.dataset.primed === '1') return;
                next.dataset.primed = '1';
                next.preload = 'auto';
                if (next.readyState < 2) next.load();
                try {
                    if (next.currentTime > 0.06 || next.ended) next.currentTime = 0;
                } catch (error) { /* metadata not ready */ }
            };

            const switchScene = () => {
                if (switching) return;
                const nextIndex = (index + 1) % videos.length;
                const current = videos[index];
                const next = videos[nextIndex];
                if (!next || next === current) return;
                switching = true;
                next.preload = 'auto';
                if (next.readyState < 2) next.load();

                let swapped = false;
                const swap = () => {
                    if (swapped) return;
                    swapped = true;
                    try {
                        if (next.currentTime > 0.06 || next.ended) next.currentTime = 0;
                    } catch (error) { /* metadata not ready */ }
                    next.classList.add('is-active');
                    current.classList.remove('is-active', 'is-leaving');
                    current.pause();
                    index = nextIndex;
                    render(next);
                    next.play().catch(() => {});
                    window.setTimeout(() => { switching = false; }, 120);
                };

                if (next.readyState >= 2) {
                    swap();
                } else {
                    let fallback = null;
                    const onReady = () => {
                        window.clearTimeout(fallback);
                        swap();
                    };
                    next.addEventListener('canplay', onReady, { once: true });
                    fallback = window.setTimeout(swap, 1400);
                }
            };

            videos.forEach((video, i) => {
                // 每个片段只完整播放一遍；播放结束后再切下一个。
                video.loop = false;
                video.classList.toggle('is-active', i === 0);
                video.addEventListener('timeupdate', () => {
                    if (video !== videos[index]) return;
                    const remain = (video.duration - video.currentTime) * 1000;
                    if (remain <= PRELOAD_LEAD) primeNext();
                });
                video.addEventListener('ended', () => {
                    if (video === videos[index] && !document.hidden && !switching) {
                        switchScene();
                    }
                });
            });
            render(videos[0]);

            if (reduce) {
                videos.forEach((video) => {
                    video.pause();
                    video.removeAttribute('autoplay');
                });
                return;
            }

            // 等首条缓冲到可连续播放再启动，避免冷启动解码丢帧。
            if (videos[0].readyState >= 4) {
                videos[0].play().catch(() => {});
            } else {
                videos[0].addEventListener('canplaythrough', () => videos[0].play().catch(() => {}), { once: true });
                videos[0].addEventListener('canplay', () => {
                    if (videos[0].paused) videos[0].play().catch(() => {});
                }, { once: true });
                window.setTimeout(() => {
                    if (videos[0].paused) videos[0].play().catch(() => {});
                }, 1400);
            }
            // 第一条通常很短，首屏后立即预载下一条。
            window.setTimeout(primeNext, 500);

            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    videos.forEach((video) => video.pause());
                } else {
                    videos[index].play().catch(() => {});
                }
            });
        }
    };

    /* ═══════════════════════════════════════════════════════════
       8. HERO STAT COUNTER — count up once when visible
    ═══════════════════════════════════════════════════════════ */
    const StatsCount = {
        init() {
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const nodes = Array.from(document.querySelectorAll('.hero-stat strong'));
            nodes.forEach((el) => {
                const raw = el.textContent.trim();
                const match = raw.match(/^(\d+)(\D*)$/);
                if (!match) return;
                const target = Number(match[1]);
                const pad = match[1].length;
                const suffix = el.querySelector('span') ? el.querySelector('span').outerHTML : '';
                const observer = new IntersectionObserver((entries) => {
                    entries.forEach((entry) => {
                        if (!entry.isIntersecting) return;
                        observer.unobserve(el);
                        const start = performance.now();
                        const duration = 900;
                        const step = (now) => {
                            const progress = Math.min(1, (now - start) / duration);
                            const eased = 1 - Math.pow(1 - progress, 3);
                            const value = Math.round(target * eased);
                            el.innerHTML = String(value).padStart(pad, '0') + suffix;
                            if (progress < 1) requestAnimationFrame(step);
                        };
                        requestAnimationFrame(step);
                    });
                }, { threshold: 0.5 });
                observer.observe(el);
            });
        }
    };

    /* ═══════════════════════════════════════════════════════════
       9. LATEST WRITE-UPS — homepage window into the archive
    ═══════════════════════════════════════════════════════════ */
    const LatestArticles = {
        async init() {
            const grid = document.getElementById('home-latest-grid');
            if (!grid) return;
            try {
                const response = await fetch('/api/articles?limit=3', { cache: 'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const payload = await response.json();
                const items = (Array.isArray(payload) ? payload : []).slice(0, 3);
                if (!items.length) throw new Error('empty');
                grid.innerHTML = items.map((article) => {
                    const category = String(article.category || 'NOTE');
                    const cover = String(article.cover_image || '').trim();
                    const date = String(article.created_at || '').slice(0, 10).replace(/-/g, '/');
                    const excerpt = this.plain(article.content).slice(0, 92);
                    const coverHtml = cover
                        ? '<span class="home-latest-cover"><img src="' + this.esc(cover) + '" alt="" loading="lazy"></span>'
                        : '<span class="home-latest-cover home-latest-cover--placeholder"><span>' + this.esc(category) + '</span></span>';
                    return '<a class="home-latest-card" href="/post/' + Number(article.id) + '" data-category="' + this.esc(category) + '">' +
                        coverHtml +
                        '<span class="home-latest-body">' +
                            '<span class="home-latest-meta"><span>' + this.esc(category) + '</span><time>' + this.esc(date) + '</time></span>' +
                            '<strong>' + this.esc(article.title || '未命名文章') + '</strong>' +
                            '<span class="home-latest-excerpt">' + this.esc(excerpt) + '</span>' +
                            '<span class="home-latest-link">阅读全文 <span aria-hidden="true">→</span></span>' +
                        '</span>' +
                    '</a>';
                }).join('');
            } catch (_) {
                grid.innerHTML = '<div class="home-latest-empty">文章流暂时不可用。<a href="/src/pages/articles.html">直接进入文章归档 →</a></div>';
            }
        },

        plain(value) {
            return String(value || '')
                .replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, ' ')
                .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
                .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
                .replace(/<[^>]*>/g, ' ')
                .replace(/[#>*_\x60~]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        },

        esc(value) {
            return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }
    };


    /* ═══════════════════════════════════════════════════════════
       8. HERO MOTION — terminal boot typing, spotlight, grid drift
       All three are additive: no-JS and reduced-motion users get the
       static markup untouched.
    ═══════════════════════════════════════════════════════════ */
    const MotionPref = window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : { matches: false, addEventListener: null };

    const TerminalBoot = {
        panel: null,
        code: null,
        nodes: [],
        queue: [],
        index: 0,
        caret: null,
        timer: null,
        currentLine: -1,
        started: false,
        finished: false,

        init() {
            this.panel = document.querySelector('.hero-panel');
            this.code = document.querySelector('.hero-terminal code');
            if (!this.panel || !this.code) return;
            if (MotionPref.matches) return;

            const lines = Array.from(this.code.querySelectorAll('.t-line'));
            if (!lines.length) return;

            lines.forEach((line, lineIndex) => {
                const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, null);
                const textNodes = [];
                let node;
                while ((node = walker.nextNode())) textNodes.push(node);

                textNodes.forEach((textNode) => {
                    const text = textNode.nodeValue;
                    if (!text) return;
                    this.nodes.push({ node: textNode, text });
                    Array.from(text).forEach((ch) => {
                        this.queue.push({ node: textNode, ch, line: lineIndex });
                    });
                    textNode.nodeValue = '';
                });
            });

            if (MotionPref.addEventListener) {
                MotionPref.addEventListener('change', (event) => {
                    if (event.matches) this.finish();
                });
            }

            this.panel.addEventListener('pointerdown', () => this.finish(), { once: true });
            this.arm();
        },

        arm() {
            if (!('IntersectionObserver' in window)) {
                this.start(600);
                return;
            }
            const observer = new IntersectionObserver((entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                observer.disconnect();
                // 卡片入场 260ms + 760ms 结束；预留一点空白后再敲
                this.start(Math.max(220, 980 - performance.now()));
            }, { threshold: 0.25 });
            observer.observe(this.panel);
        },

        start(delay) {
            if (this.started) return;
            this.started = true;
            this.timer = setTimeout(() => this.step(), delay);
        },

        step() {
            if (this.finished) return;
            if (document.hidden) {
                this.timer = setTimeout(() => this.step(), 400);
                return;
            }

            const item = this.queue[this.index++];
            if (!item) {
                this.finish();
                return;
            }

            item.node.nodeValue += item.ch;
            this.placeCaret(item.node);

            const gap = item.line !== this.currentLine
                ? 110
                : (item.ch === ' ' ? 6 : 13);
            this.currentLine = item.line;
            this.timer = setTimeout(() => this.step(), gap);
        },

        placeCaret(node) {
            if (!this.caret) {
                this.caret = document.createElement('span');
                this.caret.className = 't-caret';
                this.caret.setAttribute('aria-hidden', 'true');
            }
            if (this.caret.parentNode === node.parentNode && this.caret.previousSibling === node) {
                return;
            }
            node.parentNode.insertBefore(this.caret, node.nextSibling);
        },

        finish() {
            if (this.finished) return;
            this.finished = true;
            clearTimeout(this.timer);
            this.nodes.forEach(({ node, text }) => { node.nodeValue = text; });
            if (this.caret) {
                const caret = this.caret;
                this.caret = null;
                setTimeout(() => { caret.remove(); }, 2600);
            }
        }
    };

    const HeroSpotlight = {
        init() {
            if (MotionPref.matches) return;
            if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
            const panel = document.querySelector('.hero-panel');
            const spot = panel && panel.querySelector('.hero-spot');
            if (!panel || !spot) return;

            let frame = 0;
            let px = 0;
            let py = 0;

            panel.addEventListener('pointermove', (event) => {
                const rect = panel.getBoundingClientRect();
                px = event.clientX - rect.left;
                py = event.clientY - rect.top;
                if (frame) return;
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    spot.style.transform = 'translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)';
                });
            }, { passive: true });
        }
    };

    const GridParallax = {
        init() {
            const inner = document.querySelector('.ym-grid-inner');
            if (!inner || MotionPref.matches) return;

            let frame = 0;
            const apply = () => {
                frame = 0;
                const shift = Math.min(120, Math.max(0, (window.scrollY || 0) * 0.04));
                inner.style.setProperty('--ym-grid-shift', shift.toFixed(2) + 'px');
            };

            window.addEventListener('scroll', () => {
                if (frame) return;
                frame = requestAnimationFrame(apply);
            }, { passive: true });

            apply();
        }
    };

    /* ═══════════════════════════════════════════════════════════
       BOOT SEQUENCE
    ═══════════════════════════════════════════════════════════ */
    function boot() {
        CanvasBG.init();
        Typewriter.init();
        HeroVideo.init();
        TerminalBoot.init();
        HeroSpotlight.init();
        GridParallax.init();
        StatsCount.init();
        CLI.init();
        GitHubWidget.init();
        ZeroDayWidget.init();
        CVEWall.init();
        LatestArticles.init();

        // Animate section reveals on scroll
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(e => {
                if (e.isIntersecting) {
                    e.target.classList.add('visible');
                    observer.unobserve(e.target);
                }
            });
        }, { threshold: 0.08 });
        document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    // expose for debugging
    window.YanMoCLI = CLI;

})(window);