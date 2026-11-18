document.addEventListener('DOMContentLoaded', () => {
    // --- Hamburger Menu Toggle ---
    const hamburger = document.querySelector('.hamburger');
    const navLinks = document.querySelector('.nav-links');
    
    if (hamburger && navLinks) {
        // 汉堡图标的形变：Lumina 皮肤用 CSS（.hamburger.open span）实现，
        // 赛博皮肤依赖内联变换（legacy CSS 没有 .open 规则）。
        const syncHamburgerSpans = () => {
            const spans = hamburger.querySelectorAll('span');
            const isLumina = document.documentElement.dataset.skin === 'lumina';
            const isOpen = hamburger.classList.contains('open');

            spans.forEach(span => {
                span.style.transform = '';
                span.style.opacity = '';
            });

            if (isLumina) return;

            if (isOpen) {
                spans[0].style.transform = 'rotate(45deg)';
                spans[1].style.opacity = '0';
                spans[2].style.transform = 'rotate(-45deg)';
            }
        };

        if (!hamburger.hasAttribute('aria-expanded')) {
            hamburger.setAttribute('aria-expanded', 'false');
        }

        hamburger.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            hamburger.classList.toggle('open');
            hamburger.setAttribute('aria-expanded', String(hamburger.classList.contains('open')));
            syncHamburgerSpans();
        });

        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                navLinks.classList.remove('active');
                hamburger.classList.remove('open');
                hamburger.setAttribute('aria-expanded', 'false');
                syncHamburgerSpans();
            });
        });

        // 运行时切换皮肤后重新同步图标形态
        document.addEventListener('yanmo:themechange', syncHamburgerSpans);
    }

    // --- Scroll Reveal Animation ---
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('active');
            }
        });
    }, observerOptions);

    const revealElements = document.querySelectorAll('.reveal');
    revealElements.forEach(el => revealObserver.observe(el));

    // --- Top Nav Scroll Effects ---
    const pageHeader = document.querySelector('header');
    const navItems = document.querySelectorAll('.nav-links a');
    const activeNavItem = document.querySelector('.nav-links a.active');

    if (pageHeader) {
        let progressEl = pageHeader.querySelector('.nav-scroll-progress');
        if (!progressEl) {
            progressEl = document.createElement('div');
            progressEl.className = 'nav-scroll-progress';
            pageHeader.appendChild(progressEl);
        }
    }

    let lastScrollY = window.scrollY || window.pageYOffset || 0;
    let navHidden = false;
    let accumulatedDelta = 0;
    let ticking = false;

    const updateNavOnScroll = () => {
        const y = window.scrollY || window.pageYOffset || 0;
        const scrollDelta = y - lastScrollY;
        const scrollableHeight = Math.max(
            document.documentElement.scrollHeight - window.innerHeight,
            1
        );
        const progress = Math.min(y / scrollableHeight, 1);

        document.documentElement.style.setProperty('--page-scroll-progress', progress.toFixed(4));

        if (pageHeader) {
            pageHeader.classList.toggle('is-scrolled', y > 20);
            pageHeader.classList.toggle('is-deep-scrolled', y > 180);

            const isMobile = window.innerWidth <= 768;
            const isMenuOpen = !!(navLinks && navLinks.classList.contains('active'));

            if (isMobile || isMenuOpen || y < 80) {
                pageHeader.classList.remove('nav-hidden');
                navHidden = false;
                accumulatedDelta = 0;
            } else if (Math.abs(scrollDelta) > 1) {
                if (scrollDelta > 0 && accumulatedDelta < 0) {
                    accumulatedDelta = 0;
                }
                if (scrollDelta < 0 && accumulatedDelta > 0) {
                    accumulatedDelta = 0;
                }

                accumulatedDelta += scrollDelta;

                if (!navHidden && accumulatedDelta > 24 && y > 140) {
                    pageHeader.classList.add('nav-hidden');
                    navHidden = true;
                    accumulatedDelta = 0;
                } else if (navHidden && accumulatedDelta < -18) {
                    pageHeader.classList.remove('nav-hidden');
                    navHidden = false;
                    accumulatedDelta = 0;
                }
            }
        }

        if (activeNavItem) {
            activeNavItem.classList.toggle('scroll-active', y > 60);
        }

        navItems.forEach((item, index) => {
            const shift = Math.sin(progress * 6 + index * 0.8) * 1.6;
            item.style.setProperty('--crumb-shift', shift.toFixed(2) + 'px');
        });

        lastScrollY = y;
        ticking = false;
    };

    const onScroll = () => {
        if (!ticking) {
            window.requestAnimationFrame(updateNavOnScroll);
            ticking = true;
        }
    };

    updateNavOnScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // --- Dynamic System Status ---
    const navActions = document.querySelector('.nav-actions');
    if (navActions) {
        const statusEl = document.createElement('div');
        statusEl.className = 'nav-status';
        navActions.prepend(statusEl);

        let cachedStatsText = '';
        let cachedLvl = 'GUEST_USER';

        // Clock updates every second (client-only — no API call)
        const tickClock = () => {
            const clockEl = statusEl.querySelector('.status-clock');
            if (clockEl) {
                clockEl.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            }
        };

        // Stats + auth state refresh every 60 seconds
        const updateStatus = async () => {
            if (window.SiteLocalApi) {
                cachedLvl = window.SiteLocalApi.isAdminLoggedIn() ? 'ROOT_NODE' : 'GUEST_USER';
            }

            try {
                const response = await fetch('/api/stats');
                if (response.ok) {
                    const stats = await response.json();
                    cachedStatsText = stats.published_articles != null
                        ? ` [ITEMS: ${stats.published_articles}]`
                        : '';
                }
            } catch (e) {
                // Silently fail if API is down
            }

            const syncStatus = ['STABLE', 'SYNCING', 'ENCRYPTED'][Math.floor(Math.random() * 3)];
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });

            statusEl.innerHTML = `
                <span class="status-pulse"></span>
                <span class="status-id">> ID_${cachedLvl}</span>
                <span class="status-data">${cachedStatsText}</span>
                <span class="status-sync">[${syncStatus}]</span>
                <span class="status-clock">${time}</span>
            `;
        };

        updateStatus();
        setInterval(updateStatus, 60000);
        setInterval(tickClock, 1000);
    }

    // --- Back to Top Button ---
    const LEGACY_BACK_TO_TOP_STYLE = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        width: 50px;
        height: 50px;
        background: rgba(var(--bg-color-r), var(--bg-color-g), var(--bg-color-b), 0.8);
        border: 1px solid var(--primary-color);
        color: var(--primary-color);
        border-radius: 50%;
        cursor: pointer;
        display: none;
        z-index: 999;
        font-size: 1.5rem;
        box-shadow: 0 0 10px var(--primary-color);
        transition: all 0.3s ease;
    `;

    const backToTop = document.createElement('button');
    backToTop.type = 'button';
    backToTop.id = 'back-to-top';
    backToTop.className = 'back-to-top';
    backToTop.innerHTML = '&#8679;';
    backToTop.setAttribute('aria-label', '回到顶部');
    backToTop.title = '回到顶部';
    document.body.appendChild(backToTop);

    const isLuminaSkin = () => document.documentElement.dataset.skin === 'lumina';

    const syncBackToTopVisibility = () => {
        const visible = window.pageYOffset > 300;
        backToTop.style.display = visible ? 'block' : 'none';
        backToTop.classList.toggle('is-visible', visible);
    };

    // Lumina 皮肤：外观与定位全部交给 theme-lumina.css（可随明暗切换）
    // 赛博皮肤：沿用原来的内联样式，避免改动 legacy CSS
    const syncBackToTopSkin = () => {
        if (isLuminaSkin()) {
            backToTop.removeAttribute('style');
        } else {
            backToTop.style.cssText = LEGACY_BACK_TO_TOP_STYLE;
        }
        syncBackToTopVisibility();
    };

    syncBackToTopSkin();
    document.addEventListener('yanmo:themechange', syncBackToTopSkin);

    window.addEventListener('scroll', syncBackToTopVisibility, { passive: true });

    backToTop.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    backToTop.addEventListener('mouseenter', () => {
        if (isLuminaSkin()) return;
        backToTop.style.boxShadow = '0 0 20px var(--theme-secondary)';
        backToTop.style.borderColor = 'var(--theme-secondary)';
        backToTop.style.color = 'var(--theme-secondary)';
    });

    backToTop.addEventListener('mouseleave', () => {
        if (isLuminaSkin()) return;
        backToTop.style.boxShadow = '0 0 10px var(--primary-color)';
        backToTop.style.borderColor = 'var(--primary-color)';
        backToTop.style.color = 'var(--primary-color)';
    });
});

// ==========================================
// Matrix Digital Rain Background
// ==========================================
function initMatrixRain() {
    // Lumina 皮肤不使用暗码雨背景：视觉由主题渐变 + 光晕承担，跳过可省下整屏 rAF 开销
    if (document.documentElement.dataset.skin === 'lumina') return;
    // home-page.js owns #cyber-canvas with a rAF loop.
    // Only activate this fallback renderer on pages that don't load home-page.js.
    if (document.getElementById('cyber-canvas')) return;
    if (document.getElementById('matrix-canvas')) return;

    const canvas = document.createElement('canvas');
    canvas.id = 'matrix-canvas';
    canvas.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        z-index: -1;
        opacity: 0.08;
        pointer-events: none;
    `;
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    let width = canvas.width = window.innerWidth;
    let height = canvas.height = window.innerHeight;

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()?'.split('');
    const fontSize = 14;
    let columns = Math.floor(width / fontSize);
    let drops = Array(columns).fill(1);
    let rafId = null;

    // Read palette CSS variables so the matrix rain follows the
    // background/primary color pickers instead of hard-coded values.
    function readRgb(prefix) {
        const cs = getComputedStyle(document.documentElement);
        return {
            r: parseInt(cs.getPropertyValue(prefix + '-r').trim(), 10) || 0,
            g: parseInt(cs.getPropertyValue(prefix + '-g').trim(), 10) || 0,
            b: parseInt(cs.getPropertyValue(prefix + '-b').trim(), 10) || 0,
        };
    }

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
            columns = Math.floor(width / fontSize);
            drops = Array(columns).fill(1);
        }, 200);
    });

    function draw() {
        rafId = requestAnimationFrame(draw);
        const bg = readRgb('--bg-color');
        const main = readRgb('--primary-color');
        ctx.fillStyle = `rgba(${bg.r},${bg.g},${bg.b},0.05)`;
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = `rgba(${main.r},${main.g},${main.b},0.9)`;
        ctx.font = fontSize + 'px monospace';

        for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(text, i * fontSize, drops[i] * fontSize);
            if (drops[i] * fontSize > height && Math.random() > 0.975) {
                drops[i] = 0;
            }
            drops[i]++;
        }
    }

    draw();
}

// ==========================================
// Global Page Transition Effect
// ==========================================
function initPageTransitions() {
    // Lumina 皮肤追求「即时」的页面切换，跳过 600ms 全屏遮罩转场
    if (document.documentElement.dataset.skin === 'lumina') return;
    const overlay = document.createElement('div');
    overlay.className = 'page-transition-overlay';
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: var(--bg-color);
        z-index: 9999;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.6s ease;
    `;
    document.body.appendChild(overlay);

    document.querySelectorAll('a:not([target="_blank"]):not([href^="#"]):not([href^="javascript"])').forEach(link => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            if (!href || href === '#') return;
            
            e.preventDefault();
            overlay.style.pointerEvents = 'auto';
            overlay.style.opacity = '1';
            
            setTimeout(() => {
                window.location.href = href;
            }, 600);
        });
    });

    window.addEventListener('pageshow', () => {
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
    });
}

// ==========================================
// Code Block Enhancements
// ==========================================
function initCodeEnhancements() {
    const preBlocks = document.querySelectorAll('pre');
    if (preBlocks.length === 0) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    // 说明：原实现的 SRI 摘要与 CDN 实际内容不符，会整段被浏览器拦截，
    // 导致代码块从未高亮。这里使用实测过的 sha512 摘要（版本号固定）。
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css';
    link.integrity = 'sha512-vswe+cgvic/XBoF1OcM/TeJ2FW0OofqAVdCZiEYkd6dwGXthvkSFWOoGGJgS2CW70VK5dQM5Oh+7ne47s74VTg==';
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js';
    script.integrity = 'sha512-7Z9J3l1+EYfeaPKcGXu3MS/7T+w19WtKQY/n+xzmw4hZhJ9tyYmcUS+4QqAlzhicE5LAfMQSF3iFTK9bQdTxXg==';
    script.crossOrigin = 'anonymous';
    script.onload = () => {
        const autoloader = document.createElement('script');
        autoloader.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js';
        autoloader.integrity = 'sha512-SkmBfuA2hqjzEVpmnMt/LINrjop3GKWqsuLSSB3e7iBmYK7JuWw4ldmmxwD9mdm2IRTTi0OxSAfEGvgEi0i2Kw==';
        autoloader.crossOrigin = 'anonymous';
        document.head.appendChild(autoloader);
        
        preBlocks.forEach(pre => {
            pre.classList.add('line-numbers');

            const useLumina = document.documentElement.dataset.skin === 'lumina';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = useLumina ? 'cyber-copy-btn lm-copy-btn' : 'cyber-copy-btn';
            btn.textContent = useLumina ? '复制' : '</ Copy >';

            if (!useLumina) {
                btn.style.cssText = `
                position: absolute;
                top: 8px;
                right: 8px;
                padding: 4px 12px;
                background: rgba(0, 255, 255, 0.1);
                border: 1px solid #0ff;
                color: #0ff;
                border-radius: 4px;
                cursor: pointer;
                font-family: monospace;
                font-size: 0.8rem;
                transition: all 0.3s;
            `;
            }

            btn.addEventListener('click', () => {
                const done = () => {
                    btn.textContent = useLumina ? '已复制' : 'COPIED!';
                    btn.classList.add('is-copied');
                    if (!useLumina) btn.style.color = '#0f0';
                    setTimeout(() => {
                        btn.textContent = useLumina ? '复制' : '</ Copy >';
                        btn.classList.remove('is-copied');
                        if (!useLumina) btn.style.color = '#0ff';
                    }, 2000);
                };

                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(pre.textContent).then(done).catch(done);
                } else {
                    done();
                }
            });
            pre.style.position = 'relative';
            pre.appendChild(btn);
        });
    };
    document.head.appendChild(script);
}

// Initialize all enhancements
document.addEventListener('DOMContentLoaded', () => {
    initMatrixRain();
    initPageTransitions();
    initCodeEnhancements();
});