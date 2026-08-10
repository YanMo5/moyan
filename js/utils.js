(function(window) {
    'use strict';

    const Utils = {
        /**
         * HTML 转义，防止 XSS 攻击
         * @param {string} value - 原始值
         * @returns {string} 转义后的值
         */
        escapeHtml(value) {
            return String(value || '').replace(/[&<>'"]/g, function(char) {
                const entities = {
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    "'": '&#39;',
                    '"': '&quot;'
                };
                return entities[char] || char;
            });
        },

        /**
         * 截断文本
         * @param {string} value - 原始文本
         * @param {number} maxLength - 最大长度
         * @returns {string} 截断后的文本
         */
        truncateText(value, maxLength) {
            const text = String(value || '').replace(/\s+/g, ' ').trim();
            if (text.length <= maxLength) {
                return text;
            }
            return text.slice(0, maxLength) + '...';
        },

        /**
         * 格式化日期
         * @param {string} dateStr - 日期字符串
         * @param {string} format - 格式模板，默认 YYYY-MM-DD
         * @returns {string} 格式化后的日期
         */
        formatDate(dateStr, format = 'YYYY-MM-DD') {
            if (!dateStr) return '--';
            
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return '--';

            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');

            return format
                .replace('YYYY', year)
                .replace('MM', month)
                .replace('DD', day)
                .replace('HH', hours)
                .replace('mm', minutes)
                .replace('ss', seconds);
        },

        /**
         * 格式化日期时间
         * @param {string} dateStr - 日期字符串
         * @returns {string} 格式化后的日期时间
         */
        formatDateTime(dateStr) {
            return this.formatDate(dateStr, 'YYYY-MM-DD HH:mm');
        },

        /**
         * 获取相对时间
         * @param {string} dateStr - 日期字符串
         * @returns {string} 相对时间描述
         */
        getRelativeTime(dateStr) {
            const now = new Date();
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) return dateStr.split(' ')[0] || '--';

            const diff = now.getTime() - date.getTime();
            const minute = 60 * 1000;
            const hour = 60 * minute;
            const day = 24 * hour;
            const week = 7 * day;
            const month = 30 * day;

            if (diff < minute) return '刚刚';
            if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
            if (diff < day) return `${Math.floor(diff / hour)}小时前`;
            if (diff < week) return `${Math.floor(diff / day)}天前`;
            if (diff < month) return `${Math.floor(diff / week)}周前`;
            return this.formatDate(dateStr);
        },

        /**
         * 防抖函数
         * @param {Function} func - 要执行的函数
         * @param {number} wait - 等待时间(ms)
         * @returns {Function} 防抖后的函数
         */
        debounce(func, wait) {
            let timeout = null;
            return function(...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        },

        /**
         * 节流函数
         * @param {Function} func - 要执行的函数
         * @param {number} limit - 限制时间(ms)
         * @returns {Function} 节流后的函数
         */
        throttle(func, limit) {
            let inThrottle = false;
            return function(...args) {
                if (!inThrottle) {
                    func.apply(this, args);
                    inThrottle = true;
                    setTimeout(() => (inThrottle = false), limit);
                }
            };
        },

        /**
         * 生成唯一ID
         * @returns {string} 唯一ID
         */
        generateId() {
            return Date.now().toString(36) + Math.random().toString(36).substr(2);
        },

        /**
         * 获取 Cookie
         * @param {string} name - Cookie 名称
         * @returns {string|null} Cookie 值
         */
        getCookie(name) {
            const value = `; ${document.cookie}`;
            const parts = value.split(`; ${name}=`);
            if (parts.length === 2) return parts.pop().split(';').shift();
            return null;
        },

        /**
         * 设置 Cookie
         * @param {string} name - Cookie 名称
         * @param {string} value - Cookie 值
         * @param {number} days - 有效期(天)
         */
        setCookie(name, value, days = 30) {
            const date = new Date();
            date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
            const expires = `expires=${date.toUTCString()}`;
            document.cookie = `${name}=${value}; ${expires}; path=/; SameSite=Lax`;
        },

        /**
         * 删除 Cookie
         * @param {string} name - Cookie 名称
         */
        deleteCookie(name) {
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
        },

        /**
         * 从 localStorage 获取数据
         * @param {string} key - 存储键
         * @param {*} defaultValue - 默认值
         * @returns {*} 存储的值
         */
        storageGet(key, defaultValue = null) {
            try {
                const value = localStorage.getItem(key);
                return value ? JSON.parse(value) : defaultValue;
            } catch {
                return defaultValue;
            }
        },

        /**
         * 保存数据到 localStorage
         * @param {string} key - 存储键
         * @param {*} value - 存储值
         * @returns {boolean} 是否成功
         */
        storageSet(key, value) {
            try {
                const item = JSON.stringify(value);
                const quota = navigator.storage?.estimate?.();
                if (quota && item.length > quota.quota * 0.1) {
                    return false;
                }
                localStorage.setItem(key, item);
                return true;
            } catch {
                return false;
            }
        },

        /**
         * 从 localStorage 删除数据
         * @param {string} key - 存储键
         * @returns {boolean} 是否成功
         */
        storageRemove(key) {
            try {
                localStorage.removeItem(key);
                return true;
            } catch {
                return false;
            }
        },

        /**
         * 解析查询字符串
         * @returns {Object} 查询参数对象
         */
        parseQueryString() {
            const query = window.location.search.substring(1);
            const params = {};
            query.split('&').forEach(pair => {
                const [key, value] = pair.split('=').map(decodeURIComponent);
                if (key) params[key] = value || '';
            });
            return params;
        },

        /**
         * 构建查询字符串
         * @param {Object} params - 参数对象
         * @returns {string} 查询字符串
         */
        buildQueryString(params) {
            const pairs = [];
            Object.keys(params).forEach(key => {
                if (params[key] !== undefined && params[key] !== null) {
                    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
                }
            });
            return pairs.join('&');
        },

        /**
         * 发起 JSON 请求（带超时和重试）
         * @param {string} url - 请求地址
         * @param {Object} options - 请求选项
         * @param {number} retries - 重试次数
         * @returns {Promise<any>} 响应数据
         */
        async fetchJson(url, options = {}, retries = 2) {
            const defaultOptions = {
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'same-origin',
                signal: AbortController.timeout(10000)
            };

            const mergedOptions = { ...defaultOptions, ...options };
            mergedOptions.headers = { ...defaultOptions.headers, ...(options.headers || {}) };

            try {
                const response = await fetch(url, mergedOptions);
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || `HTTP ${response.status}`);
                }

                return data;
            } catch (error) {
                if (retries > 0 && error.name !== 'AbortError') {
                    await new Promise(r => setTimeout(r, 1000));
                    return this.fetchJson(url, options, retries - 1);
                }
                throw error;
            }
        },

        /**
         * 滚动到顶部
         * @param {boolean} smooth - 是否平滑滚动
         */
        scrollToTop(smooth = true) {
            window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
        },

        /**
         * 滚动到指定元素
         * @param {string} selector - 元素选择器
         * @param {number} offset - 偏移量
         */
        scrollToElement(selector, offset = 0) {
            const element = document.querySelector(selector);
            if (element) {
                const rect = element.getBoundingClientRect();
                const scrollPosition = window.scrollY + rect.top + offset;
                window.scrollTo({ top: scrollPosition, behavior: 'smooth' });
            }
        },

        /**
         * 切换元素类名
         * @param {HTMLElement} element - 目标元素
         * @param {string} className - 类名
         */
        toggleClass(element, className) {
            if (element) {
                element.classList.toggle(className);
            }
        },

        /**
         * 添加元素类名
         * @param {HTMLElement} element - 目标元素
         * @param {string} className - 类名
         */
        addClass(element, className) {
            if (element) {
                element.classList.add(className);
            }
        },

        /**
         * 移除元素类名
         * @param {HTMLElement} element - 目标元素
         * @param {string} className - 类名
         */
        removeClass(element, className) {
            if (element) {
                element.classList.remove(className);
            }
        },

        /**
         * 检查元素是否有指定类名
         * @param {HTMLElement} element - 目标元素
         * @param {string} className - 类名
         * @returns {boolean} 是否有类名
         */
        hasClass(element, className) {
            return element ? element.classList.contains(className) : false;
        },

        /**
         * 创建元素
         * @param {string} tagName - 标签名
         * @param {Object} options - 元素选项
         * @returns {HTMLElement} 创建的元素
         */
        createElement(tagName, options = {}) {
            const element = document.createElement(tagName);
            
            if (options.className) {
                element.className = options.className;
            }
            
            if (options.id) {
                element.id = options.id;
            }
            
            if (options.textContent) {
                element.textContent = options.textContent;
            }
            
            if (options.innerHTML) {
                element.innerHTML = options.innerHTML;
            }
            
            if (options.attributes) {
                Object.keys(options.attributes).forEach(key => {
                    element.setAttribute(key, options.attributes[key]);
                });
            }
            
            return element;
        },

        /**
         * 显示元素
         * @param {HTMLElement} element - 目标元素
         */
        showElement(element) {
            if (element) {
                element.style.display = '';
            }
        },

        /**
         * 隐藏元素
         * @param {HTMLElement} element - 目标元素
         */
        hideElement(element) {
            if (element) {
                element.style.display = 'none';
            }
        },

        /**
         * 淡入元素
         * @param {HTMLElement} element - 目标元素
         * @param {number} duration - 动画时长(ms)
         */
        fadeIn(element, duration = 300) {
            if (!element) return;
            
            element.style.opacity = '0';
            element.style.display = '';
            
            let start = null;
            function animate(timestamp) {
                if (!start) start = timestamp;
                const progress = Math.min((timestamp - start) / duration, 1);
                element.style.opacity = String(progress);
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                }
            }
            
            requestAnimationFrame(animate);
        },

        /**
         * 淡出元素
         * @param {HTMLElement} element - 目标元素
         * @param {number} duration - 动画时长(ms)
         */
        fadeOut(element, duration = 300) {
            if (!element) return;
            
            element.style.opacity = '1';
            
            let start = null;
            function animate(timestamp) {
                if (!start) start = timestamp;
                const progress = Math.min((timestamp - start) / duration, 1);
                element.style.opacity = String(1 - progress);
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    element.style.display = 'none';
                }
            }
            
            requestAnimationFrame(animate);
        },

        /**
         * 格式化数字显示
         * @param {number} num - 原始数字
         * @returns {string} 格式化后的字符串
         */
        formatNumber(num) {
            if (num >= 10000) {
                return (num / 10000).toFixed(1) + 'w';
            } else if (num >= 1000) {
                return (num / 1000).toFixed(1) + 'k';
            }
            return String(num);
        }
    };

    window.Utils = Utils;
})(window);