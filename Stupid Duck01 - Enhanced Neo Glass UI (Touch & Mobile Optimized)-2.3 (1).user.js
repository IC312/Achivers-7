// ==UserScript==
// @name          Stupid Duck01 - Enhanced Neo Glass UI (Touch & Mobile Optimized)
// @namespace     http://tampermonkey.net/
// @version       2.3
// @description   Giao diện kính mờ nâng cao với hỗ trợ touch và tối ưu mobile/tablet 🦆✨
// @author        Enhanced Touch Version
// @match         *://*/*
// @grant         GM_addStyle
// @grant         GM_setValue
// @grant         GM_getValue
// @grant         GM_deleteValue
// @grant         GM_xmlhttpRequest
// @require       https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @connect       generativelanguage.googleapis.com
// ==/UserScript==

(function () {
    'use strict';

    /* global html2canvas:true */

    // Chỉ chạy trong top-level frame
    if (window.top !== window.self) return;

    // Touch Device Detection
    function isTouchDevice() {
        return 'ontouchstart' in window ||
               navigator.maxTouchPoints > 0 ||
               navigator.msMaxTouchPoints > 0;
    }

    // Device Type Detection
    function getDeviceType() {
        const ua = navigator.userAgent;
        const isMobile = /Android|iPhone|iPod|BlackBerry|Windows Phone/i.test(ua);
        const isTablet = /iPad|Android.*tablet|Kindle|Silk/i.test(ua) ||
                        (window.innerWidth >= 768 && window.innerWidth <= 1024);

        if (isMobile && !isTablet) return 'mobile';
        if (isTablet) return 'tablet';
        return 'desktop';
    }

    const DEVICE_TYPE = getDeviceType();
    const IS_TOUCH = isTouchDevice();

    // Configuration
    const CONFIG = {
        API_PROVIDERS: {
            GEMINI: {
                name: 'Google Gemini',
                key: GM_getValue('gemini_key', 'GEMINI_API_KEY'),
                url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
                model: 'gemini-2.0-flash'
            }
        },
        THEMES: {
            DARK: 'dark',
            CYBERPUNK: 'cyberpunk'
        },
        MAX_HISTORY: 50,
        RETRY_ATTEMPTS: 3,
        RETRY_DELAY: 2000,
        RATE_LIMIT_DELAY: 1000,
        // Touch & Device specific settings
        TOUCH: {
            TAP_THRESHOLD: 10, // pixels
            HOLD_DURATION: 500, // ms
            SWIPE_THRESHOLD: 50 // pixels
        }
    };

    // State Management
    const state = {
        currentProvider: 'GEMINI',
        currentTheme: GM_getValue('current_theme', CONFIG.THEMES.DARK),
        history: JSON.parse(GM_getValue('duck_history', '[]')),
        isProcessing: false,
        settings: {
            fontSize: GM_getValue('font_size', DEVICE_TYPE === 'mobile' ? 16 : 14),
            autoSave: GM_getValue('auto_save', true),
            soundEnabled: GM_getValue('sound_enabled', false),
            uiScale: GM_getValue('ui_scale', 100)
        }
    };

    // Utility Functions
    const utils = {
        delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

        formatDate: (date) => {
            return new Intl.DateTimeFormat('vi-VN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            }).format(date);
        },

        sanitizeHTML: (str) => {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },

        playNotificationSound: () => {
            if (!state.settings.soundEnabled) return;
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();

            const createTone = (frequency, duration, volume = 0.1) => {
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();

                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);

                oscillator.frequency.value = frequency;
                oscillator.type = 'sine';

                gainNode.gain.setValueAtTime(0, audioContext.currentTime);
                gainNode.gain.linearRampToValueAtTime(volume, audioContext.currentTime + 0.05);
                gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration);

                oscillator.start(audioContext.currentTime);
                oscillator.stop(audioContext.currentTime + duration);
            };

            createTone(523.25, 0.2);
            setTimeout(() => createTone(659.25, 0.2), 200);
            setTimeout(() => createTone(783.99, 0.3), 400);
        },

        saveToHistory: (entry) => {
            state.history.unshift({
                id: Date.now(),
                timestamp: new Date(),
                ...entry
            });

            if (state.history.length > CONFIG.MAX_HISTORY) {
                state.history = state.history.slice(0, CONFIG.MAX_HISTORY);
            }

            GM_setValue('duck_history', JSON.stringify(state.history));
        },

        // Touch utilities
        getEventPosition: (e) => {
            if (e.touches && e.touches.length > 0) {
                return { x: e.touches[0].clientX, y: e.touches[0].clientY };
            }
            return { x: e.clientX, y: e.clientY };
        },

        calculateDistance: (pos1, pos2) => {
            const dx = pos1.x - pos2.x;
            const dy = pos1.y - pos2.y;
            return Math.sqrt(dx * dx + dy * dy);
        }
    };
//Dialog Manager
const dialogManager = {
    show: (title, message, type = 'confirm', options = {}) => {
        // Chặn mở dialog lặp
        if (document.querySelector('.duck-dialog-overlay')) {
            return Promise.resolve(false);
        }

        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'duck-dialog-overlay';

            const dialog = document.createElement('div');
            dialog.className = `duck-dialog duck-dialog-${type} duck-dialog-${state.currentTheme}`;

            const iconMap = {
                confirm: '⚠️',
                alert: 'ℹ️',
                close: '🐥'
            };
            const icon = options.icon || iconMap[type] || '❓';

            dialog.innerHTML = `
                <div class="duck-dialog-scan-line"></div>
                <div class="duck-dialog-header">
                    <div class="duck-dialog-icon">${icon}</div>
                    <h3 class="duck-dialog-title">${title}</h3>
                    <button class="duck-dialog-close-x">×</button>
                </div>
                <div class="duck-dialog-body">
                    <div class="duck-dialog-message">${message}</div>
                    ${options.details ? `<div class="duck-dialog-details">${options.details}</div>` : ''}
                </div>
                <div class="duck-dialog-actions">
                    ${type === 'confirm'
                        ? `<button class="duck-dialog-btn duck-dialog-cancel">
                               <span class="duck-btn-text">Hủy</span>
                           </button>
                           <button class="duck-dialog-btn duck-dialog-confirm">
                               <span class="duck-btn-text">${options.confirmText || 'Đồng ý'}</span>
                           </button>`
                        : `<button class="duck-dialog-btn duck-dialog-ok">
                               <span class="duck-btn-text">Đồng ý</span>
                           </button>`
                    }
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            // Hiệu ứng mở
            requestAnimationFrame(() => {
                overlay.classList.add('duck-dialog-show');
                dialog.querySelector('.duck-dialog-scan-line').classList.add('duck-dialog-scan-active');
            });

            // Chặn double cleanup
            let isCleaning = false;
            const cleanup = (result) => {
                if (isCleaning) return;
                isCleaning = true;

                if (overlay.parentNode) {
                    document.body.removeChild(overlay);
                }
                document.body.style.overflow = '';
                resolve(result);
            };

            // Nút đóng (X)
            dialog.querySelector('.duck-dialog-close-x').addEventListener('pointerup', (e) => {
                e.preventDefault();
                e.stopPropagation();
                cleanup(false);
            }, { once: true });

            // Nút trong dialog
            if (type === 'confirm') {
                dialog.querySelector('.duck-dialog-cancel').addEventListener('pointerup', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    cleanup(false);
                }, { once: true });

                dialog.querySelector('.duck-dialog-confirm').addEventListener('pointerup', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    cleanup(true);
                }, { once: true });
            } else {
                dialog.querySelector('.duck-dialog-ok').addEventListener('pointerup', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    cleanup(true);
                }, { once: true });
            }

            // Đóng khi click overlay
            overlay.addEventListener('pointerup', (e) => {
                if (e.target === overlay) {
                    cleanup(false);
                }
            }, { once: true });

            // Chặn scroll nền
            document.body.style.overflow = 'hidden';
        });
    },

    confirm: (title, message, options = {}) => {
        return dialogManager.show(title, message, 'confirm', options);
    },

    alert: (title, message, options = {}) => {
        return dialogManager.show(title, message, 'alert', options);
    },

    showCloseDialog: () => {
        return dialogManager.show(
            'Đóng Stupid Duck AI',
            'Ứng dụng sẽ được ẩn khỏi trang web này.',
            'confirm',
            {
                icon: '🐥',
                confirmText: 'Đóng',
                details: 'Bạn có thể khởi động lại bằng cách tải lại trang.'
            }
        );
    }
};

    // API Handlers
    const apiHandlers = {
        async xmlHttpRequestPromise(config) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    ...config,
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            resolve(response);
                        } else {
                            reject(new Error(`HTTP ${response.status}: ${response.statusText}\nResponse: ${response.responseText}`));
                        }
                    },
                    onerror: (error) => reject(new Error(`Network error: ${error.error || 'Unknown error'}`)),
                    ontimeout: () => reject(new Error('Request timeout'))
                });
            });
        },

        async fetchWithRetry(config, retries = CONFIG.RETRY_ATTEMPTS) {
            for (let i = 0; i < retries; i++) {
                try {
                    const response = await this.xmlHttpRequestPromise(config);

                    if (response.status === 429) {
                        if (i === retries - 1) throw new Error('Quá nhiều yêu cầu. Vui lòng thử lại sau vài phút.');
                        const delay = CONFIG.RETRY_DELAY * Math.pow(2, i);
                        console.log(`Rate limited, retrying in ${delay}ms...`);
                        await utils.delay(delay);
                        continue;
                    }

                    return response;
                } catch (error) {
                    console.error(`Attempt ${i + 1} failed:`, error);
                    if (i === retries - 1) throw error;
                    await utils.delay(CONFIG.RETRY_DELAY);
                }
            }
        },

        async sendToGemini(imageDataURL, description) {
            const provider = CONFIG.API_PROVIDERS.GEMINI;
            if (!provider.key) throw new Error('Chưa cấu hình API key cho Gemini');

            const mimeType = imageDataURL.match(/data:(image\/[^;]+);/)[1];
            const base64Data = imageDataURL.split(',')[1];

            const body = {
                contents: [{
                    parts: [
                        { text: `Nói tiếng Việt và giúp tôi giải bài tập trong ảnh. Mô tả: ${description || 'Không có mô tả'}` },
                        { inlineData: { mimeType, data: base64Data } }
                    ]
                }]
            };

            try {
                const response = await this.fetchWithRetry({
                    method: 'POST',
                    url: `${provider.url}?key=${provider.key}`,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    data: JSON.stringify(body),
                    timeout: 30000
                });

                const data = JSON.parse(response.responseText);
                const result = data.candidates?.[0]?.content?.parts?.[0]?.text;

                if (!result) {
                    console.error('Gemini response:', data);
                    throw new Error("Không nhận được phản hồi từ Gemini. Vui lòng kiểm tra API key hoặc thử lại.");
                }
                return result;
            } catch (error) {
                console.error('Gemini API Error:', error);
                if (error.message.includes('429')) {
                    throw new Error('Gemini API bị giới hạn. Vui lòng thử lại sau.');
                }
                if (error.message.includes('401') || error.message.includes('403')) {
                    throw new Error('API key Gemini không hợp lệ. Vui lòng kiểm tra lại.');
                }
                throw new Error(`Lỗi Gemini API: ${error.message}`);
            }
        }
    };

    // Theme Manager
    const themeManager = {
        themes: {
            [CONFIG.THEMES.DARK]: {
                primary: 'rgba(18, 18, 18, 0.9)',
                secondary: 'rgba(30, 30, 30, 0.8)',
                accent: '#4caf50',
                text: '#e0e0e0',
                border: 'rgba(255, 255, 255, 0.1)'
            },
            [CONFIG.THEMES.CYBERPUNK]: {
                primary: 'rgba(0, 15, 25, 0.9)',
                secondary: 'rgba(0, 25, 40, 0.8)',
                accent: '#00ffff',
                text: '#00ff00',
                border: 'rgba(0, 255, 255, 0.3)'
            }
        },

        apply(theme) {
            const colors = this.themes[theme];
            if (!colors) return;

            state.currentTheme = theme;
            GM_setValue('current_theme', theme);

            document.documentElement.style.setProperty('--duck-primary', colors.primary);
            document.documentElement.style.setProperty('--duck-secondary', colors.secondary);
            document.documentElement.style.setProperty('--duck-accent', colors.accent);
            document.documentElement.style.setProperty('--duck-text', colors.text);
            document.documentElement.style.setProperty('--duck-border', colors.border);
        }
    };

    // UI Components
    const ui = {
        createElement(tag, className, innerHTML) {
            const el = document.createElement(tag);
            if (className) el.className = className;
            if (innerHTML) el.innerHTML = innerHTML;
            return el;
        },

        createProgressBar() {
            return this.createElement('div', 'duck-progress-container', `
                <div class="duck-progress-bar">
                    <div class="duck-progress-fill"></div>
                </div>
                <div class="duck-progress-text">Đang xử lý...</div>
            `);
        },

        createHistoryPanel() {
            const panel = this.createElement('div', 'duck-history-panel');
            this.updateHistoryPanel(panel);
            return panel;
        },

        updateHistoryPanel(panel) {
            if (state.history.length === 0) {
                panel.innerHTML = '<div class="duck-no-history">Chưa có lịch sử</div>';
                return;
            }

            panel.innerHTML = state.history.map(entry => `
                <div class="duck-history-item" data-id="${entry.id}">
                    <div class="duck-history-header">
                        <span class="duck-history-date">${utils.formatDate(new Date(entry.timestamp))}</span>
                        <button class="duck-history-delete" data-id="${entry.id}">×</button>
                    </div>
                    <div class="duck-history-desc">${entry.description || 'Không có mô tả'}</div>
                    <div class="duck-history-preview">${entry.result.substring(0, 100)}...</div>
                </div>
            `).join('');

            panel.querySelectorAll('.duck-history-delete').forEach(btn => {
                btn.addEventListener('pointerup', (e) => {
                    e.stopPropagation();
                    const id = parseInt(btn.dataset.id);
                    state.history = state.history.filter(item => item.id !== id);
                    GM_setValue('duck_history', JSON.stringify(state.history));
                    this.updateHistoryPanel(panel);
                });
            });

            panel.querySelectorAll('.duck-history-item').forEach(item => {
                item.addEventListener('pointerup', () => {
                    const id = parseInt(item.dataset.id);
                    const entry = state.history.find(h => h.id === id);
                    if (entry) {
                        document.getElementById('duck-desc').value = entry.description || '';
                        document.getElementById('duck-result').innerHTML = entry.result.replace(/\n/g, '<br>');
                    }
                });
            });
        },

        createSettingsPanel() {
            return this.createElement('div', 'duck-settings-panel', `
                <div class="duck-settings-section">
                    <h4>AI Provider</h4>
                    <select id="duck-provider-select" disabled>
                        <option value="GEMINI" selected>Google Gemini</option>
                    </select>
                </div>

                <div class="duck-settings-section">
                    <h4>API Key</h4>
                    <div class="duck-key-input">
                        <label>Gemini API Key:</label>
                        <input type="password" id="duck-gemini-key" value="${CONFIG.API_PROVIDERS.GEMINI.key}" placeholder="Nhập API key">
                    </div>
                </div>

                <div class="duck-settings-section">
                    <h4>Giao diện</h4>
                    <select id="duck-theme-select">
                        <option value="${CONFIG.THEMES.DARK}" ${state.currentTheme === CONFIG.THEMES.DARK ? 'selected' : ''}>Dark</option>
                        <option value="${CONFIG.THEMES.CYBERPUNK}" ${state.currentTheme === CONFIG.THEMES.CYBERPUNK ? 'selected' : ''}>Cyberpunk</option>
                    </select>

                    <label class="duck-slider">
                        Kích thước UI: <span id="duck-ui-scale-value">${state.settings.uiScale}%</span>
                        <input type="range" id="duck-ui-scale" min="70" max="150" step="10" value="${state.settings.uiScale}">
                        <small class="duck-scale-hint">70% (Nhỏ) - 100% (Bình thường) - 150% (To)</small>
                    </label>
                </div>

                <div class="duck-settings-section">
                    <h4>Khác</h4>
                    <label class="duck-checkbox">
                        <input type="checkbox" id="duck-sound-toggle" ${state.settings.soundEnabled ? 'checked' : ''}>
                        Âm thanh thông báo
                    </label>
                    <label class="duck-slider">
                        Font size: <span id="duck-font-size-value">${state.settings.fontSize}px</span>
                        <input type="range" id="duck-font-size" min="12" max="24" value="${state.settings.fontSize}">
                    </label>
                </div>

                <div class="duck-settings-actions">
                    <button id="duck-save-settings" class="duck-btn-primary">💾 Lưu cài đặt</button>
                    <button id="duck-reset-settings" class="duck-btn-secondary">🔄 Khôi phục mặc định</button>
                </div>
            `);
        }
    };

    // Main Application
    class StupidDuckApp {
        constructor() {
            this.initializeIframeBlocker();
            this.createMainUI();
            this.attachEventListeners();
            themeManager.apply(state.currentTheme);
            this.applyFontSize();
            this.applyUIScale();
            this.handleDeviceSpecificSetup();
        }

        initializeIframeBlocker() {
            this.iframeBlocker = document.createElement("div");
            Object.assign(this.iframeBlocker.style, {
                position: "fixed",
                top: "0",
                left: "0",
                width: "100vw",
                height: "100vh",
                zIndex: "999998",
                cursor: IS_TOUCH ? "grabbing" : "grabbing",
                display: "none",
                touchAction: "none"
            });
            document.body.appendChild(this.iframeBlocker);
        }

        handleDeviceSpecificSetup() {
            // Prevent zoom on double tap for touch devices
            if (IS_TOUCH) {
                let lastTouchEnd = 0;
                document.addEventListener('touchend', function (event) {
                    const now = (new Date()).getTime();
                    if (now - lastTouchEnd <= 300) {
                        event.preventDefault();
                    }
                    lastTouchEnd = now;
                }, false);

                // Prevent pull-to-refresh on mobile
                document.addEventListener('touchstart', function(e) {
                    if (e.touches.length === 1) {
                        const touch = e.touches[0];
                        if (touch.clientY <= 50) {
                            e.preventDefault();
                        }
                    }
                }, { passive: false });

                // Prevent overscroll bounce
                document.addEventListener('touchmove', function(e) {
                    if (document.body.scrollTop === 0 && e.touches[0].clientY > e.touches[0].clientY) {
                        e.preventDefault();
                    }
                }, { passive: false });
            }

            // Add comprehensive viewport meta tag for mobile if not present
            if (DEVICE_TYPE === 'mobile' && !document.querySelector('meta[name="viewport"]')) {
                const viewport = document.createElement('meta');
                viewport.name = 'viewport';
                viewport.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
                document.head.appendChild(viewport);
            }

            // Handle viewport changes (orientation, resize)
            const handleViewportChange = () => {
                // Wait for viewport to settle
                setTimeout(() => {
                    this.applyUIScale();
                    // Ensure UI stays in bounds after orientation change
                    this.ensureInBounds();
                }, 100);
            };

            window.addEventListener('resize', handleViewportChange);
            window.addEventListener('orientationchange', handleViewportChange);
        }

        ensureInBounds() {
            // Simple helper method to ensure UI stays within viewport
            const margin = 10;

            // Main UI bounds check
            const mainWidth = this.mainUI.offsetWidth;
            const mainHeight = this.mainUI.offsetHeight;

            const maxX = window.innerWidth - mainWidth - margin;
            const maxY = window.innerHeight - mainHeight - margin;
            const minX = margin;
            const minY = margin;

            const currentX = parseInt(this.mainUI.style.left) || 0;
            const currentY = parseInt(this.mainUI.style.top) || 0;

            let newX = Math.max(minX, Math.min(currentX, maxX));
            let newY = Math.max(minY, Math.min(currentY, maxY));

            if (newX !== currentX || newY !== currentY) {
                this.mainUI.style.left = newX + 'px';
                this.mainUI.style.top = newY + 'px';
            }

            // Minimized button bounds check
            const minWidth = this.minimizedBtn.offsetWidth;
            const minHeight = this.minimizedBtn.offsetHeight;

            const minMaxX = window.innerWidth - minWidth - margin;
            const minMaxY = window.innerHeight - minHeight - margin;

            const minCurrentX = parseInt(this.minimizedBtn.style.left) || 0;
            const minCurrentY = parseInt(this.minimizedBtn.style.top) || 0;

            let minNewX = Math.max(margin, Math.min(minCurrentX, minMaxX));
            let minNewY = Math.max(margin, Math.min(minCurrentY, minMaxY));

            if (minNewX !== minCurrentX || minNewY !== minCurrentY) {
                this.minimizedBtn.style.left = minNewX + 'px';
                this.minimizedBtn.style.top = minNewY + 'px';
            }
        }

        makeDraggable(element) {
            let isDragging = false;
            let startPos = { x: 0, y: 0 };
            let elementStartPos = { x: 0, y: 0 };
            let touchStartTime = 0;
            let touchIdentifier = null;

            // Use pointerdown/pointermove/pointerup for unified event handling
            const handleStart = (e) => {
                // Skip if clicking on control buttons
                if (e.target.closest('.duck-control-btn') ||
                    e.target.closest('.duck-header-controls')) {
                    return;
                }

                // Only allow dragging from header or minimized button
                if (!e.target.closest('.duck-draggable') && !element.classList.contains('duck-minimized')) {
                    return;
                }

                const pos = utils.getEventPosition(e);
                startPos = pos;
                elementStartPos = {
                    x: element.offsetLeft,
                    y: element.offsetTop
                };

                isDragging = false;
                touchStartTime = Date.now();

                element.style.transition = 'none';
                element.setPointerCapture?.(e.pointerId);
            };

            const handleMove = (e) => {
                if (touchStartTime === 0) return;

                const pos = utils.getEventPosition(e);
                const distance = utils.calculateDistance(startPos, pos);

                // Start dragging if moved beyond threshold
                if (!isDragging && distance > CONFIG.TOUCH.TAP_THRESHOLD) {
                    isDragging = true;
                    e.preventDefault?.();
                    this.iframeBlocker.style.display = 'block';
                }

                if (isDragging) {
                    e.preventDefault?.();

                    const newX = elementStartPos.x + (pos.x - startPos.x);
                    const newY = elementStartPos.y + (pos.y - startPos.y);

                    // Get element's actual dimensions without considering transform
                    const elementWidth = element.offsetWidth;
                    const elementHeight = element.offsetHeight;

                    // Define minimal safe margins (much smaller)
                    const margin = IS_TOUCH ? 0 : 0; // Very small margins

                    // Calculate bounds with minimal margins
                    const maxX = window.innerWidth - elementWidth - margin;
                    const maxY = window.innerHeight - elementHeight - margin;
                    const minX = margin;
                    const minY = margin;

                    // Apply bounds with more permissive limits
                    const boundedX = Math.max(minX, Math.min(newX, maxX));
                    const boundedY = Math.max(minY, Math.min(newY, maxY));

                    element.style.left = `${boundedX}px`;
                    element.style.top = `${boundedY}px`;
                }
            };

            const handleEnd = (e) => {
                if (touchStartTime === 0) return;

                this.iframeBlocker.style.display = 'none';
                element.style.transition = '';

                // Handle tap/click if not dragged
                if (!isDragging) {
                    const touchDuration = Date.now() - touchStartTime;

                    if (element.classList.contains('duck-minimized')) {
                        if (IS_TOUCH && touchDuration < CONFIG.TOUCH.HOLD_DURATION) {
                            // Single tap - do nothing, require double tap
                        } else {
                            this.restore();
                        }
                    }
                }

                isDragging = false;
                touchStartTime = 0;
                touchIdentifier = null;
                element.releasePointerCapture?.(e.pointerId);
            };

            element.addEventListener('pointerdown', handleStart, { passive: false });
            element.addEventListener('pointermove', handleMove, { passive: false });
            element.addEventListener('pointerup', handleEnd, { passive: false });
        }

        createMainUI() {
            GM_addStyle(this.getEnhancedStyles());

            this.mainUI = ui.createElement('div', 'duck-main-ui');
            this.mainUI.innerHTML = `
                <div class="duck-header duck-draggable">
                    <h2 class="duck-title">🐥 Stupid Duck AI 🐥</h2>
                    <div class="duck-header-controls">
                        <button id="duck-settings-btn" class="duck-control-btn" title="Cài đặt">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"
                                 stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="3.5"></circle>
                                <line x1="12" y1="2" x2="12" y2="5"></line>
                                <line x1="12" y1="19" x2="12" y2="22"></line>
                                <line x1="2" y1="12" x2="5" y2="12"></line>
                                <line x1="19" y1="12" x2="22" y2="12"></line>
                                <line x1="4.5" y1="4.5" x2="6.5" y2="6.5"></line>
                                <line x1="17.5" y1="17.5" x2="19.5" y2="19.5"></line>
                                <line x1="4.5" y1="19.5" x2="6.5" y2="17.5"></line>
                                <line x1="17.5" y1="6.5" x2="19.5" y2="4.5"></line>
                            </svg>
                        </button>

                        <button id="duck-history-btn" class="duck-control-btn" title="Lịch sử">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"
                                 stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 3v5h5"></path>
                                <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path>
                                <path d="M12 7v5l4 2"></path>
                            </svg>
                        </button>

                        <button id="duck-minimize-btn" class="duck-control-btn" title="Thu nhỏ">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"
                                 stroke-linecap="round" stroke-linejoin="round">
                                <line x1="5" y1="12" x2="19" y2="12"></line>
                            </svg>
                        </button>

                        <button id="duck-close-btn" class="duck-control-btn duck-close" title="Đóng">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"
                                 stroke-linecap="round" stroke-linejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                </div>

                <div class="duck-tabs">
                    <button class="duck-tab active" data-tab="main">Giải bài</button>
                    <button class="duck-tab" data-tab="history">Lịch sử</button>
                    <button class="duck-tab" data-tab="settings">Cài đặt</button>
                </div>

                <div class="duck-content">
                    <div class="duck-tab-content active" id="duck-main-tab">
                        <div class="duck-input-group">
                            <label>Mô tả bài tập (tùy chọn):</label>
                            <textarea id="duck-desc" placeholder="Mô tả chi tiết về bài tập cần giải..."></textarea>
                        </div>

                        <div class="duck-provider-info">
                            <span>Provider: <strong id="duck-current-provider">Google Gemini</strong></span>
                        </div>

                        <div class="duck-actions">
                            <button id="duck-solve-btn" class="duck-btn-primary">
                                📷 Chụp màn hình & Giải bài
                            </button>
                            <button id="duck-clear-btn" class="duck-btn-secondary">🗑️ Xóa kết quả</button>
                        </div>

                        <div id="duck-progress" style="display: none;"></div>
                        <div id="duck-error" class="duck-error"></div>
                        <div id="duck-result" class="duck-result"></div>
                    </div>

                    <div class="duck-tab-content" id="duck-history-tab"></div>
                    <div class="duck-tab-content" id="duck-settings-tab"></div>
                </div>
            `;

            // Minimized button
            this.minimizedBtn = ui.createElement('div', 'duck-minimized');
            this.minimizedBtn.innerHTML = '<span class="duck-minimized-text">🐥</span>';
            this.minimizedBtn.title = IS_TOUCH ? 'Touch đúp để hiện lại' : 'Double click để hiện lại';

            // Append to body
            document.body.appendChild(this.mainUI);
            document.body.appendChild(this.minimizedBtn);

            // Make draggable
            this.makeDraggable(this.mainUI);
            this.makeDraggable(this.minimizedBtn);

            // Initialize tab contents
            this.initializeTabContents();
        }

        initializeTabContents() {
            const historyTab = this.mainUI.querySelector('#duck-history-tab');
            historyTab.appendChild(ui.createHistoryPanel());

            const settingsTab = this.mainUI.querySelector('#duck-settings-tab');
            settingsTab.appendChild(ui.createSettingsPanel());

            const progressContainer = this.mainUI.querySelector('#duck-progress');
            progressContainer.appendChild(ui.createProgressBar());
        }

        attachEventListeners() {
            // Tab switching with pointerup
            this.mainUI.querySelectorAll('.duck-tab').forEach(tab => {
                tab.addEventListener('pointerup', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.switchTab(tab.dataset.tab);
                });
            });

            // Main actions with pointerup
            this.mainUI.querySelector('#duck-solve-btn').addEventListener('pointerup', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleSolve();
            });

            this.mainUI.querySelector('#duck-clear-btn').addEventListener('pointerup', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.clearResult();
            });

            // Control buttons with pointerup - with higher priority event handling
            const controlBtns = {
                '#duck-minimize-btn': () => this.minimize(),
                '#duck-close-btn': () => this.close(),
                '#duck-history-btn': () => this.switchTab('history'),
                '#duck-settings-btn': () => this.switchTab('settings')
            };

            Object.keys(controlBtns).forEach(selector => {
                const btn = this.mainUI.querySelector(selector);
                if (btn) {
                    // Add multiple event types to ensure they work
                    ['pointerup', 'click'].forEach(eventType => {
                        btn.addEventListener(eventType, (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            console.log(`${selector} clicked`); // Debug log
                            controlBtns[selector]();
                        }, { capture: true });
                    });

                    // Also add touch events for mobile devices
                    if (IS_TOUCH) {
                        btn.addEventListener('touchend', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            console.log(`${selector} touched`); // Debug log
                            controlBtns[selector]();
                        }, { capture: true });
                    }
                }
            });

            // Minimized button with double tap support
            if (IS_TOUCH) {
                let lastTap = 0;
                this.minimizedBtn.addEventListener('pointerup', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const currentTime = Date.now();
                    const tapLength = currentTime - lastTap;

                    if (tapLength < 500 && tapLength > 0) {
                        this.restore();
                    }
                    lastTap = currentTime;
                });
            } else {
                this.minimizedBtn.addEventListener('dblclick', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.restore();
                });
            }

            this.attachSettingsListeners();
        }

        attachSettingsListeners() {
            const settingsPanel = this.mainUI.querySelector('#duck-settings-tab');

            settingsPanel.querySelector('#duck-gemini-key').addEventListener('change', (e) => {
                CONFIG.API_PROVIDERS.GEMINI.key = e.target.value;
                GM_setValue('gemini_key', e.target.value);
            });

            settingsPanel.querySelector('#duck-theme-select').addEventListener('change', (e) => {
                themeManager.apply(e.target.value);
            });

            const fontSizeSlider = settingsPanel.querySelector('#duck-font-size');
            const fontSizeValue = settingsPanel.querySelector('#duck-font-size-value');

            fontSizeSlider.addEventListener('input', (e) => {
                const size = parseInt(e.target.value);
                fontSizeValue.textContent = size + 'px';
                state.settings.fontSize = size;
                this.applyFontSize();
                GM_setValue('font_size', size);
            });

            // UI Scale slider
            const uiScaleSlider = settingsPanel.querySelector('#duck-ui-scale');
            const uiScaleValue = settingsPanel.querySelector('#duck-ui-scale-value');

            uiScaleSlider.addEventListener('input', (e) => {
                const scale = parseInt(e.target.value);
                uiScaleValue.textContent = scale + '%';
                state.settings.uiScale = scale;
                this.applyUIScale();
                GM_setValue('ui_scale', scale);
            });

            settingsPanel.querySelector('#duck-sound-toggle').addEventListener('change', (e) => {
                state.settings.soundEnabled = e.target.checked;
                GM_setValue('sound_enabled', e.target.checked);
            });

            settingsPanel.querySelector('#duck-save-settings').addEventListener('pointerup', (e) => {
                e.preventDefault();
                this.saveAllSettings();
                this.showNotification('Đã lưu cài đặt thành công!', 'success');
            });

            settingsPanel.querySelector('#duck-reset-settings').addEventListener('pointerup', async (e) => {
                e.preventDefault();
                const confirmed = await dialogManager.confirm(
                    'Khôi phục cài đặt',
                    'Bạn có chắc muốn khôi phục tất cả cài đặt về mặc định?',
                    { confirmText: 'Khôi phục' }
                );
                if (confirmed) {
                    this.resetSettings();
                }
            });
        }

        applyFontSize() {
            this.mainUI.style.fontSize = state.settings.fontSize + 'px';
            document.documentElement.style.setProperty('--duck-font-size', state.settings.fontSize + 'px');
        }

        applyUIScale() {
            const scale = state.settings.uiScale / 100;
            this.mainUI.style.transform = `scale(${scale})`;
            this.mainUI.style.transformOrigin = 'top left';

            // Get current position
            const currentX = parseInt(this.mainUI.style.left) || 0;
            const currentY = parseInt(this.mainUI.style.top) || 0;

            // Use simple bounds check with element's actual dimensions
            const elementWidth = this.mainUI.offsetWidth;
            const elementHeight = this.mainUI.offsetHeight;

            // Minimal margins - let user drag close to edges
            const margin = 10;

            const maxX = window.innerWidth - elementWidth - margin;
            const maxY = window.innerHeight - elementHeight - margin;
            const minX = margin;
            const minY = margin;

            // Only adjust position if element is actually outside bounds
            let newX = currentX;
            let newY = currentY;

            if (currentX > maxX) newX = maxX;
            if (currentX < minX) newX = minX;
            if (currentY > maxY) newY = maxY;
            if (currentY < minY) newY = minY;

            // Apply corrected position only if needed
            if (newX !== currentX || newY !== currentY) {
                this.mainUI.style.left = newX + 'px';
                this.mainUI.style.top = newY + 'px';
            }

            // Scale minimized button
            this.minimizedBtn.style.transform = `scale(${scale})`;
            this.minimizedBtn.style.transformOrigin = 'top left';

            // Simple bounds for minimized button too
            const minBtnWidth = this.minimizedBtn.offsetWidth;
            const minBtnHeight = this.minimizedBtn.offsetHeight;

            const minBtnMaxX = window.innerWidth - minBtnWidth - margin;
            const minBtnMaxY = window.innerHeight - minBtnHeight - margin;

            const minBtnCurrentX = parseInt(this.minimizedBtn.style.left) || 0;
            const minBtnCurrentY = parseInt(this.minimizedBtn.style.top) || 0;

            if (minBtnCurrentX > minBtnMaxX) {
                this.minimizedBtn.style.left = minBtnMaxX + 'px';
            }
            if (minBtnCurrentY > minBtnMaxY) {
                this.minimizedBtn.style.top = minBtnMaxY + 'px';
            }
        }

        async handleSolve() {
            if (state.isProcessing) return;

            try {
                state.isProcessing = true;
                this.showProgress();
                this.clearError();

                const provider = CONFIG.API_PROVIDERS.GEMINI;
                if (!provider.key) {
                    throw new Error(`Chưa cấu hình API key cho ${provider.name}. Vui lòng vào tab Cài đặt để cấu hình.`);
                }

                this.updateProgress('Đang chụp màn hình...', 20);
                const canvas = await html2canvas(document.body, {
                    useCORS: true,
                    allowTaint: true,
                    scale: DEVICE_TYPE === 'mobile' ? 0.6 : 0.8
                });
                const imageDataURL = canvas.toDataURL("image/png", 0.8);

                this.updateProgress('Đang gửi đến AI...', 60);
                const description = this.mainUI.querySelector('#duck-desc').value;

                const result = await apiHandlers.sendToGemini(imageDataURL, description);

                this.updateProgress('Hoàn thành!', 100);
                await utils.delay(500);

                this.displayResult(result);

                utils.saveToHistory({
                    description,
                    result,
                    provider: 'GEMINI'
                });

                utils.playNotificationSound();

            } catch (error) {
                this.showError(error.message);
                console.error('Duck AI Error:', error);
            } finally {
                state.isProcessing = false;
                this.hideProgress();
            }
        }

        switchTab(tabName) {
            this.mainUI.querySelectorAll('.duck-tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.tab === tabName);
            });

            this.mainUI.querySelectorAll('.duck-tab-content').forEach(content => {
                content.classList.toggle('active', content.id === `duck-${tabName}-tab`);
            });

            if (tabName === 'history') {
                const historyPanel = this.mainUI.querySelector('#duck-history-tab .duck-history-panel');
                if (historyPanel) {
                    ui.updateHistoryPanel(historyPanel);
                }
            }
        }

        showProgress() {
            this.mainUI.querySelector('#duck-progress').style.display = 'block';
            this.mainUI.querySelector('#duck-solve-btn').disabled = true;
        }

        hideProgress() {
            this.mainUI.querySelector('#duck-progress').style.display = 'none';
            this.mainUI.querySelector('#duck-solve-btn').disabled = false;
        }

        updateProgress(text, percent) {
            const progressContainer = this.mainUI.querySelector('#duck-progress');
            const progressText = progressContainer.querySelector('.duck-progress-text');
            const progressFill = progressContainer.querySelector('.duck-progress-fill');

            if (progressText) progressText.textContent = text;
            if (progressFill) progressFill.style.width = `${percent}%`;
        }

        displayResult(result) {
            const resultContainer = this.mainUI.querySelector('#duck-result');
            resultContainer.innerHTML = result.replace(/\n/g, '<br>');
            resultContainer.scrollTop = 0;
        }

        clearResult() {
            this.mainUI.querySelector('#duck-result').innerHTML = '';
            this.mainUI.querySelector('#duck-desc').value = '';
            this.clearError();
        }

        showError(message) {
            const errorContainer = this.mainUI.querySelector('#duck-error');
            errorContainer.textContent = '❌ ' + message;
        }

        clearError() {
            this.mainUI.querySelector('#duck-error').textContent = '';
        }

        showNotification(message, type = 'info') {
            const notification = ui.createElement('div', `duck-notification duck-notification-${type}`);
            notification.textContent = message;
            document.body.appendChild(notification);

            setTimeout(() => {
                notification.classList.add('duck-notification-show');
            }, 100);

            setTimeout(() => {
                notification.classList.remove('duck-notification-show');
                setTimeout(() => document.body.removeChild(notification), 300);
            }, 3000);
        }

        minimize() {
            this.mainUI.style.display = 'none';
            this.minimizedBtn.style.display = 'flex';
        }

        restore() {
            this.mainUI.style.display = 'block';
            this.minimizedBtn.style.display = 'none';
        }

        async close() {
            const confirmed = await dialogManager.showCloseDialog();

            if (confirmed) {
                this.mainUI.style.display = 'none';
                this.minimizedBtn.style.display = 'none';
            }
        }

        saveAllSettings() {
            Object.keys(state.settings).forEach(key => {
                GM_setValue(key, state.settings[key]);
            });
        }

        resetSettings() {
            GM_deleteValue('gemini_key');
            GM_deleteValue('current_theme');
            GM_deleteValue('font_size');
            GM_deleteValue('sound_enabled');
            GM_deleteValue('auto_save');
            GM_deleteValue('ui_scale');
            location.reload();
        }

        getEnhancedStyles() {
            return `
            :root {
                --duck-primary: rgba(18, 18, 18, 0.9);
                --duck-secondary: rgba(30, 30, 30, 0.8);
                --duck-accent: #4caf50;
                --duck-text: #e0e0e0;
                --duck-border: rgba(255, 255, 255, 0.1);
                --duck-shadow: 0 8px 32px rgba(0, 0, 0, 0.8);
                --duck-radius: ${DEVICE_TYPE === 'mobile' ? '12px' : '16px'};
                --duck-font-size: ${state.settings.fontSize}px;
            }

            /* Prevent text selection on touch devices */
            ${IS_TOUCH ? `
            .duck-main-ui *, .duck-minimized * {
                -webkit-user-select: none;
                -moz-user-select: none;
                -ms-user-select: none;
                user-select: none;
                -webkit-touch-callout: none;
                -webkit-tap-highlight-color: transparent;
            }

            /* Allow text selection in input areas */
            .duck-input-group textarea,
            .duck-settings-section input,
            .duck-settings-section select,
            .duck-settings-panel,
            .duck-settings-section {
                -webkit-user-select: text !important;
                -moz-user-select: text !important;
                -ms-user-select: text !important;
                user-select: text !important;
            }
            ` : ''}

            @keyframes duck-fade-in {
                from {
                    opacity: 0;
                    transform: scale(0.9) translateY(-20px);
                }
                to {
                    opacity: 1;
                    transform: scale(1) translateY(0);
                }
            }

            @keyframes duck-slide-in {
                from {
                    transform: translateX(-100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }

            @keyframes duck-progress {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }

            @keyframes duck-bounce {
                0%, 20%, 50%, 80%, 100% {
                    transform: translateY(0);
                }
                40% {
                    transform: translateY(-5px);
                }
                60% {
                    transform: translateY(-3px);
                }
            }

            .duck-main-ui {
                position: fixed;
                top: ${DEVICE_TYPE === 'mobile' ? '20px' : '80px'};
                left: ${DEVICE_TYPE === 'mobile' ? '10px' : '80px'};
                width: ${DEVICE_TYPE === 'mobile' ? 'calc(100vw - 20px)' :
                        DEVICE_TYPE === 'tablet' ? '450px' : '420px'};
                max-width: ${DEVICE_TYPE === 'mobile' ? 'none' : '450px'};
                max-height: ${DEVICE_TYPE === 'mobile' ? 'calc(100vh - 40px)' : '600px'};
                backdrop-filter: blur(20px);
                background: var(--duck-primary);
                border-radius: var(--duck-radius);
                border: 1px solid var(--duck-border);
                box-shadow: var(--duck-shadow);
                z-index: 999999;
                font-family: 'Segoe UI', -apple-system, sans-serif;
                font-size: var(--duck-font-size);
                color: var(--duck-text);
                animation: duck-fade-in 0.6s cubic-bezier(0.68, -0.55, 0.265, 1.55);
                overflow: hidden;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            .duck-main-ui:hover {
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.9);
                transform: translateY(-2px);
            }

            .duck-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: ${DEVICE_TYPE === 'mobile' ? '12px 16px' : '16px 20px'};
                background: linear-gradient(135deg, rgba(255,255,255,0.1), rgba(0,0,0,0.1));
                border-bottom: 1px solid var(--duck-border);
                cursor: move;
                user-select: none;
                ${IS_TOUCH ? 'touch-action: none;' : ''}
            }

            .duck-header h2 {
                margin: 0;
                font-size: ${DEVICE_TYPE === 'mobile' ? '16px' : '18px'};
                font-weight: 600;
                background: linear-gradient(45deg, var(--duck-accent), #81c784);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                background-clip: text;
                pointer-events: none;
                animation: duck-bounce 2s infinite;
            }

            .duck-header-controls {
                display: flex;
                gap: ${DEVICE_TYPE === 'mobile' ? '6px' : '8px'};
            }

            .duck-control-btn {
                width: ${DEVICE_TYPE === 'mobile' ? '32px' : '28px'};
                height: ${DEVICE_TYPE === 'mobile' ? '32px' : '28px'};
                border: none;
                border-radius: 6px;
                background: rgba(255, 255, 255, 0.1);
                color: var(--duck-text);
                cursor: pointer;
                font-size: 14px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                z-index: 10;
                position: relative;
                ${IS_TOUCH ? '-webkit-tap-highlight-color: transparent;' : ''}
            }

            .duck-control-btn:hover,
            .duck-control-btn:active {
                background: rgba(255, 255, 255, 0.2);
                transform: scale(1.1) rotate(5deg);
            }

            .duck-control-btn.duck-close {
                background: rgba(244, 67, 54, 0.8);
            }

            .duck-control-btn.duck-close:hover,
            .duck-control-btn.duck-close:active {
                background: rgba(244, 67, 54, 1);
                transform: scale(1.1) rotate(-5deg);
            }

            .duck-tabs {
                display: flex;
                background: rgba(0, 0, 0, 0.2);
                border-bottom: 1px solid var(--duck-border);
            }

            .duck-tab {
                flex: 1;
                padding: ${DEVICE_TYPE === 'mobile' ? '14px 12px' : '12px 16px'};
                border: none;
                background: transparent;
                color: rgba(224, 224, 224, 0.7);
                cursor: pointer;
                font-size: ${DEVICE_TYPE === 'mobile' ? '14px' : '13px'};
                font-weight: 500;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                ${IS_TOUCH ? '-webkit-tap-highlight-color: transparent;' : ''}
            }

            .duck-tab:hover,
            .duck-tab:active {
                color: var(--duck-text);
                background: rgba(255, 255, 255, 0.05);
                transform: translateY(-2px);
            }

            .duck-tab.active {
                color: var(--duck-accent);
                background: rgba(255, 255, 255, 0.1);
            }

            .duck-tab.active::after {
                content: '';
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                height: 2px;
                background: var(--duck-accent);
                animation: duck-slide-in 0.3s ease;
            }

            .duck-content {
                max-height: ${DEVICE_TYPE === 'mobile' ? 'calc(100vh - 200px)' : '450px'};
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: var(--duck-accent) transparent;
                -webkit-overflow-scrolling: touch;
                touch-action: pan-y;
            }

            .duck-content::-webkit-scrollbar {
                width: 6px;
            }

            .duck-content::-webkit-scrollbar-track {
                background: transparent;
            }

            .duck-content::-webkit-scrollbar-thumb {
                background: var(--duck-accent);
                border-radius: 3px;
            }

            .duck-tab-content {
                display: none;
                padding: ${DEVICE_TYPE === 'mobile' ? '16px' : '20px'};
                animation: duck-slide-in 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            }

            .duck-tab-content.active {
                display: block;
            }

/* Overlay */
.duck-dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(12px);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000000;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.25s ease, visibility 0.25s ease;
}
.duck-dialog-overlay.duck-dialog-show {
    opacity: 1;
    visibility: visible;
}
.duck-dialog-overlay.duck-dialog-hide {
    opacity: 0;
    visibility: hidden;
}

/* Dialog */
.duck-dialog {
    background: rgba(28, 28, 28, 0.85);
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    max-width: 420px;
    width: 100%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    transform: translateY(-15px) scale(0.96);
    transition: transform 0.25s ease, opacity 0.25s ease;
    opacity: 0;
    overflow: hidden;
}
.duck-dialog-show .duck-dialog {
    transform: translateY(0) scale(1);
    opacity: 1;
}
.duck-dialog-hide .duck-dialog {
    transform: translateY(10px) scale(0.94);
    opacity: 0;
}

/* Header */
.duck-dialog-header {
    padding: 20px;
    font-size: 18px;
    font-weight: 600;
    color: #fff;
    text-align: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    position: relative;
}
.duck-dialog-title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: #fff;
}
.duck-dialog-close-x {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 32px;
    height: 32px;
    border: none;
    background: rgba(255,255,255,0.1);
    color: #fff;
    border-radius: 50%;
    cursor: pointer;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s ease, transform 0.2s ease;
}
.duck-dialog-close-x:hover,
.duck-dialog-close-x:active {
    background: rgba(255,255,255,0.2);
    transform: scale(1.1);
}

/* Body */
.duck-dialog-body {
    padding: 22px 24px;
    font-size: 15px;
    color: rgba(255, 255, 255, 0.85);
    text-align: center;
}
.duck-dialog-message {
    margin: 0;
    font-size: 15px;
    line-height: 1.5;
}
.duck-dialog-details {
    margin-top: 14px;
    padding: 10px 14px;
    background: rgba(255,255,255,0.05);
    border-radius: 8px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.7);
}

/* Actions */
.duck-dialog-actions {
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 20px;
}
.duck-dialog-btn {
    padding: 12px 22px;
    border-radius: 10px;
    border: none;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s ease, transform 0.2s ease;
}
.duck-dialog-confirm {
    background: #007aff;
    color: white;
}
.duck-dialog-confirm:hover {
    background: #3395ff;
}
.duck-dialog-cancel,
.duck-dialog-ok {
    background: rgba(255,255,255,0.1);
    color: white;
}
.duck-dialog-cancel:hover,
.duck-dialog-ok:hover {
    background: rgba(255,255,255,0.2);
}

            .duck-input-group {
                margin-bottom: 16px;
            }

            .duck-input-group label {
                display: block;
                margin-bottom: 6px;
                font-size: ${DEVICE_TYPE === 'mobile' ? '14px' : '13px'};
                font-weight: 500;
                color: rgba(224, 224, 224, 0.9);
            }

            .duck-input-group textarea {
                width: 100%;
                height: ${DEVICE_TYPE === 'mobile' ? '100px' : '80px'};
                padding: ${DEVICE_TYPE === 'mobile' ? '14px' : '12px'};
                border: 1px solid var(--duck-border);
                border-radius: 10px;
                background: var(--duck-secondary) !important;
                color: var(--duck-text) !important;
                font-size: var(--duck-font-size);
                font-family: inherit;
                resize: vertical;
                outline: none;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                box-sizing: border-box;
                ${IS_TOUCH ? '-webkit-appearance: none;' : ''}
            }

            .duck-input-group textarea:focus {
                border-color: var(--duck-accent);
                box-shadow: 0 0 0 2px rgba(76, 175, 80, 0.2);
                transform: translateY(-2px);
            }

            .duck-provider-info {
                background: rgba(0, 0, 0, 0.3);
                padding: ${DEVICE_TYPE === 'mobile' ? '10px 14px' : '8px 12px'};
                border-radius: 8px;
                margin-bottom: 16px;
                font-size: calc(var(--duck-font-size) - 2px);
                text-align: center;
                border: 1px solid var(--duck-border);
            }

            .duck-provider-info strong {
                color: var(--duck-accent);
            }

            .duck-actions {
                display: flex;
                flex-direction: ${DEVICE_TYPE === 'mobile' ? 'column' : 'row'};
                gap: 10px;
                margin-bottom: 16px;
            }

            .duck-btn-primary, .duck-btn-secondary {
                flex: 1;
                padding: ${DEVICE_TYPE === 'mobile' ? '16px' : '12px 16px'};
                border: none;
                border-radius: 10px;
                font-size: var(--duck-font-size);
                font-weight: 500;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                position: relative;
                overflow: hidden;
                ${IS_TOUCH ? '-webkit-tap-highlight-color: transparent;' : ''}
            }

            .duck-btn-primary {
                background: var(--duck-accent);
                color: white;
                box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);
            }

            .duck-btn-primary:hover:not(:disabled),
            .duck-btn-primary:active:not(:disabled) {
                background: #66bb6a;
                transform: translateY(-2px);
                box-shadow: 0 8px 20px rgba(76, 175, 80, 0.4);
            }

            .duck-btn-primary:disabled {
                opacity: 0.6;
                cursor: not-allowed;
                transform: none;
            }

            .duck-btn-secondary {
                background: rgba(255, 255, 255, 0.1);
                color: var(--duck-text);
                border: 1px solid var(--duck-border);
            }

            .duck-btn-secondary:hover,
            .duck-btn-secondary:active {
                background: rgba(255, 255, 255, 0.15);
                transform: translateY(-1px);
            }

            .duck-progress-container {
                margin-bottom: 16px;
            }

            .duck-progress-bar {
                width: 100%;
                height: 6px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 3px;
                overflow: hidden;
                margin-bottom: 8px;
            }

            .duck-progress-fill {
                height: 100%;
                background: linear-gradient(90deg, var(--duck-accent), #81c784);
                background-size: 200% 100%;
                animation: duck-progress 2s linear infinite;
                transition: width 0.3s ease;
                width: 0%;
            }

            .duck-progress-text {
                font-size: calc(var(--duck-font-size) - 2px);
                text-align: center;
                color: rgba(224, 224, 224, 0.8);
            }

            .duck-error {
                background: rgba(244, 67, 54, 0.1);
                border: 1px solid rgba(244, 67, 54, 0.3);
                border-radius: 8px;
                padding: 12px;
                margin-bottom: 12px;
                font-size: calc(var(--duck-font-size) - 1px);
                color: #ff6b6b;
                display: none;
                animation: duck-fade-in 0.3s ease;
            }

            .duck-error:not(:empty) {
                display: block;
            }

            .duck-result {
                background: var(--duck-secondary);
                border: 1px solid var(--duck-border);
                border-radius: 10px;
                padding: 16px;
                max-height: ${DEVICE_TYPE === 'mobile' ? '200px' : '250px'};
                overflow-y: auto;
                font-size: var(--duck-font-size);
                line-height: 1.6;
                white-space: pre-wrap;
                word-wrap: break-word;
                -webkit-overflow-scrolling: touch;
                animation: duck-fade-in 0.4s ease;
                transition: all 0.3s ease;
            }

            .duck-result:empty {
                display: none;
            }

            .duck-result:hover {
                border-color: var(--duck-accent);
            }

            /* History Panel */
            .duck-history-panel {
                max-height: ${DEVICE_TYPE === 'mobile' ? '300px' : '350px'};
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                touch-action: pan-y;
            }

            .duck-no-history {
                text-align: center;
                color: rgba(224, 224, 224, 0.6);
                font-style: italic;
                padding: 40px 20px;
                font-size: var(--duck-font-size);
                animation: duck-fade-in 0.5s ease;
            }

            .duck-history-item {
                background: var(--duck-secondary);
                border: 1px solid var(--duck-border);
                border-radius: 10px;
                padding: ${DEVICE_TYPE === 'mobile' ? '16px' : '12px'};
                margin-bottom: 10px;
                cursor: pointer;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ${IS_TOUCH ? '-webkit-tap-highlight-color: transparent;' : ''}
                animation: duck-fade-in 0.4s ease;
            }

            .duck-history-item:hover,
            .duck-history-item:active {
                background: rgba(255, 255, 255, 0.05);
                border-color: var(--duck-accent);
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }

            .duck-history-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 6px;
            }

            .duck-history-date {
                font-size: calc(var(--duck-font-size) - 3px);
                color: rgba(224, 224, 224, 0.6);
            }

            .duck-history-delete {
                width: ${DEVICE_TYPE === 'mobile' ? '28px' : '20px'};
                height: ${DEVICE_TYPE === 'mobile' ? '28px' : '20px'};
                border: none;
                background: rgba(244, 67, 54, 0.2);
                color: #ff6b6b;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.3s ease;
                ${IS_TOUCH ? '-webkit-tap-highlight-color: transparent;' : ''}
            }

            .duck-history-delete:hover,
            .duck-history-delete:active {
                background: rgba(244, 67, 54, 0.4);
                transform: scale(1.1);
            }

            .duck-history-desc {
                font-size: calc(var(--duck-font-size) - 2px);
                font-weight: 500;
                margin-bottom: 4px;
                color: var(--duck-accent);
            }

            .duck-history-preview {
                font-size: calc(var(--duck-font-size) - 3px);
                color: rgba(224, 224, 224, 0.7);
                line-height: 1.4;
            }

            /* Settings Panel */
            .duck-settings-panel {
                max-height: ${DEVICE_TYPE === 'mobile' ? '300px' : '350px'};
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
                touch-action: pan-y;
            }

            .duck-settings-section {
                margin-bottom: 20px;
                padding-bottom: 16px;
                border-bottom: 1px solid var(--duck-border);
                -webkit-user-select: text;
                -moz-user-select: text;
                -ms-user-select: text;
                user-select: text;
                animation: duck-fade-in 0.5s ease;
            }

            .duck-settings-section:last-child {
                border-bottom: none;
                margin-bottom: 0;
            }

            .duck-settings-section h4 {
                margin: 0 0 10px 0;
                font-size: calc(var(--duck-font-size) + 0px);
                font-weight: 600;
                color: var(--duck-accent);
            }

            .duck-settings-section select,
            .duck-settings-section input[type="password"] {
                width: 100%;
                padding: ${DEVICE_TYPE === 'mobile' ? '12px 14px' : '8px 12px'};
                border: 1px solid var(--duck-border);
                border-radius: 8px;
                background: var(--duck-secondary);
                color: var(--duck-text);
                font-size: calc(var(--duck-font-size) - 1px);
                outline: none;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                ${IS_TOUCH ? '-webkit-appearance: none;' : ''}
            }

            .duck-settings-section select:focus,
            .duck-settings-section input[type="password"]:focus {
                border-color: var(--duck-accent);
                transform: translateY(-1px);
                box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
            }

            .duck-key-input {
                margin-bottom: 10px;
            }

            .duck-key-input label {
                display: block;
                margin-bottom: 4px;
                font-size: calc(var(--duck-font-size) - 2px);
                color: rgba(224, 224, 224, 0.8);
            }

            .duck-checkbox {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: calc(var(--duck-font-size) - 1px);
                margin-bottom: 12px;
                cursor: pointer;
                transition: all 0.2s ease;
                ${IS_TOUCH ? '-webkit-tap-highlight-color: transparent;' : ''}
            }

            .duck-checkbox:hover {
                color: var(--duck-accent);
            }

            .duck-checkbox input[type="checkbox"] {
                width: ${DEVICE_TYPE === 'mobile' ? '20px' : '16px'};
                height: ${DEVICE_TYPE === 'mobile' ? '20px' : '16px'};
                accent-color: var(--duck-accent);
            }

            .duck-slider {
                display: block;
                font-size: calc(var(--duck-font-size) - 1px);
                margin-bottom: 12px;
            }

            .duck-slider input[type="range"] {
                width: 100%;
                margin-top: 6px;
                height: ${DEVICE_TYPE === 'mobile' ? '6px' : '4px'};
                accent-color: var(--duck-accent);
                ${IS_TOUCH ? '-webkit-appearance: none;' : ''}
                transition: all 0.2s ease;
            }

            .duck-scale-hint {
                display: block;
                font-size: calc(var(--duck-font-size) - 4px);
                color: rgba(224, 224, 224, 0.5);
                margin-top: 4px;
                font-style: italic;
            }

            ${IS_TOUCH ? `
            .duck-slider input[type="range"]::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: var(--duck-accent);
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .duck-slider input[type="range"]::-webkit-slider-thumb:hover {
                transform: scale(1.2);
            }

            .duck-slider input[type="range"]::-moz-range-thumb {
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: var(--duck-accent);
                cursor: pointer;
                border: none;
            }
            ` : ''}

            .duck-settings-actions {
                display: flex;
                flex-direction: ${DEVICE_TYPE === 'mobile' ? 'column' : 'row'};
                gap: 10px;
                padding-top: 16px;
            }

            /* Minimized Button */
            .duck-minimized {
                position: fixed;
                top: ${DEVICE_TYPE === 'mobile' ? '20px' : '80px'};
                left: ${DEVICE_TYPE === 'mobile' ? '20px' : '80px'};
                width: ${DEVICE_TYPE === 'mobile' ? '60px' : '80px'};
                height: ${DEVICE_TYPE === 'mobile' ? '60px' : '40px'};
                background: var(--duck-accent);
                border-radius: ${DEVICE_TYPE === 'mobile' ? '30px' : '20px'};
                display: none;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: var(--duck-shadow);
                z-index: 999999;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                animation: duck-fade-in 0.4s ease-out;
                ${IS_TOUCH ? '-webkit-tap-highlight-color: transparent; touch-action: none;' : ''}
            }

            .duck-minimized:hover,
            .duck-minimized:active {
                transform: scale(1.1) rotate(10deg);
                box-shadow: 0 12px 40px rgba(76, 175, 80, 0.4);
            }

            .duck-minimized-text {
                color: white;
                font-weight: 600;
                font-size: ${DEVICE_TYPE === 'mobile' ? '20px' : '12px'};
                font-family: 'Segoe UI', -apple-system, sans-serif;
                user-select: none;
                animation: duck-bounce 2s infinite;
            }

            /* Notifications */
            .duck-notification {
                position: fixed;
                top: ${DEVICE_TYPE === 'mobile' ? '10px' : '20px'};
                right: ${DEVICE_TYPE === 'mobile' ? '10px' : '20px'};
                left: ${DEVICE_TYPE === 'mobile' ? '10px' : 'auto'};
                max-width: ${DEVICE_TYPE === 'mobile' ? 'none' : '300px'};
                padding: ${DEVICE_TYPE === 'mobile' ? '16px' : '12px 16px'};
                background: var(--duck-primary);
                border: 1px solid var(--duck-border);
                border-radius: 8px;
                color: var(--duck-text);
                font-size: calc(var(--duck-font-size) - 1px);
                z-index: 1000000;
                transform: translateX(${DEVICE_TYPE === 'mobile' ? '0' : '400px'});
                opacity: 0;
                transition: all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55);
                box-shadow: var(--duck-shadow);
                text-align: ${DEVICE_TYPE === 'mobile' ? 'center' : 'left'};
            }

            .duck-notification-show {
                transform: translateX(0);
                opacity: 1;
            }

            .duck-notification-success {
                border-color: var(--duck-accent);
                background: rgba(76, 175, 80, 0.1);
                color: #81c784;
            }

            .duck-notification-error {
                border-color: #f44336;
                background: rgba(244, 67, 54, 0.1);
                color: #ff6b6b;
            }

            /* Device-specific optimizations */
            ${DEVICE_TYPE === 'mobile' ? `
            /* Mobile-specific styles */
            .duck-main-ui {
                border-radius: 16px 16px 0 0;
                bottom: 0;
                top: auto;
                left: 0;
                width: 100vw;
                max-width: none;
                max-height: 70vh;
            }

            .duck-content {
                max-height: calc(70vh - 120px);
            }

            .duck-minimized {
                bottom: 20px;
                top: auto;
                right: 20px;
                left: auto;
            }

            /* Prevent body scroll when UI is open */
            body.duck-mobile-open {
                overflow: hidden;
                position: fixed;
                width: 100%;
                height: 100%;
            }
            ` : ''}

            /* Tablet optimizations */
            ${DEVICE_TYPE === 'tablet' ? `
            .duck-main-ui {
                width: 500px;
                max-height: 80vh;
            }

            .duck-content {
                max-height: calc(80vh - 140px);
            }
            ` : ''}

            /* High DPI display optimizations */
            @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
                .duck-main-ui {
                    border-width: 0.5px;
                }

                .duck-control-btn svg {
                    width: ${DEVICE_TYPE === 'mobile' ? '22px' : '18px'};
                    height: ${DEVICE_TYPE === 'mobile' ? '22px' : '18px'};
                }
            }

            /* Landscape mobile optimization */
            @media screen and (max-height: 500px) and (orientation: landscape) {
                .duck-main-ui {
                    max-height: 90vh;
                    top: 5vh;
                    bottom: auto;
                }

                .duck-content {
                    max-height: calc(90vh - 100px);
                }
            }

            /* Dark mode adjustments for better contrast on mobile */
            @media (prefers-color-scheme: dark) {
                .duck-main-ui {
                    backdrop-filter: blur(30px);
                }
            }

            /* Reduce motion for users who prefer it */
            @media (prefers-reduced-motion: reduce) {
                .duck-main-ui,
                .duck-minimized,
                .duck-notification,
                .duck-tab-content,
                .duck-dialog,
                .duck-header h2,
                .duck-minimized-text {
                    animation: none;
                    transition: opacity 0.2s ease, transform 0.2s ease;
                }
            }

            /* Performance optimizations */
            .duck-main-ui * {
                will-change: auto;
            }

            .duck-main-ui:hover *,
            .duck-control-btn:hover,
            .duck-tab:hover,
            .duck-btn-primary:hover,
            .duck-btn-secondary:hover {
                will-change: transform;
            }
            `;
        }
    }

    // Initialize the application
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new StupidDuckApp());
    } else {
        new StupidDuckApp();
    }

})();