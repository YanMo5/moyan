document.addEventListener('DOMContentLoaded', () => {
    // --- Hamburger Menu Toggle ---
    const hamburger = document.querySelector('.hamburger');
    const navLinks = document.querySelector('.nav-links');
    
    if (hamburger && navLinks) {
        hamburger.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            hamburger.classList.toggle('open');
            
            const spans = hamburger.querySelectorAll('span');
            if (hamburger.classList.contains('open')) {
                spans[0].style.transform = 'rotate(45deg)';
                spans[1].style.opacity = '0';
                spans[2].style.transform = 'rotate(-45deg)';
            } else {
                spans[0].style.transform = 'rotate(0)';
                spans[1].style.opacity = '1';
                spans[2].style.transform = 'rotate(0)';
            }
        });

        navLinks.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                navLinks.classList.remove('active');
                hamburger.classList.remove('open');
                const spans = hamburger.querySelectorAll('span');
                spans[0].style.transform = 'rotate(0)';
                spans[1].style.opacity = '1';
                spans[2].style.transform = 'rotate(0)';
            });
        });
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

        const updateStatus = async () => {
            let isAdmin = false;
            if (window.SiteLocalApi) {
                isAdmin = window.SiteLocalApi.isAdminLoggedIn();
            }

            let statsText = "";
            try {
                const response = await fetch('/api/stats');
                if (response.ok) {
                    const stats = await response.json();
                    statsText = ` [VIEWS: ${stats.total_views}] [ITEMS: ${stats.published_articles}]`;
                }
            } catch (e) {
                // Silently fail if API is down
            }

            const lvl = isAdmin ? "ROOT_NODE" : "GUEST_USER";
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            const syncStatus = ["STABLE", "SYNCING", "ENCRYPTED"][Math.floor(Math.random() * 3)];
            
            statusEl.innerHTML = `
                <span class="status-pulse"></span>
                <span class="status-id">> ID_${lvl}</span>
                <span class="status-data">${statsText}</span>
                <span class="status-sync">[${syncStatus}]</span>
                <span class="status-clock">${time}</span>
            `;
        };

        updateStatus();
        setInterval(updateStatus, 1000);
    }

    // --- Back to Top Button ---
    const backToTop = document.createElement('button');
    backToTop.className = 'back-to-top';
    backToTop.innerHTML = '&#8679;';
    backToTop.style.cssText = `
        position: fixed;
        bottom: 30px;
        right: 30px;
        width: 50px;
        height: 50px;
        background: rgba(10, 10, 18, 0.8);
        border: 1px solid #0ff;
        color: #0ff;
        border-radius: 50%;
        cursor: pointer;
        display: none;
        z-index: 999;
        font-size: 1.5rem;
        box-shadow: 0 0 10px #0ff;
        transition: all 0.3s ease;
    `;
    document.body.appendChild(backToTop);

    window.addEventListener('scroll', () => {
        backToTop.style.display = window.pageYOffset > 300 ? 'block' : 'none';
    });

    backToTop.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    backToTop.addEventListener('mouseenter', () => {
        backToTop.style.boxShadow = '0 0 20px #f0f';
        backToTop.style.borderColor = '#f0f';
        backToTop.style.color = '#f0f';
    });

    backToTop.addEventListener('mouseleave', () => {
        backToTop.style.boxShadow = '0 0 10px #0ff';
        backToTop.style.borderColor = '#0ff';
        backToTop.style.color = '#0ff';
    });
});

// ==========================================
// Matrix Digital Rain Background
// ==========================================
function initMatrixRain() {
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
    let columns = width / fontSize;
    let drops = Array(Math.floor(columns)).fill(1);

    window.addEventListener('resize', () => {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
        columns = width / fontSize;
        drops = Array(Math.floor(columns)).fill(1);
    });

    const draw = () => {
        ctx.fillStyle = 'rgba(5, 5, 10, 0.05)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = document.body.classList.contains('light-theme') ? '#006400' : '#0f0';
        ctx.font = fontSize + 'px monospace';

        for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(text, i * fontSize, drops[i] * fontSize);
            if (drops[i] * fontSize > height && Math.random() > 0.975) {
                drops[i] = 0;
            }
            drops[i]++;
        }
    };

    setInterval(draw, 50);
}

// ==========================================
// Global Page Transition Effect
// ==========================================
function initPageTransitions() {
    const overlay = document.createElement('div');
    overlay.className = 'page-transition-overlay';
    overlay.style.cssText = `
        position: fixed;
        inset: 0;
        background: #05050a;
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
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js';
    script.onload = () => {
        const autoloader = document.createElement('script');
        autoloader.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js';
        document.head.appendChild(autoloader);
        
        preBlocks.forEach(pre => {
            pre.classList.add('line-numbers');
            
            const btn = document.createElement('button');
            btn.className = 'cyber-copy-btn';
            btn.textContent = '</ Copy >';
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
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(pre.textContent);
                btn.textContent = 'COPIED!';
                btn.style.color = '#0f0';
                setTimeout(() => {
                    btn.textContent = '</ Copy >';
                    btn.style.color = '#0ff';
                }, 2000);
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