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
