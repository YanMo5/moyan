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

    // --- Nav Shell: per-page path + UTC+8 clock ---
    // 在 Logo 后接一条 shell 状态（仅桌面显示）：
    //   > ~/home   ● 23:24
    // 页面路径来自 location.pathname，时钟固定按 UTC+8，避免访客异地时含义漂移。
    const navEl = document.querySelector('header nav');
    const logoEl = navEl && navEl.querySelector('.logo');
    if (logoEl) {
        const trimmed = window.location.pathname.replace(/\/+$/, '');
        let page = trimmed.split('/').pop() || 'home';
        page = page.replace(/\.html$/, '');
        if (page === 'index') page = 'home';
        if (window.location.pathname.indexOf('/post/') === 0) page = 'post';

        const shell = document.createElement('div');
        shell.className = 'nav-shell';
        shell.setAttribute('aria-hidden', 'true');

        const pathEl = document.createElement('span');
        pathEl.className = 'nav-path';
        pathEl.textContent = '~/' + page;

        // 实时往返延迟：直接测浏览器到本站 /api/stats 的 RTT。
        const latencyWrap = document.createElement('span');
        latencyWrap.className = 'nav-latency is-checking';
        latencyWrap.setAttribute('role', 'status');
        latencyWrap.setAttribute('aria-label', '正在检测实时延迟');
        latencyWrap.title = '到本站服务器的实时往返延迟';
        const latencyDot = document.createElement('i');
        latencyDot.setAttribute('aria-hidden', 'true');
        const latencyValue = document.createElement('span');
        latencyValue.className = 'nav-latency-value';
        latencyValue.textContent = '--';
        const latencyUnit = document.createElement('em');
        latencyUnit.textContent = 'ms';
        latencyWrap.appendChild(latencyDot);
        latencyWrap.appendChild(latencyValue);
        latencyWrap.appendChild(latencyUnit);

        let latencyBusy = false;
        const updateLatency = async () => {
            if (latencyBusy || document.hidden) return;
            latencyBusy = true;
            const startedAt = performance.now();
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 5000);
            try {
                const response = await fetch('/api/stats?ping=' + Date.now(), {
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                    signal: controller.signal
                });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const ms = Math.max(0, Math.round(performance.now() - startedAt));
                const level = ms < 40 ? 'is-fast' : ms < 100 ? 'is-ok' : ms < 200 ? 'is-warn' : 'is-bad';
                latencyWrap.className = 'nav-latency ' + level;
                latencyWrap.setAttribute('aria-label', '实时延迟 ' + ms + ' 毫秒');
                latencyWrap.title = '到本站服务器的实时往返延迟：' + ms + ' ms';
                latencyValue.textContent = String(ms);
            } catch (error) {
                latencyWrap.className = 'nav-latency is-offline';
                latencyWrap.setAttribute('aria-label', '实时延迟不可用');
                latencyWrap.title = '暂时无法连接本站服务器';
                latencyValue.textContent = '--';
            } finally {
                window.clearTimeout(timeout);
                latencyBusy = false;
            }
        };

        const clockWrap = document.createElement('span');
        clockWrap.className = 'nav-clock';
        clockWrap.title = 'UTC+8 本地时间';
        const dot = document.createElement('i');
        const timeEl = document.createElement('time');
        timeEl.textContent = '--:--';
        clockWrap.appendChild(dot);
        clockWrap.appendChild(timeEl);

        shell.appendChild(pathEl);
        shell.appendChild(clockWrap);
        logoEl.insertAdjacentElement('afterend', shell);
        // 参考布局隐藏了路径/时钟；延迟徽标直接挂在 Logo 后。
        logoEl.appendChild(latencyWrap);

        updateLatency();
        window.setInterval(updateLatency, 8000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) updateLatency();
        });

        const clockFormat = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        });
        const tickNavClock = () => {
            const now = new Date();
            timeEl.textContent = clockFormat.format(now);
            timeEl.setAttribute('datetime', now.toISOString());
        };
        tickNavClock();
        window.setInterval(tickNavClock, 15000);
    }

    // 二级导航：按当前页生成一枚胶囊快捷入口（图标 + 中文）
    const NAV_ICON_PATHS = {
        file: '<path d="M6 3h9l5 5v13H6z"/><path d="M14 3v6h6"/><path d="M9 13h6M9 17h6"/>',
        github: '<path d="M9 19c-4 1.5-4-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 3.8 5.4 4.1 5.4 4.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 10.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
        shield: '<path d="M12 3l8 4v6c0 4.5-3.4 7.5-8 8-4.6-.5-8-3.5-8-8V7z"/>',
        rss: '<path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="6" cy="18" r="1.5"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
        folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        tag: '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
        user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
        chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
        route: '<circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h6a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h4"/>',
        mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
        image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 15-5-5L5 20"/>',
        archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
        chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
        tools: '<path d="M4 20h16M6 20V9l6-4 6 4v11"/><path d="M9 20v-6h6v6M9 9h6"/>',
        compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.4-4.4 2.1 2.1-4.4z"/>',
        fingerprint: '<path d="M6 10a6 6 0 0 1 12 0v4a6 6 0 0 1-2 4"/><path d="M9 11a3 3 0 0 1 6 0v5"/><path d="M12 11v8"/><path d="M4 14v3M20 14v3"/>',
        send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>'
    };
    const SUBNAV = {
        articles: [
            { label: '分类', href: '/src/pages/categories.html', icon: 'folder' },
            { label: '标签', href: '/src/pages/tags.html', icon: 'tag' },
            { label: '归档', href: '/src/pages/articles.html#archive', icon: 'archive' },
            { label: '统计', href: '/src/pages/stats.html', icon: 'chart' },
            { label: 'RSS 订阅', href: '/src/pages/rss.html', icon: 'rss' }
        ],
        links: [
            { label: '友人帐', href: '/src/pages/links.html#links-groups-container', icon: 'link' },
            { label: '申请友链', href: '/src/pages/link-apply.html', icon: 'send' },
            { label: '留言板', href: '/src/pages/guestbook.html', icon: 'chat' }
        ],
        daily: [
            { label: '日常', href: '/src/pages/daily.html', icon: 'file' },
            { label: '工具库', href: '/src/pages/tools.html', icon: 'tools' },
            { label: '联系', href: '/src/pages/contact.html', icon: 'mail' }
        ],
        tools: [
            { label: '全部工具', href: '/src/pages/tools.html', icon: 'folder' },
            { label: '网络安全', href: '/src/pages/tools.html#tools-grid', icon: 'shield' },
            { label: '上传说明', href: '/src/pages/tools.html#tool-upload', icon: 'archive' }
        ],
        about: [
            { label: '随便逛逛', href: '#random-article', icon: 'compass', action: 'random-article' },
            { label: '隐私协议', href: '/src/pages/privacy.html', icon: 'fingerprint' },
            { label: '关于本人', href: '/src/pages/about.html#whoami', icon: 'send' }
        ]
    };

    const headerEl = document.querySelector('header');
    const mainNav = document.querySelector('header nav');
    const hoverLinks = document.querySelectorAll('.nav-links > li > a');

    let subPanel = null;
    let subInner = null;
    let closeTimer = null;

    const keyForLink = (link) => {
        const href = link.getAttribute('href') || '';
        const file = href.split('/').pop().replace(/\.html$/, '');
        if (!file || file === 'index') return 'index';
        return file;
    };

    let randomArticleLoading = false;

    const openRandomArticle = async () => {
        if (randomArticleLoading) return;
        randomArticleLoading = true;

        const fallback = () => {
            window.location.href = '/src/pages/articles.html';
        };

        try {
            const response = await fetch('/api/articles?limit=50', {
                headers: { Accept: 'application/json' },
                cache: 'no-store'
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const articles = await response.json();
            const list = Array.isArray(articles) ? articles.filter((item) => item && item.id != null) : [];
            if (!list.length) throw new Error('No articles');

            const pick = list[Math.floor(Math.random() * list.length)];
            const target = '/src/pages/post.html?id=' + encodeURIComponent(pick.id);

            // 用一个临时链接触发站点已有的页面转场，而不是硬跳转
            const anchor = document.createElement('a');
            anchor.href = target;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        } catch (error) {
            fallback();
        } finally {
            randomArticleLoading = false;
        }
    };

    const makeSubLink = (item) => {
        const link = document.createElement('a');
        link.href = item.href;
        if (/^https?:/i.test(item.href)) {
            link.target = '_blank';
            link.rel = 'noopener';
        }
        if (item.action === 'random-article') {
            link.setAttribute('aria-label', '随机打开一篇文章');
            link.addEventListener('click', (event) => {
                event.preventDefault();
                openRandomArticle();
            });
        }

        const icon = document.createElement('span');
        icon.className = 'nav-ico';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (NAV_ICON_PATHS[item.icon] || '') + '</svg>';

        const label = document.createElement('span');
        label.textContent = item.label;

        link.appendChild(icon);
        link.appendChild(label);
        return link;
    };

    const clearHover = () => {
        document.querySelectorAll('.nav-links a.is-hovered').forEach((link) => {
            link.classList.remove('is-hovered');
        });
    };

    const closeSub = () => {
        window.clearTimeout(closeTimer);
        if (subPanel) subPanel.classList.remove('is-open');
        if (headerEl) headerEl.classList.remove('nav-previewing');
        clearHover();
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const desktopNav = window.matchMedia('(min-width: 921px)');

    const playNavClick = (link) => {
        if (reduceMotion.matches) return;
        link.classList.remove('is-clicked');
        const oldRing = link.querySelector('.nav-click-ring');
        if (oldRing) oldRing.remove();
        void link.offsetWidth;
        link.classList.add('is-clicked');

        const ring = document.createElement('span');
        ring.className = 'nav-click-ring';
        ring.setAttribute('aria-hidden', 'true');
        link.appendChild(ring);

        // 每次点击使用独立 token，避免上一次点击的清理计时器截断新动画
        const token = String(Number(link.dataset.navClickToken || 0) + 1);
        link.dataset.navClickToken = token;
        window.setTimeout(() => {
            if (link.dataset.navClickToken !== token) return;
            link.classList.remove('is-clicked');
        }, 360);
        window.setTimeout(() => {
            if (ring.parentNode) ring.remove();
        }, 480);
    };

    const openSub = (link) => {
        if (!subPanel || !subInner) return;
        const items = SUBNAV[keyForLink(link)];
        if (!items || !items.length) {
            closeSub();
            return;
        }

        window.clearTimeout(closeTimer);
        subInner.textContent = '';
        items.forEach((item) => subInner.appendChild(makeSubLink(item)));

        clearHover();
        link.classList.add('is-hovered');
        headerEl.classList.add('nav-previewing');
        subPanel.classList.add('is-open');
    };

    if (headerEl && mainNav && hoverLinks.length) {
        subPanel = document.createElement('nav');
        subPanel.className = 'nav-sub';
        subPanel.setAttribute('aria-label', '页面快捷入口');
        subInner = document.createElement('div');
        subInner.className = 'nav-sub-inner';
        subPanel.appendChild(subInner);
        mainNav.insertAdjacentElement('afterend', subPanel);

        hoverLinks.forEach((link) => {
            link.addEventListener('mouseenter', () => openSub(link));
            link.addEventListener('focus', () => openSub(link));

            // 桌面端一级导航只负责展开二级，不再跳转；移动端保留正常跳转。
            link.addEventListener('click', (event) => {
                if (!desktopNav.matches) return;
                event.preventDefault();
                playNavClick(link);
                openSub(link);
            });

            link.addEventListener('keydown', (event) => {
                if (!desktopNav.matches) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                playNavClick(link);
                openSub(link);
            });
        });

        mainNav.addEventListener('mouseenter', () => window.clearTimeout(closeTimer));
        mainNav.addEventListener('mouseleave', () => {
            window.clearTimeout(closeTimer);
            closeTimer = window.setTimeout(closeSub, 150);
        });

        subPanel.addEventListener('mouseenter', () => window.clearTimeout(closeTimer));
        subPanel.addEventListener('mouseleave', () => {
            window.clearTimeout(closeTimer);
            closeTimer = window.setTimeout(closeSub, 120);
        });

        headerEl.addEventListener('mouseleave', () => {
            window.clearTimeout(closeTimer);
            closeTimer = window.setTimeout(closeSub, 120);
        });

        headerEl.addEventListener('mouseenter', () => window.clearTimeout(closeTimer));

        // 固定定位的 header 在部分浏览器里 mouseleave 不稳定，补一层指针位置兜底
        document.addEventListener('mousemove', (event) => {
            if (!subPanel || !subPanel.classList.contains('is-open')) return;
            if (headerEl.contains(event.target)) return;
            window.clearTimeout(closeTimer);
            closeTimer = window.setTimeout(closeSub, 120);
        }, { passive: true });

        headerEl.addEventListener('focusout', () => {
            window.setTimeout(() => {
                if (!headerEl.contains(document.activeElement)) closeSub();
            }, 80);
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeSub();
        });

        window.addEventListener('scroll', closeSub, { passive: true });
        window.addEventListener('resize', closeSub);

        subPanel.addEventListener('click', (event) => {
            const link = event.target.closest('a');
            if (!link) return;
            closeSub();

            // 已经在本页时，二级锚点直接滚动，避免整页重新加载
            const targetUrl = new URL(link.href, window.location.href);
            if (targetUrl.pathname === window.location.pathname && targetUrl.hash) {
                const target = document.querySelector(targetUrl.hash);
                if (target) {
                    event.preventDefault();
                    window.history.replaceState({}, '', targetUrl.pathname + targetUrl.search + targetUrl.hash);
                    target.scrollIntoView({
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                        block: 'start'
                    });
                }
            }
        });
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
    const NAV_TRANSITION_KEY = 'yanmo.site.nav-transition';
    const TRANSITION_SEEN_KEY = 'yanmo.site.transition-seen';
    const root = document.documentElement;

    /* 新页面首屏交接：theme-boot 已提前加上 ym-entering，这里负责淡出 */
    if (root.classList.contains('ym-entering')) {
        requestAnimationFrame(() => {
            root.classList.add('ym-enter-done');
            window.setTimeout(() => {
                root.classList.remove('ym-entering', 'ym-enter-done');
            }, 360);
        });
    }

    const overlay = document.createElement('div');
    overlay.className = 'ym-page-transition';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('role', 'status');
    overlay.innerHTML = [
        '<div class="ym-pt-inner">',
        '  <div class="ym-pt-stage" aria-hidden="true">',
        '    <span class="ym-pt-orbit"></span>',
        '    <span class="ym-pt-orbit ym-pt-orbit--two"></span>',
        '    <svg class="ym-pt-ring" viewBox="0 0 100 100" aria-hidden="true">',
        '      <circle class="ym-pt-ring-track" cx="50" cy="50" r="46" pathLength="100"></circle>',
        '      <circle class="ym-pt-ring-value" cx="50" cy="50" r="46" pathLength="100"></circle>',
        '    </svg>',
        '    <span class="ym-pt-mark"><span class="ym-pt-mark-letter" aria-hidden="true">Y</span><img src="/assets/images/site-avatar.png" alt=""></span>',
        '    <span class="ym-pt-scan"></span>',
        '  </div>',
        '  <div class="ym-pt-brand">YANMO <span>LABS</span></div>',
        '  <div class="ym-pt-signature">YanMo <span>安全研究笔记</span></div>',
        '  <div class="ym-pt-target"><span class="ym-pt-prompt">去往</span><span class="ym-pt-path">/</span><span class="ym-pt-cursor" aria-hidden="true"></span></div>',
        '  <div class="ym-pt-bar" aria-hidden="true"><span></span><i class="ym-pt-bar-dot"></i></div>',
        '  <div class="ym-pt-meta"><span class="ym-pt-status">正在翻页</span><span class="ym-pt-percent" aria-hidden="true">0%</span></div>',
        '</div>'
    ].join('');
    document.body.appendChild(overlay);

    const pathEl = overlay.querySelector('.ym-pt-path');
    const statusEl = overlay.querySelector('.ym-pt-status');
    const percentEl = overlay.querySelector('.ym-pt-percent');
    const fillEl = overlay.querySelector('.ym-pt-bar span');
    const dotEl = overlay.querySelector('.ym-pt-bar-dot');
    const ringEl = overlay.querySelector('.ym-pt-ring-value');
    const NAV_DELAY = 1050;
    const REPEAT_NAV_DELAY = 850;
    let activeDelay = NAV_DELAY;
    const STATUS_STEPS = [
        { at: 0, label: '正在翻页' },
        { at: 28, label: '下一站' },
        { at: 58, label: '就快到了' },
        { at: 86, label: '马上就好' },
        { at: 100, label: '欢迎来到' }
    ];

    let navigating = false;
    let timer = null;
    let raf = null;
    let startTime = 0;
    let lastStatus = '';

    const PAGE_LABELS = {
        '/': '首页',
        '/index.html': '首页',
        '/src/pages/index.html': '首页',
        '/src/pages/articles.html': '文章',
        '/src/pages/post.html': '文章详情',
        '/src/pages/links.html': '友链',
        '/src/pages/link-apply.html': '友链申请',
        '/src/pages/daily.html': '我的',
        '/src/pages/tools.html': '工具库',
        '/src/pages/about.html': '关于',
        '/src/pages/guestbook.html': '留言板',
        '/src/pages/contact.html': '联系我',
        '/src/pages/privacy.html': '隐私协议',
        '/src/pages/cookies.html': 'Cookie 协议',
        '/src/pages/version.html': '版本协议',
        '/src/pages/policy.html': '站点协议'
    };

    function pathLabel(target) {
        if (PAGE_LABELS[target.pathname]) return PAGE_LABELS[target.pathname];
        let path = target.pathname + target.search;
        try {
            path = decodeURIComponent(path);
        } catch (error) { /* keep encoded path */ }
        if (path.length > 62) path = path.slice(0, 59) + '...';
        return path || '/';
    }

    function statusFor(percent) {
        let label = STATUS_STEPS[0].label;
        STATUS_STEPS.forEach(step => { if (percent >= step.at) label = step.label; });
        return label;
    }

    function tick() {
        if (!navigating) return;
        const percent = Math.min(100, Math.round(((Date.now() - startTime) / activeDelay) * 100));
        const ratio = percent / 100;
        fillEl.style.transform = 'scaleX(' + ratio + ')';
        if (dotEl) dotEl.style.left = percent + '%';
        if (ringEl) ringEl.style.strokeDashoffset = String(100 - percent);
        percentEl.textContent = percent + '%';
        const status = statusFor(percent);
        if (status !== lastStatus) {
            statusEl.textContent = status;
            lastStatus = status;
        }
        if (percent < 100) raf = requestAnimationFrame(tick);
    }

    function hideOverlay() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (raf) {
            cancelAnimationFrame(raf);
            raf = null;
        }
        navigating = false;
        overlay.classList.remove('is-active');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('ym-transitioning');
        try {
            window.sessionStorage.removeItem(NAV_TRANSITION_KEY);
        } catch (error) { /* noop */ }
    }

    function showOverlay(target, duration) {
        navigating = true;
        activeDelay = duration || NAV_DELAY;
        try {
            window.sessionStorage.setItem(NAV_TRANSITION_KEY, '1');
        } catch (error) { /* noop */ }
        const label = pathLabel(target);
        pathEl.textContent = label;
        statusEl.textContent = STATUS_STEPS[0].label;
        percentEl.textContent = '0%';
        fillEl.style.transform = 'scaleX(0)';
        if (dotEl) dotEl.style.left = '0%';
        if (ringEl) ringEl.style.strokeDashoffset = '100';
        lastStatus = STATUS_STEPS[0].label;
        overlay.setAttribute('aria-label', '正在进入 ' + label);
        overlay.classList.add('is-active');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('ym-transitioning');

        startTime = Date.now();
        raf = requestAnimationFrame(tick);
        timer = setTimeout(() => {
            window.location.href = target.href;
        }, activeDelay + 160);
    }

    document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const link = event.target.closest('a[href]');
        if (!link || navigating) return;
        if (link.hasAttribute('download')) return;
        if (link.target && link.target !== '_self') return;
        if (link.closest('[data-no-transition]')) return;

        const rawHref = link.getAttribute('href');
        if (!rawHref || rawHref === '#' || rawHref.startsWith('javascript:')) return;

        let target;
        try {
            target = new URL(link.href, window.location.href);
        } catch (error) {
            return;
        }

        if (target.protocol !== 'http:' && target.protocol !== 'https:') return;
        if (target.origin !== window.location.origin) return;
        if (target.pathname === window.location.pathname &&
            target.search === window.location.search &&
            target.hash) {
            return;
        }
        if (target.href === window.location.href) return;

        event.preventDefault();

        // 减少动态偏好：直接进入下一页
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            window.location.href = target.href;
            return;
        }

        // 每次跳转都保留转场；首次完整播放，后续使用更短的节奏
        let seen = false;
        try {
            seen = window.sessionStorage.getItem(TRANSITION_SEEN_KEY) === '1';
            window.sessionStorage.setItem(TRANSITION_SEEN_KEY, '1');
        } catch (error) { /* noop */ }
        showOverlay(target, seen ? REPEAT_NAV_DELAY : NAV_DELAY);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && navigating) {
            hideOverlay();
        }
    });

    window.addEventListener('pageshow', (event) => {
        if (event.persisted || !navigating) hideOverlay();
    });
    window.addEventListener('pagehide', () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (raf) {
            cancelAnimationFrame(raf);
            raf = null;
        }
    });
}

// ==========================================
// Rich site footer
// ==========================================
function initRichFooter() {
    const publicViews = [
        'page-home', 'articles-view', 'daily-view', 'about-view', 'contact-view',
        'guestbook-view', 'links-view', 'link-apply-view', 'message-apply-view', 'post-view', 'policy-view', 'tools-view'
    ];
    if (!publicViews.some(name => document.body.classList.contains(name))) return;

    const footer = document.querySelector('footer');
    if (!footer || footer.classList.contains('site-footer--rich')) return;

    const icon = (name, path) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
    // 外链标识：使用目标站点自己的 favicon（已本地化到 /assets/icons/），不依赖第三方图标服务
    const extLink = (href, label, iconName) =>
        '<a href="' + href + '" target="_blank" rel="noopener noreferrer">' +
        '<img class="rich-footer-link-icon" src="/assets/icons/' + iconName + '.png" alt="" width="16" height="16" loading="lazy" decoding="async">' +
        label + '</a>';

    // 站内协议没有 favicon，用同尺寸文档图标占位，保证四列行高一致
    const docLink = (href, label) =>
        '<a href="' + href + '">' +
        '<span class="rich-footer-link-icon rich-footer-link-icon--doc" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>' +
        '</span>' + label + '</a>';

    footer.className = 'site-footer site-footer--rich';
    footer.setAttribute('aria-label', '站点页脚');
    footer.innerHTML = [
        '<div class="rich-footer-social">',
        '  <a class="rich-footer-icon" href="mailto:3351708803@qq.com" aria-label="发送邮件">' + '<img class="rich-footer-icon-img" src="/assets/icons/qq.svg" alt="" width="21" height="21" loading="lazy" decoding="async">' + '</a>',
        '  <a class="rich-footer-icon" href="/rss.xml" aria-label="RSS 订阅">' + '<img class="rich-footer-icon-img" src="/assets/icons/rss.png" alt="" width="21" height="21" loading="lazy" decoding="async">' + '</a>',
        '  <a class="rich-footer-avatar" href="/src/pages/about.html" aria-label="关于 YanMo"><img src="/assets/images/site-avatar.png" alt="YanMo" width="56" height="56"></a>',
        '  <a class="rich-footer-icon" href="https://github.com/YanMo5" target="_blank" rel="noopener noreferrer" aria-label="GitHub">' + '<img class="rich-footer-icon-img" src="/assets/icons/github-light.svg" alt="" width="21" height="21" loading="lazy" decoding="async">' + '</a>',
        '  <a class="rich-footer-icon" href="/src/pages/links.html" aria-label="友情链接">' + icon('links', '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>') + '</a>',
        '</div>',
        '<div class="rich-footer-grid">',
        '  <section><h4>资产测绘</h4>' + extLink('https://fofa.info/', 'FOFA ↗', 'fofa') + extLink('https://quake.360.net/quake/', 'Quake ↗', 'quake') + extLink('https://x.threatbook.com/', '微步在线 ↗', 'threatbook') + '</section>',
        '  <section><h4>云沙箱</h4>' + extLink('https://www.virustotal.com/', 'VirusTotal ↗', 'virustotal') + extLink('https://s.threatbook.com/', '微步云沙箱 ↗', 'threatbook') + extLink('https://sandbox.dbappsecurity.com.cn/', '安恒云沙箱 ↗', 'dbappsecurity') + '</section>',
        '  <section><h4>网络检测</h4>' + extLink('https://www.itdog.cn/http/', '云拨测 ↗', 'itdog') + extLink('https://www.ipip.net/ip.html', 'IP 归属查询 ↗', 'ipip') + extLink('https://www.speedtest.cn/', '网速测试 ↗', 'speedtest') + '</section>',
        '  <section><h4>本站协议</h4>' + docLink('/src/pages/privacy.html', '隐私协议') + docLink('/src/pages/cookies.html', 'cookie协议') + docLink('/src/pages/version.html', '版本协议') + '</section>',
        '</div>',
        '<div class="rich-footer-bottom">',
        '  <span>© 2024–2026 YanMo Labs · Built with curiosity.</span>',
        '  <nav aria-label="页脚链接"><a href="/src/pages/index.html">个人主页</a><a href="/src/pages/tools.html">工具库</a><a href="/rss.xml">RSS</a><a href="/sitemap.xml">Sitemap</a><a href="https://github.com/YanMo5" target="_blank" rel="noopener noreferrer">GitHub ↗</a></nav>',
        '</div>'
    ].join('');
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
    initRichFooter();
    initCodeEnhancements();
});