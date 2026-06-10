document.addEventListener('DOMContentLoaded', () => {
    // --- Hamburger Menu Toggle ---
    const hamburger = document.querySelector('.hamburger');
    const navLinks = document.querySelector('.nav-links');
    
    if (hamburger && navLinks) {
        hamburger.addEventListener('click', () => {
            navLinks.classList.toggle('active');
            hamburger.classList.toggle('open');
            
            // Hamburger animation
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

        // Close menu when link is clicked
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

    // --- Top Nav Scroll Effects (Breadcrumb-like enhancement) ---
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

    // --- Dynamic System Status (Personalized Nav) ---
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
        setInterval(updateStatus, 1000); // 1s sync for the clock
    }

    // --- Back to Top Button ---
    const backToTop = document.createElement('button');
    backToTop.className = 'back-to-top';
    backToTop.innerHTML = '&#8679;'; // Up arrow
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
        if (window.pageYOffset > 300) {
            backToTop.style.display = 'block';
        } else {
            backToTop.style.display = 'none';
        }
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

         / /   - - -   T h e m e   T o g g l e   - - - 
         c o n s t   t h e m e T o g g l e B t n   =   d o c u m e n t . q u e r y S e l e c t o r ( ' . t h e m e - t o g g l e ' ) ; 
         i f   ( t h e m e T o g g l e B t n )   { 
                 / /   L o a d   s a v e d   t h e m e 
                 i f   ( l o c a l S t o r a g e . g e t I t e m ( ' t h e m e ' )   = = =   ' l i g h t ' )   { 
                         d o c u m e n t . d o c u m e n t E l e m e n t . c l a s s L i s t . a d d ( ' l i g h t - t h e m e ' ) ; 
                         d o c u m e n t . b o d y . c l a s s L i s t . a d d ( ' l i g h t - t h e m e ' ) ; 
                         t h e m e T o g g l e B t n . t e x t C o n t e n t   =   ' Rbc0RfY!j_' ; 
                 } 
 
                 t h e m e T o g g l e B t n . a d d E v e n t L i s t e n e r ( ' c l i c k ' ,   ( )   = >   { 
                         d o c u m e n t . d o c u m e n t E l e m e n t . c l a s s L i s t . t o g g l e ( ' l i g h t - t h e m e ' ) ; 
                         d o c u m e n t . b o d y . c l a s s L i s t . t o g g l e ( ' l i g h t - t h e m e ' ) ; 
                         
                         i f   ( d o c u m e n t . b o d y . c l a s s L i s t . c o n t a i n s ( ' l i g h t - t h e m e ' ) )   { 
                                 l o c a l S t o r a g e . s e t I t e m ( ' t h e m e ' ,   ' l i g h t ' ) ; 
                                 t h e m e T o g g l e B t n . t e x t C o n t e n t   =   ' Rbc0RfY!j_' ; 
                         }   e l s e   { 
                                 l o c a l S t o r a g e . s e t I t e m ( ' t h e m e ' ,   ' d a r k ' ) ; 
                                 t h e m e T o g g l e B t n . t e x t C o n t e n t   =   ' Rbc0R}v<f!j_' ; 
                         } 
                 } ) ; 
         } 
  
    });

    // --- Theme Toggle ---
    const themeToggleBtn = document.querySelector('.theme-toggle');
    if (themeToggleBtn) {
        // Load saved theme
        if (localStorage.getItem('theme') === 'light') {
            document.documentElement.classList.add('light-theme');
            document.body.classList.add('light-theme');
            themeToggleBtn.textContent = '切换到暗夜模式';
        }

        themeToggleBtn.addEventListener('click', () => {
            document.documentElement.classList.toggle('light-theme');
            document.body.classList.toggle('light-theme');
            
            if (document.body.classList.contains('light-theme')) {
                localStorage.setItem('theme', 'light');
                themeToggleBtn.textContent = '切换到暗夜模式';
            } else {
                localStorage.setItem('theme', 'dark');
                themeToggleBtn.textContent = '切换到白昼模式';
            }
        });
    }
});// ==========================================
// 1. Matrix Digital Rain Background (Option 3)
// ==========================================
function initMatrixRain() {
    if (document.getElementById('matrix-canvas')) return;
    const canvas = document.createElement('canvas');
    canvas.id = 'matrix-canvas';
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100vw';
    canvas.style.height = '100vh';
    canvas.style.zIndex = '-1';
    canvas.style.opacity = '0.08';
    canvas.style.pointerEvents = 'none';
    document.body.prepend(canvas);

    const ctx = canvas.getContext('2d');
    let width = canvas.width = window.innerWidth;
    let height = canvas.height = window.innerHeight;

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()?'.split('');
    const fontSize = 14;
    let columns = width / fontSize;
    let drops = [];
    for (let i = 0; i < columns; i++) drops[i] = 1;

    window.addEventListener('resize', () => {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
        columns = width / fontSize;
        drops = [];
        for (let i = 0; i < columns; i++) drops[i] = 1;
    });

    function draw() {
        ctx.fillStyle = 'rgba(5, 5, 10, 0.05)';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = document.body.classList.contains('light-theme') ? '#006400' : '#0f0';
        ctx.font = fontSize + 'px monospace';

        for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
            ctx.fillText(text, i * fontSize, drops[i] * fontSize);
            if (drops[i] * fontSize > height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
        }
    }
    setInterval(draw, 50);
}

// ==========================================
// 2. Global Page Transition Effect (Option 1)
// ==========================================
function initPageTransitions() {
    const overlay = document.createElement('div');
    overlay.className = 'page-transition-overlay';
    document.body.appendChild(overlay);

    document.querySelectorAll(:not([target='_blank']):not([href^='#']):not([href^='javascript'])).forEach(link => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            if (!href) return;
            e.preventDefault();
            overlay.classList.add('active');
            setTimeout(() => {
                window.location.href = href;
            }, 600);
        });
    });

    window.addEventListener('pageshow', () => {
        overlay.classList.remove('active');
    });
}

// ==========================================
// 3. Prism.js & Code Block Enhancements (Option 2)
// ==========================================
function initCodeEnhancements() {
    const preBlocks = document.querySelectorAll('pre');
    if (preBlocks.length === 0) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-dark.min.css';
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
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(pre.innerText.replace('</ Copy >', ''));
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

document.addEventListener('DOMContentLoaded', () => {
    initMatrixRain();
    initPageTransitions();
    initCodeEnhancements();
});
