// ==UserScript==
// @name         Smart Homework Capture - Groq AI Tutor
// @namespace    https://github.com/smart-homework-capture
// @version      1.0.0
// @description  Capture homework questions on any webpage and solve/explain step-by-step using Groq Vision & Reasoning AI inside an isolated Shadow DOM panel.
// @author       Smart Homework Capture
// @match        *://*/*
// @run-at       document-end
// @noframes
// @connect      api.groq.com
// @require      https://cdn.jsdelivr.net/npm/html2canvas-pro@2.6.5/dist/html2canvas-pro.min.js
// @require      https://cdn.jsdelivr.net/npm/marked@18.3.0/lib/marked.umd.js
// @require      https://cdn.jsdelivr.net/npm/dompurify@3.5.0/dist/purify.min.js
// @require      https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.js
// @resource     katexCSS https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_getResourceText
// ==/UserScript==

(function (globalScope) {
  'use strict';

  const SHC = (globalScope.SHC = globalScope.SHC || {});
  if (typeof window !== 'undefined' && window !== globalScope) {
    window.SHC = SHC;
  }

  // =========================================================================
  // Module: src/core.js
  // =========================================================================
  (function (globalScope, module, exports) {
    /**
     * Smart Homework Capture (Groq Edition) — Core Engine
     *
     * Implements the 8 core platform modules attached to the `SHC` namespace:
     *  1. ErrorHandler
     *  2. StorageManager
     *  3. SettingsManager
     *  4. APIKeyManager
     *  5. GroqAPIClient
     *  6. FailoverEngine
     *  7. ContextManager
     *  8. ConversationManager
     *
     * Compatible with Tampermonkey/Userscript IIFE bundles, browser globals, and Node.js CommonJS/vm tests.
     */
    (function (root, existingSHC) {
      'use strict';

      const SHC = existingSHC || (root.SHC = root.SHC || {});

      // ---------------------------------------------------------------------------
      // Internal Helpers
      // ---------------------------------------------------------------------------

      /**
       * Deep-clones plain JSON-compatible data structures defensively.
       * @template T
       * @param {T} value
       * @returns {T}
       */
      function deepClone(value) {
        if (value === null || typeof value !== 'object') {
          return value;
        }
        if (Array.isArray(value)) {
          return value.map(deepClone);
        }
        const out = {};
        for (const key of Object.keys(value)) {
          out[key] = deepClone(value[key]);
        }
        return out;
      }

      /**
       * Deep-merges source properties onto target defaults without mutating inputs.
       * @param {Object} defaults
       * @param {Object} source
       * @returns {Object}
       */
      function deepMerge(defaults, source) {
        const base = deepClone(defaults || {});
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
          return base;
        }
        for (const key of Object.keys(source)) {
          const srcVal = source[key];
          if (srcVal === undefined) continue;
          const baseVal = base[key];
          if (
            srcVal &&
            typeof srcVal === 'object' &&
            !Array.isArray(srcVal) &&
            baseVal &&
            typeof baseVal === 'object' &&
            !Array.isArray(baseVal)
          ) {
            base[key] = deepMerge(baseVal, srcVal);
          } else {
            base[key] = deepClone(srcVal);
          }
        }
        return base;
      }

      /**
       * Generates a collision-resistant short identifier.
       * @param {string} prefix
       * @returns {string}
       */
      function generateId(prefix = 'id') {
        const ts = Date.now().toString(36);
        const rand = Math.random().toString(36).slice(2, 8);
        return `${prefix}_${ts}_${rand}`;
      }

      /**
       * Parses duration strings such as "2m59.56s", "7.66s", "500ms", or numeric seconds.
       * @param {string|number|null|undefined} raw
       * @returns {number|null}
       */
      function parseDurationToSeconds(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw === 'number') {
          return Number.isFinite(raw) && raw >= 0 ? raw : null;
        }
        const str = String(raw).trim();
        if (!str) return null;

        // Pure numeric string -> seconds
        if (/^\d+(\.\d+)?$/.test(str)) {
          const num = Number(str);
          return Number.isFinite(num) ? num : null;
        }

        // Compound durations like "1h2m3.5s", "2m59.56s", "7.66s", "500ms"
        let totalSeconds = 0;
        let matched = false;
        const regex = /(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi;
        let m;
        while ((m = regex.exec(str)) !== null) {
          matched = true;
          const val = Number(m[1]);
          const unit = m[2].toLowerCase();
          if (unit === 'h') totalSeconds += val * 3600;
          else if (unit === 'm') totalSeconds += val * 60;
          else if (unit === 's') totalSeconds += val;
          else if (unit === 'ms') totalSeconds += val / 1000;
        }
        if (matched) {
          return Math.max(0, totalSeconds);
        }

        // HTTP-date fallback for Retry-After
        const dateMs = Date.parse(str);
        if (!Number.isNaN(dateMs)) {
          return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
        }
        return null;
      }

      /**
       * Normalizes HTTP headers from GM_xmlhttpRequest string, Fetch Headers, or plain object.
       * @param {string|Headers|Object|null|undefined} rawHeaders
       * @returns {Object<string, string>}
       */
      function normalizeHeaders(rawHeaders) {
        const map = {};
        if (!rawHeaders) return map;

        if (typeof rawHeaders === 'string') {
          const lines = rawHeaders.split(/\r?\n/);
          for (const line of lines) {
            const idx = line.indexOf(':');
            if (idx > 0) {
              const k = line.slice(0, idx).trim().toLowerCase();
              const v = line.slice(idx + 1).trim();
              if (k) map[k] = v;
            }
          }
          return map;
        }

        if (typeof rawHeaders.forEach === 'function') {
          rawHeaders.forEach((value, key) => {
            if (key) map[String(key).toLowerCase()] = String(value);
          });
          return map;
        }

        if (typeof rawHeaders === 'object') {
          for (const key of Object.keys(rawHeaders)) {
            if (rawHeaders[key] !== undefined && rawHeaders[key] !== null) {
              map[String(key).toLowerCase()] = String(rawHeaders[key]);
            }
          }
        }
        return map;
      }

      /**
       * Resolves GM_* functions whether bound in userscript closure or mocked on globalThis.
       * @param {string} fnName
       * @returns {Function|null}
       */
      function resolveGMFunction(fnName) {
        try {
          if (fnName === 'GM_getValue' && typeof GM_getValue === 'function') return GM_getValue;
          if (fnName === 'GM_setValue' && typeof GM_setValue === 'function') return GM_setValue;
          if (fnName === 'GM_deleteValue' && typeof GM_deleteValue === 'function') return GM_deleteValue;
          if (fnName === 'GM_xmlhttpRequest' && typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
        } catch (_) {
          // Ignore reference errors in strict sandboxes
        }
        if (root && typeof root[fnName] === 'function') {
          return root[fnName];
        }
        if (typeof globalThis !== 'undefined' && typeof globalThis[fnName] === 'function') {
          return globalThis[fnName];
        }
        return null;
      }

      /**
       * Cancellable delay supporting AbortSignal.
       * @param {number} ms
       * @param {AbortSignal} [signal]
       * @returns {Promise<void>}
       */
      function cancellableSleep(ms, signal) {
        if (signal && signal.aborted) {
          const err = new Error('Request aborted');
          err.name = 'AbortError';
          err.isAbort = true;
          return Promise.reject(err);
        }
        const waitMs = Math.max(0, Number(ms) || 0);
        if (waitMs === 0) return Promise.resolve();

        return new Promise((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (signal && typeof signal.removeEventListener === 'function') {
              signal.removeEventListener('abort', onAbort);
            }
            resolve();
          }, waitMs);

          function onAbort() {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const err = new Error('Request aborted');
            err.name = 'AbortError';
            err.isAbort = true;
            reject(err);
          }

          if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }

      // ===========================================================================
      // 1. ErrorHandler
      // ===========================================================================

      /**
       * Classifies HTTP, Groq API, network, capture, image, and configuration errors
       * with localized Vietnamese/English messages and strictly sanitized technical details.
       */
      class ErrorHandler {
        /**
         * @param {Object} [options]
         * @param {string|Function} [options.language='vi'] Default language or getter function.
         */
        constructor(options = {}) {
          this._languageOption = options.language || 'vi';
        }

        /**
         * Resolves active display language ('vi' | 'en').
         * @param {string} [overrideLang]
         * @returns {'vi'|'en'}
         */
        getLanguage(overrideLang) {
          const lang =
            overrideLang ||
            (typeof this._languageOption === 'function'
              ? this._languageOption()
              : this._languageOption);
          return lang === 'en' ? 'en' : 'vi';
        }

        /**
         * Masks raw API keys (`gsk_...`), Bearer tokens, and auth header snippets in text or objects.
         * @param {*} input
         * @returns {string}
         */
        static sanitize(input) {
          if (input === null || input === undefined) return '';
          let str;
          if (typeof input === 'string') {
            str = input;
          } else if (input instanceof Error) {
            str = `${input.name || 'Error'}: ${input.message || ''}`;
          } else {
            try {
              str = JSON.stringify(ErrorHandler.sanitizeObject(input));
            } catch (_) {
              str = String(input);
            }
          }

          return ErrorHandler.sanitizeString(str);
        }

        /**
         * Sanitizes a string so secrets, Bearer tokens, and auth headers are never leaked.
         * @param {string} str
         * @returns {string}
         */
        static sanitizeString(str) {
          if (!str || typeof str !== 'string') return '';
          return str
            // Mask Bearer tokens (case-insensitive)
            .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
            // Mask auth header / key-value assignments
            .replace(
              /((?:authorization|x-api-key|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?)([^"'\s,;}\]]+)/gi,
              (_, prefix, val) => {
                if (/^\[REDACTED/i.test(val)) return `${prefix}${val}`;
                return `${prefix}[REDACTED]`;
              }
            )
            // Mask Groq API keys (`gsk_...`) completely so zero secret prefix/suffix leaks in logs/errors
            .replace(/gsk_[A-Za-z0-9_-]+/g, 'gsk_***REDACTED***');
        }

        /**
         * Recursively clones and sanitizes an object/array, redacting secret fields.
         * @param {*} value
         * @param {WeakSet} [seen]
         * @returns {*}
         */
        static sanitizeObject(value, seen = new WeakSet()) {
          if (value === null || value === undefined) return value;
          if (typeof value === 'string') return ErrorHandler.sanitizeString(value);
          if (typeof value !== 'object') return value;
          if (seen.has(value)) return '[Circular]';
          seen.add(value);

          if (Array.isArray(value)) {
            return value.map((item) => ErrorHandler.sanitizeObject(item, seen));
          }

          const sensitiveKeyRe = /^(?:authorization|x-api-key|api_?key|rawkey|secret|secretkey|accesstoken|authtoken|authheader)$/i;
          const out = {};
          for (const key of Object.keys(value)) {
            if (sensitiveKeyRe.test(key)) {
              out[key] = '[REDACTED]';
            } else if (key === 'key' && typeof value[key] === 'string' && /^gsk_/i.test(value[key].trim())) {
              out[key] = '[REDACTED]';
            } else {
              out[key] = ErrorHandler.sanitizeObject(value[key], seen);
            }
          }
          return out;
        }

        /**
         * Alias for `ErrorHandler.sanitize`.
         * @param {*} input
         * @returns {string}
         */
        static maskSecrets(input) {
          return ErrorHandler.sanitize(input);
        }

        /**
         * Classifies an error or HTTP failure context into a structured object with localized UX text.
         * @param {*} errorOrContext
         * @param {Object} [options]
         * @param {string} [options.language]
         * @param {string} [options.model]
         * @returns {Object}
         */
        static classify(errorOrContext, options = {}) {
          const lang = options.language === 'en' ? 'en' : 'vi';
          const raw = errorOrContext || {};

          // Already classified
          if (raw && raw.classified && typeof raw.classified === 'object' && raw.classified.code) {
            const cloned = deepClone(raw.classified);
            cloned.userMessage = cloned.messages?.[lang] || cloned.userMessage;
            return cloned;
          }
          if (raw && typeof raw === 'object' && raw.code && raw.messages && raw.technicalDetails !== undefined) {
            const cloned = deepClone(raw);
            cloned.userMessage = cloned.messages?.[lang] || cloned.userMessage;
            return cloned;
          }

          const status =
            typeof raw.status === 'number'
              ? raw.status
              : typeof raw.statusCode === 'number'
                ? raw.statusCode
                : null;
          const codeHint = typeof raw.code === 'string' ? raw.code.toUpperCase() : '';
          const nameHint = typeof raw.name === 'string' ? raw.name : '';
          const headers = normalizeHeaders(raw.headers || raw.responseHeaders);

          let parsedBody = raw.body;
          if (typeof parsedBody === 'string') {
            try {
              parsedBody = JSON.parse(parsedBody);
            } catch (_) {
              // keep string
            }
          }

          const apiErrorObj =
            parsedBody && typeof parsedBody === 'object' && parsedBody.error && typeof parsedBody.error === 'object'
              ? parsedBody.error
              : null;
          const apiMessage = apiErrorObj?.message || (typeof parsedBody === 'string' ? parsedBody : '') || raw.message || '';
          const apiType = apiErrorObj?.type || raw.apiType || null;
          const sanitizedMsg = ErrorHandler.sanitizeString(String(apiMessage || ''));
          const rawBodyText = typeof raw.body === 'string' ? raw.body : apiMessage;

          // Extract retry-after / rate-limit wait seconds if available
          const retryAfterHeader = headers['retry-after'];
          const resetReqHeader = headers['x-ratelimit-reset-requests'];
          const resetTokHeader = headers['x-ratelimit-reset-tokens'];
          const retryAfterSec =
            typeof raw.retryAfterSec === 'number'
              ? raw.retryAfterSec
              : parseDurationToSeconds(retryAfterHeader) ??
                parseDurationToSeconds(resetReqHeader) ??
                parseDurationToSeconds(resetTokHeader);

          const detailsParts = [];
          if (status) detailsParts.push(`HTTP ${status}`);
          if (codeHint) detailsParts.push(`Code: ${codeHint}`);
          if (apiType) detailsParts.push(`Type: ${ErrorHandler.sanitizeString(String(apiType))}`);
          if (options.model) detailsParts.push(`Model: ${ErrorHandler.sanitizeString(String(options.model))}`);
          if (sanitizedMsg) detailsParts.push(`Message: ${sanitizedMsg}`);
          if (raw.technicalDetails) detailsParts.push(ErrorHandler.sanitize(raw.technicalDetails));
          const technicalDetails = ErrorHandler.sanitizeString(detailsParts.join(' | ') || 'Unknown error');

          const buildResult = ({
            code,
            category,
            retryable = false,
            failoverEligible = false,
            isAbort = false,
            isRateLimit = false,
            isOrgLevelRateLimit = false,
            isUncertainState = false,
            allowRetry = false,
            vi,
            en,
            titleVi,
            titleEn,
          }) => ({
            code,
            category,
            status,
            retryable,
            failoverEligible,
            isAbort,
            isRateLimit,
            isOrgLevelRateLimit,
            isUncertainState,
            allowRetry,
            retryAfterSec: retryAfterSec ?? null,
            apiType,
            title: lang === 'en' ? titleEn : titleVi,
            messages: { vi, en },
            userMessage: lang === 'en' ? en : vi,
            technicalDetails,
            timestamp: Date.now(),
          });

          // 1. Abort / Cancellation
          if (
            raw.isAbort ||
            nameHint === 'AbortError' ||
            codeHint === 'ABORTED' ||
            codeHint === 'ERR_ABORTED' ||
            status === 499
          ) {
            return buildResult({
              code: 'ABORTED',
              category: 'abort',
              isAbort: true,
              titleVi: 'Đã hủy yêu cầu',
              titleEn: 'Request Cancelled',
              vi: 'Yêu cầu đã được hủy bởi người dùng.',
              en: 'The request was cancelled by the user.',
            });
          }

          // 2. Explicit app/config/validation codes
          if (codeHint === 'NO_KEY') {
            return buildResult({
              code: 'NO_KEY',
              category: 'config',
              titleVi: 'Chưa có API Key',
              titleEn: 'No API Key',
              vi: 'Chưa có Groq API Key nào. Vui lòng mở Trình quản lý API Key để thêm ít nhất một key.',
              en: 'No Groq API key is configured. Please add at least one key in the API Key Manager.',
            });
          }

          if (codeHint === 'NO_ACTIVE_KEY') {
            const waitNoteVi = retryAfterSec ? ` Có thể thử lại sau khoảng ${Math.ceil(retryAfterSec)} giây.` : '';
            const waitNoteEn = retryAfterSec ? ` Try again in about ${Math.ceil(retryAfterSec)} seconds.` : '';
            return buildResult({
              code: 'NO_ACTIVE_KEY',
              category: 'config',
              titleVi: 'Không có API Key khả dụng',
              titleEn: 'No Active API Key',
              vi: `Tất cả API Key hiện đang bị vô hiệu hóa, không hợp lệ hoặc đang trong thời gian chờ.${waitNoteVi}`,
              en: `All API keys are currently disabled, invalid, or in cooldown.${waitNoteEn}`,
            });
          }

          if (codeHint === 'NON_VISION_MODEL') {
            return buildResult({
              code: 'NON_VISION_MODEL',
              category: 'validation',
              titleVi: 'Model không hỗ trợ ảnh',
              titleEn: 'Model Does Not Support Vision',
              vi: 'Model hiện tại chỉ hỗ trợ văn bản và không thể xử lý ảnh. Hãy chuyển sang model Vision (ví dụ: qwen/qwen3.8-27b).',
              en: 'The selected model is text-only and cannot process images. Please switch to a Vision model (e.g., qwen/qwen3.8-27b).',
            });
          }

          if (codeHint === 'EMPTY_RESPONSE') {
            return buildResult({
              code: 'EMPTY_RESPONSE',
              category: 'parse',
              allowRetry: true,
              titleVi: 'Phản hồi trống',
              titleEn: 'Empty Response',
              vi: 'Groq API trả về phản hồi trống. Vui lòng thử gửi lại yêu cầu.',
              en: 'Groq API returned an empty response. Please try sending the request again.',
            });
          }

          if (codeHint === 'INVALID_JSON') {
            return buildResult({
              code: 'INVALID_JSON',
              category: 'parse',
              allowRetry: true,
              titleVi: 'Dữ liệu JSON không hợp lệ',
              titleEn: 'Invalid JSON Response',
              vi: 'Không thể phân tích phản hồi JSON từ máy chủ Groq.',
              en: 'Unable to parse JSON response from Groq servers.',
            });
          }

          if (codeHint === 'CAPTURE_ERROR') {
            return buildResult({
              code: 'CAPTURE_ERROR',
              category: 'capture',
              titleVi: 'Lỗi chụp màn hình',
              titleEn: 'Capture Error',
              vi: sanitizedMsg || 'Không thể chụp vùng màn hình đã chọn. Hãy thử chế độ Screen Capture hoặc tải ảnh lên.',
              en: sanitizedMsg || 'Could not capture the selected screen area. Try Screen Capture mode or upload an image.',
            });
          }

          if (codeHint === 'IMAGE_ERROR' || codeHint === 'IMAGE_LIMIT_EXCEEDED') {
            return buildResult({
              code: codeHint,
              category: 'image',
              titleVi: 'Lỗi ảnh đính kèm',
              titleEn: 'Image Validation Error',
              vi: sanitizedMsg || 'Ảnh đính kèm không hợp lệ hoặc vượt quá giới hạn cho phép.',
              en: sanitizedMsg || 'Attached image is invalid or exceeds the allowed limit.',
            });
          }

          if (codeHint === 'CONCURRENT_REQUEST') {
            return buildResult({
              code: 'CONCURRENT_REQUEST',
              category: 'validation',
              titleVi: 'Đang xử lý yêu cầu khác',
              titleEn: 'Request Already In Flight',
              vi: 'Một yêu cầu đang được xử lý. Vui lòng đợi hoàn tất hoặc nhấn Hủy trước khi gửi yêu cầu mới.',
              en: 'Another request is already in progress. Please wait or cancel it before sending a new one.',
            });
          }

          // 3. HTTP Status Codes
          if (status === 400) {
            return buildResult({
              code: 'HTTP_400',
              category: 'client',
              titleVi: 'Yêu cầu không hợp lệ (400)',
              titleEn: 'Bad Request (400)',
              vi: `Yêu cầu gửi tới Groq không hợp lệ (400). Kiểm tra lại tên model, tham số hoặc định dạng ảnh. ${sanitizedMsg ? `(${sanitizedMsg})` : ''}`.trim(),
              en: `Invalid request sent to Groq (400). Check model ID, parameters, or image format. ${sanitizedMsg ? `(${sanitizedMsg})` : ''}`.trim(),
            });
          }

          if (status === 401) {
            return buildResult({
              code: 'HTTP_401',
              category: 'auth',
              failoverEligible: true,
              titleVi: 'API Key không hợp lệ (401)',
              titleEn: 'Unauthorized API Key (401)',
              vi: 'API Key không hợp lệ hoặc đã bị thu hồi (401). Key đã được đánh dấu Invalid và cần kiểm tra lại.',
              en: 'API key is invalid or revoked (401). The key has been marked invalid and needs re-testing.',
            });
          }

          if (status === 403) {
            const lowerBody = String(rawBodyText || '').toLowerCase();
            const isWafOrGeoBlock =
              lowerBody.includes('cloudflare') ||
              lowerBody.includes('cf-ray') ||
              lowerBody.includes('country') ||
              lowerBody.includes('region not supported') ||
              lowerBody.includes('ip blocked') ||
              /<html[\s>]/i.test(lowerBody);
            return buildResult({
              code: 'HTTP_403',
              category: 'permission',
              failoverEligible: !isWafOrGeoBlock,
              titleVi: 'Không có quyền truy cập (403)',
              titleEn: 'Forbidden (403)',
              vi: isWafOrGeoBlock
                ? 'Truy cập bị chặn bởi tường lửa hoặc giới hạn khu vực (403).'
                : 'API Key không có quyền sử dụng tài nguyên hoặc model này (403).',
              en: isWafOrGeoBlock
                ? 'Access was blocked by firewall or regional restrictions (403).'
                : 'This API key lacks permission to access the requested model or resource (403).',
            });
          }

          if (status === 404) {
            return buildResult({
              code: 'HTTP_404',
              category: 'client',
              titleVi: 'Không tìm thấy Model hoặc Endpoint (404)',
              titleEn: 'Not Found (404)',
              vi: 'Không tìm thấy endpoint hoặc Model ID không tồn tại trên Groq (404). Hãy kiểm tra lại Model ID trong Cài đặt.',
              en: 'Endpoint or Model ID was not found on Groq (404). Verify the Model ID in Settings.',
            });
          }

          if (status === 413) {
            return buildResult({
              code: 'HTTP_413',
              category: 'client',
              titleVi: 'Dữ liệu quá lớn (413)',
              titleEn: 'Payload Too Large (413)',
              vi: 'Nội dung hoặc ảnh đính kèm vượt quá giới hạn dung lượng của Groq (413). Hãy giảm kích thước hoặc số lượng ảnh.',
              en: 'Request payload or images exceed Groq size limits (413). Reduce image size or count.',
            });
          }

          if (status === 422) {
            return buildResult({
              code: 'HTTP_422',
              category: 'client',
              titleVi: 'Không thể xử lý yêu cầu (422)',
              titleEn: 'Unprocessable Entity (422)',
              vi: 'Yêu cầu đúng cú pháp nhưng không thể xử lý ngữ nghĩa (422). Vui lòng kiểm tra lại nội dung và thử lại.',
              en: 'Request was well-formed but could not be processed semantically (422). Verify input and retry.',
            });
          }

          if (status === 429) {
            const waitSec = retryAfterSec !== null ? Math.max(1, Math.ceil(retryAfterSec)) : null;
            const waitVi = waitSec ? ` Vui lòng chờ khoảng ${waitSec} giây trước khi gửi lại.` : ' Vui lòng đợi một lát rồi thử lại.';
            const waitEn = waitSec ? ` Please wait about ${waitSec} seconds before retrying.` : ' Please wait briefly and try again.';
            return buildResult({
              code: 'HTTP_429',
              category: 'rate_limit',
              isRateLimit: true,
              isOrgLevelRateLimit: true,
              failoverEligible: false,
              retryAfterSec: waitSec,
              titleVi: 'Vượt giới hạn tốc độ (429)',
              titleEn: 'Rate Limit Exceeded (429)',
              vi: `Đã chạm giới hạn tốc độ Groq (429). Lưu ý: Groq áp dụng giới hạn theo cấp Organization (RPM/TPM/RPD), nên hệ thống không xoay vòng key vô hạn để tránh vượt hạn mức.${waitVi}`,
              en: `Groq rate limit exceeded (429). Note: Groq enforces rate limits at the organization level (RPM/TPM/RPD), so keys are not rotated endlessly to bypass limits.${waitEn}`,
            });
          }

          if (status === 498) {
            return buildResult({
              code: 'HTTP_498',
              category: 'capacity',
              retryable: true,
              titleVi: 'Quá tải Flex Tier (498)',
              titleEn: 'Flex Tier Capacity Exceeded (498)',
              vi: 'Hệ thống Groq Flex Tier đang quá tải tạm thời (498). Vui lòng thử lại sau ít giây.',
              en: 'Groq Flex Tier capacity is temporarily exceeded (498). Please try again shortly.',
            });
          }

          if (status === 500 || status === 502 || status === 503 || (status !== null && status >= 500 && status < 600)) {
            return buildResult({
              code: `HTTP_${status}`,
              category: 'server',
              retryable: true,
              allowRetry: true,
              titleVi: `Lỗi máy chủ Groq (${status})`,
              titleEn: `Groq Server Error (${status})`,
              vi: `Máy chủ Groq đang gặp sự cố tạm thời (${status}). Bạn không bị tính phí cho các phản hồi lỗi máy chủ; vui lòng thử lại sau.`,
              en: `Groq servers encountered a temporary error (${status}). Server errors are not billed; please retry shortly.`,
            });
          }

          // 4. Network / Timeout
          const lowerMsg = sanitizedMsg.toLowerCase();
          if (
            codeHint === 'TIMEOUT' ||
            codeHint === 'ETIMEDOUT' ||
            codeHint === 'NETWORK_ERROR' ||
            codeHint === 'ECONNREFUSED' ||
            codeHint === 'ENOTFOUND' ||
            raw.isNetworkError ||
            raw.isTimeout ||
            lowerMsg.includes('network') ||
            lowerMsg.includes('timeout') ||
            lowerMsg.includes('timed out') ||
            lowerMsg.includes('failed to fetch')
          ) {
            const isTimeout = codeHint === 'TIMEOUT' || codeHint === 'ETIMEDOUT' || raw.isTimeout || lowerMsg.includes('timeout') || lowerMsg.includes('timed out');
            return buildResult({
              code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
              category: 'network',
              isUncertainState: true,
              allowRetry: true,
              titleVi: isTimeout ? 'Hết thời gian chờ kết nối' : 'Lỗi kết nối mạng',
              titleEn: isTimeout ? 'Request Timeout' : 'Network Connection Error',
              vi: isTimeout
                ? 'Yêu cầu bị quá thời gian chờ. Máy chủ có thể đã hoặc chưa xử lý yêu cầu này — hãy kiểm tra kết nối trước khi thử gửi lại để tránh gửi trùng.'
                : 'Không thể kết nối tới Groq API (lỗi mạng). Trạng thái xử lý trên máy chủ chưa rõ ràng — hãy kiểm tra mạng trước khi thử lại để tránh gửi trùng.',
              en: isTimeout
                ? 'The request timed out. The server may or may not have processed it — verify connectivity before retrying to avoid duplicate requests.'
                : 'Unable to reach Groq API (network error). Server processing state is uncertain — check your connection before retrying to avoid duplicate requests.',
            });
          }

          // 5. Fallback Unknown
          return buildResult({
            code: codeHint || 'UNKNOWN_ERROR',
            category: 'unknown',
            allowRetry: true,
            titleVi: 'Lỗi không xác định',
            titleEn: 'Unexpected Error',
            vi: sanitizedMsg ? `Đã xảy ra lỗi: ${sanitizedMsg}` : 'Đã xảy ra lỗi không xác định khi xử lý yêu cầu.',
            en: sanitizedMsg ? `An error occurred: ${sanitizedMsg}` : 'An unexpected error occurred while processing the request.',
          });
        }

        /**
         * Instance wrapper around `ErrorHandler.classify` using instance language configuration.
         * @param {*} errorOrContext
         * @param {Object} [options]
         * @returns {Object}
         */
        classify(errorOrContext, options = {}) {
          return ErrorHandler.classify(errorOrContext, {
            ...options,
            language: this.getLanguage(options.language),
          });
        }

        /**
         * Creates a sanitized `Error` instance enriched with classification fields.
         * @param {*} errorOrContext
         * @param {Object} [options]
         * @returns {Error}
         */
        toError(errorOrContext, options = {}) {
          const classified = this.classify(errorOrContext, options);
          const err = new Error(classified.userMessage);
          err.name = 'SHCError';
          err.code = classified.code;
          err.category = classified.category;
          err.status = classified.status;
          err.userMessage = classified.userMessage;
          err.technicalDetails = classified.technicalDetails;
          err.retryAfterSec = classified.retryAfterSec;
          err.isAbort = classified.isAbort;
          err.isRateLimit = classified.isRateLimit;
          err.isOrgLevelRateLimit = classified.isOrgLevelRateLimit;
          err.isUncertainState = classified.isUncertainState;
          err.allowRetry = classified.allowRetry;
          err.classified = classified;
          return err;
        }
      }

      // ===========================================================================
      // 2. StorageManager
      // ===========================================================================

      /**
       * Persistent storage abstraction wrapping Tampermonkey GM_* APIs with
       * localStorage fallback, bucket isolation, export/import/wipe-all, and secret redaction.
       */
      class StorageManager {
        /**
         * @param {Object} [options]
         * @param {Object} [options.gm] Optional injected GM storage adapter `{ getValue, setValue, deleteValue }`.
         * @param {Storage} [options.localStorage] Optional localStorage-compatible adapter.
         */
        constructor(options = {}) {
          this._gm = options.gm || null;
          this._localStorage = options.localStorage || null;
          this._memoryFallback = new Map();
        }

        /**
         * Resolves the active storage driver dynamically.
         * @returns {'gm-injected'|'gm'|'localStorage'|'memory'}
         */
        getDriverName() {
          if (this._gm && typeof this._gm.getValue === 'function' && typeof this._gm.setValue === 'function') {
            return 'gm-injected';
          }
          if (resolveGMFunction('GM_getValue') && resolveGMFunction('GM_setValue')) {
            return 'gm';
          }
          const ls = this._getLocalStorage();
          if (ls) return 'localStorage';
          return 'memory';
        }

        /**
         * @returns {Storage|null}
         */
        _getLocalStorage() {
          if (this._localStorage) return this._localStorage;
          try {
            if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
            if (root && root.localStorage) return root.localStorage;
          } catch (_) {
            // localStorage may throw SecurityError in sandboxed contexts
          }
          return null;
        }

        /**
         * Recursively redacts API keys and auth secrets from data destined for non-key storage buckets.
         * @param {*} value
         * @param {Object} [options]
         * @param {boolean} [options.allowRawKeyField=false] Only true for `shc_keys` record's `key` field.
         * @returns {*}
         */
        static redactSecrets(value, options = {}) {
          const allowRawKeyField = Boolean(options.allowRawKeyField);
          if (value === null || value === undefined) return value;
          if (typeof value === 'string') {
            return ErrorHandler.sanitizeString(value);
          }
          if (typeof value !== 'object') return value;
          if (Array.isArray(value)) {
            return value.map((item) => StorageManager.redactSecrets(item, options));
          }

          const secretPropRe = /^(?:authorization|x-api-key|api_?key|rawkey|secretkey|accesstoken|authtoken|authheader)$/i;
          const out = {};
          for (const prop of Object.keys(value)) {
            const val = value[prop];
            if (allowRawKeyField && prop === 'key' && typeof val === 'string') {
              out[prop] = val;
              continue;
            }
            if (secretPropRe.test(prop)) {
              out[prop] = '[REDACTED]';
              continue;
            }
            if (prop === 'key' && typeof val === 'string' && /^gsk_/i.test(val.trim())) {
              out[prop] = '[REDACTED]';
              continue;
            }
            out[prop] = StorageManager.redactSecrets(val, options);
          }
          return out;
        }

        /**
         * Returns true if any unmasked Groq API key (`gsk_...`) or Bearer secret exists in the value.
         * @param {*} value
         * @returns {boolean}
         */
        static containsSecret(value) {
          if (value === null || value === undefined) return false;
          const serialized = typeof value === 'string' ? value : JSON.stringify(value);
          if (!serialized) return false;
          if (/gsk_[A-Za-z0-9_-]{8,}/.test(serialized)) return true;
          if (/Bearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{8,}/i.test(serialized)) return true;
          return false;
        }

        /**
         * Reads and parses a storage bucket.
         * @template T
         * @param {string} key
         * @param {T} [defaultValue=null]
         * @returns {T}
         */
        get(key, defaultValue = null) {
          if (!key) return deepClone(defaultValue);

          let raw;
          const driver = this.getDriverName();
          try {
            if (driver === 'gm-injected') {
              raw = this._gm.getValue(key, undefined);
            } else if (driver === 'gm') {
              const gmGet = resolveGMFunction('GM_getValue');
              raw = gmGet(key, undefined);
            } else if (driver === 'localStorage') {
              const ls = this._getLocalStorage();
              const item = ls.getItem(key);
              raw = item === null ? undefined : item;
            } else {
              raw = this._memoryFallback.has(key) ? this._memoryFallback.get(key) : undefined;
            }
          } catch (_) {
            raw = this._memoryFallback.has(key) ? this._memoryFallback.get(key) : undefined;
          }

          if (raw === undefined || raw === null || raw === '') {
            return deepClone(defaultValue);
          }

          if (typeof raw === 'string') {
            try {
              return JSON.parse(raw);
            } catch (_) {
              return raw;
            }
          }
          return deepClone(raw);
        }

        /**
         * Serializes and persists a value to a storage bucket, enforcing secret redaction on non-key buckets.
         * @param {string} key
         * @param {*} value
         * @returns {boolean}
         */
        set(key, value) {
          if (!key) return false;

          const isKeysBucket = key === StorageManager.KEYS.KEYS;
          const safeValue = isKeysBucket
            ? StorageManager.redactSecrets(value, { allowRawKeyField: true })
            : StorageManager.redactSecrets(value, { allowRawKeyField: false });

          const payload = JSON.stringify(safeValue);
          this._memoryFallback.set(key, payload);

          const driver = this.getDriverName();
          try {
            if (driver === 'gm-injected') {
              this._gm.setValue(key, payload);
              return true;
            }
            if (driver === 'gm') {
              const gmSet = resolveGMFunction('GM_setValue');
              gmSet(key, payload);
              return true;
            }
            if (driver === 'localStorage') {
              const ls = this._getLocalStorage();
              ls.setItem(key, payload);
              return true;
            }
            return true;
          } catch (_) {
            return false;
          }
        }

        /**
         * Deletes a storage bucket.
         * @param {string} key
         * @returns {boolean}
         */
        remove(key) {
          if (!key) return false;
          this._memoryFallback.delete(key);

          const driver = this.getDriverName();
          try {
            if (driver === 'gm-injected' && typeof this._gm.deleteValue === 'function') {
              this._gm.deleteValue(key);
              return true;
            }
            if (driver === 'gm') {
              const gmDel = resolveGMFunction('GM_deleteValue');
              if (gmDel) gmDel(key);
              return true;
            }
            if (driver === 'localStorage') {
              const ls = this._getLocalStorage();
              ls.removeItem(key);
              return true;
            }
            return true;
          } catch (_) {
            return false;
          }
        }

        /**
         * Alias for `remove`.
         * @param {string} key
         * @returns {boolean}
         */
        delete(key) {
          return this.remove(key);
        }

        /**
         * Exports all SHC storage buckets as a JSON-serializable bundle.
         * Excludes raw API keys by default (`includeKeys: false`) for security.
         * @param {Object} [options]
         * @param {boolean} [options.includeKeys=false]
         * @returns {Object}
         */
        exportAll(options = {}) {
          const includeKeys = Boolean(options.includeKeys);
          const data = {
            [StorageManager.KEYS.MODEL_SETTINGS]: this.get(StorageManager.KEYS.MODEL_SETTINGS, null),
            [StorageManager.KEYS.APP_SETTINGS]: this.get(StorageManager.KEYS.APP_SETTINGS, null),
            [StorageManager.KEYS.CONVERSATIONS]: this.get(StorageManager.KEYS.CONVERSATIONS, null),
            [StorageManager.KEYS.USAGE]: this.get(StorageManager.KEYS.USAGE, null),
          };
          if (includeKeys) {
            data[StorageManager.KEYS.KEYS] = this.get(StorageManager.KEYS.KEYS, []);
          }
          return {
            schema: 'shc-export-v1',
            exportedAt: new Date().toISOString(),
            includesKeys: includeKeys,
            data,
          };
        }

        /**
         * Imports a previously exported bundle into storage buckets.
         * @param {Object|string} bundle
         * @param {Object} [options]
         * @param {boolean} [options.includeKeys=false]
         * @param {boolean} [options.overwrite=true]
         * @returns {{ importedKeys: string[] }}
         */
        importAll(bundle, options = {}) {
          const parsed = typeof bundle === 'string' ? JSON.parse(bundle) : bundle;
          if (!parsed || typeof parsed !== 'object') {
            throw new Error('Invalid SHC export bundle.');
          }
          const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
          const includeKeys = Boolean(options.includeKeys);
          const overwrite = options.overwrite !== false;
          const allowedKeys = [
            StorageManager.KEYS.MODEL_SETTINGS,
            StorageManager.KEYS.APP_SETTINGS,
            StorageManager.KEYS.CONVERSATIONS,
            StorageManager.KEYS.USAGE,
          ];
          if (includeKeys) {
            allowedKeys.push(StorageManager.KEYS.KEYS);
          }

          const importedKeys = [];
          for (const bucketKey of allowedKeys) {
            if (data[bucketKey] !== undefined && data[bucketKey] !== null) {
              if (!overwrite && this.get(bucketKey, null) !== null) {
                continue;
              }
              this.set(bucketKey, data[bucketKey]);
              importedKeys.push(bucketKey);
            }
          }
          return { importedKeys };
        }

        /**
         * Permanently removes all SHC storage buckets.
         * @returns {string[]} List of removed bucket keys.
         */
        wipeAll() {
          const keys = Object.values(StorageManager.KEYS);
          for (const k of keys) {
            this.remove(k);
          }
          return keys;
        }
      }

      StorageManager.KEYS = Object.freeze({
        KEYS: 'shc_keys',
        MODEL_SETTINGS: 'shc_model_settings',
        APP_SETTINGS: 'shc_app_settings',
        CONVERSATIONS: 'shc_conversations',
        USAGE: 'shc_usage',
      });

      // ===========================================================================
      // 3. SettingsManager
      // ===========================================================================

      const DEFAULT_SETTINGS = Object.freeze({
        general: {
          enabled: true,
          hotkey: {
            key: 'Insert',
            code: 'Insert',
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
          },
          theme: 'dark',
          language: 'vi',
          systemPromptMode: 'tutor',
          customSystemPrompt: '',
        },
        model: {
          provider: 'groq',
          endpoint: 'https://api.groq.com/openai/v1/chat/completions',
          modelsEndpoint: 'https://api.groq.com/openai/v1/models',
          visionModel: 'qwen/qwen3.8-27b',
          textModel: 'llama-3.3-70b-versatile',
          activeModel: 'qwen/qwen3.8-27b',
          temperature: 0.6,
          maxCompletionTokens: 4096,
          topP: 0.95,
          reasoningEffort: 'default',
          reasoningFormat: 'parsed',
          stream: true,
        },
        api: {
          autoFailover: true,
          retryLimit: 2,
          defaultCooldownSec: 60,
          requestTimeoutMs: 60000,
        },
        capture: {
          method: 'dom',
          imageQuality: 0.92,
          maxImageSizeMB: 4,
          maxImagesPerMessage: 3,
          previewBeforeSend: true,
        },
        conversation: {
          saveHistory: true,
          saveImagesInHistory: false,
          maxMessages: 30,
          autoSummarize: true,
        },
        privacy: {
          neverAutoSend: true,
          maskKeysInLogs: true,
        },
      });

      /**
       * Manages application and AI model settings across separated storage buckets.
       */
      class SettingsManager {
        /**
         * @param {StorageManager} [storage]
         */
        constructor(storage) {
          this._storage = storage || new StorageManager();
          this._listeners = new Set();
          this._settings = deepClone(DEFAULT_SETTINGS);
          this.load();
        }

        /**
         * Returns a deep copy of default settings.
         * @returns {Object}
         */
        static getDefaults() {
          return deepClone(DEFAULT_SETTINGS);
        }

        /**
         * Normalizes and clamps settings values to safe ranges.
         * @param {Object} raw
         * @returns {Object}
         */
        static validateAndNormalize(raw) {
          const merged = deepMerge(DEFAULT_SETTINGS, raw || {});

          // General
          merged.general.enabled = Boolean(merged.general.enabled);
          merged.general.theme = merged.general.theme === 'light' ? 'light' : 'dark';
          merged.general.language = merged.general.language === 'en' ? 'en' : 'vi';
          if (!['tutor', 'concise', 'detailed', 'custom'].includes(merged.general.systemPromptMode)) {
            merged.general.systemPromptMode = 'tutor';
          }
          merged.general.customSystemPrompt = String(merged.general.customSystemPrompt || '');

          const hk = merged.general.hotkey || {};
          merged.general.hotkey = {
            key: String(hk.key || 'Insert'),
            code: String(hk.code || hk.key || 'Insert'),
            ctrl: Boolean(hk.ctrl),
            alt: Boolean(hk.alt),
            shift: Boolean(hk.shift),
            meta: Boolean(hk.meta),
          };

          // Model
          merged.model.provider = String(merged.model.provider || 'groq');
          merged.model.endpoint = String(
            merged.model.endpoint || DEFAULT_SETTINGS.model.endpoint
          ).trim();
          merged.model.modelsEndpoint = String(
            merged.model.modelsEndpoint || DEFAULT_SETTINGS.model.modelsEndpoint
          ).trim();
          merged.model.visionModel = String(
            merged.model.visionModel || DEFAULT_SETTINGS.model.visionModel
          ).trim();
          merged.model.textModel = String(
            merged.model.textModel || DEFAULT_SETTINGS.model.textModel
          ).trim();
          merged.model.activeModel = String(
            merged.model.activeModel || merged.model.visionModel || DEFAULT_SETTINGS.model.visionModel
          ).trim();

          const temp = Number(merged.model.temperature);
          merged.model.temperature = Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : 0.6;

          const maxTok = Math.round(Number(merged.model.maxCompletionTokens));
          merged.model.maxCompletionTokens = Number.isFinite(maxTok) && maxTok >= 1 ? Math.min(131072, maxTok) : 4096;

          const topP = Number(merged.model.topP);
          merged.model.topP = Number.isFinite(topP) ? Math.min(1, Math.max(0, topP)) : 0.95;

          if (!['none', 'default', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(merged.model.reasoningEffort)) {
            merged.model.reasoningEffort = 'default';
          }
          if (!['parsed', 'raw', 'hidden'].includes(merged.model.reasoningFormat)) {
            merged.model.reasoningFormat = 'parsed';
          }
          merged.model.stream = Boolean(merged.model.stream);

          // API Management
          merged.api.autoFailover = Boolean(merged.api.autoFailover);
          const retryLimit = Math.round(Number(merged.api.retryLimit));
          merged.api.retryLimit = Number.isFinite(retryLimit) ? Math.min(5, Math.max(0, retryLimit)) : 2;
          const cooldownSec = Number(merged.api.defaultCooldownSec);
          merged.api.defaultCooldownSec = Number.isFinite(cooldownSec) && cooldownSec >= 1 ? Math.min(3600, cooldownSec) : 60;
          const timeoutMs = Number(merged.api.requestTimeoutMs);
          merged.api.requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? Math.min(300000, timeoutMs) : 60000;

          // Capture
          merged.capture.method = merged.capture.method === 'screen' ? 'screen' : 'dom';
          const iq = Number(merged.capture.imageQuality);
          merged.capture.imageQuality = Number.isFinite(iq) ? Math.min(1, Math.max(0.1, iq)) : 0.92;
          const maxSize = Number(merged.capture.maxImageSizeMB);
          merged.capture.maxImageSizeMB = Number.isFinite(maxSize) && maxSize > 0 ? Math.min(20, maxSize) : 4;
          const maxImgs = Math.round(Number(merged.capture.maxImagesPerMessage));
          merged.capture.maxImagesPerMessage = Number.isFinite(maxImgs) && maxImgs >= 1 ? Math.min(5, maxImgs) : 3;
          merged.capture.previewBeforeSend = Boolean(merged.capture.previewBeforeSend);

          // Conversation
          merged.conversation.saveHistory = Boolean(merged.conversation.saveHistory);
          merged.conversation.saveImagesInHistory = Boolean(merged.conversation.saveImagesInHistory);
          const maxMsgs = Math.round(Number(merged.conversation.maxMessages));
          merged.conversation.maxMessages = Number.isFinite(maxMsgs) && maxMsgs >= 2 ? Math.min(200, maxMsgs) : 30;
          merged.conversation.autoSummarize = Boolean(merged.conversation.autoSummarize);

          // Privacy
          merged.privacy.neverAutoSend = Boolean(merged.privacy.neverAutoSend);
          merged.privacy.maskKeysInLogs = Boolean(merged.privacy.maskKeysInLogs);

          return merged;
        }

        /**
         * Loads persisted settings from `shc_app_settings` and `shc_model_settings`.
         * @returns {Object}
         */
        load() {
          const appSaved = this._storage.get(StorageManager.KEYS.APP_SETTINGS, {});
          const modelSaved = this._storage.get(StorageManager.KEYS.MODEL_SETTINGS, {});
          const combined = {
            ...(appSaved && typeof appSaved === 'object' ? appSaved : {}),
            model: modelSaved && typeof modelSaved === 'object' ? modelSaved : appSaved?.model || {},
          };
          this._settings = SettingsManager.validateAndNormalize(combined);
          return this.getAll();
        }

        /**
         * Persists current settings across `shc_model_settings` and `shc_app_settings`.
         * @returns {Object}
         */
        save() {
          const { model, ...appSections } = this._settings;
          this._storage.set(StorageManager.KEYS.MODEL_SETTINGS, model);
          this._storage.set(StorageManager.KEYS.APP_SETTINGS, appSections);
          return this.getAll();
        }

        /**
         * Returns a deep-cloned snapshot of all settings.
         * @returns {Object}
         */
        getAll() {
          return deepClone(this._settings);
        }

        /**
         * Reads a settings section or dot-path (e.g., `'model.visionModel'`).
         * @param {string} path
         * @param {*} [fallback]
         * @returns {*}
         */
        get(path, fallback = undefined) {
          if (!path) return this.getAll();
          const parts = String(path).split('.');
          let cur = this._settings;
          for (const p of parts) {
            if (cur && typeof cur === 'object' && p in cur) {
              cur = cur[p];
            } else {
              return fallback;
            }
          }
          return deepClone(cur);
        }

        /**
         * Returns a single top-level section (`general`, `model`, `api`, `capture`, `conversation`, `privacy`).
         * @param {string} sectionName
         * @returns {Object}
         */
        getSection(sectionName) {
          return deepClone(this._settings[sectionName] || {});
        }

        /**
         * Updates a dot-path setting, validates, persists, and notifies subscribers.
         * @param {string} path
         * @param {*} value
         * @returns {Object}
         */
        set(path, value) {
          const parts = String(path).split('.');
          if (!parts.length || !parts[0]) return this.getAll();

          const next = deepClone(this._settings);
          let cursor = next;
          for (let i = 0; i < parts.length - 1; i++) {
            const segment = parts[i];
            if (!cursor[segment] || typeof cursor[segment] !== 'object') {
              cursor[segment] = {};
            }
            cursor = cursor[segment];
          }
          cursor[parts[parts.length - 1]] = deepClone(value);

          if (path === 'model.visionModel' && next.model.activeModel === this._settings.model.visionModel) {
            next.model.activeModel = next.model.visionModel;
          }

          this._settings = SettingsManager.validateAndNormalize(next);
          this.save();
          this._emitChange();
          return this.getAll();
        }

        /**
         * Deep-merges partial updates into settings, validates, persists, and notifies subscribers.
         * @param {Object} partial
         * @returns {Object}
         */
        update(partial) {
          if (!partial || typeof partial !== 'object') return this.getAll();
          const prevVision = this._settings.model.visionModel;
          const merged = deepMerge(this._settings, partial);
          if (
            partial.model &&
            partial.model.visionModel &&
            !partial.model.activeModel &&
            this._settings.model.activeModel === prevVision
          ) {
            merged.model.activeModel = partial.model.visionModel;
          }
          this._settings = SettingsManager.validateAndNormalize(merged);
          this.save();
          this._emitChange();
          return this.getAll();
        }

        /**
         * Resets all settings or a specific section to defaults.
         * @param {string} [section]
         * @returns {Object}
         */
        reset(section) {
          if (section && section in DEFAULT_SETTINGS) {
            const next = deepClone(this._settings);
            next[section] = deepClone(DEFAULT_SETTINGS[section]);
            this._settings = SettingsManager.validateAndNormalize(next);
          } else {
            this._settings = deepClone(DEFAULT_SETTINGS);
          }
          this.save();
          this._emitChange();
          return this.getAll();
        }

        /**
         * Convenience helper for the active chat completion model ID.
         * @returns {string}
         */
        getActiveModel() {
          return this._settings.model.activeModel || this._settings.model.visionModel;
        }

        /**
         * Sets the active model ID and persists it.
         * @param {string} modelId
         * @returns {Object}
         */
        setActiveModel(modelId) {
          const clean = String(modelId || '').trim();
          if (!clean) return this.getAll();
          return this.set('model.activeModel', clean);
        }

        /**
         * Subscribes to settings changes.
         * @param {Function} callback
         * @returns {Function} Unsubscribe callback.
         */
        onChange(callback) {
          if (typeof callback !== 'function') return () => {};
          this._listeners.add(callback);
          return () => {
            this._listeners.delete(callback);
          };
        }

        /** @private */
        _emitChange() {
          const snapshot = this.getAll();
          for (const cb of this._listeners) {
            try {
              cb(snapshot);
            } catch (_) {
              // Isolate listener errors
            }
          }
        }
      }

      // ===========================================================================
      // 4. APIKeyManager
      // ===========================================================================

      const KEY_STATUSES = Object.freeze([
        'active',
        'invalid',
        'cooldown',
        'rate_limited',
        'permission_error',
        'network_error',
        'disabled',
      ]);

      /**
       * Manages the multi-key Groq API key pool with masking, primary selection,
       * round-robin ordering, cooldown recovery, and real `GET /models` verification.
       */
      class APIKeyManager {
        /**
         * @param {StorageManager} [storage]
         * @param {ErrorHandler} [errorHandler]
         */
        constructor(storage, errorHandler) {
          this._storage = storage || new StorageManager();
          this._errorHandler = errorHandler || new ErrorHandler();
          this._keys = [];
          this._rrIndex = 0;
          this._listeners = new Set();
          this.load();
        }

        /**
         * Masks an API key showing only first 6 and last 4 characters (or `****` for very short keys).
         * @param {string} key
         * @returns {string}
         */
        static maskKey(key) {
          const clean = String(key || '').trim();
          if (!clean) return '';
          if (clean.length < 12) {
            return clean.length <= 4 ? '****' : `${clean.slice(0, 2)}****`;
          }
          return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
        }

        /**
         * Alias for `APIKeyManager.maskKey`.
         * @param {string} key
         * @returns {string}
         */
        maskKey(key) {
          return APIKeyManager.maskKey(key);
        }

        /**
         * Returns a public/UI-safe copy of a key record WITHOUT the raw secret `key`.
         * @param {Object} record
         * @returns {Object}
         */
        static toPublicRecord(record) {
          if (!record) return null;
          return {
            id: record.id,
            name: record.name,
            maskedKey: record.maskedKey || APIKeyManager.maskKey(record.key),
            status: record.status,
            enabled: Boolean(record.enabled),
            isPrimary: Boolean(record.isPrimary),
            lastUsedAt: record.lastUsedAt || null,
            lastError: record.lastError ? ErrorHandler.sanitizeString(String(record.lastError)) : null,
            successCount: Number(record.successCount || 0),
            errorCount: Number(record.errorCount || 0),
            cooldownUntil: record.cooldownUntil || null,
            rateLimitInfo: record.rateLimitInfo ? deepClone(record.rateLimitInfo) : null,
            createdAt: record.createdAt || null,
            updatedAt: record.updatedAt || null,
          };
        }

        /**
         * Loads persisted key records from `shc_keys`.
         * @returns {Array<Object>} Sanitized key summaries.
         */
        load() {
          const saved = this._storage.get(StorageManager.KEYS.KEYS, []);
          if (Array.isArray(saved)) {
            this._keys = saved
              .filter((item) => item && typeof item === 'object' && typeof item.key === 'string' && item.key.trim())
              .map((item) => this._normalizeRecord(item));
          } else {
            this._keys = [];
          }
          this._ensureSinglePrimary();
          return this.getKeys();
        }

        /** @private */
        _normalizeRecord(item) {
          const rawKey = String(item.key || '').trim();
          const enabled = item.enabled !== false;
          const status = KEY_STATUSES.includes(item.status)
            ? enabled
              ? item.status
              : 'disabled'
            : enabled
              ? 'active'
              : 'disabled';
          return {
            id: item.id || generateId('key'),
            name: String(item.name || 'Groq Key').trim() || 'Groq Key',
            key: rawKey,
            maskedKey: APIKeyManager.maskKey(rawKey),
            status,
            enabled,
            isPrimary: Boolean(item.isPrimary),
            lastUsedAt: item.lastUsedAt || null,
            lastError: item.lastError ? ErrorHandler.sanitizeString(String(item.lastError)) : null,
            successCount: Number(item.successCount || 0),
            errorCount: Number(item.errorCount || 0),
            cooldownUntil: item.cooldownUntil || null,
            rateLimitInfo: item.rateLimitInfo ? deepClone(item.rateLimitInfo) : null,
            createdAt: item.createdAt || Date.now(),
            updatedAt: item.updatedAt || Date.now(),
          };
        }

        /** @private */
        _save() {
          this._storage.set(StorageManager.KEYS.KEYS, this._keys);
          this._emitChange();
        }

        /** @private */
        _ensureSinglePrimary() {
          if (this._keys.length === 0) return;
          const primaries = this._keys.filter((k) => k.isPrimary);
          if (primaries.length === 1) return;
          if (primaries.length > 1) {
            let kept = false;
            for (const k of this._keys) {
              if (k.isPrimary && !kept) {
                kept = true;
              } else {
                k.isPrimary = false;
              }
            }
            return;
          }
          // None marked primary -> promote first enabled key or first key
          const candidate = this._keys.find((k) => k.enabled) || this._keys[0];
          candidate.isPrimary = true;
        }

        /**
         * Adds a new API key to the pool.
         * Supports `addKey({ name, key, isPrimary, enabled })` or `addKey(name, key)`.
         * @param {Object|string} nameOrOptions
         * @param {string} [maybeKey]
         * @returns {Object} Sanitized key summary (no raw secret).
         */
        addKey(nameOrOptions, maybeKey) {
          let opts;
          if (typeof nameOrOptions === 'string') {
            if (maybeKey !== undefined) {
              opts = { name: nameOrOptions, key: maybeKey };
            } else {
              opts = { name: `Key ${this._keys.length + 1}`, key: nameOrOptions };
            }
          } else {
            opts = nameOrOptions || {};
          }

          const rawKey = String(opts.key || '').trim();
          if (!rawKey) {
            throw new Error('API key cannot be empty.');
          }
          if (this._keys.some((k) => k.key === rawKey)) {
            throw new Error('This API key already exists in the key pool.');
          }

          const shouldBePrimary = Boolean(opts.isPrimary) || this._keys.length === 0;
          if (shouldBePrimary) {
            for (const existing of this._keys) existing.isPrimary = false;
          }

          const enabled = opts.enabled !== false;
          const record = this._normalizeRecord({
            id: opts.id || generateId('key'),
            name: String(opts.name || `Key ${this._keys.length + 1}`).trim(),
            key: rawKey,
            enabled,
            status: enabled ? 'active' : 'disabled',
            isPrimary: shouldBePrimary,
          });

          this._keys.push(record);
          this._save();
          return APIKeyManager.toPublicRecord(record);
        }

        /**
         * Updates an existing key's name, raw secret, enabled state, or primary flag.
         * @param {string} id
         * @param {Object} patch
         * @returns {Object} Sanitized key summary.
         */
        updateKey(id, patch = {}) {
          const record = this._findMutable(id);
          if (!record) throw new Error(`API key not found: ${id}`);

          if (typeof patch.name === 'string' && patch.name.trim()) {
            record.name = patch.name.trim();
          }
          if (typeof patch.key === 'string' && patch.key.trim()) {
            const nextRaw = patch.key.trim();
            if (this._keys.some((k) => k.id !== id && k.key === nextRaw)) {
              throw new Error('Another entry already uses this API key.');
            }
            if (nextRaw !== record.key) {
              record.key = nextRaw;
              record.maskedKey = APIKeyManager.maskKey(nextRaw);
              record.status = record.enabled ? 'active' : 'disabled';
              record.lastError = null;
              record.cooldownUntil = null;
            }
          }
          if (typeof patch.enabled === 'boolean') {
            record.enabled = patch.enabled;
            record.status = patch.enabled
              ? record.status === 'disabled'
                ? 'active'
                : record.status
              : 'disabled';
            if (patch.enabled && record.status === 'active') {
              record.cooldownUntil = null;
            }
          }
          if (patch.isPrimary === true) {
            for (const k of this._keys) k.isPrimary = k.id === id;
          }

          record.updatedAt = Date.now();
          this._ensureSinglePrimary();
          this._save();
          return APIKeyManager.toPublicRecord(record);
        }

        /**
         * Removes an API key by ID.
         * @param {string} id
         * @returns {boolean}
         */
        removeKey(id) {
          const idx = this._keys.findIndex((k) => k.id === id);
          if (idx === -1) return false;
          this._keys.splice(idx, 1);
          this._ensureSinglePrimary();
          if (this._rrIndex >= this._keys.length) {
            this._rrIndex = 0;
          }
          this._save();
          return true;
        }

        /**
         * Alias for `removeKey`.
         * @param {string} id
         * @returns {boolean}
         */
        deleteKey(id) {
          return this.removeKey(id);
        }

        /**
         * Returns all key records WITHOUT raw secrets.
         * @returns {Array<Object>}
         */
        getKeys() {
          this.refreshCooldowns(Date.now(), { persist: false });
          return this._keys.map(APIKeyManager.toPublicRecord);
        }

        /**
         * Alias for `getKeys`.
         * @returns {Array<Object>}
         */
        listKeys() {
          return this.getKeys();
        }

        /**
         * Returns a single sanitized key summary by ID.
         * @param {string} id
         * @returns {Object|null}
         */
        getKey(id) {
          const rec = this._findMutable(id);
          return rec ? APIKeyManager.toPublicRecord(rec) : null;
        }

        /**
         * Returns total number of configured keys (regardless of status).
         * @returns {number}
         */
        getTotalCount() {
          return this._keys.length;
        }

        /**
         * Resolves the raw secret key string ONLY for internal API transport signing.
         * Never expose this value to UI tables, logs, errors, or conversation storage.
         * @param {string} id
         * @returns {string|null}
         */
        getRawKey(id) {
          const rec = this._findMutable(id);
          return rec ? rec.key : null;
        }

        /**
         * Returns the current primary key (sanitized).
         * @returns {Object|null}
         */
        getPrimaryKey() {
          const rec = this._keys.find((k) => k.isPrimary) || this._keys[0] || null;
          return rec ? APIKeyManager.toPublicRecord(rec) : null;
        }

        /**
         * Promotes a key to primary.
         * @param {string} id
         * @returns {Object} Sanitized key summary.
         */
        setPrimary(id) {
          const target = this._findMutable(id);
          if (!target) throw new Error(`API key not found: ${id}`);
          for (const k of this._keys) {
            k.isPrimary = k.id === id;
          }
          target.updatedAt = Date.now();
          this._save();
          return APIKeyManager.toPublicRecord(target);
        }

        /**
         * Enables or disables a key.
         * @param {string} id
         * @param {boolean} enabled
         * @returns {Object} Sanitized key summary.
         */
        setEnabled(id, enabled) {
          const target = this._findMutable(id);
          if (!target) throw new Error(`API key not found: ${id}`);
          target.enabled = Boolean(enabled);
          target.status = target.enabled ? 'active' : 'disabled';
          if (target.enabled) {
            target.cooldownUntil = null;
          }
          target.updatedAt = Date.now();
          this._save();
          return APIKeyManager.toPublicRecord(target);
        }

        /**
         * Resets a key's error/cooldown state back to `active` (or `disabled` if disabled unless `forceEnable`).
         * @param {string} id
         * @param {Object} [options]
         * @param {boolean} [options.forceEnable=false]
         * @returns {Object} Sanitized key summary.
         */
        resetStatus(id, options = {}) {
          const target = this._findMutable(id);
          if (!target) throw new Error(`API key not found: ${id}`);
          if (options.forceEnable) {
            target.enabled = true;
          }
          target.status = target.enabled ? 'active' : 'disabled';
          target.lastError = null;
          target.cooldownUntil = null;
          target.updatedAt = Date.now();
          this._save();
          return APIKeyManager.toPublicRecord(target);
        }

        /**
         * Transitions keys whose `cooldownUntil` timestamp has elapsed back to `active`.
         * @param {number} [now=Date.now()]
         * @param {Object} [options]
         * @param {boolean} [options.persist=true]
         * @returns {number} Count of recovered keys.
         */
        refreshCooldowns(now = Date.now(), options = {}) {
          let recovered = 0;
          for (const k of this._keys) {
            if (
              k.enabled &&
              (k.status === 'cooldown' || k.status === 'rate_limited') &&
              k.cooldownUntil &&
              k.cooldownUntil <= now
            ) {
              k.status = 'active';
              k.cooldownUntil = null;
              k.updatedAt = now;
              recovered++;
            }
          }
          if (recovered > 0 && options.persist !== false) {
            this._save();
          }
          return recovered;
        }

        /**
         * Returns candidate keys ordered with primary active key first, followed by
         * remaining active keys in round-robin order. Respects `cooldownUntil`.
         * Never exposes raw secrets.
         * @param {Object} [options]
         * @param {boolean} [options.includeNetworkError=false] Include `network_error` keys after active keys (for manual retry).
         * @param {number} [options.now=Date.now()]
         * @returns {Array<Object>}
         */
        getCandidateOrder(options = {}) {
          const now = typeof options.now === 'number' ? options.now : Date.now();
          this.refreshCooldowns(now, { persist: true });

          const activePool = this._keys.filter(
            (k) =>
              k.enabled &&
              k.status === 'active' &&
              (!k.cooldownUntil || k.cooldownUntil <= now)
          );

          const primary = activePool.find((k) => k.isPrimary) || null;
          const backups = activePool.filter((k) => !k.isPrimary);

          let orderedBackups = backups;
          if (backups.length > 1) {
            const offset = ((this._rrIndex % backups.length) + backups.length) % backups.length;
            orderedBackups = backups.slice(offset).concat(backups.slice(0, offset));
          }

          const ordered = primary ? [primary, ...orderedBackups] : orderedBackups;

          if (options.includeNetworkError) {
            const netKeys = this._keys.filter(
              (k) =>
                k.enabled &&
                k.status === 'network_error' &&
                (!k.cooldownUntil || k.cooldownUntil <= now)
            );
            ordered.push(...netKeys);
          }

          return ordered.map(APIKeyManager.toPublicRecord);
        }

        /**
         * Advances the round-robin cursor after attempting a non-primary key.
         * @param {string} [attemptedId]
         */
        recordAttempt(attemptedId) {
          const rec = attemptedId ? this._findMutable(attemptedId) : null;
          if (!rec || !rec.isPrimary) {
            this._rrIndex = (this._rrIndex + 1) % Math.max(1, this._keys.length);
          }
        }

        /**
         * Marks a key attempt as successful.
         * @param {string} id
         * @param {Object} [rateLimitInfo]
         * @returns {Object|null}
         */
        markSuccess(id, rateLimitInfo = null) {
          const target = this._findMutable(id);
          if (!target) return null;
          const now = Date.now();
          target.lastUsedAt = now;
          target.updatedAt = now;
          target.successCount = Number(target.successCount || 0) + 1;
          target.status = target.enabled ? 'active' : 'disabled';
          target.lastError = null;
          target.cooldownUntil = null;
          if (rateLimitInfo && typeof rateLimitInfo === 'object') {
            target.rateLimitInfo = deepClone(rateLimitInfo);
          }
          this._save();
          return APIKeyManager.toPublicRecord(target);
        }

        /**
         * Marks a key with an error status, sanitized message, and optional cooldown.
         * @param {string} id
         * @param {string} status
         * @param {string} errorMessage
         * @param {Object} [meta]
         * @returns {Object|null}
         */
        markError(id, status, errorMessage, meta = {}) {
          const target = this._findMutable(id);
          if (!target) return null;
          const now = Date.now();
          target.lastUsedAt = now;
          target.updatedAt = now;
          target.errorCount = Number(target.errorCount || 0) + 1;
          if (KEY_STATUSES.includes(status)) {
            target.status = target.enabled ? status : 'disabled';
          }
          target.lastError = ErrorHandler.sanitizeString(String(errorMessage || 'Error'));
          if (meta.cooldownUntil !== undefined) {
            target.cooldownUntil = meta.cooldownUntil;
          }
          if (meta.rateLimitInfo && typeof meta.rateLimitInfo === 'object') {
            target.rateLimitInfo = deepClone(meta.rateLimitInfo);
          }
          this._save();
          return APIKeyManager.toPublicRecord(target);
        }

        /**
         * Returns the earliest future `cooldownUntil` timestamp (ms) among cooldown/rate-limited enabled keys.
         * @param {number} [now=Date.now()]
         * @returns {number|null}
         */
        getEarliestCooldownUntil(now = Date.now()) {
          let earliest = null;
          for (const k of this._keys) {
            if (
              k.enabled &&
              (k.status === 'cooldown' || k.status === 'rate_limited') &&
              k.cooldownUntil &&
              k.cooldownUntil > now
            ) {
              if (earliest === null || k.cooldownUntil < earliest) {
                earliest = k.cooldownUntil;
              }
            }
          }
          return earliest;
        }

        /**
         * Tests an API key by performing a real `GET /models` request via `apiClient`.
         * @param {string} id
         * @param {GroqAPIClient} apiClient
         * @param {Object} [options]
         * @returns {Promise<{ok: boolean, key: Object, models?: Array, error?: Object}>}
         */
        async testKey(id, apiClient, options = {}) {
          const target = this._findMutable(id);
          if (!target) {
            throw new Error(`API key not found: ${id}`);
          }
          if (!apiClient || typeof apiClient.listModels !== 'function') {
            throw new Error('Valid GroqAPIClient instance is required to test API key.');
          }

          try {
            const res = await apiClient.listModels(target.key, options);
            const now = Date.now();
            target.enabled = true;
            target.status = 'active';
            target.lastUsedAt = now;
            target.updatedAt = now;
            target.lastError = null;
            target.cooldownUntil = null;
            if (res.rateLimitInfo) {
              target.rateLimitInfo = deepClone(res.rateLimitInfo);
            }
            this._save();
            return {
              ok: true,
              key: APIKeyManager.toPublicRecord(target),
              models: res.models || [],
              rateLimitInfo: res.rateLimitInfo || null,
            };
          } catch (err) {
            const classified = this._errorHandler.classify(err);
            let nextStatus = target.status;
            let cooldownUntil = null;

            if (classified.status === 401) {
              nextStatus = 'invalid';
            } else if (classified.status === 403) {
              nextStatus = 'permission_error';
            } else if (classified.status === 429) {
              nextStatus = 'rate_limited';
              const waitSec = classified.retryAfterSec || 60;
              cooldownUntil = Date.now() + waitSec * 1000;
            } else if (classified.category === 'network') {
              nextStatus = 'network_error';
            }

            this.markError(id, nextStatus, classified.userMessage, {
              cooldownUntil,
              rateLimitInfo: err.rateLimitInfo,
            });

            return {
              ok: false,
              key: this.getKey(id),
              error: classified,
            };
          }
        }

        /**
         * Subscribes to key pool changes (always receives sanitized summaries).
         * @param {Function} callback
         * @returns {Function}
         */
        onChange(callback) {
          if (typeof callback !== 'function') return () => {};
          this._listeners.add(callback);
          return () => {
            this._listeners.delete(callback);
          };
        }

        /** @private */
        _findMutable(id) {
          return this._keys.find((k) => k.id === id) || null;
        }

        /** @private */
        _emitChange() {
          const snapshot = this.getKeys();
          for (const cb of this._listeners) {
            try {
              cb(snapshot);
            } catch (_) {
              // Ignore listener failures
            }
          }
        }
      }

      // ===========================================================================
      // 5. GroqAPIClient
      // ===========================================================================

      const GROQ_CHAT_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
      const GROQ_MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models';

      const MODEL_REGISTRY = Object.freeze({
        'qwen/qwen3.8-27b': Object.freeze({
          id: 'qwen/qwen3.8-27b',
          displayName: 'Qwen 3.8 27B (Vision + Reasoning)',
          vision: true,
          maxImagesPerRequest: 3,
          maxImageSizeMB: 20,
          tokensPerImage: 2048,
          contextWindow: 131072,
          maxCompletionTokens: 16384,
          reasoning: true,
          reasoningEffortOptions: ['none', 'default', 'low', 'medium', 'high'],
          reasoningFormatOptions: ['parsed', 'raw', 'hidden'],
          supportsIncludeReasoning: true,
          preview: true,
        }),
        'meta-models/muse-spark-open': Object.freeze({
          id: 'meta-models/muse-spark-open',
          displayName: 'Muse Spark Open (Vision + Reasoning Preview)',
          vision: true,
          maxImagesPerRequest: 5,
          maxImageSizeMB: 20,
          tokensPerImage: 1026,
          contextWindow: 131072,
          maxCompletionTokens: 131072,
          reasoning: true,
          reasoningEffortOptions: ['low', 'medium', 'high', 'xhigh'],
          reasoningFormatOptions: ['parsed', 'raw', 'hidden'],
          supportsIncludeReasoning: true,
          preview: true,
        }),
        'llama-3.3-70b-versatile': Object.freeze({
          id: 'llama-3.3-70b-versatile',
          displayName: 'Llama 3.3 70B Versatile (Text)',
          vision: false,
          maxImagesPerRequest: 0,
          maxImageSizeMB: 0,
          tokensPerImage: 0,
          contextWindow: 131072,
          maxCompletionTokens: 32768,
          reasoning: false,
          reasoningEffortOptions: [],
          reasoningFormatOptions: [],
          supportsIncludeReasoning: false,
          preview: false,
        }),
        'llama-3.1-8b-instant': Object.freeze({
          id: 'llama-3.1-8b-instant',
          displayName: 'Llama 3.1 8B Instant (Text)',
          vision: false,
          maxImagesPerRequest: 0,
          maxImageSizeMB: 0,
          tokensPerImage: 0,
          contextWindow: 131072,
          maxCompletionTokens: 131072,
          reasoning: false,
          reasoningEffortOptions: [],
          reasoningFormatOptions: [],
          supportsIncludeReasoning: false,
          preview: false,
        }),
        'openai/gpt-oss-120b': Object.freeze({
          id: 'openai/gpt-oss-120b',
          displayName: 'OpenAI GPT-OSS 120B (Reasoning)',
          vision: false,
          maxImagesPerRequest: 0,
          maxImageSizeMB: 0,
          tokensPerImage: 0,
          contextWindow: 131072,
          maxCompletionTokens: 65536,
          reasoning: true,
          reasoningEffortOptions: ['low', 'medium', 'high'],
          reasoningFormatOptions: [],
          supportsIncludeReasoning: true,
          preview: false,
        }),
        'openai/gpt-oss-20b': Object.freeze({
          id: 'openai/gpt-oss-20b',
          displayName: 'OpenAI GPT-OSS 20B (Reasoning)',
          vision: false,
          maxImagesPerRequest: 0,
          maxImageSizeMB: 0,
          tokensPerImage: 0,
          contextWindow: 131072,
          maxCompletionTokens: 65536,
          reasoning: true,
          reasoningEffortOptions: ['low', 'medium', 'high'],
          reasoningFormatOptions: [],
          supportsIncludeReasoning: true,
          preview: false,
        }),
        'openai/gpt-oss-safeguard-20b': Object.freeze({
          id: 'openai/gpt-oss-safeguard-20b',
          displayName: 'Safety GPT-OSS 20B',
          vision: false,
          maxImagesPerRequest: 0,
          maxImageSizeMB: 0,
          tokensPerImage: 0,
          contextWindow: 131072,
          maxCompletionTokens: 65536,
          reasoning: true,
          reasoningEffortOptions: ['low', 'medium', 'high'],
          reasoningFormatOptions: [],
          supportsIncludeReasoning: true,
          preview: true,
        }),
        'minimaxai/minimax-m2.7': Object.freeze({
          id: 'minimaxai/minimax-m2.7',
          displayName: 'MiniMax M2.7 (Reasoning)',
          vision: false,
          maxImagesPerRequest: 0,
          maxImageSizeMB: 0,
          tokensPerImage: 0,
          contextWindow: 196608,
          maxCompletionTokens: 131072,
          reasoning: true,
          reasoningEffortOptions: [],
          reasoningFormatOptions: ['parsed', 'raw', 'hidden'],
          supportsIncludeReasoning: true,
          preview: true,
        }),
      });

      const UNSUPPORTED_GROQ_FIELDS = new Set([
        'presence_penalty',
        'frequency_penalty',
        'logprobs',
        'top_logprobs',
        'logit_bias',
        'metadata',
        'store',
      ]);

      /**
       * Direct Groq REST API client using `GM_xmlhttpRequest` (with `fetch` fallback in test environments),
       * incremental SSE streaming, rate-limit header extraction, and model constraint enforcement.
       */
      class GroqAPIClient {
        /**
         * @param {Object} [options]
         * @param {string} [options.endpoint]
         * @param {string} [options.modelsEndpoint]
         * @param {number} [options.timeoutMs=60000]
         * @param {Function} [options.gmRequest] Optional custom GM_xmlhttpRequest implementation.
         * @param {Function} [options.fetchImpl] Optional custom fetch implementation.
         * @param {ErrorHandler} [options.errorHandler]
         */
        constructor(options = {}) {
          this._endpoint = options.endpoint || GROQ_CHAT_ENDPOINT;
          this._modelsEndpoint = options.modelsEndpoint || GROQ_MODELS_ENDPOINT;
          this._timeoutMs = Number(options.timeoutMs) || 60000;
          this._gmRequest = options.gmRequest || null;
          this._fetchImpl = options.fetchImpl || null;
          this._errorHandler = options.errorHandler || new ErrorHandler();
          this._activeRequests = new Map();
        }

        /**
         * Checks whether a model ID supports multimodal image inputs.
         * @param {string} modelId
         * @returns {boolean}
         */
        static isVisionModel(modelId) {
          const id = String(modelId || '').trim().toLowerCase();
          if (!id) return false;
          if (id in MODEL_REGISTRY) {
            return Boolean(MODEL_REGISTRY[id].vision);
          }
          return /\b(vision|vl|pixtral|llava|muse-spark|qwen3\.8)\b/i.test(id);
        }

        /**
         * Checks whether a model ID supports reasoning parameters (`reasoning_effort` / `reasoning_format` / `include_reasoning`).
         * @param {string} modelId
         * @returns {boolean}
         */
        static isReasoningModel(modelId) {
          const id = String(modelId || '').trim().toLowerCase();
          if (!id) return false;
          if (id in MODEL_REGISTRY) {
            return Boolean(MODEL_REGISTRY[id].reasoning);
          }
          return /\b(qwen3\.8|muse-spark|gpt-oss|minimax-m2)\b/i.test(id);
        }

        /**
         * Returns capability constraints for a given model ID.
         * @param {string} modelId
         * @returns {Object}
         */
        static getModelConstraints(modelId) {
          const rawId = String(modelId || '').trim();
          const id = rawId.toLowerCase();
          if (id in MODEL_REGISTRY) {
            return deepClone(MODEL_REGISTRY[id]);
          }
          const vision = GroqAPIClient.isVisionModel(id);
          const reasoning = GroqAPIClient.isReasoningModel(id);
          return {
            id: rawId,
            displayName: rawId || 'Custom Model',
            vision,
            maxImagesPerRequest: vision ? 3 : 0,
            maxImageSizeMB: vision ? 20 : 0,
            tokensPerImage: vision ? 2048 : 0,
            contextWindow: 131072,
            maxCompletionTokens: 16384,
            reasoning,
            reasoningEffortOptions: reasoning ? ['low', 'medium', 'high'] : [],
            reasoningFormatOptions: reasoning ? ['parsed', 'raw', 'hidden'] : [],
            supportsIncludeReasoning: reasoning,
            custom: true,
          };
        }

        /**
         * Returns the built-in model registry list.
         * @returns {Array<Object>}
         */
        static getSupportedModels() {
          return Object.values(MODEL_REGISTRY).map((m) => deepClone(m));
        }

        isVisionModel(modelId) {
          return GroqAPIClient.isVisionModel(modelId);
        }

        isReasoningModel(modelId) {
          return GroqAPIClient.isReasoningModel(modelId);
        }

        getModelConstraints(modelId) {
          return GroqAPIClient.getModelConstraints(modelId);
        }

        /**
         * Counts `image_url` parts across a Groq `messages` array.
         * @param {Array} messages
         * @returns {number}
         */
        static countImagesInMessages(messages) {
          if (!Array.isArray(messages)) return 0;
          let count = 0;
          for (const msg of messages) {
            if (msg && Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part && part.type === 'image_url' && part.image_url && part.image_url.url) {
                  count++;
                }
              }
            }
          }
          return count;
        }

        /**
         * Parses Groq rate-limit and retry-after HTTP response headers.
         * @param {string|Headers|Object} rawHeaders
         * @returns {Object}
         */
        static parseRateLimitHeaders(rawHeaders) {
          const headers = normalizeHeaders(rawHeaders);
          const toInt = (val) => {
            if (val === undefined || val === null || val === '') return null;
            const n = Number(val);
            return Number.isFinite(n) ? n : null;
          };

          const retryAfterSec = parseDurationToSeconds(headers['retry-after']);
          const resetRequestsRaw = headers['x-ratelimit-reset-requests'] || null;
          const resetTokensRaw = headers['x-ratelimit-reset-tokens'] || null;

          return {
            retryAfterSec,
            limitRequests: toInt(headers['x-ratelimit-limit-requests']),
            limitTokens: toInt(headers['x-ratelimit-limit-tokens']),
            remainingRequests: toInt(headers['x-ratelimit-remaining-requests']),
            remainingTokens: toInt(headers['x-ratelimit-remaining-tokens']),
            resetRequestsRaw,
            resetTokensRaw,
            resetRequestsSec: parseDurationToSeconds(resetRequestsRaw),
            resetTokensSec: parseDurationToSeconds(resetTokensRaw),
          };
        }

        /**
         * Sanitizes a Groq chat completion request payload according to official Groq rules:
         * - Strips unsupported fields (`presence_penalty`, `frequency_penalty`, `logprobs`, `logit_bias`, etc.)
         * - Strips `reasoning_format` / `reasoning_effort` / `include_reasoning` for non-reasoning models
         * - Ensures only valid `reasoning_effort` and `reasoning_format` values for the target model
         * - Prevents sending mutually exclusive `include_reasoning` and `reasoning_format` together
         * @param {Object} payload
         * @returns {Object}
         */
        static sanitizePayload(payload) {
          const src = payload && typeof payload === 'object' ? payload : {};
          const model = String(src.model || '').trim();
          const caps = GroqAPIClient.getModelConstraints(model);

          const clean = {
            model,
            messages: Array.isArray(src.messages) ? deepClone(src.messages) : [],
          };

          const passthroughKeys = [
            'temperature',
            'top_p',
            'stream',
            'stop',
            'seed',
            'response_format',
            'tools',
            'tool_choice',
            'parallel_tool_calls',
            'service_tier',
            'user',
            'stream_options',
          ];
          for (const k of passthroughKeys) {
            if (src[k] !== undefined && !UNSUPPORTED_GROQ_FIELDS.has(k)) {
              clean[k] = deepClone(src[k]);
            }
          }

          // Normalize deprecated max_tokens -> max_completion_tokens
          const rawMaxCompletion =
            src.max_completion_tokens !== undefined ? src.max_completion_tokens : src.max_tokens;
          if (rawMaxCompletion !== undefined && rawMaxCompletion !== null) {
            const parsedMax = Math.round(Number(rawMaxCompletion));
            if (Number.isFinite(parsedMax) && parsedMax >= 1) {
              clean.max_completion_tokens = caps.maxCompletionTokens
                ? Math.min(parsedMax, caps.maxCompletionTokens)
                : parsedMax;
            }
          }

          // Reasoning parameters ONLY for reasoning-capable models
          if (caps.reasoning) {
            if (
              src.reasoning_effort !== undefined &&
              src.reasoning_effort !== null &&
              Array.isArray(caps.reasoningEffortOptions) &&
              caps.reasoningEffortOptions.includes(src.reasoning_effort)
            ) {
              clean.reasoning_effort = src.reasoning_effort;
            }

            const hasValidFormat =
              src.reasoning_format !== undefined &&
              src.reasoning_format !== null &&
              Array.isArray(caps.reasoningFormatOptions) &&
              caps.reasoningFormatOptions.includes(src.reasoning_format);

            if (hasValidFormat) {
              clean.reasoning_format = src.reasoning_format;
            } else if (
              src.include_reasoning !== undefined &&
              src.include_reasoning !== null &&
              caps.supportsIncludeReasoning
            ) {
              clean.include_reasoning = Boolean(src.include_reasoning);
            }
          }

          return clean;
        }

        /**
         * Fetches the active Groq model list (`GET /openai/v1/models`) for key testing or model refresh.
         * @param {string} apiKey
         * @param {Object} [options]
         * @returns {Promise<{models: Array, raw: Object, rateLimitInfo: Object}>}
         */
        async listModels(apiKey, options = {}) {
          if (!apiKey || !String(apiKey).trim()) {
            throw this._errorHandler.toError({ code: 'NO_KEY' });
          }
          const url = options.modelsEndpoint || this._modelsEndpoint;
          const res = await this._requestJSON({
            method: 'GET',
            url,
            apiKey: String(apiKey).trim(),
            signal: options.signal,
            timeoutMs: options.timeoutMs || this._timeoutMs,
          });

          const models = Array.isArray(res.data?.data) ? res.data.data : [];
          return {
            models,
            raw: res.data,
            rateLimitInfo: res.rateLimitInfo,
          };
        }

        /**
         * Sends a chat completion request to Groq (`POST /openai/v1/chat/completions`),
         * supporting both SSE streaming and non-streaming JSON responses.
         * @param {Object} params
         * @param {string} params.apiKey
         * @param {Object} params.payload
         * @param {AbortSignal} [params.signal]
         * @param {Function} [params.onChunk]
         * @param {string} [params.endpoint]
         * @param {number} [params.timeoutMs]
         * @returns {Promise<Object>}
         */
        async sendChatCompletion({ apiKey, payload, signal, onChunk, endpoint, timeoutMs } = {}) {
          if (!apiKey || !String(apiKey).trim()) {
            throw this._errorHandler.toError({ code: 'NO_KEY' });
          }
          if (!payload || typeof payload !== 'object') {
            throw this._errorHandler.toError({ status: 400, message: 'Missing request payload.' });
          }

          const cleanPayload = GroqAPIClient.sanitizePayload(payload);
          const model = cleanPayload.model;
          const caps = GroqAPIClient.getModelConstraints(model);
          const imageCount = GroqAPIClient.countImagesInMessages(cleanPayload.messages);

          if (imageCount > 0 && !caps.vision) {
            throw this._errorHandler.toError(
              { code: 'NON_VISION_MODEL', message: `Model "${model}" does not support images.` },
              { model }
            );
          }

          if (imageCount > 0 && caps.maxImagesPerRequest && imageCount > caps.maxImagesPerRequest) {
            throw this._errorHandler.toError(
              {
                code: 'IMAGE_LIMIT_EXCEEDED',
                message: `Model "${model}" allows at most ${caps.maxImagesPerRequest} image(s) per request (got ${imageCount}).`,
              },
              { model }
            );
          }

          if (signal && signal.aborted) {
            throw this._errorHandler.toError({ code: 'ABORTED', isAbort: true }, { model });
          }

          const url = endpoint || this._endpoint;
          const timeout = Number(timeoutMs) || this._timeoutMs;
          const wantStream = Boolean(cleanPayload.stream);

          const gmReq = this._resolveGMRequest();
          if (gmReq) {
            return this._executeWithGM({
              gmReq,
              url,
              apiKey: String(apiKey).trim(),
              payload: cleanPayload,
              wantStream,
              signal,
              onChunk,
              timeoutMs: timeout,
            });
          }

          const fetchFn = this._resolveFetch();
          if (fetchFn) {
            return this._executeWithFetch({
              fetchFn,
              url,
              apiKey: String(apiKey).trim(),
              payload: cleanPayload,
              wantStream,
              signal,
              onChunk,
              timeoutMs: timeout,
            });
          }

          throw this._errorHandler.toError({
            code: 'NETWORK_ERROR',
            isNetworkError: true,
            message: 'Neither GM_xmlhttpRequest nor fetch is available in this runtime.',
          });
        }

        /**
         * Aborts a specific active request by ID, or all active requests if omitted.
         * @param {string} [requestId]
         */
        abort(requestId) {
          if (requestId && this._activeRequests.has(requestId)) {
            const abortFn = this._activeRequests.get(requestId);
            this._activeRequests.delete(requestId);
            try {
              abortFn();
            } catch (_) {
              // Ignore abort errors
            }
            return;
          }
          for (const [id, abortFn] of Array.from(this._activeRequests.entries())) {
            this._activeRequests.delete(id);
            try {
              abortFn();
            } catch (_) {
              // Ignore abort errors
            }
          }
        }

        /** @private */
        _resolveGMRequest() {
          if (typeof this._gmRequest === 'function') return this._gmRequest;
          return resolveGMFunction('GM_xmlhttpRequest');
        }

        /** @private */
        _resolveFetch() {
          if (typeof this._fetchImpl === 'function') return this._fetchImpl;
          if (typeof fetch === 'function') return fetch;
          if (root && typeof root.fetch === 'function') return root.fetch.bind(root);
          return null;
        }

        /** @private */
        async _requestJSON({ method, url, apiKey, body, signal, timeoutMs }) {
          const gmReq = this._resolveGMRequest();
          if (gmReq) {
            return new Promise((resolve, reject) => {
              if (signal && signal.aborted) {
                reject(this._errorHandler.toError({ code: 'ABORTED', isAbort: true }));
                return;
              }

              const reqId = generateId('req');
              let settled = false;
              let gmHandle = null;

              const cleanup = () => {
                this._activeRequests.delete(reqId);
                if (signal && typeof signal.removeEventListener === 'function') {
                  signal.removeEventListener('abort', onAbort);
                }
              };

              const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                if (gmHandle && typeof gmHandle.abort === 'function') {
                  try {
                    gmHandle.abort();
                  } catch (_) {}
                }
                reject(this._errorHandler.toError({ code: 'ABORTED', isAbort: true }));
              };

              if (signal && typeof signal.addEventListener === 'function') {
                signal.addEventListener('abort', onAbort, { once: true });
              }

              this._activeRequests.set(reqId, onAbort);

              try {
                gmHandle = gmReq({
                  method,
                  url,
                  timeout: timeoutMs,
                  headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                  },
                  data: body ? JSON.stringify(body) : undefined,
                  onload: (resp) => {
                    if (settled) return;
                    settled = true;
                    cleanup();

                    const status = Number(resp.status || 0);
                    const rateLimitInfo = GroqAPIClient.parseRateLimitHeaders(resp.responseHeaders);
                    const rawText = String(resp.responseText || '');

                    if (status >= 400 || status === 0) {
                      const err = this._errorHandler.toError({
                        status: status || null,
                        headers: resp.responseHeaders,
                        body: rawText,
                        retryAfterSec: rateLimitInfo.retryAfterSec,
                        isNetworkError: status === 0,
                      });
                      err.rateLimitInfo = rateLimitInfo;
                      reject(err);
                      return;
                    }

                    if (!rawText.trim()) {
                      const err = this._errorHandler.toError({ code: 'EMPTY_RESPONSE', status });
                      err.rateLimitInfo = rateLimitInfo;
                      reject(err);
                      return;
                    }

                    try {
                      const parsed = JSON.parse(rawText);
                      resolve({ status, data: parsed, rateLimitInfo });
                    } catch (parseErr) {
                      const err = this._errorHandler.toError({
                        code: 'INVALID_JSON',
                        status,
                        message: parseErr.message,
                      });
                      err.rateLimitInfo = rateLimitInfo;
                      reject(err);
                    }
                  },
                  onerror: (resp) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    const err = this._errorHandler.toError({
                      code: 'NETWORK_ERROR',
                      isNetworkError: true,
                      status: resp?.status && resp.status >= 400 ? resp.status : null,
                      message: resp?.error || resp?.statusText || 'Network request failed',
                    });
                    reject(err);
                  },
                  ontimeout: () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(
                      this._errorHandler.toError({
                        code: 'TIMEOUT',
                        isTimeout: true,
                        message: `Request timed out after ${timeoutMs}ms`,
                      })
                    );
                  },
                  onabort: () => {
                    onAbort();
                  },
                });
              } catch (invokeErr) {
                if (!settled) {
                  settled = true;
                  cleanup();
                  reject(
                    this._errorHandler.toError({
                      code: 'NETWORK_ERROR',
                      isNetworkError: true,
                      message: invokeErr.message,
                    })
                  );
                }
              }
            });
          }

          const fetchFn = this._resolveFetch();
          if (!fetchFn) {
            throw this._errorHandler.toError({
              code: 'NETWORK_ERROR',
              isNetworkError: true,
              message: 'No HTTP transport available.',
            });
          }

          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const reqId = generateId('req');
          let timedOut = false;
          const timer = controller && timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
              }, timeoutMs)
            : null;

          const onExternalAbort = () => {
            if (controller) controller.abort();
          };
          if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', onExternalAbort, { once: true });
          }
          if (controller) {
            this._activeRequests.set(reqId, () => controller.abort());
          }

          try {
            const resp = await fetchFn(url, {
              method,
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: body ? JSON.stringify(body) : undefined,
              signal: controller ? controller.signal : signal,
            });

            const rateLimitInfo = GroqAPIClient.parseRateLimitHeaders(resp.headers);
            const rawText = await resp.text();

            if (!resp.ok) {
              const err = this._errorHandler.toError({
                status: resp.status,
                headers: resp.headers,
                body: rawText,
                retryAfterSec: rateLimitInfo.retryAfterSec,
              });
              err.rateLimitInfo = rateLimitInfo;
              throw err;
            }

            if (!rawText.trim()) {
              throw this._errorHandler.toError({ code: 'EMPTY_RESPONSE', status: resp.status });
            }

            try {
              const parsed = JSON.parse(rawText);
              return { status: resp.status, data: parsed, rateLimitInfo };
            } catch (parseErr) {
              throw this._errorHandler.toError({
                code: 'INVALID_JSON',
                status: resp.status,
                message: parseErr.message,
              });
            }
          } catch (err) {
            if (err && err.classified) throw err;
            if (timedOut) {
              throw this._errorHandler.toError({ code: 'TIMEOUT', isTimeout: true });
            }
            if (signal && signal.aborted) {
              throw this._errorHandler.toError({ code: 'ABORTED', isAbort: true });
            }
            if (err && err.name === 'AbortError') {
              throw this._errorHandler.toError({ code: 'ABORTED', isAbort: true });
            }
            throw this._errorHandler.toError({
              code: 'NETWORK_ERROR',
              isNetworkError: true,
              message: err?.message || 'Network error',
            });
          } finally {
            if (timer) clearTimeout(timer);
            this._activeRequests.delete(reqId);
            if (signal && typeof signal.removeEventListener === 'function') {
              signal.removeEventListener('abort', onExternalAbort);
            }
          }
        }

        /** @private */
        _createSSEAccumulator(model, onChunk) {
          let buffer = '';
          let content = '';
          let reasoning = '';
          let usage = null;
          let finishReason = null;
          let responseId = null;
          let responseModel = model;
          let chunkCount = 0;
          let sawDone = false;

          const emit = (payload) => {
            if (typeof onChunk === 'function') {
              try {
                onChunk(payload);
              } catch (_) {
                // Do not break stream ingestion on listener error
              }
            }
          };

          const processLine = (rawLine) => {
            const line = rawLine.replace(/\r$/, '');
            if (!line || line.startsWith(':')) return;
            if (!line.startsWith('data:')) return;
            const dataStr = line.slice(5).trim();
            if (!dataStr) return;
            if (dataStr === '[DONE]') {
              sawDone = true;
              return;
            }

            let parsed;
            try {
              parsed = JSON.parse(dataStr);
            } catch (_) {
              // Ignore malformed keepalive or partial trailing line until flush
              return;
            }

            chunkCount++;
            if (parsed.id) responseId = parsed.id;
            if (parsed.model) responseModel = parsed.model;
            if (parsed.usage) usage = parsed.usage;
            if (parsed.x_groq && parsed.x_groq.usage) usage = parsed.x_groq.usage;

            const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
            if (choice) {
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const delta = choice.delta || choice.message || {};
              if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
                reasoning += delta.reasoning;
                emit({
                  type: 'reasoning',
                  delta: delta.reasoning,
                  content,
                  reasoning,
                  rawChunk: parsed,
                });
              } else if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                reasoning += delta.reasoning_content;
                emit({
                  type: 'reasoning',
                  delta: delta.reasoning_content,
                  content,
                  reasoning,
                  rawChunk: parsed,
                });
              }
              if (typeof delta.content === 'string' && delta.content.length > 0) {
                content += delta.content;
                emit({
                  type: 'content',
                  delta: delta.content,
                  content,
                  reasoning,
                  rawChunk: parsed,
                });
              }
            }
          };

          return {
            pushText(textChunk) {
              if (!textChunk) return;
              buffer += textChunk;
              let nlIndex;
              while ((nlIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nlIndex);
                buffer = buffer.slice(nlIndex + 1);
                processLine(line);
              }
            },
            flush() {
              if (buffer.trim()) {
                processLine(buffer);
                buffer = '';
              }
            },
            getState() {
              return {
                id: responseId,
                model: responseModel,
                content,
                reasoning,
                usage,
                finishReason,
                chunkCount,
                sawDone,
              };
            },
          };
        }

        /** @private */
        _normalizeFinalResponse({ rawText, sseState, status, rateLimitInfo, model, wantStream, onChunk }) {
          // If SSE chunks were parsed
          if (sseState && sseState.chunkCount > 0) {
            if (!sseState.content && !sseState.reasoning) {
              const err = this._errorHandler.toError({ code: 'EMPTY_RESPONSE', status }, { model });
              err.rateLimitInfo = rateLimitInfo;
              throw err;
            }
            return {
              id: sseState.id,
              model: sseState.model || model,
              content: sseState.content,
              reasoning: sseState.reasoning || null,
              usage: sseState.usage || null,
              finishReason: sseState.finishReason || 'stop',
              rateLimitInfo,
              streamed: true,
            };
          }

          const trimmed = String(rawText || '').trim();
          if (!trimmed) {
            const err = this._errorHandler.toError({ code: 'EMPTY_RESPONSE', status }, { model });
            err.rateLimitInfo = rateLimitInfo;
            throw err;
          }

          // Non-streaming JSON response (or fallback when server returned JSON despite stream=true)
          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch (parseErr) {
            const err = this._errorHandler.toError(
              { code: 'INVALID_JSON', status, message: parseErr.message },
              { model }
            );
            err.rateLimitInfo = rateLimitInfo;
            throw err;
          }

          if (parsed && parsed.error) {
            const err = this._errorHandler.toError(
              { status: status >= 400 ? status : 400, body: parsed, retryAfterSec: rateLimitInfo?.retryAfterSec },
              { model }
            );
            err.rateLimitInfo = rateLimitInfo;
            throw err;
          }

          const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
          const message = choice?.message || {};
          const content = typeof message.content === 'string' ? message.content : '';
          const reasoning =
            typeof message.reasoning === 'string'
              ? message.reasoning
              : typeof message.reasoning_content === 'string'
                ? message.reasoning_content
                : null;
          const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

          if (!content && !reasoning && !hasToolCalls) {
            const err = this._errorHandler.toError({ code: 'EMPTY_RESPONSE', status }, { model });
            err.rateLimitInfo = rateLimitInfo;
            throw err;
          }

          if (wantStream && typeof onChunk === 'function') {
            if (reasoning) {
              onChunk({ type: 'reasoning', delta: reasoning, content: '', reasoning, rawChunk: parsed });
            }
            if (content) {
              onChunk({ type: 'content', delta: content, content, reasoning: reasoning || '', rawChunk: parsed });
            }
          }

          return {
            id: parsed.id || null,
            model: parsed.model || model,
            content,
            reasoning,
            toolCalls: message.tool_calls || null,
            usage: parsed.usage || parsed.x_groq?.usage || null,
            finishReason: choice?.finish_reason || 'stop',
            rateLimitInfo,
            raw: parsed,
            streamed: false,
          };
        }

        /** @private */
        _executeWithGM({ gmReq, url, apiKey, payload, wantStream, signal, onChunk, timeoutMs }) {
          const model = payload.model;
          return new Promise((resolve, reject) => {
            const reqId = generateId('chat');
            let settled = false;
            let gmHandle = null;
            let processedLen = 0;
            const sse = wantStream ? this._createSSEAccumulator(model, onChunk) : null;

            const cleanup = () => {
              this._activeRequests.delete(reqId);
              if (signal && typeof signal.removeEventListener === 'function') {
                signal.removeEventListener('abort', onAbort);
              }
            };

            const onAbort = () => {
              if (settled) return;
              settled = true;
              cleanup();
              if (gmHandle && typeof gmHandle.abort === 'function') {
                try {
                  gmHandle.abort();
                } catch (_) {}
              }
              reject(this._errorHandler.toError({ code: 'ABORTED', isAbort: true }, { model }));
            };

            if (signal && typeof signal.addEventListener === 'function') {
              signal.addEventListener('abort', onAbort, { once: true });
            }
            this._activeRequests.set(reqId, onAbort);

            const consumeIncremental = (resp) => {
              if (!wantStream || !sse || settled) return;
              const status = Number(resp?.status || 200);
              if (status >= 400) return; // Wait for onload to surface error payload
              const text = typeof resp?.responseText === 'string' ? resp.responseText : '';
              if (text.length > processedLen) {
                const deltaText = text.slice(processedLen);
                processedLen = text.length;
                if (deltaText.includes('data:') || sse.getState().chunkCount > 0 || !text.trimStart().startsWith('{')) {
                  sse.pushText(deltaText);
                }
              }
            };

            try {
              gmHandle = gmReq({
                method: 'POST',
                url,
                timeout: timeoutMs,
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                  Accept: wantStream ? 'text/event-stream, application/json' : 'application/json',
                },
                data: JSON.stringify(payload),
                onloadstart: (resp) => consumeIncremental(resp),
                onprogress: (resp) => consumeIncremental(resp),
                onreadystatechange: (resp) => {
                  if (resp && resp.readyState >= 3) {
                    consumeIncremental(resp);
                  }
                },
                onload: (resp) => {
                  if (settled) return;
                  settled = true;
                  cleanup();

                  const status = Number(resp?.status || 0);
                  const rateLimitInfo = GroqAPIClient.parseRateLimitHeaders(resp?.responseHeaders);
                  const rawText = typeof resp?.responseText === 'string' ? resp.responseText : '';

                  if (status >= 400 || status === 0) {
                    const err = this._errorHandler.toError(
                      {
                        status: status || null,
                        headers: resp?.responseHeaders,
                        body: rawText,
                        retryAfterSec: rateLimitInfo.retryAfterSec,
                        isNetworkError: status === 0,
                      },
                      { model }
                    );
                    err.rateLimitInfo = rateLimitInfo;
                    reject(err);
                    return;
                  }

                  if (wantStream && sse) {
                    if (rawText.length > processedLen) {
                      const tail = rawText.slice(processedLen);
                      processedLen = rawText.length;
                      if (tail.includes('data:') || sse.getState().chunkCount > 0 || !rawText.trimStart().startsWith('{')) {
                        sse.pushText(tail);
                      }
                    }
                    sse.flush();
                  }

                  try {
                    const result = this._normalizeFinalResponse({
                      rawText,
                      sseState: sse ? sse.getState() : null,
                      status,
                      rateLimitInfo,
                      model,
                      wantStream,
                      onChunk,
                    });
                    resolve(result);
                  } catch (normErr) {
                    reject(normErr);
                  }
                },
                onerror: (resp) => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  reject(
                    this._errorHandler.toError(
                      {
                        code: 'NETWORK_ERROR',
                        isNetworkError: true,
                        status: resp?.status && resp.status >= 400 ? resp.status : null,
                        message: resp?.error || resp?.statusText || 'Network request failed',
                      },
                      { model }
                    )
                  );
                },
                ontimeout: () => {
                  if (settled) return;
                  settled = true;
                  cleanup();
                  reject(
                    this._errorHandler.toError(
                      {
                        code: 'TIMEOUT',
                        isTimeout: true,
                        message: `Request timed out after ${timeoutMs}ms`,
                      },
                      { model }
                    )
                  );
                },
                onabort: () => {
                  onAbort();
                },
              });
            } catch (invokeErr) {
              if (!settled) {
                settled = true;
                cleanup();
                reject(
                  this._errorHandler.toError(
                    { code: 'NETWORK_ERROR', isNetworkError: true, message: invokeErr.message },
                    { model }
                  )
                );
              }
            }
          });
        }

        /** @private */
        async _executeWithFetch({ fetchFn, url, apiKey, payload, wantStream, signal, onChunk, timeoutMs }) {
          const model = payload.model;
          const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const reqId = generateId('chat');
          let timedOut = false;

          const timer = controller && timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
              }, timeoutMs)
            : null;

          const onExternalAbort = () => {
            if (controller) controller.abort();
          };
          if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', onExternalAbort, { once: true });
          }
          if (controller) {
            this._activeRequests.set(reqId, () => controller.abort());
          }

          try {
            const resp = await fetchFn(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Accept: wantStream ? 'text/event-stream, application/json' : 'application/json',
              },
              body: JSON.stringify(payload),
              signal: controller ? controller.signal : signal,
            });

            const rateLimitInfo = GroqAPIClient.parseRateLimitHeaders(resp.headers);

            if (!resp.ok) {
              const errText = await resp.text();
              const err = this._errorHandler.toError(
                {
                  status: resp.status,
                  headers: resp.headers,
                  body: errText,
                  retryAfterSec: rateLimitInfo.retryAfterSec,
                },
                { model }
              );
              err.rateLimitInfo = rateLimitInfo;
              throw err;
            }

            const contentType = String(resp.headers?.get?.('content-type') || '').toLowerCase();
            const isReadableStream = wantStream && resp.body && typeof resp.body.getReader === 'function';

            if (isReadableStream && (contentType.includes('text/event-stream') || !contentType.includes('application/json'))) {
              const sse = this._createSSEAccumulator(model, onChunk);
              const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
              const reader = resp.body.getReader();
              let rawFallback = '';

              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                const text =
                  typeof value === 'string'
                    ? value
                    : decoder
                      ? decoder.decode(value, { stream: true })
                      : String(value || '');
                rawFallback += text;
                if (text.includes('data:') || sse.getState().chunkCount > 0 || !rawFallback.trimStart().startsWith('{')) {
                  sse.pushText(text);
                }
              }
              if (decoder) {
                const tail = decoder.decode();
                if (tail) {
                  rawFallback += tail;
                  if (sse.getState().chunkCount > 0 || tail.includes('data:')) {
                    sse.pushText(tail);
                  }
                }
              }
              sse.flush();

              return this._normalizeFinalResponse({
                rawText: rawFallback,
                sseState: sse.getState(),
                status: resp.status,
                rateLimitInfo,
                model,
                wantStream,
                onChunk,
              });
            }

            const rawText = await resp.text();
            let sse = null;
            if (wantStream && rawText.includes('data:') && !rawText.trimStart().startsWith('{')) {
              sse = this._createSSEAccumulator(model, onChunk);
              sse.pushText(rawText);
              sse.flush();
            }

            return this._normalizeFinalResponse({
              rawText,
              sseState: sse ? sse.getState() : null,
              status: resp.status,
              rateLimitInfo,
              model,
              wantStream,
              onChunk,
            });
          } catch (err) {
            if (err && err.classified) throw err;
            if (timedOut) {
              throw this._errorHandler.toError({ code: 'TIMEOUT', isTimeout: true }, { model });
            }
            if ((signal && signal.aborted) || err?.name === 'AbortError') {
              throw this._errorHandler.toError({ code: 'ABORTED', isAbort: true }, { model });
            }
            throw this._errorHandler.toError(
              {
                code: 'NETWORK_ERROR',
                isNetworkError: true,
                message: err?.message || 'Network request failed',
              },
              { model }
            );
          } finally {
            if (timer) clearTimeout(timer);
            this._activeRequests.delete(reqId);
            if (signal && typeof signal.removeEventListener === 'function') {
              signal.removeEventListener('abort', onExternalAbort);
            }
          }
        }
      }

      GroqAPIClient.MODEL_REGISTRY = MODEL_REGISTRY;
      GroqAPIClient.DEFAULT_ENDPOINT = GROQ_CHAT_ENDPOINT;
      GroqAPIClient.DEFAULT_MODELS_ENDPOINT = GROQ_MODELS_ENDPOINT;

      // ===========================================================================
      // 6. FailoverEngine
      // ===========================================================================

      /**
       * Smart sequential API Key Rotation & Retry Engine wrapping GroqAPIClient and APIKeyManager.
       *
       * Enforces:
       * - Strictly sequential single-request lifecycle (never parallelizes across keys)
       * - At most one attempt per key per failover cycle (`triedKeyIds`)
       * - 401 -> marks key `invalid`, fails over to next key
       * - 403 -> marks key `permission_error`, fails over only for credential/permission errors when `autoFailover` enabled
       * - 429 -> puts key in `rate_limited` cooldown and stops (does NOT hop keys endlessly to evade org limits)
       * - 500/502/503/498 -> bounded exponential backoff retries up to `retryLimit`
       * - 400/404/413/422/non-vision -> surfaces immediately without cross-key failover
       * - Network/Timeout -> marks `network_error`, surfaces uncertain-state warning for explicit user retry
       * - Never mutates or clears conversation history on failover or failure
       */
      class FailoverEngine {
        /**
         * @param {Object} deps
         * @param {GroqAPIClient} deps.apiClient
         * @param {APIKeyManager} deps.keyManager
         * @param {SettingsManager} [deps.settingsManager]
         * @param {ErrorHandler} [deps.errorHandler]
         * @param {StorageManager} [deps.storageManager]
         * @param {number} [deps.backoffBaseMs=800]
         * @param {Function} [deps.sleep]
         */
        constructor(deps = {}) {
          this._apiClient = deps.apiClient || new GroqAPIClient();
          this._keyManager = deps.keyManager || new APIKeyManager();
          this._settingsManager = deps.settingsManager || null;
          this._errorHandler = deps.errorHandler || new ErrorHandler();
          this._storage = deps.storageManager || this._keyManager._storage || new StorageManager();
          this._backoffBaseMs = typeof deps.backoffBaseMs === 'number' ? deps.backoffBaseMs : 800;
          this._sleep = typeof deps.sleep === 'function' ? deps.sleep : cancellableSleep;
          this._inFlight = false;
        }

        /**
         * Returns whether a chat request lifecycle is currently running.
         * @returns {boolean}
         */
        isBusy() {
          return this._inFlight;
        }

        /**
         * Aborts any currently in-flight API request.
         */
        abort() {
          this._apiClient.abort();
        }

        /**
         * Executes a chat completion request through the failover lifecycle.
         * @param {Object} options
         * @param {Object} [options.payload] Pre-built Groq payload (or supply `messages` + `model` directly).
         * @param {Array} [options.messages]
         * @param {string} [options.model]
         * @param {AbortSignal} [options.signal]
         * @param {Function} [options.onChunk]
         * @param {Function} [options.onStatusChange]
         * @param {Function} [options.onFailover]
         * @returns {Promise<Object>}
         */
        async sendChatCompletion(options = {}) {
          if (this._inFlight) {
            throw this._errorHandler.toError({ code: 'CONCURRENT_REQUEST' });
          }

          const settings = this._settingsManager ? this._settingsManager.getAll() : SettingsManager.getDefaults();
          const lang = settings.general?.language || 'vi';
          const emitStatus = (status, info) => {
            if (typeof options.onStatusChange === 'function') {
              try {
                options.onStatusChange(status, info);
              } catch (_) {}
            }
          };

          const basePayload = options.payload
            ? deepClone(options.payload)
            : {
                model: options.model || settings.model.activeModel || settings.model.visionModel,
                messages: deepClone(options.messages || []),
                temperature: settings.model.temperature,
                max_completion_tokens: settings.model.maxCompletionTokens,
                top_p: settings.model.topP,
                reasoning_effort: settings.model.reasoningEffort,
                reasoning_format: settings.model.reasoningFormat,
                stream: settings.model.stream,
              };

          const model = String(basePayload.model || settings.model.activeModel || settings.model.visionModel).trim();
          basePayload.model = model;

          // Pre-flight 1: non-vision model with images -> fail fast without touching keys
          const imgCount = GroqAPIClient.countImagesInMessages(basePayload.messages);
          if (imgCount > 0 && !this._apiClient.isVisionModel(model)) {
            throw this._errorHandler.toError(
              { code: 'NON_VISION_MODEL', message: `Model "${model}" does not support image inputs.` },
              { language: lang, model }
            );
          }

          const caps = this._apiClient.getModelConstraints(model);
          if (imgCount > 0 && caps.maxImagesPerRequest && imgCount > caps.maxImagesPerRequest) {
            throw this._errorHandler.toError(
              {
                code: 'IMAGE_LIMIT_EXCEEDED',
                message: `Model "${model}" supports at most ${caps.maxImagesPerRequest} image(s) per request (got ${imgCount}).`,
              },
              { language: lang, model }
            );
          }

          // Pre-flight 2: ensure key pool has at least one candidate
          if (this._keyManager.getTotalCount() === 0) {
            throw this._errorHandler.toError({ code: 'NO_KEY' }, { language: lang, model });
          }

          let candidates = this._keyManager.getCandidateOrder({ includeNetworkError: false });
          if (candidates.length === 0) {
            // Allow user-initiated retry on network_error keys when no active keys exist
            candidates = this._keyManager.getCandidateOrder({ includeNetworkError: true });
          }
          if (candidates.length === 0) {
            const earliest = this._keyManager.getEarliestCooldownUntil();
            const retryAfterSec = earliest ? Math.max(1, Math.ceil((earliest - Date.now()) / 1000)) : null;
            throw this._errorHandler.toError(
              { code: 'NO_ACTIVE_KEY', retryAfterSec },
              { language: lang, model }
            );
          }

          const autoFailover = Boolean(settings.api?.autoFailover ?? true);
          const retryLimit = Math.max(0, Number(settings.api?.retryLimit ?? 2));
          const defaultCooldownSec = Math.max(1, Number(settings.api?.defaultCooldownSec ?? 60));
          const endpoint = options.endpoint || settings.model?.endpoint;
          const timeoutMs = Number(options.timeoutMs || settings.api?.requestTimeoutMs || 60000);

          const triedKeyIds = new Set();
          let totalAttempts = 0;

          this._inFlight = true;
          try {
            while (true) {
              if (options.signal && options.signal.aborted) {
                throw this._errorHandler.toError({ code: 'ABORTED', isAbort: true }, { language: lang, model });
              }

              let pool = this._keyManager.getCandidateOrder({ includeNetworkError: false });
              let nextCandidate = pool.find((k) => !triedKeyIds.has(k.id));
              if (!nextCandidate) {
                pool = this._keyManager.getCandidateOrder({ includeNetworkError: true });
                nextCandidate = pool.find((k) => !triedKeyIds.has(k.id));
              }

              if (!nextCandidate) {
                throw this._errorHandler.toError({ code: 'NO_ACTIVE_KEY' }, { language: lang, model });
              }

              triedKeyIds.add(nextCandidate.id);
              this._keyManager.recordAttempt(nextCandidate.id);
              const rawKey = this._keyManager.getRawKey(nextCandidate.id);

              let retryCount = 0;
              while (true) {
                totalAttempts++;
                emitStatus('sending', {
                  keyId: nextCandidate.id,
                  maskedKey: nextCandidate.maskedKey,
                  attempt: totalAttempts,
                  model,
                });

                try {
                  let streamingNotified = false;
                  const wrappedOnChunk = typeof options.onChunk === 'function'
                    ? (chunk) => {
                        if (!streamingNotified) {
                          streamingNotified = true;
                          emitStatus('streaming', {
                            keyId: nextCandidate.id,
                            maskedKey: nextCandidate.maskedKey,
                            model,
                          });
                        }
                        options.onChunk(chunk);
                      }
                    : undefined;

                  const result = await this._apiClient.sendChatCompletion({
                    apiKey: rawKey,
                    payload: basePayload,
                    signal: options.signal,
                    onChunk: wrappedOnChunk,
                    endpoint,
                    timeoutMs,
                  });

                  this._keyManager.markSuccess(nextCandidate.id, result.rateLimitInfo);
                  this._recordUsage(result.usage, model);
                  emitStatus('idle', {
                    keyId: nextCandidate.id,
                    maskedKey: nextCandidate.maskedKey,
                    model: result.model || model,
                  });

                  return {
                    ...result,
                    keyId: nextCandidate.id,
                    maskedKey: nextCandidate.maskedKey,
                    attempts: totalAttempts,
                    triedKeyIds: Array.from(triedKeyIds),
                  };
                } catch (err) {
                  const classified = this._errorHandler.classify(err, { language: lang, model });
                  const enrichAndThrow = (extra = {}) => {
                    const wrapped = this._errorHandler.toError(classified, { language: lang, model });
                    wrapped.attempts = totalAttempts;
                    wrapped.triedKeyIds = Array.from(triedKeyIds);
                    wrapped.keyId = nextCandidate.id;
                    wrapped.maskedKey = nextCandidate.maskedKey;
                    Object.assign(wrapped, extra);
                    emitStatus(classified.isAbort ? 'idle' : classified.isRateLimit ? 'cooldown' : 'error', {
                      keyId: nextCandidate.id,
                      maskedKey: nextCandidate.maskedKey,
                      error: wrapped,
                    });
                    throw wrapped;
                  };

                  // 1. User abort -> immediate stop, no key penalty
                  if (classified.isAbort) {
                    enrichAndThrow();
                  }

                  // 2. 401 -> mark invalid, failover sequentially if enabled and untried candidate exists
                  if (classified.status === 401) {
                    this._keyManager.markError(nextCandidate.id, 'invalid', classified.userMessage, {
                      rateLimitInfo: err.rateLimitInfo,
                    });
                    if (autoFailover) {
                      const remaining = this._findNextUntried(triedKeyIds);
                      if (remaining) {
                        emitStatus('failover', {
                          fromKeyId: nextCandidate.id,
                          fromMaskedKey: nextCandidate.maskedKey,
                          toKeyId: remaining.id,
                          toMaskedKey: remaining.maskedKey,
                          reason: classified.code,
                        });
                        if (typeof options.onFailover === 'function') {
                          try {
                            options.onFailover({
                              fromKey: nextCandidate,
                              toKey: remaining,
                              reason: classified,
                              attempt: totalAttempts,
                            });
                          } catch (_) {}
                        }
                        break; // advance outer key loop
                      }
                    }
                    enrichAndThrow();
                  }

                  // 3. 403 -> mark permission_error, failover ONLY if credential/permission error & autoFailover
                  if (classified.status === 403) {
                    this._keyManager.markError(nextCandidate.id, 'permission_error', classified.userMessage, {
                      rateLimitInfo: err.rateLimitInfo,
                    });
                    if (autoFailover && classified.failoverEligible) {
                      const remaining = this._findNextUntried(triedKeyIds);
                      if (remaining) {
                        emitStatus('failover', {
                          fromKeyId: nextCandidate.id,
                          fromMaskedKey: nextCandidate.maskedKey,
                          toKeyId: remaining.id,
                          toMaskedKey: remaining.maskedKey,
                          reason: classified.code,
                        });
                        if (typeof options.onFailover === 'function') {
                          try {
                            options.onFailover({
                              fromKey: nextCandidate,
                              toKey: remaining,
                              reason: classified,
                              attempt: totalAttempts,
                            });
                          } catch (_) {}
                        }
                        break;
                      }
                    }
                    enrichAndThrow();
                  }

                  // 4. 429 -> put key in rate_limited cooldown, DO NOT hop across keys to evade org limits
                  if (classified.status === 429) {
                    const rl = err.rateLimitInfo || {};
                    const cooldownSec = Math.max(
                      1,
                      Math.ceil(
                        classified.retryAfterSec ??
                          rl.retryAfterSec ??
                          rl.resetRequestsSec ??
                          rl.resetTokensSec ??
                          defaultCooldownSec
                      )
                    );
                    this._keyManager.markError(nextCandidate.id, 'rate_limited', classified.userMessage, {
                      cooldownUntil: Date.now() + cooldownSec * 1000,
                      rateLimitInfo: rl,
                    });
                    classified.retryAfterSec = cooldownSec;
                    enrichAndThrow({ retryAfterSec: cooldownSec });
                  }

                  // 5. 500/502/503/498 -> bounded exponential backoff retries on the same key
                  if (classified.status === 500 || classified.status === 502 || classified.status === 503 || classified.status === 498) {
                    if (retryCount < retryLimit) {
                      retryCount++;
                      const delayMs = this._backoffBaseMs * Math.pow(2, retryCount - 1);
                      emitStatus('retrying', {
                        keyId: nextCandidate.id,
                        maskedKey: nextCandidate.maskedKey,
                        retryCount,
                        retryLimit,
                        delayMs,
                        status: classified.status,
                      });
                      await this._sleep(delayMs, options.signal);
                      continue;
                    }
                    enrichAndThrow();
                  }

                  // 6. Network / Timeout -> mark network_error, stop immediately with uncertain-state warning
                  if (classified.category === 'network') {
                    this._keyManager.markError(nextCandidate.id, 'network_error', classified.userMessage);
                    enrichAndThrow({ isUncertainState: true, allowRetry: true });
                  }

                  // 7. 400 / 404 / 413 / 422 / non-vision / parse errors -> surface immediately without failover
                  enrichAndThrow();
                }
              }
            }
          } finally {
            this._inFlight = false;
          }
        }

        /** @private */
        _findNextUntried(triedKeyIds) {
          const active = this._keyManager.getCandidateOrder({ includeNetworkError: false });
          return active.find((k) => !triedKeyIds.has(k.id)) || null;
        }

        /** @private */
        _recordUsage(usage, model) {
          if (!this._storage) return;
          const current = this._storage.get(StorageManager.KEYS.USAGE, {
            totalRequests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            byModel: {},
            lastUpdated: null,
          });

          current.totalRequests = Number(current.totalRequests || 0) + 1;
          const promptTokens = Number(usage?.prompt_tokens || 0);
          const completionTokens = Number(usage?.completion_tokens || 0);
          const totalTokens = Number(usage?.total_tokens || promptTokens + completionTokens);

          current.promptTokens = Number(current.promptTokens || 0) + promptTokens;
          current.completionTokens = Number(current.completionTokens || 0) + completionTokens;
          current.totalTokens = Number(current.totalTokens || 0) + totalTokens;
          current.lastUpdated = Date.now();

          if (model) {
            current.byModel = current.byModel || {};
            const prev = current.byModel[model] || { requests: 0, tokens: 0 };
            current.byModel[model] = {
              requests: prev.requests + 1,
              tokens: prev.tokens + totalTokens,
            };
          }

          this._storage.set(StorageManager.KEYS.USAGE, current);
        }
      }

      // ===========================================================================
      // 7. ContextManager
      // ===========================================================================

      /**
       * Builds valid Groq `messages[]` payloads from conversation history, handling
       * homework-tutor system prompts, multi-turn image preservation without duplicate
       * base64 encoding, `<think>` / `reasoning` stripping, context trimming with structured
       * summarization, and non-vision model mismatch warnings.
       */
      class ContextManager {
        /**
         * @param {SettingsManager} [settingsManager]
         */
        constructor(settingsManager) {
          this._settingsManager = settingsManager || null;
        }

        /**
         * Strips `<think>...</think>` blocks (including unclosed trailing think tags) from assistant text.
         * @param {string} content
         * @returns {string}
         */
        static stripReasoning(content) {
          if (!content || typeof content !== 'string') return '';
          return content
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/<think>[\s\S]*$/gi, '')
            .trim();
        }

        /**
         * Generates the homework-tutor system prompt for the requested language and mode.
         * @param {'vi'|'en'} [language='vi']
         * @param {'tutor'|'concise'|'detailed'|'custom'} [mode='tutor']
         * @param {string} [customPrompt='']
         * @returns {string}
         */
        static getSystemPrompt(language = 'vi', mode = 'tutor', customPrompt = '') {
          const lang = language === 'en' ? 'en' : 'vi';
          if (mode === 'custom' && customPrompt && customPrompt.trim()) {
            return customPrompt.trim();
          }

          if (lang === 'en') {
            const baseEn = [
              'You are Smart Homework Capture, a careful and accurate AI homework tutor.',
              'OCR & Visual Accuracy: Read every number, mathematical symbol, exponent, subscript, unit, diagram label, and line of text from attached images with extreme care.',
              'Honesty Policy: If any part of an image is blurry, cropped, occluded, low-resolution, or unreadable, explicitly state which part cannot be read reliably and ask the user for a clearer image. NEVER guess or fabricate missing numbers, text, or givens.',
              'Formatting: Present solutions clearly with LaTeX math ($...$ inline, $$...$$ block).',
            ];
            if (mode === 'concise') {
              baseEn.push('Style: Be concise — list extracted givens briefly, show core steps, and highlight the final answer.');
            } else if (mode === 'detailed') {
              baseEn.push('Style: Provide thorough step-by-step explanations, underlying formulas/theorems, intermediate algebra, and a quick verification check at the end.');
            } else {
              baseEn.push('Style: Explain step by step so the student understands both the method and the final answer.');
            }
            return baseEn.join('\n');
          }

          const baseVi = [
            'Bạn là Smart Homework Capture, trợ lý AI gia sư giải bài tập cẩn thận và trung thực.',
            'Độ chính xác OCR & Hình ảnh: Đọc thật kỹ từng chữ số, ký hiệu toán học, số mũ, chỉ số dưới, phân số, đơn vị, nhãn hình vẽ và đề bài trong ảnh đính kèm.',
            'Nguyên tắc trung thực: Nếu ảnh bị mờ, bị cắt mất đề, thiếu dữ kiện hoặc có phần chữ/số không thể đọc chắc chắn, PHẢI thông báo rõ phần nào không đọc được và đề nghị người dùng gửi ảnh rõ hơn. TUYỆT ĐỐI KHÔNG tự bịa đề bài hoặc đoán mò dữ kiện bị thiếu.',
            'Trình bày: Trả lời bằng tiếng Việt rõ ràng, công thức toán/lý/hóa viết chuẩn LaTeX ($...$ cho công thức cùng dòng, $$...$$ cho công thức khối).',
          ];
          if (mode === 'concise') {
            baseVi.push('Phong cách: Ngắn gọn, đi thẳng vào tóm tắt dữ kiện, các bước giải chính và đáp án cuối cùng.');
          } else if (mode === 'detailed') {
            baseVi.push('Phong cách: Giải thích chi tiết từng bước, nêu rõ công thức/định lý áp dụng, phép biến đổi trung gian và bước kiểm tra lại kết quả.');
          } else {
            baseVi.push('Phong cách: Hướng dẫn từng bước dễ hiểu để học sinh nắm được phương pháp làm bài và đáp án chính xác.');
          }
          return baseVi.join('\n');
        }

        /**
         * Checks whether a conversation contains any image attachments.
         * @param {Object|Array} conversationOrMessages
         * @returns {{ hasAnyImages: boolean, hasLiveImageData: boolean, totalImages: number }}
         */
        static inspectImages(conversationOrMessages) {
          const list = Array.isArray(conversationOrMessages)
            ? conversationOrMessages
            : Array.isArray(conversationOrMessages?.messages)
              ? conversationOrMessages.messages
              : [];

          let totalImages = 0;
          let hasLiveImageData = false;
          for (const msg of list) {
            if (msg && Array.isArray(msg.images)) {
              for (const img of msg.images) {
                if (img) {
                  totalImages++;
                  if (typeof img.dataUrl === 'string' && img.dataUrl.trim()) {
                    hasLiveImageData = true;
                  }
                }
              }
            }
          }
          return {
            hasAnyImages: totalImages > 0,
            hasLiveImageData,
            totalImages,
          };
        }

        /**
         * Checks model compatibility with the current conversation (e.g., warns when switching
         * to a text-only model while images exist in the conversation).
         * @param {Object|Array} conversationOrMessages
         * @param {string} modelId
         * @param {'vi'|'en'} [language='vi']
         * @returns {{ compatible: boolean, warnings: Array<Object> }}
         */
        checkModelCompatibility(conversationOrMessages, modelId, language) {
          const lang = language || this._settingsManager?.get('general.language', 'vi') || 'vi';
          const { hasAnyImages, hasLiveImageData, totalImages } = ContextManager.inspectImages(conversationOrMessages);
          const isVision = GroqAPIClient.isVisionModel(modelId);
          const warnings = [];

          if (hasAnyImages && !isVision) {
            const vi = `Cuộc trò chuyện hiện có ${totalImages} ảnh, nhưng model "${modelId}" không hỗ trợ xử lý ảnh (chỉ hỗ trợ văn bản). Hãy chuyển về model Vision như qwen/qwen3.8-27b.`;
            const en = `This conversation contains ${totalImages} image(s), but model "${modelId}" is text-only and cannot view images. Switch to a Vision model such as qwen/qwen3.8-27b.`;
            warnings.push({
              code: 'NON_VISION_MODEL_WITH_IMAGES',
              model: modelId,
              hasLiveImageData,
              totalImages,
              vi,
              en,
              message: lang === 'en' ? en : vi,
            });
          }

          return {
            compatible: warnings.length === 0,
            isVisionModel: isVision,
            hasAnyImages,
            hasLiveImageData,
            warnings,
          };
        }

        /**
         * Summarizes trimmed middle messages while retaining problem statement, givens,
         * formulas, prior results, and open questions.
         * @param {Array<Object>} trimmedMessages
         * @param {Object} [initialProblemMsg]
         * @param {'vi'|'en'} [language='vi']
         * @returns {string}
         */
        static summarizeMessages(trimmedMessages, initialProblemMsg = null, language = 'vi') {
          const lines = [];
          const givens = [];
          const formulas = [];
          const priorResults = [];
          const openQuestions = [];

          const formulaRe = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|[A-Za-z0-9_)\]]+\s*=\s*[^,;\n.]+/g;
          const givenRe = /(?:^|[.;\n])\s*(?:cho|biết|giả sử|đặt|gọi|tìm|tính|chứng minh|given|let|suppose|find|solve|calculate)\b[^.\n]{3,140}/gi;
          const resultRe = /(?:đáp án|kết quả|suy ra|vậy|do đó|ta có|therefore|thus|hence|answer|result|solution)\s*[:\-]?\s*[^.\n]{3,160}/gi;

          if (initialProblemMsg && typeof initialProblemMsg.content === 'string' && initialProblemMsg.content.trim()) {
            const snippet = initialProblemMsg.content.trim().replace(/\s+/g, ' ').slice(0, 240);
            lines.push(
              language === 'en'
                ? `- Problem statement: ${snippet}`
                : `- Đề bài ban đầu: ${snippet}`
            );
          }

          for (const msg of trimmedMessages) {
            if (!msg) continue;
            const rawText =
              msg.role === 'assistant'
                ? ContextManager.stripReasoning(String(msg.content || ''))
                : String(msg.content || '');
            const text = rawText.replace(/\s+/g, ' ').trim();
            if (!text) continue;

            if (msg.role === 'user') {
              const gMatches = text.match(givenRe);
              if (gMatches) {
                for (const g of gMatches.slice(0, 3)) {
                  const cleaned = g.replace(/^[.;\s]+/, '').trim();
                  if (cleaned && !givens.includes(cleaned)) givens.push(cleaned);
                }
              }
              if (text.includes('?') || /^(?:tại sao|làm sao|câu|phần|why|how|what|check)/i.test(text)) {
                openQuestions.push(text.slice(0, 140));
              }
            } else if (msg.role === 'assistant') {
              const rMatches = text.match(resultRe);
              if (rMatches) {
                for (const r of rMatches.slice(0, 3)) {
                  const cleaned = r.trim();
                  if (cleaned && !priorResults.includes(cleaned)) priorResults.push(cleaned);
                }
              } else {
                priorResults.push(text.slice(-160));
              }
            }

            const fMatches = text.match(formulaRe);
            if (fMatches) {
              for (const f of fMatches) {
                const cleanF = f.trim();
                if (cleanF.length <= 120 && !formulas.includes(cleanF)) {
                  formulas.push(cleanF);
                }
                if (formulas.length >= 8) break;
              }
            }
          }

          if (givens.length > 0) {
            lines.push(
              language === 'en'
                ? `- Givens / constraints: ${givens.slice(0, 5).join('; ')}`
                : `- Dữ kiện đã nêu: ${givens.slice(0, 5).join('; ')}`
            );
          }
          if (formulas.length > 0) {
            lines.push(
              language === 'en'
                ? `- Key formulas / expressions: ${formulas.slice(0, 6).join(', ')}`
                : `- Công thức / biểu thức chính: ${formulas.slice(0, 6).join(', ')}`
            );
          }
          if (priorResults.length > 0) {
            lines.push(
              language === 'en'
                ? `- Prior results: ${priorResults.slice(-4).join(' | ')}`
                : `- Kết quả bước trước: ${priorResults.slice(-4).join(' | ')}`
            );
          }
          if (openQuestions.length > 0) {
            lines.push(
              language === 'en'
                ? `- Earlier follow-ups: ${openQuestions.slice(-2).join(' | ')}`
                : `- Câu hỏi phụ trước đó: ${openQuestions.slice(-2).join(' | ')}`
            );
          }

          if (lines.length === 0) {
            lines.push(
              language === 'en'
                ? `- ${trimmedMessages.length} earlier message(s) omitted to fit context window.`
                : `- Đã tóm tắt lược bỏ ${trimmedMessages.length} tin nhắn trước đó để giữ gọn ngữ cảnh.`
            );
          }

          return (
            (language === 'en'
              ? '[Trimmed Conversation Context Summary]\n'
              : '[Tóm tắt ngữ cảnh hội thoại trước đó]\n') + lines.join('\n')
          );
        }

        /**
         * Builds a Groq-compatible `messages[]` array from conversation state.
         * @param {Object|Array} conversationOrMessages
         * @param {Object} [options]
         * @returns {Object}
         */
        buildMessages(conversationOrMessages, options = {}) {
          const settings = this._settingsManager ? this._settingsManager.getAll() : SettingsManager.getDefaults();
          const language = options.language || settings.general.language || 'vi';
          const mode = options.systemPromptMode || settings.general.systemPromptMode || 'tutor';
          const customPrompt =
            options.customSystemPrompt !== undefined
              ? options.customSystemPrompt
              : settings.general.customSystemPrompt;
          const model =
            options.model ||
            (!Array.isArray(conversationOrMessages) && conversationOrMessages?.model) ||
            settings.model.activeModel ||
            settings.model.visionModel;

          const maxMessages = Math.max(
            1,
            Number(options.maxMessages ?? settings.conversation.maxMessages ?? 30)
          );
          const autoSummarize =
            options.autoSummarize !== undefined
              ? Boolean(options.autoSummarize)
              : Boolean(settings.conversation.autoSummarize);

          const caps = GroqAPIClient.getModelConstraints(model);
          const isVision = caps.vision;
          const maxImagesCap = isVision
            ? Math.max(
                1,
                Math.min(
                  Number(options.maxImages ?? settings.capture.maxImagesPerMessage ?? caps.maxImagesPerRequest ?? 3),
                  caps.maxImagesPerRequest || 3
                )
              )
            : 0;

          const rawMessages = Array.isArray(conversationOrMessages)
            ? conversationOrMessages
            : Array.isArray(conversationOrMessages?.messages)
              ? conversationOrMessages.messages
              : [];

          // Filter out empty failed assistant turns, preserve user and valid assistant messages
          const cleanMessages = rawMessages.filter((m) => {
            if (!m || !m.role) return false;
            if (m.role === 'system') return false;
            if (m.status === 'error') return false;
            if (m.role === 'assistant') {
              return ContextManager.stripReasoning(String(m.content || '')).length > 0;
            }
            return true;
          });

          const compat = this.checkModelCompatibility(cleanMessages, model, language);

          // Determine retained slice when exceeding maxMessages:
          // Always retain the initial user problem turn (if any) + most recent turns up to maxMessages.
          let retainedMessages = cleanMessages;
          let trimmedMessages = [];
          let summary = null;

          if (cleanMessages.length > maxMessages) {
            const firstUserIdx = cleanMessages.findIndex((m) => m.role === 'user');
            if (firstUserIdx !== -1 && maxMessages >= 2) {
              const initialMsg = cleanMessages[firstUserIdx];
              const tailBudget = maxMessages - 1;
              const tailStart = Math.max(firstUserIdx + 1, cleanMessages.length - tailBudget);
              trimmedMessages = cleanMessages.slice(firstUserIdx + 1, tailStart);
              retainedMessages = [initialMsg, ...cleanMessages.slice(tailStart)];
            } else {
              const tailStart = cleanMessages.length - maxMessages;
              trimmedMessages = cleanMessages.slice(0, tailStart);
              retainedMessages = cleanMessages.slice(tailStart);
            }

            if (autoSummarize && trimmedMessages.length > 0) {
              summary = ContextManager.summarizeMessages(
                trimmedMessages,
                cleanMessages.find((m) => m.role === 'user') || null,
                language
              );
            }
          }

          // Select which live images across retained user messages are kept up to maxImagesCap:
          // Priority 1: initial user message image(s)
          // Priority 2: most recent user message image(s)
          const selectedImageKeys = new Set();
          let totalLiveImages = 0;

          const imageRefs = [];
          retainedMessages.forEach((msg, mIdx) => {
            if (msg.role === 'user' && Array.isArray(msg.images)) {
              msg.images.forEach((img, iIdx) => {
                if (img && typeof img.dataUrl === 'string' && img.dataUrl.trim()) {
                  totalLiveImages++;
                  imageRefs.push({ key: `${mIdx}:${iIdx}`, mIdx, iIdx });
                }
              });
            }
          });

          if (isVision && maxImagesCap > 0 && imageRefs.length > 0) {
            const firstImageMsgIdx = imageRefs[0].mIdx;
            // 1. Keep initial image(s)
            for (const ref of imageRefs) {
              if (ref.mIdx === firstImageMsgIdx && selectedImageKeys.size < maxImagesCap) {
                selectedImageKeys.add(ref.key);
              }
            }
            // 2. Keep most recent image(s) scanning backward
            for (let i = imageRefs.length - 1; i >= 0 && selectedImageKeys.size < maxImagesCap; i--) {
              selectedImageKeys.add(imageRefs[i].key);
            }
          } else if (!isVision && !options.allowTextOnlyFallback) {
            // When NOT in text-only fallback, preserve image_url parts on the latest user turn
            // (or all live turns up to 3) so pre-flight/FailoverEngine detects NON_VISION_MODEL accurately
            // rather than silently hallucinating without the image!
            for (let i = imageRefs.length - 1; i >= 0 && selectedImageKeys.size < 3; i--) {
              selectedImageKeys.add(imageRefs[i].key);
            }
          }

          // Assemble Groq messages[]
          let systemPrompt = ContextManager.getSystemPrompt(language, mode, customPrompt);
          if (summary) {
            systemPrompt = `${systemPrompt}\n\n${summary}`;
          }

          const apiMessages = [{ role: 'system', content: systemPrompt }];
          let includedImageCount = 0;
          let omittedImagesCount = 0;

          retainedMessages.forEach((msg, mIdx) => {
            if (msg.role === 'assistant') {
              const cleaned = ContextManager.stripReasoning(String(msg.content || ''));
              apiMessages.push({
                role: 'assistant',
                content: cleaned,
              });
              return;
            }

            if (msg.role === 'user') {
              const userText = typeof msg.content === 'string' ? msg.content : '';
              const imgs = Array.isArray(msg.images) ? msg.images : [];

              if (imgs.length === 0) {
                apiMessages.push({
                  role: 'user',
                  content: userText,
                });
                return;
              }

              const parts = [];
              const notes = [];

              if (userText.trim()) {
                parts.push({ type: 'text', text: userText });
              }

              imgs.forEach((img, iIdx) => {
                if (!img) return;
                const hasUrl = typeof img.dataUrl === 'string' && img.dataUrl.trim().length > 0;
                const refKey = `${mIdx}:${iIdx}`;

                if (hasUrl && selectedImageKeys.has(refKey)) {
                  parts.push({
                    type: 'image_url',
                    image_url: { url: img.dataUrl },
                  });
                  includedImageCount++;
                } else if (!hasUrl) {
                  notes.push(img.placeholder || '[Image attached in previous session]');
                } else {
                  omittedImagesCount++;
                  notes.push(
                    !isVision
                      ? '[Image omitted: current model is text-only]'
                      : `[Previous image omitted due to ${maxImagesCap}-image limit]`
                  );
                }
              });

              if (notes.length > 0) {
                const noteText = notes.join(' ');
                if (parts.length > 0 && parts[0].type === 'text') {
                  parts[0].text = `${parts[0].text}\n${noteText}`.trim();
                } else {
                  parts.unshift({ type: 'text', text: noteText });
                }
              }

              // If no image_url parts ended up in this turn, keep clean string content
              const hasImagePart = parts.some((p) => p.type === 'image_url');
              if (!hasImagePart) {
                const combinedText = parts.map((p) => p.text || '').join('\n').trim();
                apiMessages.push({ role: 'user', content: combinedText });
              } else {
                // Ensure at least one text part accompanies image_url if userText was empty
                if (!parts.some((p) => p.type === 'text')) {
                  parts.unshift({
                    type: 'text',
                    text: language === 'en' ? 'Please solve the exercise in this image.' : 'Hãy giải bài tập trong ảnh này.',
                  });
                }
                apiMessages.push({ role: 'user', content: parts });
              }
            }
          });

          const containsUnsupportedImages = !isVision && includedImageCount > 0;

          return {
            messages: apiMessages,
            model,
            imageCount: includedImageCount,
            totalImagesInHistory: compat.totalImages,
            totalLiveImages,
            omittedImagesCount,
            trimmedCount: trimmedMessages.length,
            summary,
            warnings: compat.warnings,
            hasVisionMismatch: !compat.compatible,
            containsUnsupportedImages,
          };
        }
      }

      // ===========================================================================
      // 8. ConversationManager
      // ===========================================================================

      /**
       * Manages multi-conversation CRUD, in-memory image sessions, privacy-aware
       * persistence (`saveHistory` / `saveImagesInHistory`), and JSON/Markdown exports.
       */
      class ConversationManager {
        /**
         * @param {StorageManager} [storage]
         * @param {SettingsManager} [settingsManager]
         */
        constructor(storage, settingsManager) {
          this._storage = storage || new StorageManager();
          this._settingsManager = settingsManager || null;
          this._conversations = [];
          this._activeId = null;
          this._listeners = new Set();
          this.load();
        }

        /**
         * Loads persisted conversations from `shc_conversations` if `saveHistory` is enabled.
         * Ensures at least one active conversation exists.
         * @returns {Array<Object>}
         */
        load() {
          const saveHistory = this._getSetting('conversation.saveHistory', true);
          if (saveHistory) {
            const saved = this._storage.get(StorageManager.KEYS.CONVERSATIONS, null);
            if (saved && Array.isArray(saved.conversations)) {
              this._conversations = saved.conversations.map((c) => this._normalizeConversation(c));
              this._activeId = saved.activeId || null;
            } else {
              this._conversations = [];
              this._activeId = null;
            }
          } else {
            this._conversations = [];
            this._activeId = null;
          }

          if (this._conversations.length === 0) {
            this.create({ persist: saveHistory });
          } else if (!this._conversations.some((c) => c.id === this._activeId)) {
            this._activeId = this._conversations[0].id;
          }

          return this.getAll();
        }

        /**
         * Persists conversations honoring `saveHistory` and `saveImagesInHistory` privacy rules.
         * In-memory session images remain intact even when base64 is stripped on storage save.
         */
        save() {
          const saveHistory = this._getSetting('conversation.saveHistory', true);
          if (!saveHistory) {
            this._storage.remove(StorageManager.KEYS.CONVERSATIONS);
            this._emitChange();
            return;
          }

          const saveImages = this._getSetting('conversation.saveImagesInHistory', false);
          const serialized = this._conversations.map((conv) => ({
            id: conv.id,
            title: ErrorHandler.sanitizeString(String(conv.title || 'New Chat')),
            model: conv.model || null,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            messages: conv.messages.map((msg) => this._prepareMessageForStorage(msg, saveImages)),
          }));

          this._storage.set(StorageManager.KEYS.CONVERSATIONS, {
            activeId: this._activeId,
            conversations: serialized,
          });
          this._emitChange();
        }

        /** @private */
        _getSetting(path, fallback) {
          if (this._settingsManager && typeof this._settingsManager.get === 'function') {
            return this._settingsManager.get(path, fallback);
          }
          return fallback;
        }

        /** @private */
        _normalizeConversation(conv) {
          const now = Date.now();
          return {
            id: conv?.id || generateId('conv'),
            title: String(conv?.title || 'New Homework Chat').trim() || 'New Homework Chat',
            model: conv?.model || this._getSetting('model.activeModel', 'qwen/qwen3.8-27b'),
            createdAt: conv?.createdAt || now,
            updatedAt: conv?.updatedAt || now,
            messages: Array.isArray(conv?.messages)
              ? conv.messages.map((m) => this._normalizeMessage(m))
              : [],
          };
        }

        /** @private */
        _normalizeMessage(msg) {
          const now = Date.now();
          const images = Array.isArray(msg?.images)
            ? msg.images.filter(Boolean).map((img, idx) => ({
                id: img.id || generateId('img'),
                name: String(img.name || `image-${idx + 1}.png`),
                mimeType: img.mimeType || 'image/png',
                width: Number(img.width || 0),
                height: Number(img.height || 0),
                sizeBytes: Number(img.sizeBytes || 0),
                dataUrl: typeof img.dataUrl === 'string' && img.dataUrl ? img.dataUrl : null,
                placeholder: img.placeholder || '[Image attached in session]',
                strippedFromStorage: Boolean(img.strippedFromStorage || !img.dataUrl),
              }))
            : [];

          return {
            id: msg?.id || generateId('msg'),
            role: msg?.role === 'assistant' ? 'assistant' : msg?.role === 'system' ? 'system' : 'user',
            content: ErrorHandler.sanitizeString(String(msg?.content || '')),
            reasoning: msg?.reasoning ? ErrorHandler.sanitizeString(String(msg.reasoning)) : null,
            images,
            model: msg?.model || null,
            usage: msg?.usage ? deepClone(msg.usage) : null,
            status: msg?.status || 'complete',
            error: msg?.error ? ErrorHandler.sanitizeString(String(msg.error)) : null,
            timestamp: msg?.timestamp || now,
          };
        }

        /** @private */
        _prepareMessageForStorage(msg, saveImages) {
          const cloned = {
            id: msg.id,
            role: msg.role,
            content: ErrorHandler.sanitizeString(String(msg.content || '')),
            reasoning: msg.reasoning ? ErrorHandler.sanitizeString(String(msg.reasoning)) : null,
            model: msg.model || null,
            usage: msg.usage ? deepClone(msg.usage) : null,
            status: msg.status || 'complete',
            error: msg.error ? ErrorHandler.sanitizeString(String(msg.error)) : null,
            timestamp: msg.timestamp,
            images: (msg.images || []).map((img, idx) => {
              const base = {
                id: img.id,
                name: img.name || `image-${idx + 1}.png`,
                mimeType: img.mimeType || 'image/png',
                width: Number(img.width || 0),
                height: Number(img.height || 0),
                sizeBytes: Number(img.sizeBytes || 0),
                placeholder: img.placeholder || '[Image attached in session]',
              };
              if (saveImages && typeof img.dataUrl === 'string' && img.dataUrl) {
                base.dataUrl = img.dataUrl;
                base.strippedFromStorage = false;
              } else {
                base.dataUrl = null;
                base.strippedFromStorage = true;
              }
              return base;
            }),
          };
          return cloned;
        }

        /** @private */
        _findConv(id) {
          const targetId = id || this._activeId;
          return this._conversations.find((c) => c.id === targetId) || null;
        }

        /**
         * Creates a new conversation and switches to it (unless `activate: false`).
         * @param {Object} [options]
         * @returns {Object} Cloned conversation.
         */
        create(options = {}) {
          const lang = this._getSetting('general.language', 'vi');
          const defaultTitle = lang === 'en' ? 'New Homework Chat' : 'Bài tập mới';
          const conv = this._normalizeConversation({
            id: options.id || generateId('conv'),
            title: options.title || defaultTitle,
            model: options.model || this._getSetting('model.activeModel', 'qwen/qwen3.8-27b'),
            messages: [],
          });
          this._conversations.unshift(conv);
          if (options.activate !== false) {
            this._activeId = conv.id;
          }
          if (options.persist !== false) {
            this.save();
          } else {
            this._emitChange();
          }
          return deepClone(conv);
        }

        /**
         * Switches the active conversation by ID.
         * @param {string} id
         * @returns {Object}
         */
        switch(id) {
          const target = this._conversations.find((c) => c.id === id);
          if (!target) {
            throw new Error(`Conversation not found: ${id}`);
          }
          this._activeId = id;
          this.save();
          return deepClone(target);
        }

        /**
         * Alias for `switch`.
         * @param {string} id
         * @returns {Object}
         */
        setActive(id) {
          return this.switch(id);
        }

        /**
         * Renames a conversation.
         * @param {string} id
         * @param {string} title
         * @returns {Object}
         */
        rename(id, title) {
          const target = this._findConv(id);
          if (!target) throw new Error(`Conversation not found: ${id}`);
          const clean = ErrorHandler.sanitizeString(String(title || '').trim());
          if (clean) {
            target.title = clean.slice(0, 120);
            target.updatedAt = Date.now();
            this.save();
          }
          return deepClone(target);
        }

        /**
         * Deletes a conversation by ID; ensures an active conversation always remains.
         * @param {string} id
         * @returns {boolean}
         */
        delete(id) {
          const idx = this._conversations.findIndex((c) => c.id === id);
          if (idx === -1) return false;
          this._conversations.splice(idx, 1);
          if (this._conversations.length === 0) {
            this.create({ persist: false });
          } else if (this._activeId === id) {
            this._activeId = this._conversations[0].id;
          }
          this.save();
          return true;
        }

        /**
         * Clears all conversations and starts a fresh empty active conversation.
         * @returns {Object} Fresh active conversation.
         */
        clearAll() {
          this._conversations = [];
          this._activeId = null;
          this._storage.remove(StorageManager.KEYS.CONVERSATIONS);
          return this.create();
        }

        /**
         * Clears all messages inside the active (or specified) conversation without deleting the conversation entry.
         * @param {string} [id]
         * @returns {Object}
         */
        clearCurrent(id) {
          const target = this._findConv(id);
          if (!target) return this.create();
          target.messages = [];
          target.updatedAt = Date.now();
          this.save();
          return deepClone(target);
        }

        /**
         * Returns the currently active conversation (cloned).
         * @returns {Object}
         */
        getActive() {
          let conv = this._findConv(this._activeId);
          if (!conv) {
            return this.create();
          }
          return deepClone(conv);
        }

        /**
         * Returns a conversation by ID (cloned).
         * @param {string} id
         * @returns {Object|null}
         */
        getById(id) {
          const conv = this._conversations.find((c) => c.id === id);
          return conv ? deepClone(conv) : null;
        }

        /**
         * Returns all conversations (cloned).
         * @returns {Array<Object>}
         */
        getAll() {
          return deepClone(this._conversations);
        }

        /**
         * Returns lightweight metadata summaries for sidebar rendering.
         * @returns {Array<Object>}
         */
        getSummaryList() {
          return this._conversations.map((c) => {
            const last = c.messages[c.messages.length - 1];
            return {
              id: c.id,
              title: c.title,
              model: c.model,
              createdAt: c.createdAt,
              updatedAt: c.updatedAt,
              messageCount: c.messages.length,
              lastMessagePreview: last
                ? ContextManager.stripReasoning(last.content || '').slice(0, 80)
                : '',
              isActive: c.id === this._activeId,
            };
          });
        }

        /**
         * Appends a message to the active conversation (or specified `convId`).
         * Supports `addMessage(msg)` and `addMessage(convId, msg)`.
         * @param {string|Object} convIdOrMsg
         * @param {Object} [maybeMsg]
         * @returns {Object} Cloned added message.
         */
        addMessage(convIdOrMsg, maybeMsg) {
          const hasConvId = typeof convIdOrMsg === 'string';
          const conv = hasConvId ? this._findConv(convIdOrMsg) : this._findConv(this._activeId) || this._conversations[0];
          const rawMsg = hasConvId ? maybeMsg : convIdOrMsg;

          if (!conv) {
            this.create({ persist: false });
          }
          const targetConv = hasConvId ? this._findConv(convIdOrMsg) : this._findConv(this._activeId);
          if (!targetConv) throw new Error(`Conversation not found: ${convIdOrMsg}`);

          const msg = this._normalizeMessage(rawMsg);
          targetConv.messages.push(msg);
          targetConv.updatedAt = Date.now();
          if (msg.model) {
            targetConv.model = msg.model;
          }

          // Auto-title on first meaningful user prompt if still using default title
          if (
            msg.role === 'user' &&
            targetConv.messages.filter((m) => m.role === 'user').length === 1 &&
            (targetConv.title === 'Bài tập mới' || targetConv.title === 'New Homework Chat')
          ) {
            const snippet = msg.content.trim().replace(/\s+/g, ' ');
            if (snippet) {
              targetConv.title = snippet.length > 48 ? `${snippet.slice(0, 45)}...` : snippet;
            } else if (msg.images.length > 0) {
              const lang = this._getSetting('general.language', 'vi');
              targetConv.title = lang === 'en' ? 'Image Homework' : 'Bài tập hình ảnh';
            }
          }

          this.save();
          return deepClone(msg);
        }

        /**
         * Updates an existing message (e.g., during streaming or status completion).
         * Supports `updateMessage(msgId, patch)` and `updateMessage(convId, msgId, patch)`.
         * @param {string} arg1
         * @param {string|Object} arg2
         * @param {Object} [arg3]
         * @returns {Object|null}
         */
        updateMessage(arg1, arg2, arg3) {
          const hasConvId = typeof arg2 === 'string';
          const conv = hasConvId ? this._findConv(arg1) : this._findConv(this._activeId);
          const msgId = hasConvId ? arg2 : arg1;
          const patch = (hasConvId ? arg3 : arg2) || {};
          if (!conv) return null;

          const msg = conv.messages.find((m) => m.id === msgId);
          if (!msg) return null;

          if (patch.content !== undefined) {
            msg.content = ErrorHandler.sanitizeString(String(patch.content));
          }
          if (patch.reasoning !== undefined) {
            msg.reasoning = patch.reasoning ? ErrorHandler.sanitizeString(String(patch.reasoning)) : null;
          }
          if (patch.status !== undefined) msg.status = patch.status;
          if (patch.model !== undefined) msg.model = patch.model;
          if (patch.usage !== undefined) msg.usage = patch.usage ? deepClone(patch.usage) : null;
          if (patch.error !== undefined) {
            msg.error = patch.error ? ErrorHandler.sanitizeString(String(patch.error)) : null;
          }
          if (Array.isArray(patch.images)) {
            msg.images = this._normalizeMessage({ images: patch.images }).images;
          }

          conv.updatedAt = Date.now();
          // Skip writing to disk on every streaming token unless explicitly requested or final
          if (patch.persist !== false && patch.status !== 'streaming') {
            this.save();
          } else {
            this._emitChange();
          }
          return deepClone(msg);
        }

        /**
         * Deletes a message by ID.
         * Supports `deleteMessage(msgId)` and `deleteMessage(convId, msgId)`.
         * @param {string} arg1
         * @param {string} [arg2]
         * @returns {boolean}
         */
        deleteMessage(arg1, arg2) {
          const hasConvId = arg2 !== undefined;
          const conv = hasConvId ? this._findConv(arg1) : this._findConv(this._activeId);
          const msgId = hasConvId ? arg2 : arg1;
          if (!conv) return false;

          const idx = conv.messages.findIndex((m) => m.id === msgId);
          if (idx === -1) return false;
          conv.messages.splice(idx, 1);
          conv.updatedAt = Date.now();
          this.save();
          return true;
        }

        /**
         * Removes a single image attachment from a message by image ID or index.
         * Supports `(msgId, imgIdOrIndex)` and `(convId, msgId, imgIdOrIndex)`.
         * @param {string} arg1
         * @param {string|number} arg2
         * @param {string|number} [arg3]
         * @returns {boolean}
         */
        deleteImageFromMessage(arg1, arg2, arg3) {
          const hasConvId = arg3 !== undefined;
          const conv = hasConvId ? this._findConv(arg1) : this._findConv(this._activeId);
          const msgId = hasConvId ? arg2 : arg1;
          const imgTarget = hasConvId ? arg3 : arg2;
          if (!conv) return false;

          const msg = conv.messages.find((m) => m.id === msgId);
          if (!msg || !Array.isArray(msg.images)) return false;

          let removed = false;
          if (typeof imgTarget === 'number') {
            if (imgTarget >= 0 && imgTarget < msg.images.length) {
              msg.images.splice(imgTarget, 1);
              removed = true;
            }
          } else {
            const idx = msg.images.findIndex((img) => img.id === imgTarget);
            if (idx !== -1) {
              msg.images.splice(idx, 1);
              removed = true;
            }
          }

          if (removed) {
            conv.updatedAt = Date.now();
            this.save();
          }
          return removed;
        }

        /**
         * Prepares a conversation for retrying from a given user or assistant message:
         * - If targeting an assistant message, removes it and any later messages and returns the preceding user message.
         * - If targeting a user message, removes all messages strictly after it and returns that user message.
         * Supports `retryFromMessage(msgId)` and `retryFromMessage(convId, msgId)`.
         * @param {string} arg1
         * @param {string} [arg2]
         * @returns {{ conversation: Object, userMessage: Object|null }}
         */
        retryFromMessage(arg1, arg2) {
          const hasConvId = arg2 !== undefined;
          const conv = hasConvId ? this._findConv(arg1) : this._findConv(this._activeId);
          const msgId = hasConvId ? arg2 : arg1;
          if (!conv) throw new Error('Conversation not found.');

          const idx = conv.messages.findIndex((m) => m.id === msgId);
          if (idx === -1) throw new Error(`Message not found: ${msgId}`);

          const target = conv.messages[idx];
          let cutIndex = idx;

          if (target.role === 'user') {
            cutIndex = idx + 1;
          } else {
            cutIndex = idx;
          }

          conv.messages = conv.messages.slice(0, cutIndex);
          conv.updatedAt = Date.now();
          this.save();

          let userMessage = null;
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            if (conv.messages[i].role === 'user') {
              userMessage = deepClone(conv.messages[i]);
              break;
            }
          }

          return {
            conversation: deepClone(conv),
            userMessage,
          };
        }

        /**
         * Exports a conversation (or active conversation) as sanitized JSON string.
         * Strips raw base64 unless `includeImages: true` and always strips API secrets.
         * @param {string} [id]
         * @param {Object} [options]
         * @param {boolean} [options.includeImages=false]
         * @returns {string}
         */
        exportJSON(id, options = {}) {
          const conv = this._findConv(id);
          if (!conv) throw new Error('Conversation not found.');
          const includeImages = Boolean(options.includeImages);
          const sanitized = {
            id: conv.id,
            title: ErrorHandler.sanitizeString(conv.title),
            model: conv.model,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            exportedAt: new Date().toISOString(),
            messages: conv.messages.map((m) => this._prepareMessageForStorage(m, includeImages)),
          };
          return JSON.stringify(StorageManager.redactSecrets(sanitized), null, 2);
        }

        /**
         * Exports a conversation (or active conversation) as clean Markdown.
         * @param {string} [id]
         * @returns {string}
         */
        exportMarkdown(id) {
          const conv = this._findConv(id);
          if (!conv) throw new Error('Conversation not found.');

          const lines = [
            `# ${ErrorHandler.sanitizeString(conv.title)}`,
            '',
            `- **Model**: ${conv.model || 'N/A'}`,
            `- **Created**: ${new Date(conv.createdAt).toISOString()}`,
            `- **Updated**: ${new Date(conv.updatedAt).toISOString()}`,
            '',
            '---',
            '',
          ];

          for (const msg of conv.messages) {
            const ts = new Date(msg.timestamp).toISOString();
            const roleLabel = msg.role === 'assistant' ? 'Assistant' : 'User';
            lines.push(`## ${roleLabel} (${ts})`);
            lines.push('');

            if (Array.isArray(msg.images) && msg.images.length > 0) {
              for (const img of msg.images) {
                const dims = img.width && img.height ? ` (${img.width}x${img.height})` : '';
                lines.push(`> [Image: ${img.name || 'capture'}${dims}]`);
              }
              lines.push('');
            }

            if (msg.content) {
              lines.push(ErrorHandler.sanitizeString(msg.content));
              lines.push('');
            }

            if (msg.reasoning) {
              lines.push('<details>');
              lines.push('<summary>Reasoning</summary>');
              lines.push('');
              lines.push(ErrorHandler.sanitizeString(msg.reasoning));
              lines.push('');
              lines.push('</details>');
              lines.push('');
            }
          }

          return ErrorHandler.sanitizeString(lines.join('\n'));
        }

        /**
         * Subscribes to conversation updates.
         * @param {Function} callback
         * @returns {Function}
         */
        onChange(callback) {
          if (typeof callback !== 'function') return () => {};
          this._listeners.add(callback);
          return () => {
            this._listeners.delete(callback);
          };
        }

        /** @private */
        _emitChange() {
          const summary = this.getSummaryList();
          for (const cb of this._listeners) {
            try {
              cb(summary);
            } catch (_) {}
          }
        }
      }

      // ===========================================================================
      // Attach to SHC Namespace & Export for Node.js
      // ===========================================================================

      SHC.ErrorHandler = ErrorHandler;
      SHC.StorageManager = StorageManager;
      SHC.SettingsManager = SettingsManager;
      SHC.APIKeyManager = APIKeyManager;
      SHC.GroqAPIClient = GroqAPIClient;
      SHC.FailoverEngine = FailoverEngine;
      SHC.ContextManager = ContextManager;
      SHC.ConversationManager = ConversationManager;

      // Helpful constants / version tag
      SHC.GROQ_ENDPOINTS = Object.freeze({
        CHAT: GROQ_CHAT_ENDPOINT,
        MODELS: GROQ_MODELS_ENDPOINT,
      });

      if (typeof module !== 'undefined' && module.exports) {
        module.exports = SHC;
      }
    })(
      typeof globalThis !== 'undefined'
        ? globalThis
        : typeof window !== 'undefined'
          ? window
          : this,
      typeof SHC !== 'undefined' ? SHC : undefined
    );
  }).call(globalScope, globalScope, undefined, undefined);

  // =========================================================================
  // Module: src/capture-render.js
  // =========================================================================
  (function (globalScope, module, exports) {
    /**
     * Smart Homework Capture (Groq Edition) — Capture, Image, Hotkey & Rendering Modules
     *
     * Implements 4 modular ES6 classes attached to the `SHC` namespace:
     *  1. HotkeyManager    - Global single-listener keyboard shortcut manager with input/editor suppression
     *  2. ImageProcessor   - Async image validation, crisp downscaling/compression, Object URL & Base64 helpers
     *  3. CaptureManager   - Explicit DOM Capture (html2canvas-pro + taint/iframe warnings) & Screen Capture (getDisplayMedia + cropper)
     *  4. MarkdownRenderer - Math-protected Markdown + KaTeX rendering with pure-JS fallbacks & mandatory HTML sanitization
     *
     * Compatible with Tampermonkey/Userscript IIFE bundles, browser globals, and Node.js CommonJS/vm tests.
     */
    (function (root, existingSHC) {
      'use strict';

      const SHC = existingSHC || (root.SHC = root.SHC || {});

      // ---------------------------------------------------------------------------
      // Shared Utilities
      // ---------------------------------------------------------------------------

      const ALLOWED_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
      const GROQ_MAX_IMAGE_MB = 20;
      const GROQ_MAX_IMAGE_BYTES = GROQ_MAX_IMAGE_MB * 1024 * 1024;
      const DEFAULT_MAX_DIMENSION = 2400;
      const HARD_MAX_DIMENSION = 16384;

      function resolveGlobal(name, preferred) {
        if (preferred !== undefined && preferred !== null) return preferred;
        if (root && root[name] !== undefined) return root[name];
        if (typeof globalThis !== 'undefined' && globalThis[name] !== undefined) return globalThis[name];
        if (typeof self !== 'undefined' && self[name] !== undefined) return self[name];
        if (typeof window !== 'undefined' && window[name] !== undefined) return window[name];
        try {
          // eslint-disable-next-line no-eval
          if (name === 'document' && typeof document !== 'undefined') return document;
          if (name === 'window' && typeof window !== 'undefined') return window;
          if (name === 'navigator' && typeof navigator !== 'undefined') return navigator;
          if (name === 'html2canvas' && typeof html2canvas !== 'undefined') return html2canvas;
          if (name === 'marked' && typeof marked !== 'undefined') return marked;
          if (name === 'DOMPurify' && typeof DOMPurify !== 'undefined') return DOMPurify;
          if (name === 'katex' && typeof katex !== 'undefined') return katex;
        } catch (_) {}
        return undefined;
      }

      function nextTick() {
        return new Promise((resolve) => setTimeout(resolve, 0));
      }

      function makeModuleError(code, reason, message, extra = {}) {
        const err = new Error(message);
        err.code = code;
        if (reason) err.reason = reason;
        Object.assign(err, extra);
        return err;
      }

      function normalizeMimeType(rawMime) {
        if (!rawMime || typeof rawMime !== 'string') return '';
        const lower = rawMime.split(';')[0].trim().toLowerCase();
        if (lower === 'image/jpg') return 'image/jpeg';
        return lower;
      }

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function escapeAttr(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      function decodeHtmlEntities(str) {
        return String(str ?? '').replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, entity) => {
          const lower = entity.toLowerCase();
          if (lower === 'amp') return '&';
          if (lower === 'lt') return '<';
          if (lower === 'gt') return '>';
          if (lower === 'quot') return '"';
          if (lower === 'apos' || lower === '#39') return "'";
          if (lower === 'colon') return ':';
          if (lower === 'tab') return '\t';
          if (lower === 'newline') return '\n';
          if (lower === 'nbsp') return ' ';
          if (lower.startsWith('#x')) {
            const cp = parseInt(lower.slice(2), 16);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          }
          if (lower.startsWith('#')) {
            const cp = parseInt(lower.slice(1), 10);
            return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          }
          return full;
        });
      }

      function uint8ToBase64(bytes) {
        const btoaFn = resolveGlobal('btoa');
        if (typeof btoaFn === 'function') {
          const chunkSize = 0x8000;
          const parts = [];
          for (let i = 0; i < bytes.length; i += chunkSize) {
            const slice = bytes.subarray(i, i + chunkSize);
            parts.push(String.fromCharCode.apply(null, slice));
          }
          return btoaFn(parts.join(''));
        }
        if (typeof Buffer !== 'undefined') {
          return Buffer.from(bytes).toString('base64');
        }
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let out = '';
        for (let i = 0; i < bytes.length; i += 3) {
          const a = bytes[i];
          const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
          const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
          const triple = (a << 16) | (b << 8) | c;
          out += chars[(triple >> 18) & 63];
          out += chars[(triple >> 12) & 63];
          out += i + 1 < bytes.length ? chars[(triple >> 6) & 63] : '=';
          out += i + 2 < bytes.length ? chars[triple & 63] : '=';
        }
        return out;
      }

      function base64ToUint8(b64) {
        const cleaned = String(b64 || '').replace(/\s+/g, '');
        const atobFn = resolveGlobal('atob');
        if (typeof atobFn === 'function') {
          const bin = atobFn(cleaned);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i);
          }
          return out;
        }
        if (typeof Buffer !== 'undefined') {
          return new Uint8Array(Buffer.from(cleaned, 'base64'));
        }
        const lookup = new Int16Array(256).fill(-1);
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
        const len = cleaned.length;
        const pad = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
        const out = new Uint8Array(((len * 3) >> 2) - pad);
        let p = 0;
        for (let i = 0; i < len; i += 4) {
          const n =
            (lookup[cleaned.charCodeAt(i)] << 18) |
            (lookup[cleaned.charCodeAt(i + 1)] << 12) |
            ((lookup[cleaned.charCodeAt(i + 2)] & 63) << 6) |
            (lookup[cleaned.charCodeAt(i + 3)] & 63);
          out[p++] = (n >> 16) & 255;
          if (p < out.length) out[p++] = (n >> 8) & 255;
          if (p < out.length) out[p++] = n & 255;
        }
        return out;
      }

      function detectImageHeader(bytes) {
        if (!bytes || bytes.length < 12) return null;
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (
          bytes[0] === 0x89 &&
          bytes[1] === 0x50 &&
          bytes[2] === 0x4e &&
          bytes[3] === 0x47 &&
          bytes[4] === 0x0d &&
          bytes[5] === 0x0a &&
          bytes[6] === 0x1a &&
          bytes[7] === 0x0a &&
          bytes.length >= 24
        ) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const width = view.getUint32(16, false);
          const height = view.getUint32(20, false);
          return { mimeType: 'image/png', width, height };
        }
        // JPEG: FF D8 FF
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
          let offset = 2;
          while (offset + 4 < bytes.length) {
            if (bytes[offset] !== 0xff) {
              offset++;
              continue;
            }
            const marker = bytes[offset + 1];
            if (marker === 0xd8 || marker === 0xd9 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
              offset += 2;
              continue;
            }
            const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
            const isSOF =
              (marker >= 0xc0 && marker <= 0xc3) ||
              (marker >= 0xc5 && marker <= 0xc7) ||
              (marker >= 0xc9 && marker <= 0xcb) ||
              (marker >= 0xcd && marker <= 0xcf);
            if (isSOF && offset + 9 <= bytes.length) {
              const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
              const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
              return { mimeType: 'image/jpeg', width, height };
            }
            if (segLen < 2) break;
            offset += 2 + segLen;
          }
          return { mimeType: 'image/jpeg', width: 0, height: 0 };
        }
        // WebP: RIFF....WEBP
        if (
          bytes[0] === 0x52 &&
          bytes[1] === 0x49 &&
          bytes[2] === 0x46 &&
          bytes[3] === 0x46 &&
          bytes[8] === 0x57 &&
          bytes[9] === 0x45 &&
          bytes[10] === 0x42 &&
          bytes[11] === 0x50
        ) {
          let width = 0;
          let height = 0;
          if (bytes.length >= 30 && bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38) {
            if (bytes[15] === 0x20) {
              // VP8
              width = ((bytes[26] | (bytes[27] << 8)) & 0x3fff);
              height = ((bytes[28] | (bytes[29] << 8)) & 0x3fff);
            } else if (bytes[15] === 0x4c && bytes.length >= 25) {
              // VP8L
              const b0 = bytes[21];
              const b1 = bytes[22];
              const b2 = bytes[23];
              const b3 = bytes[24];
              width = 1 + (b0 | ((b1 & 0x3f) << 8));
              height = 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
            } else if (bytes[15] === 0x58 && bytes.length >= 30) {
              // VP8X
              width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
              height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
            }
          }
          return { mimeType: 'image/webp', width, height };
        }
        return null;
      }

      function isMockCanvasDataUrl(dataUrl) {
        if (typeof dataUrl !== 'string') return false;
        const comma = dataUrl.indexOf(',');
        if (comma === -1) return false;
        try {
          const bytes = base64ToUint8(dataUrl.slice(comma + 1, comma + 64));
          let ascii = '';
          for (let i = 0; i < Math.min(bytes.length, 16); i++) {
            ascii += String.fromCharCode(bytes[i]);
          }
          return ascii.startsWith('MOCK_IMAGE_');
        } catch (_) {
          return false;
        }
      }

      // ===========================================================================
      // 1. HotkeyManager
      // ===========================================================================

      const ACTIVE_HOTKEY_BY_TARGET = new WeakMap();

      const EDITOR_CLASS_NAMES = [
        'CodeMirror',
        'CodeMirror-code',
        'cm-editor',
        'cm-content',
        'ace_editor',
        'ace_text-input',
        'monaco-editor',
        'inputarea',
        'ProseMirror',
        'ql-editor',
        'ql-container',
        'mce-content-body',
        'tox-edit-area',
        'ck-editor__editable',
      ];

      const SPECIAL_KEY_ALIASES = Object.freeze({
        ' ': 'space',
        spacebar: 'space',
        space: 'space',
        esc: 'escape',
        escape: 'escape',
        del: 'delete',
        delete: 'delete',
        ins: 'insert',
        insert: 'insert',
        return: 'enter',
        enter: 'enter',
      });

      /**
       * Manages a single global keyboard shortcut listener with full suppression inside
       * form controls, contentEditable regions, Shadow DOM inputs, and rich/code editors.
       */
      class HotkeyManager {
        /**
         * @param {Object|Function} [optionsOrCallback]
         * @param {Object} [maybeOptions]
         */
        constructor(optionsOrCallback = {}, maybeOptions = {}) {
          const opts =
            typeof optionsOrCallback === 'function'
              ? { ...(maybeOptions || {}), onTrigger: optionsOrCallback }
              : { ...(optionsOrCallback || {}) };

          this._doc = opts.document || resolveGlobal('document') || null;
          this._win = opts.window || resolveGlobal('window') || null;
          this._target = opts.target || this._doc || this._win || null;
          this._onTrigger = typeof opts.onTrigger === 'function' ? opts.onTrigger : null;
          this._enabled = opts.enabled !== undefined ? Boolean(opts.enabled) : true;
          this._ignoreRepeat = opts.ignoreRepeat !== undefined ? Boolean(opts.ignoreRepeat) : true;
          this._singleton = opts.singleton !== undefined ? Boolean(opts.singleton) : true;
          this._useCapture = true;
          this._attached = false;
          this._destroyed = false;

          this._hotkey = HotkeyManager.normalizeHotkey(opts.hotkey);
          this._boundOnKeyDown = this._handleKeyDown.bind(this);

          if (opts.autoAttach !== false && this._target) {
            this.init();
          }
        }

        /**
         * Normalizes a hotkey configuration object.
         * @param {Object} [config]
         * @returns {{key:string, code:string, ctrl:boolean, alt:boolean, shift:boolean, meta:boolean}}
         */
        static normalizeHotkey(config) {
          const src = config && typeof config === 'object' ? config : {};
          const key = src.key ? String(src.key) : 'Insert';
          const code =
            src.code !== undefined && src.code !== null
              ? String(src.code)
              : key.toLowerCase() === 'insert'
                ? 'Insert'
                : '';
          return {
            key,
            code,
            ctrl: Boolean(src.ctrl),
            alt: Boolean(src.alt),
            shift: Boolean(src.shift),
            meta: Boolean(src.meta),
          };
        }

        /**
         * Converts a KeyboardEvent into a normalized hotkey descriptor (returns null for bare modifiers).
         * @param {KeyboardEvent} event
         * @returns {Object|null}
         */
        static eventToHotkey(event) {
          if (!event || !event.key) return null;
          const bareModifiers = ['Control', 'Shift', 'Alt', 'Meta', 'OS'];
          if (bareModifiers.includes(event.key)) return null;
          return HotkeyManager.normalizeHotkey({
            key: event.key,
            code: event.code || '',
            ctrl: Boolean(event.ctrlKey),
            alt: Boolean(event.altKey),
            shift: Boolean(event.shiftKey),
            meta: Boolean(event.metaKey),
          });
        }

        /**
         * Formats a hotkey config for UI display.
         * @param {Object} [config]
         * @returns {string}
         */
        static formatHotkey(config) {
          const hk = HotkeyManager.normalizeHotkey(config);
          const parts = [];
          if (hk.ctrl) parts.push('Ctrl');
          if (hk.alt) parts.push('Alt');
          if (hk.shift) parts.push('Shift');
          if (hk.meta) parts.push('Meta');
          const keyLabel = hk.key === ' ' ? 'Space' : hk.key.length === 1 ? hk.key.toUpperCase() : hk.key;
          parts.push(keyLabel);
          return parts.join(' + ');
        }

        /**
         * Attaches the global `keydown` listener once (idempotent).
         * @param {Function} [onTrigger]
         * @returns {HotkeyManager}
         */
        init(onTrigger) {
          if (typeof onTrigger === 'function') {
            this._onTrigger = onTrigger;
          }
          this._destroyed = false;
          if (this._attached || !this._target || typeof this._target.addEventListener !== 'function') {
            return this;
          }

          if (this._singleton && typeof this._target === 'object') {
            const previous = ACTIVE_HOTKEY_BY_TARGET.get(this._target);
            if (previous && previous !== this) {
              previous.destroy();
            }
            ACTIVE_HOTKEY_BY_TARGET.set(this._target, this);
          }

          this._target.addEventListener('keydown', this._boundOnKeyDown, this._useCapture);
          this._attached = true;
          return this;
        }

        /**
         * Alias for `init()`.
         * @param {Function} [onTrigger]
         * @returns {HotkeyManager}
         */
        attach(onTrigger) {
          return this.init(onTrigger);
        }

        /**
         * Removes the global listener and cleans up references.
         */
        destroy() {
          if (this._attached && this._target && typeof this._target.removeEventListener === 'function') {
            this._target.removeEventListener('keydown', this._boundOnKeyDown, this._useCapture);
          }
          if (this._singleton && this._target && typeof this._target === 'object') {
            if (ACTIVE_HOTKEY_BY_TARGET.get(this._target) === this) {
              ACTIVE_HOTKEY_BY_TARGET.delete(this._target);
            }
          }
          this._attached = false;
          this._destroyed = true;
        }

        /**
         * Updates the active hotkey binding.
         * @param {Object} nextHotkey
         * @returns {Object}
         */
        updateHotkey(nextHotkey) {
          this._hotkey = HotkeyManager.normalizeHotkey(nextHotkey);
          return this.getHotkey();
        }

        /**
         * Returns a shallow copy of the current hotkey config.
         * @returns {{key:string, code:string, ctrl:boolean, alt:boolean, shift:boolean, meta:boolean}}
         */
        getHotkey() {
          return { ...this._hotkey };
        }

        /**
         * Enables or disables hotkey handling without duplicating listeners.
         * @param {boolean} enabled
         */
        setEnabled(enabled) {
          this._enabled = Boolean(enabled);
        }

        /**
         * @returns {boolean}
         */
        isEnabled() {
          return this._enabled;
        }

        /**
         * @returns {boolean}
         */
        isAttached() {
          return this._attached;
        }

        /**
         * Checks whether a KeyboardEvent matches the configured hotkey.
         * @param {KeyboardEvent} event
         * @returns {boolean}
         */
        matchesEvent(event) {
          if (!event || event.isComposing || event.keyCode === 229) return false;
          if (this._ignoreRepeat && event.repeat) return false;

          const hk = this._hotkey;
          if (
            Boolean(event.ctrlKey) !== hk.ctrl ||
            Boolean(event.altKey) !== hk.alt ||
            Boolean(event.shiftKey) !== hk.shift ||
            Boolean(event.metaKey) !== hk.meta
          ) {
            return false;
          }

          const norm = (val) => {
            if (val === null || val === undefined) return '';
            const lower = String(val).toLowerCase();
            return SPECIAL_KEY_ALIASES[lower] || lower;
          };

          const targetKey = norm(hk.key);
          const eventKey = norm(event.key);
          const targetCode = hk.code ? String(hk.code).toLowerCase() : '';
          const eventCode = event.code ? String(event.code).toLowerCase() : '';

          if (targetCode && eventCode) {
            if (eventCode === targetCode) return true;
            // Support Numpad0 Insert or alternate physical keys when named special key matches
            if (targetKey === 'insert' && eventKey === 'insert') return true;
            return false;
          }

          if (eventKey && targetKey && eventKey === targetKey) {
            return true;
          }
          if (!eventKey && eventCode && targetKey && norm(eventCode) === targetKey) {
            return true;
          }
          return false;
        }

        /**
         * Checks if the event target, composed path, or deep Shadow DOM activeElement
         * is inside an input, textarea, select, contenteditable, or rich/code editor.
         * @param {Event|Element} targetOrEvent
         * @returns {boolean}
         */
        isEditableTarget(targetOrEvent) {
          if (!targetOrEvent) return false;
          const candidates = [];
          const seen = new Set();

          const pushCandidate = (node) => {
            if (node && typeof node === 'object' && !seen.has(node)) {
              seen.add(node);
              candidates.push(node);
            }
          };

          if (targetOrEvent.type && ('target' in targetOrEvent || 'composedPath' in targetOrEvent)) {
            pushCandidate(targetOrEvent.target);
            if (typeof targetOrEvent.composedPath === 'function') {
              try {
                const path = targetOrEvent.composedPath();
                if (Array.isArray(path)) {
                  for (const n of path) pushCandidate(n);
                }
              } catch (_) {}
            }
            // Deep Shadow DOM activeElement traversal
            let active = this._doc && this._doc.activeElement ? this._doc.activeElement : null;
            const activeSeen = new Set();
            while (active && !activeSeen.has(active)) {
              activeSeen.add(active);
              pushCandidate(active);
              if (active.shadowRoot && active.shadowRoot.activeElement) {
                active = active.shadowRoot.activeElement;
              } else {
                break;
              }
            }
          } else {
            pushCandidate(targetOrEvent);
          }

          for (const candidate of candidates) {
            if (this._isNodeOrAncestorEditable(candidate)) {
              return true;
            }
          }
          return false;
        }

        /** @private */
        _isNodeOrAncestorEditable(node) {
          let cur = node;
          const visited = new Set();
          while (cur && typeof cur === 'object' && !visited.has(cur)) {
            visited.add(cur);
            if (this._isSingleElementEditable(cur)) {
              return true;
            }
            if (cur.parentElement) {
              cur = cur.parentElement;
            } else if (cur.parentNode) {
              cur = cur.parentNode;
            } else if (cur.host) {
              // Cross ShadowRoot boundary up to host element
              cur = cur.host;
            } else if (typeof cur.getRootNode === 'function') {
              try {
                const rootNode = cur.getRootNode();
                cur = rootNode && rootNode.host ? rootNode.host : null;
              } catch (_) {
                cur = null;
              }
            } else {
              cur = null;
            }
          }
          return false;
        }

        /** @private */
        _isSingleElementEditable(el) {
          if (!el || typeof el !== 'object') return false;
          const tag = String(el.tagName || el.nodeName || '').toLowerCase();
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') {
            return !el.disabled;
          }

          if (el.isContentEditable === true) return true;

          if (typeof el.getAttribute === 'function') {
            const ceAttr = el.getAttribute('contenteditable');
            if (ceAttr !== null && ceAttr !== undefined) {
              const val = String(ceAttr).trim().toLowerCase();
              if (val !== 'false' && val !== 'inherit') return true;
            }
            const role = String(el.getAttribute('role') || '').trim().toLowerCase();
            if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
              return true;
            }
            if (el.getAttribute('data-slate-editor') === 'true' || el.hasAttribute?.('data-mce-bogus')) {
              return true;
            }
          } else if (el.contentEditable !== undefined && el.contentEditable !== null) {
            const val = String(el.contentEditable).trim().toLowerCase();
            if (val === '' || val === 'true' || val === 'plaintext-only') return true;
          }

          // Known code/rich-text editor class checks (supports both classList and plain className)
          const clsStr = typeof el.className === 'string' ? el.className : '';
          const clsTokens = clsStr ? clsStr.split(/\s+/) : [];
          for (const editorCls of EDITOR_CLASS_NAMES) {
            if (el.classList && typeof el.classList.contains === 'function') {
              if (el.classList.contains(editorCls)) return true;
            }
            if (clsTokens.includes(editorCls)) return true;
          }

          return false;
        }

        /** @private */
        _handleKeyDown(event) {
          if (!this._enabled || this._destroyed) return;
          if (!this.matchesEvent(event)) return;
          if (this.isEditableTarget(event)) return;

          if (typeof event.preventDefault === 'function') {
            event.preventDefault();
          }
          if (typeof event.stopPropagation === 'function') {
            event.stopPropagation();
          }
          if (typeof this._onTrigger === 'function') {
            this._onTrigger(event);
          }
        }
      }

      HotkeyManager.DEFAULT_HOTKEY = Object.freeze({
        key: 'Insert',
        code: 'Insert',
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
      });

      // ===========================================================================
      // 2. ImageProcessor
      // ===========================================================================

      /**
       * Validates, optimizes, and converts homework images (File/Blob/DataURL/Canvas)
       * while preserving text/formula crispness and enforcing Groq size ceilings.
       */
      class ImageProcessor {
        /**
         * @param {Object} [options]
         */
        constructor(options = {}) {
          this._settings = options.settingsManager || null;
          this._doc = options.document || resolveGlobal('document') || null;
          this._win = options.window || resolveGlobal('window') || null;
          this._maxImageSizeMB = Number(options.maxImageSizeMB) > 0 ? Number(options.maxImageSizeMB) : 4;
          this._maxDimension = Number(options.maxDimension) > 0 ? Number(options.maxDimension) : DEFAULT_MAX_DIMENSION;
          this._minDimension = Number(options.minDimension) > 0 ? Number(options.minDimension) : 600;
          this._quality = Number(options.quality) > 0 && Number(options.quality) <= 1 ? Number(options.quality) : 0.92;
          this._minQuality = Number(options.minQuality) > 0 && Number(options.minQuality) <= 1 ? Number(options.minQuality) : 0.68;
          this._allowedMimes = Array.isArray(options.allowedMimeTypes) && options.allowedMimeTypes.length > 0
            ? options.allowedMimeTypes.map(normalizeMimeType)
            : [...ALLOWED_IMAGE_MIMES];
          this._objectUrls = new Set();
          this._seq = 0;
        }

        /**
         * Formats byte size into human-readable units.
         * @param {number} bytes
         * @returns {string}
         */
        static formatBytes(bytes) {
          const n = Number(bytes || 0);
          if (!Number.isFinite(n) || n <= 0) return '0 B';
          if (n < 1024) return `${Math.round(n)} B`;
          if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
          return `${(n / (1024 * 1024)).toFixed(2)} MB`;
        }

        /** @returns {string} */
        formatBytes(bytes) {
          return ImageProcessor.formatBytes(bytes);
        }

        /**
         * Checks whether a MIME type is allowed (`image/png`, `image/jpeg`, `image/webp`).
         * @param {string} mimeType
         * @returns {boolean}
         */
        isValidMimeType(mimeType) {
          const norm = normalizeMimeType(mimeType);
          return this._allowedMimes.includes(norm);
        }

        /**
         * Validates pixel dimensions.
         * @param {number} width
         * @param {number} height
         * @returns {boolean}
         */
        validateDimensions(width, height) {
          const w = Number(width);
          const h = Number(height);
          if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
          if (w <= 0 || h <= 0) return false;
          if (w > HARD_MAX_DIMENSION || h > HARD_MAX_DIMENSION) return false;
          return true;
        }

        /**
         * Extracts MIME type and raw base64 payload from a Data URL.
         * @param {string} dataUrl
         * @returns {{mimeType:string, base64:string, dataUrl:string}}
         */
        extractBase64(dataUrl) {
          if (typeof dataUrl !== 'string' || !dataUrl.trim()) {
            throw makeModuleError('IMAGE_ERROR', 'INVALID_FORMAT', 'Image data URL is empty.');
          }
          const trimmed = dataUrl.trim();
          const match = trimmed.match(/^data:([^;,]+)((?:;[^;,]+)*?)(;base64)?,([\s\S]*)$/i);
          if (!match) {
            throw makeModuleError('IMAGE_ERROR', 'INVALID_FORMAT', 'Invalid image Data URL format.');
          }
          const mimeType = normalizeMimeType(match[1]);
          if (!this.isValidMimeType(mimeType)) {
            throw makeModuleError(
              'IMAGE_ERROR',
              'UNSUPPORTED_MIME',
              `Unsupported image type "${mimeType || 'unknown'}". Allowed: PNG, JPEG, WEBP.`
            );
          }
          const isBase64 = Boolean(match[3]);
          const payload = match[4] || '';
          if (!isBase64) {
            throw makeModuleError('IMAGE_ERROR', 'INVALID_FORMAT', 'Image Data URL must be base64 encoded.');
          }
          if (!payload || payload.replace(/\s+/g, '').length === 0) {
            throw makeModuleError('IMAGE_ERROR', 'EMPTY_IMAGE', 'Image base64 payload is empty.');
          }
          return {
            mimeType,
            base64: payload.replace(/\s+/g, ''),
            dataUrl: `data:${mimeType};base64,${payload.replace(/\s+/g, '')}`,
          };
        }

        /**
         * Creates and tracks an Object URL for cleanup via `revokeAll()`.
         * @param {Blob} blob
         * @returns {string|null}
         */
        createObjectUrl(blob) {
          const URLObj = resolveGlobal('URL', this._win?.URL);
          if (!blob || !URLObj || typeof URLObj.createObjectURL !== 'function') return null;
          try {
            const url = URLObj.createObjectURL(blob);
            if (url) this._objectUrls.add(url);
            return url;
          } catch (_) {
            return null;
          }
        }

        /**
         * Revokes a tracked Object URL.
         * @param {string} url
         */
        revokeObjectUrl(url) {
          if (!url) return;
          const URLObj = resolveGlobal('URL', this._win?.URL);
          if (URLObj && typeof URLObj.revokeObjectURL === 'function') {
            try {
              URLObj.revokeObjectURL(url);
            } catch (_) {}
          }
          this._objectUrls.delete(url);
        }

        /**
         * Revokes all tracked Object URLs.
         */
        revokeAll() {
          const URLObj = resolveGlobal('URL', this._win?.URL);
          for (const url of this._objectUrls) {
            if (URLObj && typeof URLObj.revokeObjectURL === 'function') {
              try {
                URLObj.revokeObjectURL(url);
              } catch (_) {}
            }
          }
          this._objectUrls.clear();
        }

        /** @private */
        _getLimits(options = {}) {
          const settingsMB = this._settings?.get?.('capture.maxImageSizeMB');
          const settingsQuality = this._settings?.get?.('capture.imageQuality');
          const rawMB = Number(options.maxImageSizeMB ?? settingsMB ?? this._maxImageSizeMB);
          const effectiveMB = Math.min(Number.isFinite(rawMB) && rawMB > 0 ? rawMB : 4, GROQ_MAX_IMAGE_MB);
          const maxBytes = Math.floor(effectiveMB * 1024 * 1024);
          const maxDim = Number(options.maxDimension ?? this._maxDimension) || DEFAULT_MAX_DIMENSION;
          const qualityRaw = Number(options.quality ?? settingsQuality ?? this._quality);
          const quality = Number.isFinite(qualityRaw) && qualityRaw > 0 && qualityRaw <= 1 ? qualityRaw : 0.92;
          return { effectiveMB, maxBytes, maxDim, quality };
        }

        /** @private */
        async _blobToUint8Array(blob) {
          if (blob && typeof blob.arrayBuffer === 'function') {
            const buf = await blob.arrayBuffer();
            return new Uint8Array(buf);
          }
          const Reader = resolveGlobal('FileReader', this._win?.FileReader);
          if (typeof Reader === 'function') {
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new Reader();
              reader.onload = (ev) => resolve(ev?.target?.result || reader.result);
              reader.onerror = (err) => reject(err || new Error('FileReader failed'));
              reader.readAsDataURL(blob);
            });
            const parsed = this.extractBase64(dataUrl);
            return base64ToUint8(parsed.base64);
          }
          throw makeModuleError('IMAGE_ERROR', 'READ_FAILED', 'Unable to read image Blob bytes.');
        }

        /** @private */
        async _decodeDimensionsWithImage(src) {
          const ImageCtor = resolveGlobal('Image', this._win?.Image);
          if (typeof ImageCtor !== 'function') return null;

          return new Promise((resolve, reject) => {
            const img = new ImageCtor();
            let settled = false;
            const done = (fn, val) => {
              if (settled) return;
              settled = true;
              fn(val);
            };
            img.onload = () => {
              const w = Number(img.naturalWidth || img.width || 0);
              const h = Number(img.naturalHeight || img.height || 0);
              done(resolve, { img, width: w, height: h });
            };
            img.onerror = () => {
              done(reject, makeModuleError('IMAGE_ERROR', 'DECODE_FAILED', 'Corrupted or unreadable image file.'));
            };
            img.src = src;
          });
        }

        /** @private */
        _createCanvas(width, height) {
          if (!this._doc || typeof this._doc.createElement !== 'function') return null;
          const canvas = this._doc.createElement('canvas');
          if (!canvas) return null;
          canvas.width = Math.max(1, Math.round(width));
          canvas.height = Math.max(1, Math.round(height));
          return canvas;
        }

        /** @private */
        _encodeCanvas(canvas, mimeType, quality) {
          if (!canvas || typeof canvas.toDataURL !== 'function') return null;
          const targetMime = this.isValidMimeType(mimeType) ? mimeType : 'image/png';
          let url = canvas.toDataURL(targetMime, quality);
          if (typeof url !== 'string' || !url.startsWith(`data:${targetMime}`)) {
            // Fallback if browser doesn't support WebP toDataURL encoding
            url = canvas.toDataURL('image/jpeg', quality);
            return { dataUrl: url, mimeType: 'image/jpeg' };
          }
          return { dataUrl: url, mimeType: targetMime };
        }

        /** @private */
        async _optimizeViaCanvas({ imgOrCanvas, width, height, sourceMime, maxBytes, maxDim, quality, hasRealHeader }) {
          const scaleNeeded = Math.max(width, height) > maxDim ? maxDim / Math.max(width, height) : 1;
          let curScale = scaleNeeded;
          let curW = Math.max(1, Math.round(width * curScale));
          let curH = Math.max(1, Math.round(height * curScale));

          const testCanvas = this._createCanvas(curW, curH);
          const ctx = testCanvas && typeof testCanvas.getContext === 'function' ? testCanvas.getContext('2d') : null;
          if (!testCanvas || !ctx) return null;

          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(imgOrCanvas, 0, 0, curW, curH);

          // Candidate formats prioritizing crispness for text/math
          const tryFormats = sourceMime === 'image/png'
            ? ['image/png', 'image/webp', 'image/jpeg']
            : sourceMime === 'image/webp'
              ? ['image/webp', 'image/jpeg']
              : ['image/jpeg', 'image/webp'];

          // Check initial lossless/high-quality encode
          for (const fmt of tryFormats) {
            const q = fmt === 'image/png' ? undefined : quality;
            const encoded = this._encodeCanvas(testCanvas, fmt, q);
            if (!encoded) continue;
            // Guard against mock canvas shrinking a genuinely oversized unparseable test blob
            if (isMockCanvasDataUrl(encoded.dataUrl) && !hasRealHeader && curScale === 1) {
              return { isMock: true };
            }
            const byteLen = encoded.dataUrl.length;
            if (byteLen <= maxBytes && byteLen <= GROQ_MAX_IMAGE_BYTES) {
              return {
                dataUrl: encoded.dataUrl,
                mimeType: encoded.mimeType,
                width: curW,
                height: curH,
                wasResized: curW !== width || curH !== height,
                wasRecompressed: true,
              };
            }
          }

          // Step down quality first (keeps resolution crisp), then scale down if still exceeding maxBytes
          const lossyFormats = sourceMime === 'image/webp' ? ['image/webp', 'image/jpeg'] : ['image/jpeg', 'image/webp'];
          for (let scalePass = 0; scalePass < 5; scalePass++) {
            if (scalePass > 0) {
              curScale *= 0.8;
              curW = Math.max(1, Math.round(width * curScale));
              curH = Math.max(1, Math.round(height * curScale));
              if (Math.max(curW, curH) < Math.min(this._minDimension, Math.max(width, height)) * 0.4) {
                break;
              }
              await nextTick();
            }

            const c = this._createCanvas(curW, curH);
            const cCtx = c.getContext('2d');
            cCtx.imageSmoothingEnabled = true;
            cCtx.imageSmoothingQuality = 'high';
            cCtx.drawImage(imgOrCanvas, 0, 0, curW, curH);

            for (let q = quality; q >= this._minQuality - 0.001; q -= 0.08) {
              const clampedQ = Math.max(this._minQuality, Number(q.toFixed(2)));
              for (const fmt of lossyFormats) {
                const encoded = this._encodeCanvas(c, fmt, clampedQ);
                if (!encoded) continue;
                if (isMockCanvasDataUrl(encoded.dataUrl) && !hasRealHeader) {
                  return { isMock: true };
                }
                if (encoded.dataUrl.length <= maxBytes && encoded.dataUrl.length <= GROQ_MAX_IMAGE_BYTES) {
                  return {
                    dataUrl: encoded.dataUrl,
                    mimeType: encoded.mimeType,
                    width: curW,
                    height: curH,
                    wasResized: curW !== width || curH !== height,
                    wasRecompressed: true,
                  };
                }
              }
              await nextTick();
            }
          }

          throw makeModuleError(
            'IMAGE_ERROR',
            'IMAGE_TOO_LARGE',
            `Image exceeds maximum allowed size (${this.formatBytes(maxBytes)}) even after optimization.`
          );
        }

        /**
         * Validates and processes any image input (`File`, `Blob`, `DataURL`, `HTMLCanvasElement`, or wrapped image object).
         * @param {File|Blob|string|HTMLCanvasElement|Object} input
         * @param {Object} [options]
         * @returns {Promise<Object>}
         */
        async processImage(input, options = {}) {
          if (!input) {
            throw makeModuleError('IMAGE_ERROR', 'EMPTY_IMAGE', 'No image input provided.');
          }

          if (typeof input === 'string') {
            return this.processDataUrl(input, options);
          }

          if (typeof input === 'object' && typeof input.toDataURL === 'function' && 'width' in input && 'height' in input) {
            return this.processCanvas(input, options);
          }

          if (typeof input === 'object' && typeof input.dataUrl === 'string' && typeof input.arrayBuffer !== 'function') {
            return this.processDataUrl(input.dataUrl, {
              name: input.name,
              source: input.source,
              ...options,
            });
          }

          if (typeof input === 'object' && (typeof input.arrayBuffer === 'function' || typeof input.size === 'number')) {
            return this.processFile(input, options);
          }

          throw makeModuleError('IMAGE_ERROR', 'INVALID_FORMAT', 'Unsupported image input type.');
        }

        /**
         * Processes a `File` or `Blob`.
         * @param {File|Blob} fileOrBlob
         * @param {Object} [options]
         * @returns {Promise<Object>}
         */
        async processFile(fileOrBlob, options = {}) {
          if (!fileOrBlob || typeof fileOrBlob !== 'object') {
            throw makeModuleError('IMAGE_ERROR', 'INVALID_FORMAT', 'Expected a File or Blob.');
          }
          const { maxBytes, maxDim, quality } = this._getLimits(options);
          const declaredMime = normalizeMimeType(fileOrBlob.type);
          if (declaredMime && !this.isValidMimeType(declaredMime)) {
            throw makeModuleError(
              'IMAGE_ERROR',
              'UNSUPPORTED_MIME',
              `Unsupported image format "${declaredMime}". Allowed: PNG, JPEG, WEBP.`
            );
          }

          const bytes = await this._blobToUint8Array(fileOrBlob);
          if (!bytes || bytes.length === 0) {
            throw makeModuleError('IMAGE_ERROR', 'EMPTY_IMAGE', 'Image file is empty (0 bytes).');
          }

          // Hard Groq ceiling guard on raw payload
          if (bytes.length > GROQ_MAX_IMAGE_BYTES * 2) {
            throw makeModuleError(
              'IMAGE_ERROR',
              'IMAGE_TOO_LARGE',
              `Image size (${this.formatBytes(bytes.length)}) exceeds Groq maximum limit (${GROQ_MAX_IMAGE_MB} MB).`
            );
          }

          await nextTick();
          const headerInfo = detectImageHeader(bytes);
          const mimeType = declaredMime || headerInfo?.mimeType || '';
          if (!this.isValidMimeType(mimeType)) {
            throw makeModuleError(
              'IMAGE_ERROR',
              'UNSUPPORTED_MIME',
              `Unsupported or unrecognized image format "${mimeType || 'unknown'}". Allowed: PNG, JPEG, WEBP.`
            );
          }

          const base64 = uint8ToBase64(bytes);
          const rawDataUrl = `data:${mimeType};base64,${base64}`;
          const objectUrl = this.createObjectUrl(fileOrBlob);
          const name = options.name || fileOrBlob.name || `image-${++this._seq}.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}`;

          try {
            const result = await this._finalizeImage({
              dataUrl: rawDataUrl,
              bytes,
              mimeType,
              headerInfo,
              name,
              objectUrl,
              source: options.source || 'upload',
              maxBytes,
              maxDim,
              quality,
            });
            return result;
          } catch (err) {
            if (objectUrl) this.revokeObjectUrl(objectUrl);
            throw err;
          }
        }

        /**
         * Processes a base64 Data URL.
         * @param {string} dataUrl
         * @param {Object} [options]
         * @returns {Promise<Object>}
         */
        async processDataUrl(dataUrl, options = {}) {
          const { maxBytes, maxDim, quality } = this._getLimits(options);
          const parsed = this.extractBase64(dataUrl);

          await nextTick();
          const bytes = base64ToUint8(parsed.base64);
          if (!bytes || bytes.length === 0) {
            throw makeModuleError('IMAGE_ERROR', 'EMPTY_IMAGE', 'Decoded image bytes are empty.');
          }

          const headerInfo = detectImageHeader(bytes);
          const name =
            options.name ||
            `image-${++this._seq}.${parsed.mimeType === 'image/jpeg' ? 'jpg' : parsed.mimeType.split('/')[1]}`;

          return this._finalizeImage({
            dataUrl: parsed.dataUrl,
            bytes,
            mimeType: parsed.mimeType,
            headerInfo,
            name,
            objectUrl: null,
            source: options.source || 'data-url',
            maxBytes,
            maxDim,
            quality,
          });
        }

        /**
         * Extracts and optimizes an image from an HTMLCanvasElement / offscreen canvas.
         * @param {HTMLCanvasElement} canvas
         * @param {Object} [options]
         * @returns {Promise<Object>}
         */
        async processCanvas(canvas, options = {}) {
          if (!canvas || typeof canvas.toDataURL !== 'function') {
            throw makeModuleError('IMAGE_ERROR', 'INVALID_FORMAT', 'Invalid canvas element.');
          }
          const w = Number(canvas.width || 0);
          const h = Number(canvas.height || 0);
          if (!this.validateDimensions(w, h)) {
            throw makeModuleError('IMAGE_ERROR', 'INVALID_DIMENSIONS', `Invalid canvas dimensions (${w}x${h}).`);
          }

          const { maxBytes, maxDim, quality } = this._getLimits(options);
          const preferredMime = normalizeMimeType(options.mimeType || 'image/png');
          const encoded = this._encodeCanvas(canvas, preferredMime, preferredMime === 'image/png' ? undefined : quality);
          if (!encoded) {
            throw makeModuleError('IMAGE_ERROR', 'ENCODE_FAILED', 'Unable to serialize canvas image.');
          }

          const parsed = this.extractBase64(encoded.dataUrl);
          const bytes = base64ToUint8(parsed.base64);
          const needOptimize =
            Math.max(w, h) > maxDim ||
            encoded.dataUrl.length > maxBytes ||
            encoded.dataUrl.length > GROQ_MAX_IMAGE_BYTES;

          if (!needOptimize) {
            return this._buildImageResult({
              name: options.name || `capture-${++this._seq}.png`,
              mimeType: encoded.mimeType,
              originalMimeType: encoded.mimeType,
              width: w,
              height: h,
              originalWidth: w,
              originalHeight: h,
              sizeBytes: bytes.length,
              dataUrl: encoded.dataUrl,
              objectUrl: null,
              source: options.source || 'capture',
              wasResized: false,
              wasRecompressed: false,
            });
          }

          const optimized = await this._optimizeViaCanvas({
            imgOrCanvas: canvas,
            width: w,
            height: h,
            sourceMime: encoded.mimeType,
            maxBytes,
            maxDim,
            quality,
            hasRealHeader: !isMockCanvasDataUrl(encoded.dataUrl),
          });

          if (!optimized || optimized.isMock) {
            if (encoded.dataUrl.length > maxBytes || encoded.dataUrl.length > GROQ_MAX_IMAGE_BYTES) {
              throw makeModuleError(
                'IMAGE_ERROR',
                'IMAGE_TOO_LARGE',
                `Canvas image exceeds maximum allowed size (${this.formatBytes(maxBytes)}).`
              );
            }
            return this._buildImageResult({
              name: options.name || `capture-${++this._seq}.png`,
              mimeType: encoded.mimeType,
              originalMimeType: encoded.mimeType,
              width: w,
              height: h,
              originalWidth: w,
              originalHeight: h,
              sizeBytes: bytes.length,
              dataUrl: encoded.dataUrl,
              objectUrl: null,
              source: options.source || 'capture',
              wasResized: false,
              wasRecompressed: false,
            });
          }

          const optParsed = this.extractBase64(optimized.dataUrl);
          const optBytes = base64ToUint8(optParsed.base64);
          return this._buildImageResult({
            name: options.name || `capture-${++this._seq}.${optimized.mimeType === 'image/jpeg' ? 'jpg' : optimized.mimeType.split('/')[1]}`,
            mimeType: optimized.mimeType,
            originalMimeType: encoded.mimeType,
            width: optimized.width,
            height: optimized.height,
            originalWidth: w,
            originalHeight: h,
            sizeBytes: optBytes.length,
            dataUrl: optimized.dataUrl,
            objectUrl: null,
            source: options.source || 'capture',
            wasResized: optimized.wasResized,
            wasRecompressed: optimized.wasRecompressed,
          });
        }

        /** @private */
        async _finalizeImage({ dataUrl, bytes, mimeType, headerInfo, name, objectUrl, source, maxBytes, maxDim, quality }) {
          let width = headerInfo?.width || 0;
          let height = headerInfo?.height || 0;
          let decodedImg = null;

          // Decode with Image when available to validate integrity and enable smart canvas downscaling
          if (resolveGlobal('Image', this._win?.Image)) {
            const decoded = await this._decodeDimensionsWithImage(objectUrl || dataUrl);
            if (decoded) {
              decodedImg = decoded.img;
              if (!width || !height) {
                width = decoded.width;
                height = decoded.height;
              }
              if (!this.validateDimensions(decoded.width, decoded.height)) {
                throw makeModuleError(
                  'IMAGE_ERROR',
                  'INVALID_DIMENSIONS',
                  `Invalid image dimensions (${decoded.width}x${decoded.height}).`
                );
              }
            }
          } else if (headerInfo && headerInfo.width > 0 && headerInfo.height > 0 && !this.validateDimensions(width, height)) {
            throw makeModuleError(
              'IMAGE_ERROR',
              'INVALID_DIMENSIONS',
              `Invalid image dimensions (${width}x${height}).`
            );
          }

          const withinDimensionLimit = !width || !height || Math.max(width, height) <= maxDim;
          const withinSizeLimit =
            bytes.length <= maxBytes &&
            dataUrl.length <= maxBytes &&
            bytes.length <= GROQ_MAX_IMAGE_BYTES &&
            dataUrl.length <= GROQ_MAX_IMAGE_BYTES;

          if (withinDimensionLimit && withinSizeLimit) {
            return this._buildImageResult({
              name,
              mimeType,
              originalMimeType: mimeType,
              width,
              height,
              originalWidth: width,
              originalHeight: height,
              sizeBytes: bytes.length,
              dataUrl,
              objectUrl,
              source,
              wasResized: false,
              wasRecompressed: false,
            });
          }

          // Attempt smart downscale/compression only if a canvas + decoded real pixels exist
          if (decodedImg && this._doc && typeof this._doc.createElement === 'function') {
            const optimized = await this._optimizeViaCanvas({
              imgOrCanvas: decodedImg,
              width: width || 1,
              height: height || 1,
              sourceMime: mimeType,
              maxBytes,
              maxDim,
              quality,
              hasRealHeader: Boolean(headerInfo),
            });
            if (optimized && !optimized.isMock) {
              const optParsed = this.extractBase64(optimized.dataUrl);
              const optBytes = base64ToUint8(optParsed.base64);
              return this._buildImageResult({
                name,
                mimeType: optimized.mimeType,
                originalMimeType: mimeType,
                width: optimized.width,
                height: optimized.height,
                originalWidth: width,
                originalHeight: height,
                sizeBytes: optBytes.length,
                dataUrl: optimized.dataUrl,
                objectUrl,
                source,
                wasResized: optimized.wasResized,
                wasRecompressed: optimized.wasRecompressed,
              });
            }
          }

          if (bytes.length > maxBytes || dataUrl.length > maxBytes || dataUrl.length > GROQ_MAX_IMAGE_BYTES) {
            throw makeModuleError(
              'IMAGE_ERROR',
              'IMAGE_TOO_LARGE',
              `Image size (${this.formatBytes(Math.max(bytes.length, dataUrl.length))}) exceeds limit (${this.formatBytes(maxBytes)}).`
            );
          }

          return this._buildImageResult({
            name,
            mimeType,
            originalMimeType: mimeType,
            width,
            height,
            originalWidth: width,
            originalHeight: height,
            sizeBytes: bytes.length,
            dataUrl,
            objectUrl,
            source,
            wasResized: false,
            wasRecompressed: false,
          });
        }

        /** @private */
        _buildImageResult(info) {
          const dims = info.width && info.height ? `${info.width} × ${info.height}` : '';
          return {
            id: `img_${Date.now().toString(36)}_${++this._seq}`,
            name: info.name,
            mimeType: info.mimeType,
            originalMimeType: info.originalMimeType || info.mimeType,
            width: info.width || 0,
            height: info.height || 0,
            originalWidth: info.originalWidth || info.width || 0,
            originalHeight: info.originalHeight || info.height || 0,
            sizeBytes: info.sizeBytes,
            base64Bytes: info.dataUrl.length,
            humanSize: this.formatBytes(info.sizeBytes),
            humanDimensions: dims,
            dataUrl: info.dataUrl,
            objectUrl: info.objectUrl || null,
            source: info.source || 'upload',
            wasResized: Boolean(info.wasResized),
            wasRecompressed: Boolean(info.wasRecompressed),
            createdAt: Date.now(),
          };
        }

        /**
         * Processes an array/FileList of image inputs preserving order and reporting per-item errors.
         * @param {Array|FileList} inputs
         * @param {Object} [options]
         * @returns {Promise<{items:Array<Object>, errors:Array<Error>}>}
         */
        async processBatch(inputs, options = {}) {
          const list = inputs ? Array.from(inputs) : [];
          const maxCount = Number(options.maxCount || 0);
          const items = [];
          const errors = [];

          for (let i = 0; i < list.length; i++) {
            if (maxCount > 0 && items.length >= maxCount) {
              errors.push(
                makeModuleError(
                  'IMAGE_LIMIT_EXCEEDED',
                  'MAX_IMAGES_EXCEEDED',
                  `Exceeded maximum image count (${maxCount}).`
                )
              );
              break;
            }
            try {
              const item = await this.processImage(list[i], options);
              items.push(item);
            } catch (err) {
              errors.push(err);
            }
          }

          return { items, errors };
        }

        /**
         * Extracts and processes image files from a DragEvent (`drop`).
         * @param {DragEvent} event
         * @param {Object} [options]
         * @returns {Promise<{items:Array<Object>, errors:Array<Error>}>}
         */
        async extractFromDropEvent(event, options = {}) {
          const dt = event?.dataTransfer;
          if (!dt) return { items: [], errors: [] };
          const files = [];
          if (dt.files && dt.files.length > 0) {
            files.push(...Array.from(dt.files));
          } else if (dt.items && dt.items.length > 0) {
            for (const item of Array.from(dt.items)) {
              if (item && item.kind === 'file' && typeof item.getAsFile === 'function') {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
          }
          return this.processBatch(files, { source: 'drop', ...options });
        }

        /**
         * Extracts and processes image files from a file `<input>` element or `change` Event.
         * @param {HTMLInputElement|Event} inputOrEvent
         * @param {Object} [options]
         * @returns {Promise<{items:Array<Object>, errors:Array<Error>}>}
         */
        async extractFromFileInput(inputOrEvent, options = {}) {
          const inputEl = inputOrEvent?.target || inputOrEvent;
          const files = inputEl?.files ? Array.from(inputEl.files) : [];
          return this.processBatch(files, { source: 'upload', ...options });
        }

        /**
         * Extracts and processes pasted images from a ClipboardEvent (`paste`).
         * @param {ClipboardEvent} event
         * @param {Object} [options]
         * @returns {Promise<{hasImages:boolean, items:Array<Object>, errors:Array<Error>}>}
         */
        async extractFromPasteEvent(event, options = {}) {
          const cd = event?.clipboardData;
          if (!cd) return { hasImages: false, items: [], errors: [] };
          const files = [];
          if (cd.items && cd.items.length > 0) {
            for (const item of Array.from(cd.items)) {
              if (item && item.kind === 'file' && typeof item.getAsFile === 'function') {
                const f = item.getAsFile();
                if (f && (!f.type || f.type.startsWith('image/'))) {
                  files.push(f);
                }
              }
            }
          }
          if (files.length === 0 && cd.files && cd.files.length > 0) {
            for (const f of Array.from(cd.files)) {
              if (f && (!f.type || f.type.startsWith('image/'))) {
                files.push(f);
              }
            }
          }
          if (files.length === 0) {
            return { hasImages: false, items: [], errors: [] };
          }
          const res = await this.processBatch(files, { source: 'paste', ...options });
          return { hasImages: true, ...res };
        }
      }

      ImageProcessor.ALLOWED_MIME_TYPES = ALLOWED_IMAGE_MIMES;
      ImageProcessor.GROQ_MAX_IMAGE_BYTES = GROQ_MAX_IMAGE_BYTES;

      // ===========================================================================
      // 3. CaptureManager
      // ===========================================================================

      const SHC_UI_IDS = new Set(['shc-host-root', 'shc-capture-overlay', 'shc-crop-overlay']);

      /**
       * Implements explicit DOM Capture (`html2canvas-pro` + region warning inspection + pure-DOM fallback)
       * and optional Screen Capture (`getDisplayMedia` with strict track cleanup in `finally` + interactive cropper),
       * plus interactive Crop Again on any image.
       */
      class CaptureManager {
        /**
         * @param {Object} [options]
         */
        constructor(options = {}) {
          this._doc = options.document || resolveGlobal('document') || null;
          this._win = options.window || resolveGlobal('window') || null;
          this._settings = options.settingsManager || null;
          this._imageProcessor = options.imageProcessor || new ImageProcessor({
            settingsManager: this._settings,
            document: this._doc,
            window: this._win,
          });
          this._html2canvas = options.html2canvas || null;
          this._ignoreIds = new Set([...SHC_UI_IDS, ...(Array.isArray(options.ignoreIds) ? options.ignoreIds : [])]);
          this._activeCleanup = null;
        }

        /**
         * Cancels any active region selection or crop overlay immediately.
         */
        cancelActiveOverlay() {
          if (typeof this._activeCleanup === 'function') {
            try {
              this._activeCleanup();
            } catch (_) {}
            this._activeCleanup = null;
          }
        }

        /**
         * Predicate determining whether an element belongs to SHC UI or capture overlays.
         * @param {Element} el
         * @returns {boolean}
         */
        shouldIgnoreElement(el) {
          if (!el || typeof el !== 'object') return false;
          let cur = el;
          const seen = new Set();
          while (cur && typeof cur === 'object' && !seen.has(cur)) {
            seen.add(cur);
            if (cur.id && this._ignoreIds.has(cur.id)) return true;
            if (typeof cur.hasAttribute === 'function') {
              if (cur.hasAttribute('data-shc-ui') || cur.hasAttribute('data-shc-overlay')) return true;
            }
            if (typeof cur.getAttribute === 'function') {
              if (cur.getAttribute('data-shc-ui') || cur.getAttribute('data-shc-overlay')) return true;
            }
            cur = cur.parentElement || cur.parentNode || cur.host || null;
          }
          return false;
        }

        /**
         * Checks if two viewport rectangles intersect.
         * @param {{x:number,y:number,width:number,height:number}} a
         * @param {{left:number,top:number,right:number,bottom:number,width?:number,height?:number}} b
         * @returns {boolean}
         */
        _rectsIntersect(a, b) {
          if (!a || !b) return false;
          const bLeft = Number(b.left ?? b.x ?? 0);
          const bTop = Number(b.top ?? b.y ?? 0);
          const bRight = Number(b.right ?? (bLeft + Number(b.width || 0)));
          const bBottom = Number(b.bottom ?? (bTop + Number(b.height || 0)));
          if (bRight <= bLeft || bBottom <= bTop) return false;
          return !(bRight < a.x || bLeft > a.x + a.width || bBottom < a.y || bTop > a.y + a.height);
        }

        /**
         * Inspects DOM elements inside/overlapping a viewport selection rectangle for
         * cross-origin iframes, videos, WebGL/tainted canvases, and cross-origin images.
         * @param {{x:number,y:number,width:number,height:number}} rect
         * @returns {{warnings:string[], warningDetails:Array<Object>}}
         */
        inspectRegionElements(rect) {
          const warningDetails = [];
          const doc = this._doc;
          if (!doc || typeof doc.querySelectorAll !== 'function') {
            return { warnings: [], warningDetails };
          }

          const pageOrigin = doc.location?.origin || this._win?.location?.origin || '';
          const extractOrigin = (rawUrl) => {
            const s = String(rawUrl || '').trim();
            if (!s) return '';
            const URLCtor = resolveGlobal('URL', this._win?.URL);
            if (typeof URLCtor === 'function') {
              try {
                const parsed = new URLCtor(s, pageOrigin || 'https://localhost');
                return parsed.origin || '';
              } catch (_) {}
            }
            if (s.startsWith('//')) {
              const protoMatch = String(pageOrigin || 'https:').match(/^([a-z][a-z0-9+.-]*:)/i);
              const hostMatch = s.slice(2).match(/^([^/?#]+)/);
              return protoMatch && hostMatch ? `${protoMatch[1]}//${hostMatch[1]}` : '';
            }
            const absMatch = s.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i);
            if (absMatch) return absMatch[1].toLowerCase();
            return pageOrigin;
          };
          const isCrossOriginUrl = (urlStr) => {
            if (!urlStr || typeof urlStr !== 'string') return false;
            const s = urlStr.trim();
            if (!s || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('about:') || s.startsWith('#')) {
              return false;
            }
            const targetOrigin = extractOrigin(s);
            return Boolean(pageOrigin && targetOrigin && targetOrigin.toLowerCase() !== pageOrigin.toLowerCase() && targetOrigin !== 'null');
          };

          const elementInRegion = (el) => {
            if (!el || this.shouldIgnoreElement(el)) return false;
            if (!rect || typeof el.getBoundingClientRect !== 'function') return true;
            try {
              const box = el.getBoundingClientRect();
              return this._rectsIntersect(rect, box);
            } catch (_) {
              return true;
            }
          };

          // 1. Cross-origin <iframe>
          let crossOriginIframes = 0;
          for (const iframe of Array.from(doc.querySelectorAll('iframe') || [])) {
            if (!elementInRegion(iframe)) continue;
            let isCross = false;
            const src = iframe.getAttribute?.('src') || iframe.src || '';
            if (isCrossOriginUrl(src)) {
              isCross = true;
            } else {
              try {
                if ('contentDocument' in iframe && iframe.contentDocument === null && src) {
                  isCross = true;
                }
              } catch (_) {
                isCross = true;
              }
            }
            if (isCross) crossOriginIframes++;
          }
          if (crossOriginIframes > 0) {
            warningDetails.push({
              code: 'CROSS_ORIGIN_IFRAME',
              tagName: 'iframe',
              count: crossOriginIframes,
              message: `Detected ${crossOriginIframes} cross-origin <iframe> element(s) in region; DOM capture cannot read third-party frame contents (use Screen Capture if blank).`,
            });
          }

          // 2. <video> elements
          let videoCount = 0;
          for (const video of Array.from(doc.querySelectorAll('video') || [])) {
            if (elementInRegion(video)) videoCount++;
          }
          if (videoCount > 0) {
            warningDetails.push({
              code: 'VIDEO_ELEMENT',
              tagName: 'video',
              count: videoCount,
              message: `Detected ${videoCount} <video> element(s) in region; video frames may appear blank in DOM capture (use Screen Capture for video).`,
            });
          }

          // 3. WebGL or tainted <canvas>
          let problematicCanvases = 0;
          for (const canvas of Array.from(doc.querySelectorAll('canvas') || [])) {
            if (!elementInRegion(canvas)) continue;
            let issue = Boolean(canvas._tainted);
            if (!issue && typeof canvas.getContext === 'function') {
              try {
                const ctx2d = canvas.getContext('2d');
                if (ctx2d && typeof ctx2d.getImageData === 'function') {
                  ctx2d.getImageData(0, 0, 1, 1);
                } else if (!ctx2d) {
                  // Possible WebGL / WebGL2 context (often clears drawing buffer unless preserved)
                  if (canvas.getContext('webgl') || canvas.getContext('webgl2') || canvas.getContext('experimental-webgl')) {
                    issue = true;
                  }
                }
              } catch (_) {
                issue = true;
              }
            }
            if (!issue && typeof canvas.toDataURL === 'function') {
              try {
                canvas.toDataURL('image/png');
              } catch (_) {
                issue = true;
              }
            }
            if (issue) problematicCanvases++;
          }
          if (problematicCanvases > 0) {
            warningDetails.push({
              code: 'TAINTED_OR_WEBGL_CANVAS',
              tagName: 'canvas',
              count: problematicCanvases,
              message: `Detected ${problematicCanvases} WebGL or tainted <canvas> element(s) in region; canvas pixels may not export accurately via DOM capture.`,
            });
          }

          // 4. Cross-origin <img> without CORS
          let crossOriginImgs = 0;
          for (const img of Array.from(doc.querySelectorAll('img') || [])) {
            if (!elementInRegion(img)) continue;
            const src = img.getAttribute?.('src') || img.src || '';
            const corsAttr = img.getAttribute?.('crossorigin') ?? img.crossOrigin;
            if (isCrossOriginUrl(src) && !corsAttr) {
              crossOriginImgs++;
            }
          }
          if (crossOriginImgs > 0) {
            warningDetails.push({
              code: 'CROSS_ORIGIN_IMAGE',
              tagName: 'img',
              count: crossOriginImgs,
              message: `Detected ${crossOriginImgs} cross-origin <img> element(s) without CORS; image(s) may be omitted by DOM capture unless server sends CORS headers.`,
            });
          }

          return {
            warnings: warningDetails.map((w) => w.message),
            warningDetails,
          };
        }

        /**
         * Method 1 — DOM Capture.
         * Displays an interactive region selection overlay, inspects elements in region,
         * renders page DOM via `html2canvas-pro`, and crops exact viewport selection onto an offscreen canvas.
         * Falls back with explicit warnings if `html2canvas` is missing or throws.
         * @param {Object} [options]
         * @returns {Promise<Object>}
         */
        async captureDOM(options = {}) {
          const doc = this._doc;
          const win = this._win;
          if (!doc) {
            throw makeModuleError('CAPTURE_ERROR', 'NO_DOCUMENT', 'Document is unavailable for DOM capture.');
          }

          const rect = options.rect
            ? this._normalizeRect(options.rect)
            : await this._promptRegionSelection({
                title: 'Drag to select homework region • Esc to cancel',
              });

          if (!rect) {
            return { cancelled: true, method: 'dom', image: null, warnings: [], warningDetails: [], fallbackUsed: false };
          }

          const inspection = this.inspectRegionElements(rect);
          const warnings = [...inspection.warnings];
          const warningDetails = [...inspection.warningDetails];

          const dpr = Number(win?.devicePixelRatio || 1);
          const scale = Math.min(Number.isFinite(dpr) && dpr > 0 ? dpr : 1, 2);
          const scrollX = Number(win?.scrollX ?? win?.pageXOffset ?? 0) || 0;
          const scrollY = Number(win?.scrollY ?? win?.pageYOffset ?? 0) || 0;
          const viewportW = Number(win?.innerWidth || doc.documentElement?.clientWidth || rect.x + rect.width || 1280);
          const viewportH = Number(win?.innerHeight || doc.documentElement?.clientHeight || rect.y + rect.height || 720);

          const h2c = options.html2canvas || this._html2canvas || resolveGlobal('html2canvas', win?.html2canvas);
          let croppedCanvas = null;
          let fallbackUsed = false;

          if (typeof h2c === 'function') {
            try {
              const targetRoot = doc.body || doc.documentElement;
              const rendered = await h2c(targetRoot, {
                useCORS: true,
                allowTaint: false,
                scale,
                backgroundColor: null,
                logging: false,
                x: scrollX,
                y: scrollY,
                width: viewportW,
                height: viewportH,
                windowWidth: viewportW,
                windowHeight: viewportH,
                scrollX,
                scrollY,
                ignoreElements: (el) => this.shouldIgnoreElement(el),
              });

              if (!rendered || !rendered.width || !rendered.height) {
                throw new Error('html2canvas returned an empty canvas.');
              }

              croppedCanvas = this._cropRenderedCanvas(rendered, rect, viewportW, viewportH, scale);
            } catch (err) {
              fallbackUsed = true;
              const msg = `DOM capture engine (html2canvas-pro) failed (${err?.message || 'unknown error'}); attempted limited pure-DOM fallback. Use Screen Capture for complex or cross-origin content.`;
              warnings.push(msg);
              warningDetails.push({ code: 'HTML2CANVAS_FAILED', tagName: 'canvas', count: 1, message: msg });
            }
          } else {
            fallbackUsed = true;
            const msg = 'DOM capture engine (html2canvas-pro) is not loaded; attempted limited pure-DOM fallback. Use Screen Capture or Upload/Paste.';
            warnings.push(msg);
            warningDetails.push({ code: 'HTML2CANVAS_UNAVAILABLE', tagName: 'script', count: 1, message: msg });
          }

          if (!croppedCanvas && fallbackUsed) {
            croppedCanvas = this._pureDomFallbackCanvas(rect, scale);
          }

          if (!croppedCanvas) {
            return {
              cancelled: false,
              method: 'dom',
              image: null,
              warnings,
              warningDetails,
              fallbackUsed,
              rect,
            };
          }

          const image = await this._imageProcessor.processCanvas(croppedCanvas, {
            source: 'dom-capture',
            name: `dom-capture-${rect.width}x${rect.height}.png`,
            mimeType: 'image/png',
          });

          return {
            cancelled: false,
            method: 'dom',
            image,
            warnings,
            warningDetails,
            fallbackUsed,
            rect,
          };
        }

        /** @private */
        _cropRenderedCanvas(rendered, rect, viewportW, viewportH, expectedScale) {
          const doc = this._doc;
          const outW = Math.max(1, Math.round(rect.width * expectedScale));
          const outH = Math.max(1, Math.round(rect.height * expectedScale));
          const offscreen = doc.createElement('canvas');
          offscreen.width = outW;
          offscreen.height = outH;
          const ctx = offscreen.getContext('2d');
          if (!ctx) return null;

          // Determine whether html2canvas returned full-viewport canvas or already-cropped rect canvas
          const isAlreadyCropped =
            rendered.width <= Math.round(rect.width * expectedScale) + 4 &&
            rendered.height <= Math.round(rect.height * expectedScale) + 4 &&
            (rect.x > 4 || rect.y > 4);

          if (isAlreadyCropped) {
            ctx.drawImage(rendered, 0, 0, rendered.width, rendered.height, 0, 0, outW, outH);
          } else {
            const scaleX = rendered.width / Math.max(1, viewportW);
            const scaleY = rendered.height / Math.max(1, viewportH);
            const sx = Math.max(0, Math.round(rect.x * scaleX));
            const sy = Math.max(0, Math.round(rect.y * scaleY));
            const sw = Math.max(1, Math.min(rendered.width - sx, Math.round(rect.width * scaleX)));
            const sh = Math.max(1, Math.min(rendered.height - sy, Math.round(rect.height * scaleY)));
            ctx.drawImage(rendered, sx, sy, sw, sh, 0, 0, outW, outH);
          }

          return offscreen;
        }

        /** @private */
        _pureDomFallbackCanvas(rect, scale = 1) {
          const doc = this._doc;
          if (!doc || typeof doc.createElement !== 'function') return null;
          const canvas = doc.createElement('canvas');
          if (!canvas || typeof canvas.getContext !== 'function') return null;
          canvas.width = Math.max(1, Math.round(rect.width * scale));
          canvas.height = Math.max(1, Math.round(rect.height * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;

          try {
            ctx.save?.();
            ctx.scale?.(scale, scale);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect?.(0, 0, rect.width, rect.height);

            // Best-effort copy of accessible same-origin <img> / untainted <canvas> inside rect
            if (typeof doc.querySelectorAll === 'function') {
              for (const el of Array.from(doc.querySelectorAll('img, canvas') || [])) {
                if (this.shouldIgnoreElement(el) || el === canvas) continue;
                if (typeof el.getBoundingClientRect !== 'function') continue;
                const box = el.getBoundingClientRect();
                if (!this._rectsIntersect(rect, box)) continue;
                try {
                  ctx.drawImage(el, box.left - rect.x, box.top - rect.y, box.width, box.height);
                } catch (_) {}
              }
            }
            ctx.restore?.();
          } catch (_) {}
          return canvas;
        }

        /**
         * Method 2 — Optional Screen Capture via `getDisplayMedia`.
         * Immediately stops all `MediaStreamTrack`s in `finally` after grabbing one video frame,
         * then presents an interactive canvas cropper overlay so the user selects the exact region.
         * @param {Object} [options]
         * @returns {Promise<Object>}
         */
        async captureScreen(options = {}) {
          const nav = this._win?.navigator || resolveGlobal('navigator');
          const getDisplayMedia = nav?.mediaDevices?.getDisplayMedia;
          if (typeof getDisplayMedia !== 'function') {
            throw makeModuleError(
              'CAPTURE_ERROR',
              'SCREEN_CAPTURE_UNSUPPORTED',
              'Screen Capture (getDisplayMedia) is not available in this browser or insecure context.'
            );
          }

          let stream = null;
          let frameCanvas = null;

          try {
            stream = await getDisplayMedia.call(nav.mediaDevices, {
              video: { preferCurrentTab: true },
              audio: false,
            });

            if (options.signal?.aborted) {
              return { cancelled: true, method: 'screen', image: null, warnings: [], warningDetails: [] };
            }

            frameCanvas = await this._grabSingleVideoFrame(stream, options);
          } catch (err) {
            const name = err?.name || '';
            if (name === 'AbortError' || name === 'NotAllowedError') {
              return {
                cancelled: true,
                method: 'screen',
                image: null,
                warnings: [],
                warningDetails: [],
                reason: name,
              };
            }
            throw makeModuleError(
              'CAPTURE_ERROR',
              err?.reason || 'SCREEN_CAPTURE_FAILED',
              err?.message || 'Screen Capture failed.'
            );
          } finally {
            this._stopMediaStream(stream);
          }

          if (!frameCanvas) {
            throw makeModuleError('CAPTURE_ERROR', 'EMPTY_FRAME', 'Could not extract a video frame from screen stream.');
          }

          // Present interactive canvas cropper overlay on captured frame (unless programmatic cropRect supplied)
          const cropResult = await this.cropImage(frameCanvas, {
            ...options,
            source: 'screen-capture',
            name: `screen-capture-${Date.now()}.png`,
            allowFullFrame: true,
            title: 'Drag to crop homework area from captured screen • Esc to cancel',
          });

          if (!cropResult || cropResult.cancelled) {
            return { cancelled: true, method: 'screen', image: null, warnings: [], warningDetails: [] };
          }

          return {
            cancelled: false,
            method: 'screen',
            image: cropResult.image,
            warnings: cropResult.warnings || [],
            warningDetails: [],
            rect: cropResult.rect,
          };
        }

        /** @private */
        _stopMediaStream(stream) {
          if (!stream || typeof stream.getTracks !== 'function') return;
          try {
            const tracks = stream.getTracks();
            if (Array.isArray(tracks)) {
              for (const track of tracks) {
                if (track && typeof track.stop === 'function') {
                  try {
                    track.stop();
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }

        /** @private */
        async _grabSingleVideoFrame(stream, options = {}) {
          const doc = this._doc;
          if (!doc || typeof doc.createElement !== 'function') {
            throw makeModuleError('CAPTURE_ERROR', 'NO_DOCUMENT', 'Document is unavailable for frame extraction.');
          }

          const video = doc.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.autoplay = true;

          const waitFrameReady = new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, val) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              fn(val);
            };
            const timer = setTimeout(() => {
              finish(reject, makeModuleError('CAPTURE_ERROR', 'FRAME_TIMEOUT', 'Timed out waiting for screen capture frame.'));
            }, Number(options.frameTimeoutMs || 5000));

            const onReady = async () => {
              try {
                if (typeof video.play === 'function') {
                  await video.play().catch(() => {});
                }
              } catch (_) {}
              finish(resolve);
            };

            video.onloadedmetadata = onReady;
            if (typeof video.addEventListener === 'function') {
              video.addEventListener('loadedmetadata', onReady, { once: true });
            }
            video.onerror = () => finish(reject, makeModuleError('CAPTURE_ERROR', 'VIDEO_ERROR', 'Video stream failed.'));
          });

          video.srcObject = stream;
          await waitFrameReady;

          if (options.signal?.aborted) {
            return null;
          }

          const w = Number(video.videoWidth || 1280);
          const h = Number(video.videoHeight || 720);
          const canvas = doc.createElement('canvas');
          canvas.width = Math.max(1, w);
          canvas.height = Math.max(1, h);
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          try {
            video.pause?.();
            video.srcObject = null;
          } catch (_) {}

          return canvas;
        }

        /**
         * Interactive Crop Again for any captured/uploaded image (`dataUrl`, `Blob`, `File`, `HTMLCanvasElement`, or image item).
         * @param {string|Blob|File|HTMLCanvasElement|Object} imageSource
         * @param {Object} [options]
         * @returns {Promise<Object>}
         */
        async cropImage(imageSource, options = {}) {
          if (!imageSource) {
            throw makeModuleError('CAPTURE_ERROR', 'INVALID_IMAGE', 'No image provided to crop.');
          }

          const loaded = await this._loadSourceAsCanvas(imageSource);
          const srcCanvas = loaded.canvas;
          const srcW = srcCanvas.width;
          const srcH = srcCanvas.height;

          let cropRect = null;
          if (options.cropRect) {
            cropRect = this._clampRectToBounds(options.cropRect, srcW, srcH);
          } else if (options.skipCropOverlay) {
            cropRect = { x: 0, y: 0, width: srcW, height: srcH };
          } else {
            cropRect = await this._promptImageCropOverlay(srcCanvas, options);
          }

          if (!cropRect) {
            return { cancelled: true, method: 'crop', image: null, warnings: [] };
          }

          const croppedCanvas = this.cropCanvasRegion(srcCanvas, cropRect);
          const outName = options.name || loaded.name || `cropped-${cropRect.width}x${cropRect.height}.png`;
          const processed = await this._imageProcessor.processCanvas(croppedCanvas, {
            source: options.source || 'crop',
            name: outName,
            mimeType: 'image/png',
          });

          return {
            cancelled: false,
            method: 'crop',
            image: processed,
            warnings: [],
            rect: cropRect,
          };
        }

        /**
         * Deterministically crops a pixel region from a source canvas/image onto a clean offscreen canvas.
         * @param {HTMLCanvasElement|Object} sourceCanvas
         * @param {{x:number,y:number,width:number,height:number}} rect
         * @returns {HTMLCanvasElement}
         */
        cropCanvasRegion(sourceCanvas, rect) {
          const doc = this._doc;
          if (!doc || typeof doc.createElement !== 'function') {
            throw makeModuleError('CAPTURE_ERROR', 'NO_DOCUMENT', 'Document unavailable for canvas crop.');
          }
          const clamped = this._clampRectToBounds(rect, sourceCanvas.width, sourceCanvas.height);
          const out = doc.createElement('canvas');
          out.width = Math.max(1, clamped.width);
          out.height = Math.max(1, clamped.height);
          const ctx = out.getContext('2d');
          if (ctx) {
            ctx.drawImage(
              sourceCanvas,
              clamped.x,
              clamped.y,
              clamped.width,
              clamped.height,
              0,
              0,
              clamped.width,
              clamped.height
            );
          }
          return out;
        }

        /** @private */
        async _loadSourceAsCanvas(imageSource) {
          const doc = this._doc;
          if (typeof imageSource === 'object' && typeof imageSource.toDataURL === 'function' && 'width' in imageSource) {
            return { canvas: imageSource, name: 'capture.png' };
          }

          let dataUrl = '';
          let name = 'image.png';
          let knownW = 0;
          let knownH = 0;

          if (typeof imageSource === 'string') {
            dataUrl = imageSource;
          } else if (typeof imageSource === 'object' && typeof imageSource.dataUrl === 'string') {
            dataUrl = imageSource.dataUrl;
            name = imageSource.name || name;
            knownW = Number(imageSource.width || 0);
            knownH = Number(imageSource.height || 0);
          } else {
            const processed = await this._imageProcessor.processImage(imageSource);
            dataUrl = processed.dataUrl;
            name = processed.name || name;
            knownW = processed.width || 0;
            knownH = processed.height || 0;
          }

          const ImageCtor = resolveGlobal('Image', this._win?.Image);
          if (typeof ImageCtor === 'function') {
            const loaded = await new Promise((resolve, reject) => {
              const img = new ImageCtor();
              img.onload = () => resolve(img);
              img.onerror = () => reject(makeModuleError('CAPTURE_ERROR', 'DECODE_FAILED', 'Failed to load image for cropping.'));
              img.src = dataUrl;
            });
            const w = Number(loaded.naturalWidth || loaded.width || knownW || 1);
            const h = Number(loaded.naturalHeight || loaded.height || knownH || 1);
            const canvas = doc.createElement('canvas');
            canvas.width = Math.max(1, w);
            canvas.height = Math.max(1, h);
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(loaded, 0, 0, canvas.width, canvas.height);
            return { canvas, name };
          }

          const canvas = doc.createElement('canvas');
          canvas.width = Math.max(1, knownW || 800);
          canvas.height = Math.max(1, knownH || 600);
          return { canvas, name };
        }

        /** @private */
        _normalizeRect(rect) {
          const x = Math.round(Number(rect?.x ?? rect?.left ?? 0));
          const y = Math.round(Number(rect?.y ?? rect?.top ?? 0));
          const width = Math.round(Number(rect?.width ?? 0));
          const height = Math.round(Number(rect?.height ?? 0));
          if (!Number.isFinite(width) || !Number.isFinite(height) || width < 4 || height < 4) {
            return null;
          }
          return { x: Math.max(0, x), y: Math.max(0, y), width, height };
        }

        /** @private */
        _clampRectToBounds(rect, maxW, maxH) {
          const x = Math.max(0, Math.min(maxW - 1, Math.round(Number(rect?.x ?? 0))));
          const y = Math.max(0, Math.min(maxH - 1, Math.round(Number(rect?.y ?? 0))));
          const w = Math.max(1, Math.min(maxW - x, Math.round(Number(rect?.width ?? maxW))));
          const h = Math.max(1, Math.min(maxH - y, Math.round(Number(rect?.height ?? maxH))));
          return { x, y, width: w, height: h };
        }

        /** @private */
        _promptRegionSelection({ title }) {
          const doc = this._doc;
          if (!doc || !doc.body || typeof doc.createElement !== 'function') {
            return Promise.resolve(null);
          }

          this.cancelActiveOverlay();

          return new Promise((resolve) => {
            let settled = false;
            const overlay = doc.createElement('div');
            overlay.id = 'shc-capture-overlay';
            overlay.setAttribute('data-shc-overlay', 'true');
            Object.assign(overlay.style, {
              position: 'fixed',
              inset: '0',
              zIndex: '2147483647',
              background: 'rgba(15, 23, 42, 0.32)',
              cursor: 'crosshair',
              userSelect: 'none',
              touchAction: 'none',
            });

            const banner = doc.createElement('div');
            banner.setAttribute('data-shc-overlay', 'true');
            banner.textContent = title || 'Drag to select region • Esc to cancel';
            Object.assign(banner.style, {
              position: 'fixed',
              top: '14px',
              left: '50%',
              transform: 'translateX(-50%)',
              padding: '7px 14px',
              borderRadius: '999px',
              background: 'rgba(15, 23, 42, 0.92)',
              color: '#f8fafc',
              border: '1px solid rgba(99, 102, 241, 0.65)',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              fontSize: '12.5px',
              fontWeight: '600',
              pointerEvents: 'none',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
            });

            const selBox = doc.createElement('div');
            selBox.setAttribute('data-shc-overlay', 'true');
            Object.assign(selBox.style, {
              position: 'fixed',
              display: 'none',
              border: '2px dashed #22d3ee',
              background: 'rgba(34, 211, 238, 0.12)',
              boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.42)',
              pointerEvents: 'none',
              boxSizing: 'border-box',
            });

            const readout = doc.createElement('div');
            readout.setAttribute('data-shc-overlay', 'true');
            Object.assign(readout.style, {
              position: 'absolute',
              bottom: '-26px',
              right: '0',
              padding: '2px 7px',
              borderRadius: '4px',
              background: '#0f172a',
              color: '#22d3ee',
              fontFamily: 'ui-monospace, monospace',
              fontSize: '11px',
              whiteSpace: 'nowrap',
            });
            selBox.appendChild(readout);

            overlay.appendChild(selBox);
            overlay.appendChild(banner);
            doc.body.appendChild(overlay);

            let dragging = false;
            let startX = 0;
            let startY = 0;
            let currentRect = null;

            const cleanup = () => {
              doc.removeEventListener('keydown', onKeyDown, true);
              overlay.removeEventListener('mousedown', onMouseDown);
              doc.removeEventListener('mousemove', onMouseMove, true);
              doc.removeEventListener('mouseup', onMouseUp, true);
              overlay.remove?.();
              if (this._activeCleanup === finishCancel) {
                this._activeCleanup = null;
              }
            };

            const finish = (result) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(result);
            };

            const finishCancel = () => finish(null);
            this._activeCleanup = finishCancel;

            const updateBox = (x1, y1, x2, y2) => {
              const left = Math.min(x1, x2);
              const top = Math.min(y1, y2);
              const width = Math.abs(x2 - x1);
              const height = Math.abs(y2 - y1);
              currentRect = { x: left, y: top, width, height };
              selBox.style.display = 'block';
              selBox.style.left = `${left}px`;
              selBox.style.top = `${top}px`;
              selBox.style.width = `${width}px`;
              selBox.style.height = `${height}px`;
              readout.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
            };

            const onMouseDown = (e) => {
              if (e.button !== undefined && e.button !== 0) return;
              e.preventDefault?.();
              e.stopPropagation?.();
              dragging = true;
              startX = Number(e.clientX || 0);
              startY = Number(e.clientY || 0);
              updateBox(startX, startY, startX, startY);
            };

            const onMouseMove = (e) => {
              if (!dragging) return;
              e.preventDefault?.();
              updateBox(startX, startY, Number(e.clientX || 0), Number(e.clientY || 0));
            };

            const onMouseUp = (e) => {
              if (!dragging) return;
              dragging = false;
              e.preventDefault?.();
              e.stopPropagation?.();
              updateBox(startX, startY, Number(e.clientX || 0), Number(e.clientY || 0));
              const normalized = this._normalizeRect(currentRect);
              if (!normalized || normalized.width < 8 || normalized.height < 8) {
                selBox.style.display = 'none';
                currentRect = null;
                return;
              }
              finish(normalized);
            };

            const onKeyDown = (e) => {
              if (e.key === 'Escape') {
                e.preventDefault?.();
                e.stopPropagation?.();
                finish(null);
              }
            };

            overlay.addEventListener('mousedown', onMouseDown);
            doc.addEventListener('mousemove', onMouseMove, true);
            doc.addEventListener('mouseup', onMouseUp, true);
            doc.addEventListener('keydown', onKeyDown, true);
          });
        }

        /** @private */
        _promptImageCropOverlay(srcCanvas, options = {}) {
          const doc = this._doc;
          const win = this._win;
          if (!doc || !doc.body || typeof doc.createElement !== 'function') {
            return Promise.resolve({ x: 0, y: 0, width: srcCanvas.width, height: srcCanvas.height });
          }

          this.cancelActiveOverlay();

          return new Promise((resolve) => {
            let settled = false;
            const vw = Math.max(320, Number(win?.innerWidth || 1280) - 80);
            const vh = Math.max(240, Number(win?.innerHeight || 720) - 140);
            const fitScale = Math.min(vw / srcCanvas.width, vh / srcCanvas.height, 1);
            const dispW = Math.max(1, Math.round(srcCanvas.width * fitScale));
            const dispH = Math.max(1, Math.round(srcCanvas.height * fitScale));

            const overlay = doc.createElement('div');
            overlay.id = 'shc-crop-overlay';
            overlay.setAttribute('data-shc-overlay', 'true');
            Object.assign(overlay.style, {
              position: 'fixed',
              inset: '0',
              zIndex: '2147483647',
              background: 'rgba(2, 6, 23, 0.86)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              fontFamily: 'system-ui, -apple-system, sans-serif',
              userSelect: 'none',
            });

            const header = doc.createElement('div');
            header.textContent = options.title || 'Drag on image to crop homework region • Esc to cancel';
            Object.assign(header.style, {
              color: '#f8fafc',
              fontSize: '13px',
              fontWeight: '600',
            });

            const stage = doc.createElement('div');
            Object.assign(stage.style, {
              position: 'relative',
              width: `${dispW}px`,
              height: `${dispH}px`,
              border: '1px solid rgba(148, 163, 184, 0.35)',
              boxShadow: '0 20px 50px rgba(0,0,0,0.55)',
              cursor: 'crosshair',
              overflow: 'hidden',
            });

            const previewCanvas = doc.createElement('canvas');
            previewCanvas.width = dispW;
            previewCanvas.height = dispH;
            previewCanvas.style.display = 'block';
            previewCanvas.style.width = `${dispW}px`;
            previewCanvas.style.height = `${dispH}px`;
            const pCtx = previewCanvas.getContext('2d');
            pCtx?.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, dispW, dispH);

            const selBox = doc.createElement('div');
            Object.assign(selBox.style, {
              position: 'absolute',
              display: 'none',
              border: '2px dashed #22d3ee',
              background: 'rgba(34, 211, 238, 0.14)',
              boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.5)',
              pointerEvents: 'none',
              boxSizing: 'border-box',
            });

            const dimLabel = doc.createElement('div');
            Object.assign(dimLabel.style, {
              position: 'absolute',
              top: '4px',
              left: '4px',
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'rgba(15, 23, 42, 0.9)',
              color: '#22d3ee',
              fontSize: '11px',
              fontFamily: 'ui-monospace, monospace',
            });
            selBox.appendChild(dimLabel);

            stage.appendChild(previewCanvas);
            stage.appendChild(selBox);

            const toolbar = doc.createElement('div');
            Object.assign(toolbar.style, { display: 'flex', gap: '8px', alignItems: 'center' });

            const makeBtn = (label, primary = false) => {
              const btn = doc.createElement('button');
              btn.type = 'button';
              btn.textContent = label;
              Object.assign(btn.style, {
                padding: '7px 14px',
                borderRadius: '8px',
                border: primary ? '1px solid #6366f1' : '1px solid rgba(148,163,184,0.35)',
                background: primary ? '#4f46e5' : '#1e293b',
                color: '#f8fafc',
                fontSize: '12.5px',
                fontWeight: '600',
                cursor: 'pointer',
              });
              return btn;
            };

            const applyBtn = makeBtn('Apply Crop', true);
            const fullBtn = makeBtn(options.allowFullFrame ? 'Use Full Frame' : 'Reset Selection');
            const cancelBtn = makeBtn('Cancel');

            toolbar.appendChild(applyBtn);
            toolbar.appendChild(fullBtn);
            toolbar.appendChild(cancelBtn);

            overlay.appendChild(header);
            overlay.appendChild(stage);
            overlay.appendChild(toolbar);
            doc.body.appendChild(overlay);

            let dragging = false;
            let sx = 0;
            let sy = 0;
            let activeDisplayRect = null;

            const cleanup = () => {
              doc.removeEventListener('keydown', onKeyDown, true);
              doc.removeEventListener('mousemove', onMouseMove, true);
              doc.removeEventListener('mouseup', onMouseUp, true);
              overlay.remove?.();
              if (this._activeCleanup === finishCancel) {
                this._activeCleanup = null;
              }
            };

            const finish = (rect) => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(rect);
            };

            const finishCancel = () => finish(null);
            this._activeCleanup = finishCancel;

            const toStageCoords = (e) => {
              const box = stage.getBoundingClientRect ? stage.getBoundingClientRect() : { left: 0, top: 0, width: dispW, height: dispH };
              const rx = Math.max(0, Math.min(dispW, Number(e.clientX || 0) - box.left));
              const ry = Math.max(0, Math.min(dispH, Number(e.clientY || 0) - box.top));
              return { x: rx, y: ry };
            };

            const renderSelection = (x1, y1, x2, y2) => {
              const left = Math.min(x1, x2);
              const top = Math.min(y1, y2);
              const width = Math.abs(x2 - x1);
              const height = Math.abs(y2 - y1);
              activeDisplayRect = { x: left, y: top, width, height };
              selBox.style.display = 'block';
              selBox.style.left = `${left}px`;
              selBox.style.top = `${top}px`;
              selBox.style.width = `${width}px`;
              selBox.style.height = `${height}px`;
              const realW = Math.max(1, Math.round(width / fitScale));
              const realH = Math.max(1, Math.round(height / fitScale));
              dimLabel.textContent = `${realW} × ${realH} px`;
            };

            const commitDisplayRect = () => {
              if (!activeDisplayRect || activeDisplayRect.width < 6 || activeDisplayRect.height < 6) {
                return { x: 0, y: 0, width: srcCanvas.width, height: srcCanvas.height };
              }
              return this._clampRectToBounds(
                {
                  x: Math.round(activeDisplayRect.x / fitScale),
                  y: Math.round(activeDisplayRect.y / fitScale),
                  width: Math.round(activeDisplayRect.width / fitScale),
                  height: Math.round(activeDisplayRect.height / fitScale),
                },
                srcCanvas.width,
                srcCanvas.height
              );
            };

            stage.addEventListener('mousedown', (e) => {
              if (e.button !== undefined && e.button !== 0) return;
              e.preventDefault?.();
              const pt = toStageCoords(e);
              dragging = true;
              sx = pt.x;
              sy = pt.y;
              renderSelection(sx, sy, sx, sy);
            });

            const onMouseMove = (e) => {
              if (!dragging) return;
              const pt = toStageCoords(e);
              renderSelection(sx, sy, pt.x, pt.y);
            };

            const onMouseUp = (e) => {
              if (!dragging) return;
              dragging = false;
              const pt = toStageCoords(e);
              renderSelection(sx, sy, pt.x, pt.y);
            };

            applyBtn.addEventListener('click', () => finish(commitDisplayRect()));
            fullBtn.addEventListener('click', () => {
              if (options.allowFullFrame) {
                finish({ x: 0, y: 0, width: srcCanvas.width, height: srcCanvas.height });
              } else {
                activeDisplayRect = null;
                selBox.style.display = 'none';
              }
            });
            cancelBtn.addEventListener('click', () => finish(null));

            const onKeyDown = (e) => {
              if (e.key === 'Escape') {
                e.preventDefault?.();
                e.stopPropagation?.();
                finish(null);
              } else if (e.key === 'Enter') {
                e.preventDefault?.();
                finish(commitDisplayRect());
              }
            };

            doc.addEventListener('mousemove', onMouseMove, true);
            doc.addEventListener('mouseup', onMouseUp, true);
            doc.addEventListener('keydown', onKeyDown, true);
          });
        }
      }

      // ===========================================================================
      // 4. MarkdownRenderer
      // ===========================================================================

      const LATEX_SYMBOLS = Object.freeze({
        alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
        zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
        lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
        sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ',
        psi: 'ψ', omega: 'ω',
        Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
        Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
        times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', ast: '∗',
        le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
        approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
        infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫',
        oint: '∮', forall: '∀', exists: '∃', nexists: '∄', empty: '∅', varnothing: '∅',
        in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
        cup: '∪', cap: '∩', land: '∧', lor: '∨', neg: '¬', lnot: '¬',
        rightarrow: '→', to: '→', leftarrow: '←', leftrightarrow: '↔',
        Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', iff: '⟺',
        deg: '°', angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵',
        ldots: '…', cdots: '⋯', vdots: '⋮',
      });

      const ALLOWED_HTML_TAGS = new Set([
        'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
        'sup', 'sub', 'small', 'mark', 'kbd', 'abbr', 'cite', 'q', 'blockquote',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'ul', 'ol', 'li', 'dl', 'dt', 'dd',
        'pre', 'code', 'button',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
        'a', 'img',
        // MathML + KaTeX structural tags
        'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace',
        'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover', 'munder',
        'munderover', 'mtable', 'mtr', 'mtd', 'annotation', 'annotation-xml',
        // Safe SVG primitives used by KaTeX
        'svg', 'g', 'path', 'line', 'rect', 'circle', 'polygon',
      ]);

      const STRIP_CONTENT_TAGS = new Set([
        'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed',
        'applet', 'noscript', 'template', 'xmp', 'noembed', 'title', 'textarea',
      ]);

      const GLOBAL_ALLOWED_ATTRS = new Set([
        'class', 'id', 'title', 'role', 'dir', 'lang', 'style',
        'aria-hidden', 'aria-label', 'aria-labelledby',
        'data-code-copy', 'data-math-fallback',
      ]);

      const TAG_ALLOWED_ATTRS = Object.freeze({
        a: new Set(['href', 'target', 'rel']),
        img: new Set(['src', 'alt', 'width', 'height']),
        button: new Set(['type', 'disabled']),
        ol: new Set(['start', 'type', 'reversed']),
        li: new Set(['value']),
        td: new Set(['colspan', 'rowspan', 'align']),
        th: new Set(['colspan', 'rowspan', 'align', 'scope']),
        math: new Set(['xmlns', 'display']),
        mspace: new Set(['width', 'height', 'depth']),
        annotation: new Set(['encoding']),
        svg: new Set(['xmlns', 'viewbox', 'width', 'height', 'preserveaspectratio', 'focusable']),
        path: new Set(['d', 'fill', 'stroke', 'stroke-width']),
        line: new Set(['x1', 'y1', 'x2', 'y2', 'stroke', 'stroke-width']),
        rect: new Set(['x', 'y', 'width', 'height', 'fill', 'stroke']),
        circle: new Set(['cx', 'cy', 'r', 'fill', 'stroke']),
        polygon: new Set(['points', 'fill', 'stroke']),
        g: new Set(['transform', 'fill', 'stroke']),
      });

      const SAFE_CSS_PROPS = new Set([
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius',
        'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
        'top', 'right', 'bottom', 'left', 'vertical-align', 'position', 'display',
        'font-size', 'font-style', 'font-weight', 'font-family', 'line-height',
        'text-align', 'color', 'background', 'background-color', 'transform', 'white-space',
      ]);

      /**
       * Renders Markdown + LaTeX math safely with `marked`, `katex`, and `DOMPurify`,
       * plus built-in pure-JS Markdown parser, math formatter, and allowlist HTML sanitizer fallbacks.
       */
      class MarkdownRenderer {
        /**
         * @param {Object} [options]
         */
        constructor(options = {}) {
          this._marked = options.marked;
          this._domPurify = options.DOMPurify;
          this._katex = options.katex;
          this._useMarked = options.useMarked !== false;
          this._useDOMPurify = options.useDOMPurify !== false;
          this._useKatex = options.useKatex !== false;
          this._nonceCounter = 0;
        }

        /**
         * Convenience static render method.
         * @param {string} markdown
         * @param {Object} [options]
         * @returns {string}
         */
        static render(markdown, options = {}) {
          if (!MarkdownRenderer._defaultInstance) {
            MarkdownRenderer._defaultInstance = new MarkdownRenderer();
          }
          return MarkdownRenderer._defaultInstance.render(markdown, options);
        }

        /**
         * Convenience static sanitizer method.
         * @param {string} html
         * @param {Object} [options]
         * @returns {string}
         */
        static sanitizeHtml(html, options = {}) {
          if (!MarkdownRenderer._defaultInstance) {
            MarkdownRenderer._defaultInstance = new MarkdownRenderer();
          }
          return MarkdownRenderer._defaultInstance.sanitizeHtml(html, options);
        }

        /** @private */
        _resolveMarked(options = {}) {
          if (options.useMarked === false || !this._useMarked) return null;
          const m = options.marked ?? this._marked ?? resolveGlobal('marked');
          if (!m) return null;
          if (typeof m.parse === 'function') return m;
          if (m.marked && typeof m.marked.parse === 'function') return m.marked;
          if (typeof m === 'function') return { parse: m };
          return null;
        }

        /** @private */
        _resolveDOMPurify(options = {}) {
          if (options.useDOMPurify === false || !this._useDOMPurify) return null;
          const dp = options.DOMPurify ?? this._domPurify ?? resolveGlobal('DOMPurify');
          if (!dp) return null;
          if (typeof dp.sanitize === 'function') return dp;
          if (typeof dp === 'function') {
            try {
              const win = resolveGlobal('window');
              const inst = win ? dp(win) : null;
              if (inst && typeof inst.sanitize === 'function') return inst;
            } catch (_) {}
          }
          return null;
        }

        /** @private */
        _resolveKatex(options = {}) {
          if (options.useKatex === false || !this._useKatex) return null;
          const kx = options.katex ?? this._katex ?? resolveGlobal('katex');
          if (kx && typeof kx.renderToString === 'function') return kx;
          return null;
        }

        /**
         * Renders Markdown text (with protected LaTeX math and code blocks) into sanitized HTML.
         * @param {string} markdown
         * @param {Object} [options]
         * @returns {string}
         */
        render(markdown, options = {}) {
          const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
          if (!source.trim()) return '';

          const nonce = `N${(++this._nonceCounter).toString(36)}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
          const { maskedText, mathEntries } = this._protectMath(source, nonce);

          const markedImpl = this._resolveMarked(options);
          let rawHtml = '';
          if (markedImpl) {
            rawHtml = this._renderWithMarked(markedImpl, maskedText);
          } else {
            rawHtml = this._renderFallbackMarkdown(maskedText);
          }

          const katexImpl = this._resolveKatex(options);
          const restoredHtml = this._restoreMath(rawHtml, mathEntries, katexImpl);
          return this.sanitizeHtml(restoredHtml, options);
        }

        /**
         * Sanitizes HTML using DOMPurify (if available/enabled) followed by strict XSS verification,
         * or the built-in stateful allowlist sanitizer if DOMPurify is absent/disabled.
         * @param {string} html
         * @param {Object} [options]
         * @returns {string}
         */
        sanitizeHtml(html, options = {}) {
          const input = String(html ?? '');
          if (!input) return '';

          const purify = this._resolveDOMPurify(options);
          if (purify) {
            try {
              const purified = purify.sanitize(input, {
                USE_PROFILES: { html: true, mathMl: true, svg: true },
                ADD_TAGS: [...ALLOWED_HTML_TAGS],
                ADD_ATTR: ['data-code-copy', 'data-math-fallback', 'target', 'rel', 'aria-label', 'aria-hidden', 'xmlns', 'display', 'encoding', 'style'],
                FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'textarea', 'select'],
                FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'formaction'],
              });
              // Second defense-in-depth pass in case a minimal mock DOMPurify misses encoded XSS vectors
              return this._fallbackSanitizeHtml(purified);
            } catch (_) {
              return this._fallbackSanitizeHtml(input);
            }
          }

          return this._fallbackSanitizeHtml(input);
        }

        /**
         * Protects LaTeX math outside code blocks/inline code spans before Markdown runs.
         * @private
         */
        _protectMath(text, nonce) {
          const mathEntries = [];
          const addMath = (expr, displayMode) => {
            const idx = mathEntries.length;
            const token = `SHCMATH${nonce}M${idx}TOKEN`;
            mathEntries.push({ token, expr: expr.trim(), displayMode });
            return token;
          };

          const out = [];
          let i = 0;
          const len = text.length;

          const isLineStart = (pos) => pos === 0 || text[pos - 1] === '\n';

          while (i < len) {
            // 1. Skip fenced code blocks (``` or ~~~) untouched
            if (isLineStart(i)) {
              const lineRest = text.slice(i);
              const fenceMatch = lineRest.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
              if (fenceMatch) {
                const fenceChar = fenceMatch[1][0];
                const fenceLen = fenceMatch[1].length;
                const endHeader = text.indexOf('\n', i);
                if (endHeader === -1) {
                  out.push(text.slice(i));
                  break;
                }
                const closeRe = new RegExp(`\\n[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*(?:\\n|$)`);
                const restAfterHeader = text.slice(endHeader);
                const closeMatch = restAfterHeader.match(closeRe);
                if (closeMatch) {
                  const blockEnd = endHeader + closeMatch.index + closeMatch[0].length;
                  out.push(text.slice(i, blockEnd));
                  i = blockEnd;
                  continue;
                } else {
                  out.push(text.slice(i));
                  break;
                }
              }
            }

            // 2. Skip inline code spans (`...`) untouched
            if (text[i] === '`') {
              let tickCount = 0;
              while (i + tickCount < len && text[i + tickCount] === '`') tickCount++;
              const closeIdx = this._findClosingBackticks(text, i + tickCount, tickCount);
              if (closeIdx !== -1) {
                out.push(text.slice(i, closeIdx + tickCount));
                i = closeIdx + tickCount;
                continue;
              }
              out.push(text.slice(i, i + tickCount));
              i += tickCount;
              continue;
            }

            // 3. Escaped characters (\$ etc.)
            if (text[i] === '\\') {
              const next = text[i + 1];
              // \[ ... \] display math
              if (next === '[') {
                const close = this._findUnescapedDelim(text, i + 2, '\\]');
                if (close !== -1) {
                  out.push(addMath(text.slice(i + 2, close), true));
                  i = close + 2;
                  continue;
                }
              }
              // \( ... \) inline math
              if (next === '(') {
                const close = this._findUnescapedDelim(text, i + 2, '\\)');
                if (close !== -1) {
                  out.push(addMath(text.slice(i + 2, close), false));
                  i = close + 2;
                  continue;
                }
              }
              // Keep escaped sequence
              if (next !== undefined) {
                out.push(text.slice(i, i + 2));
                i += 2;
                continue;
              }
            }

            // 4. $$ ... $$ display math
            if (text[i] === '$' && text[i + 1] === '$') {
              const close = this._findUnescapedDelim(text, i + 2, '$$');
              if (close !== -1) {
                out.push(addMath(text.slice(i + 2, close), true));
                i = close + 2;
                continue;
              }
            }

            // 5. $ ... $ inline math (currency-safe Pandoc rule)
            if (text[i] === '$' && text[i + 1] !== '$') {
              const afterOpen = text[i + 1];
              if (afterOpen && !/\s/.test(afterOpen) && afterOpen !== '\n') {
                const close = this._findInlineDollarEnd(text, i + 1);
                if (close !== -1) {
                  out.push(addMath(text.slice(i + 1, close), false));
                  i = close + 1;
                  continue;
                }
              }
            }

            out.push(text[i]);
            i++;
          }

          return { maskedText: out.join(''), mathEntries };
        }

        /** @private */
        _findClosingBackticks(text, start, count) {
          let i = start;
          while (i < text.length) {
            if (text[i] === '`') {
              let run = 0;
              while (i + run < text.length && text[i + run] === '`') run++;
              if (run === count) return i;
              i += run;
            } else {
              i++;
            }
          }
          return -1;
        }

        /** @private */
        _findUnescapedDelim(text, start, delim) {
          let i = start;
          while (i < text.length) {
            if (text[i] === '\\') {
              if (delim.startsWith('\\') && text.startsWith(delim, i)) {
                return i;
              }
              i += 2;
              continue;
            }
            if (text.startsWith(delim, i)) {
              return i;
            }
            i++;
          }
          return -1;
        }

        /** @private */
        _findInlineDollarEnd(text, start) {
          let i = start;
          while (i < text.length) {
            if (text[i] === '\\') {
              i += 2;
              continue;
            }
            if (text[i] === '\n' && text[i + 1] === '\n') {
              return -1;
            }
            if (text[i] === '$') {
              if (text[i + 1] === '$') return -1;
              const beforeClose = text[i - 1];
              const afterClose = text[i + 1];
              if (beforeClose && !/\s/.test(beforeClose) && !(afterClose && /[0-9]/.test(afterClose))) {
                return i;
              }
              return -1;
            }
            i++;
          }
          return -1;
        }

        /** @private */
        _restoreMath(html, mathEntries, katexImpl) {
          let out = html;
          for (const entry of mathEntries) {
            const rendered = this._renderSingleMath(entry.expr, entry.displayMode, katexImpl);
            out = out.split(entry.token).join(rendered);
          }
          return out;
        }

        /** @private */
        _renderSingleMath(expr, displayMode, katexImpl) {
          if (katexImpl) {
            try {
              const html = katexImpl.renderToString(expr, {
                displayMode: Boolean(displayMode),
                output: 'htmlAndMathml',
                throwOnError: false,
                strict: false,
                trust: false,
              });
              if (displayMode && !html.includes('katex-display')) {
                return `<div class="katex-display">${html}</div>`;
              }
              return html;
            } catch (_) {}
          }
          return this._renderFallbackMath(expr, displayMode);
        }

        /**
         * Pure-JS math formatter fallback when KaTeX is unavailable.
         * Escapes input before substituting safe superscripts/subscripts/symbols.
         * @private
         */
        _renderFallbackMath(expr, displayMode) {
          let s = escapeHtml(expr);
          // Replace known LaTeX commands with Unicode math symbols
          s = s.replace(/\\([a-zA-Z]+)/g, (full, name) => {
            if (LATEX_SYMBOLS[name]) return LATEX_SYMBOLS[name];
            if (name === 'text' || name === 'mathrm' || name === 'mathbf') return '';
            return full;
          });
          // Superscripts & subscripts first so nested exponents inside \frac / \sqrt convert cleanly
          s = s.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>');
          s = s.replace(/\^([A-Za-z0-9])/g, '<sup>$1</sup>');
          s = s.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>');
          s = s.replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>');
          // \frac{a}{b} (iterate to support shallow nesting)
          for (let pass = 0; pass < 3 && s.includes('\\frac{'); pass++) {
            s = s.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '<span class="shc-math-frac">($1)/($2)</span>');
          }
          // \sqrt{x}
          for (let pass = 0; pass < 3 && s.includes('\\sqrt{'); pass++) {
            s = s.replace(/\\sqrt\{([^{}]+)\}/g, '√($1)');
          }
          // Clean remaining simple braces
          s = s.replace(/[{}]/g, '');

          if (displayMode) {
            return `<div class="shc-math shc-math-block" data-math-fallback="true">${s}</div>`;
          }
          return `<span class="shc-math shc-math-inline" data-math-fallback="true">${s}</span>`;
        }

        /** @private */
        _formatCodeBlockHtml(codeText, langRaw) {
          const safeLangMatch = String(langRaw || '').trim().match(/^[A-Za-z0-9_+#.-]+/);
          const lang = safeLangMatch ? safeLangMatch[0] : 'text';
          const escapedCode = escapeHtml(codeText);
          return (
            `<div class="shc-code-block">` +
            `<div class="shc-code-header">` +
            `<span class="shc-code-lang">${escapeHtml(lang)}</span>` +
            `<button type="button" class="shc-code-copy-btn" data-code-copy="true" aria-label="Copy code">Copy</button>` +
            `</div>` +
            `<pre style="margin:0;border:0;border-radius:0;background:transparent;"><code class="language-${escapeAttr(lang)}">${escapedCode}</code></pre>` +
            `</div>`
          );
        }

        /** @private */
        _renderWithMarked(markedImpl, text) {
          try {
            const self = this;
            const renderer = {
              code(tokenOrCode, maybeLang) {
                if (tokenOrCode && typeof tokenOrCode === 'object') {
                  return self._formatCodeBlockHtml(tokenOrCode.text ?? '', tokenOrCode.lang ?? '');
                }
                return self._formatCodeBlockHtml(tokenOrCode ?? '', maybeLang ?? '');
              },
            };
            if (typeof markedImpl.use === 'function' && typeof markedImpl.Marked === 'function') {
              const inst = new markedImpl.Marked({ gfm: true, breaks: true, renderer });
              return inst.parse(text);
            }
            return markedImpl.parse(text, { gfm: true, breaks: true, renderer });
          } catch (_) {
            return this._renderFallbackMarkdown(text);
          }
        }

        /**
         * Built-in pure-JS Markdown parser fallback supporting fenced code blocks, headings,
         * lists, GFM tables, blockquotes, horizontal rules, inline code, bold, italic, and links.
         * @private
         */
        _renderFallbackMarkdown(text) {
          const lines = text.split('\n');
          const blocks = [];
          let i = 0;

          const isTableSep = (line) =>
            /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line) && line.includes('|');

          const splitTableRow = (line) => {
            let s = line.trim();
            if (s.startsWith('|')) s = s.slice(1);
            if (s.endsWith('|')) s = s.slice(0, -1);
            return s.split('|').map((cell) => cell.trim());
          };

          const isBlockBoundary = (line) => {
            const t = line.trim();
            if (!t) return true;
            if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(line)) return true;
            if (/^#{1,6}\s+/.test(t)) return true;
            if (/^>\s?/.test(t)) return true;
            if (/^([-*_])\1{2,}\s*$/.test(t)) return true;
            if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) return true;
            return false;
          };

          while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) {
              i++;
              continue;
            }

            // 1. Fenced code block
            const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
            if (fenceMatch) {
              const fenceChar = fenceMatch[1][0];
              const fenceLen = fenceMatch[1].length;
              const lang = fenceMatch[2].trim();
              const codeLines = [];
              i++;
              const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
              while (i < lines.length && !closeRe.test(lines[i])) {
                codeLines.push(lines[i]);
                i++;
              }
              if (i < lines.length) i++;
              blocks.push(this._formatCodeBlockHtml(codeLines.join('\n'), lang));
              continue;
            }

            // 2. Headings (# - ######)
            const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
            if (headingMatch) {
              const level = headingMatch[1].length;
              blocks.push(`<h${level}>${this._renderInlineMarkdown(headingMatch[2].replace(/\s+#+\s*$/, ''))}</h${level}>`);
              i++;
              continue;
            }

            // 3. Horizontal rule
            if (/^([-*_])(?:\s*\1){2,}\s*$/.test(trimmed)) {
              blocks.push('<hr>');
              i++;
              continue;
            }

            // 4. Blockquote
            if (/^>\s?/.test(trimmed)) {
              const quoteLines = [];
              while (i < lines.length && (/^>\s?/.test(lines[i].trim()) || (lines[i].trim() !== '' && quoteLines.length > 0 && !isBlockBoundary(lines[i])))) {
                quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
                i++;
              }
              blocks.push(`<blockquote>${this._renderFallbackMarkdown(quoteLines.join('\n'))}</blockquote>`);
              continue;
            }

            // 5. GFM Table
            if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
              const headers = splitTableRow(line);
              const aligns = splitTableRow(lines[i + 1]).map((sep) => {
                if (sep.startsWith(':') && sep.endsWith(':')) return 'center';
                if (sep.endsWith(':')) return 'right';
                if (sep.startsWith(':')) return 'left';
                return '';
              });
              i += 2;
              const rows = [];
              while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(splitTableRow(lines[i]));
                i++;
              }
              const thead = `<thead><tr>${headers
                .map((h, idx) => `<th${aligns[idx] ? ` align="${aligns[idx]}"` : ''}>${this._renderInlineMarkdown(h)}</th>`)
                .join('')}</tr></thead>`;
              const tbody = rows.length
                ? `<tbody>${rows
                    .map(
                      (r) =>
                        `<tr>${headers
                          .map((_, idx) => `<td${aligns[idx] ? ` align="${aligns[idx]}"` : ''}>${this._renderInlineMarkdown(r[idx] ?? '')}</td>`)
                          .join('')}</tr>`
                    )
                    .join('')}</tbody>`
                : '';
              blocks.push(`<table>${thead}${tbody}</table>`);
              continue;
            }

            // 6. Ordered or unordered list
            const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
            const olMatch = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
            if (ulMatch || olMatch) {
              const { html, nextIndex } = this._parseListBlock(lines, i);
              blocks.push(html);
              i = nextIndex;
              continue;
            }

            // 7. Paragraph
            const paraLines = [];
            while (i < lines.length) {
              if (!lines[i].trim()) break;
              if (paraLines.length > 0 && isBlockBoundary(lines[i])) break;
              if (lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
              paraLines.push(lines[i]);
              i++;
            }
            if (paraLines.length > 0) {
              blocks.push(`<p>${paraLines.map((l) => this._renderInlineMarkdown(l)).join('<br>')}</p>`);
            }
          }

          return blocks.join('\n');
        }

        /** @private */
        _parseListBlock(lines, startIndex) {
          const firstLine = lines[startIndex];
          const baseIndent = (firstLine.match(/^(\s*)/) || ['', ''])[1].length;
          const isOrdered = /^\s*\d+[.)]\s+/.test(firstLine);
          const tag = isOrdered ? 'ol' : 'ul';
          const itemRe = isOrdered ? /^(\s*)\d+[.)]\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
          const anyListRe = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;

          const items = [];
          let i = startIndex;

          while (i < lines.length) {
            const line = lines[i];
            if (!line.trim()) {
              // Stop list on blank line unless next non-empty line continues same list level
              if (i + 1 >= lines.length || !itemRe.test(lines[i + 1])) break;
              i++;
              continue;
            }
            const m = line.match(itemRe);
            const anyM = line.match(anyListRe);
            const indent = (line.match(/^(\s*)/) || ['', ''])[1].length;

            if (m && indent === baseIndent) {
              const contentParts = [this._renderInlineMarkdown(m[2])];
              i++;
              while (i < lines.length) {
                const sub = lines[i];
                if (!sub.trim()) break;
                const subListM = sub.match(anyListRe);
                const subIndent = (sub.match(/^(\s*)/) || ['', ''])[1].length;
                if (subListM && subIndent > baseIndent) {
                  const nested = this._parseListBlock(lines, i);
                  contentParts.push(nested.html);
                  i = nested.nextIndex;
                } else if (!subListM && subIndent > baseIndent) {
                  contentParts.push(this._renderInlineMarkdown(sub.trim()));
                  i++;
                } else {
                  break;
                }
              }
              items.push(`<li>${contentParts.join(' ')}</li>`);
            } else if (anyM && indent > baseIndent && items.length > 0) {
              const nested = this._parseListBlock(lines, i);
              items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, ` ${nested.html}</li>`);
              i = nested.nextIndex;
            } else {
              break;
            }
          }

          return { html: `<${tag}>${items.join('')}</${tag}>`, nextIndex: i };
        }

        /** @private */
        _renderInlineMarkdown(text) {
          let s = String(text ?? '');
          // 1. Protect inline code spans first so HTML/Markdown inside `...` stays literal
          const codeSpans = [];
          s = s.replace(/(`+)([^`]*?)\1/g, (_, ticks, code) => {
            const token = `SHCINLINECODE${codeSpans.length}Z`;
            codeSpans.push({ token, html: `<code>${escapeHtml(code.trim())}</code>` });
            return token;
          });

          // 2. Preserve raw HTML tags temporarily so final sanitizeHtml() strips XSS tags/attrs cleanly
          const rawHtmlTokens = [];
          s = s.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g, (tag) => {
            const token = `SHCRAWHTML${rawHtmlTokens.length}Z`;
            rawHtmlTokens.push({ token, html: tag });
            return token;
          });

          // 3. Escape stray <, >, & in plain prose (e.g. "x < 5")
          s = escapeHtml(s);

          // Links: [label](url)
          s = s.replace(/\[([^\]]+)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g, (_, label, rawHref) => {
            const href = rawHref.replace(/\s+"[^"]*"$/, '').trim();
            const safeUrl = this._sanitizeUrl(href, false);
            if (!safeUrl) return label;
            return `<a href="${escapeAttr(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
          });

          // Bold + Italic
          s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
          s = s.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
          // Bold
          s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
          s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
          // Italic
          s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
          s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
          // Strikethrough
          s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

          // Restore raw HTML tags (will be strictly sanitized by sanitizeHtml())
          for (const raw of rawHtmlTokens) {
            s = s.split(raw.token).join(raw.html);
          }

          // Restore inline code spans
          for (const span of codeSpans) {
            s = s.split(span.token).join(span.html);
          }

          return s;
        }

        /** @private */
        _sanitizeUrl(rawUrl, isImageSrc = false) {
          if (typeof rawUrl !== 'string') return '';
          const decoded = decodeHtmlEntities(rawUrl);
          // Remove ASCII control characters & whitespace before protocol check
          const stripped = decoded.replace(/[\u0000-\u0020\u007f]+/g, '');
          if (!stripped) return '';
          if (stripped.startsWith('#') || (stripped.startsWith('/') && !stripped.startsWith('//'))) {
            return stripped;
          }
          const lower = stripped.toLowerCase();
          if (isImageSrc) {
            if (/^data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/i.test(stripped)) {
              return stripped;
            }
            if (lower.startsWith('https://') || lower.startsWith('http://')) {
              return decoded.trim();
            }
            return '';
          }
          if (lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('mailto:')) {
            return decoded.trim();
          }
          return '';
        }

        /** @private */
        _sanitizeStyle(rawStyle) {
          if (typeof rawStyle !== 'string') return '';
          const decoded = decodeHtmlEntities(rawStyle);
          const lower = decoded.toLowerCase();
          if (lower.includes('expression(') || lower.includes('javascript:') || lower.includes('vbscript:') || lower.includes('url(') || lower.includes('@import') || lower.includes('behavior')) {
            return '';
          }
          const safeDecls = [];
          for (const decl of decoded.split(';')) {
            const colon = decl.indexOf(':');
            if (colon === -1) continue;
            const prop = decl.slice(0, colon).trim().toLowerCase();
            const val = decl.slice(colon + 1).trim();
            if (!SAFE_CSS_PROPS.has(prop)) continue;
            if (!val || /[<>{}]/.test(val)) continue;
            safeDecls.push(`${prop}:${val}`);
          }
          return safeDecls.join(';');
        }

        /**
         * Stateful HTML tokenizer + strict allowlist sanitizer (works in both Node and browser).
         * Strips dangerous tags (`script`, `iframe`, `style`, `object`, `embed`, etc.),
         * all `on*` event handlers, unsafe URI schemes (`javascript:`, `vbscript:`, `data:text/html`),
         * and HTML comments.
         * @private
         */
        _fallbackSanitizeHtml(html) {
          const src = String(html ?? '');
          const out = [];
          let i = 0;
          const len = src.length;
          let skipUntilClosingTag = null;

          while (i < len) {
            const lt = src.indexOf('<', i);
            if (lt === -1) {
              if (!skipUntilClosingTag) {
                out.push(src.slice(i));
              }
              break;
            }

            if (lt > i && !skipUntilClosingTag) {
              out.push(src.slice(i, lt));
            }

            // HTML comment <!-- ... -->
            if (src.startsWith('<!--', lt)) {
              const endComment = src.indexOf('-->', lt + 4);
              i = endComment === -1 ? len : endComment + 3;
              continue;
            }

            const parsedTag = this._readTagToken(src, lt);
            if (!parsedTag) {
              if (!skipUntilClosingTag) out.push('&lt;');
              i = lt + 1;
              continue;
            }

            const { tagName, isClosing, selfClosing, rawAttrs, nextIndex } = parsedTag;
            i = nextIndex;

            if (skipUntilClosingTag) {
              if (isClosing && tagName === skipUntilClosingTag) {
                skipUntilClosingTag = null;
              }
              continue;
            }

            if (STRIP_CONTENT_TAGS.has(tagName)) {
              if (!isClosing && !selfClosing) {
                skipUntilClosingTag = tagName;
              }
              continue;
            }

            if (!ALLOWED_HTML_TAGS.has(tagName)) {
              // Drop disallowed tag markup cleanly while preserving safe inner text
              continue;
            }

            if (isClosing) {
              out.push(`</${tagName}>`);
              continue;
            }

            const sanitizedAttrs = this._sanitizeTagAttributes(tagName, rawAttrs);
            if (tagName === 'a' && sanitizedAttrs.some((a) => a.startsWith('href="'))) {
              if (!sanitizedAttrs.some((a) => a.startsWith('rel="'))) {
                sanitizedAttrs.push('rel="noopener noreferrer"');
              }
            }
            const attrPart = sanitizedAttrs.length > 0 ? ' ' + sanitizedAttrs.join(' ') : '';
            out.push(`<${tagName}${attrPart}${selfClosing ? ' /' : ''}>`);
          }

          return out.join('');
        }

        /** @private */
        _readTagToken(src, ltIndex) {
          const len = src.length;
          let p = ltIndex + 1;
          let isClosing = false;
          if (src[p] === '/') {
            isClosing = true;
            p++;
          }
          const nameStart = p;
          while (p < len && /[A-Za-z0-9:-]/.test(src[p])) p++;
          if (p === nameStart) return null;
          const tagName = src.slice(nameStart, p).toLowerCase();

          let quote = null;
          const attrStart = p;
          while (p < len) {
            const ch = src[p];
            if (quote) {
              if (ch === quote) quote = null;
            } else {
              if (ch === '"' || ch === "'") quote = ch;
              else if (ch === '>') break;
            }
            p++;
          }
          if (p >= len) return null;

          let rawAttrs = src.slice(attrStart, p);
          let selfClosing = false;
          if (!isClosing && /\/\s*$/.test(rawAttrs)) {
            selfClosing = true;
            rawAttrs = rawAttrs.replace(/\/\s*$/, '');
          }

          return { tagName, isClosing, selfClosing, rawAttrs, nextIndex: p + 1 };
        }

        /** @private */
        _sanitizeTagAttributes(tagName, rawAttrs) {
          const out = [];
          const tagSpecific = TAG_ALLOWED_ATTRS[tagName] || null;
          const attrRe = /([A-Za-z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
          let match;

          while ((match = attrRe.exec(rawAttrs)) !== null) {
            const attrName = match[1].toLowerCase();
            const attrVal = match[2] ?? match[3] ?? match[4] ?? '';

            // Strip all inline event handlers (on*)
            if (attrName.startsWith('on')) continue;

            const isAllowed = GLOBAL_ALLOWED_ATTRS.has(attrName) || (tagSpecific && tagSpecific.has(attrName));
            if (!isAllowed) continue;

            if (attrName === 'href') {
              const safeHref = this._sanitizeUrl(attrVal, false);
              if (!safeHref) continue;
              out.push(`href="${escapeAttr(safeHref)}"`);
              continue;
            }

            if (attrName === 'src') {
              const safeSrc = this._sanitizeUrl(attrVal, tagName === 'img');
              if (!safeSrc) continue;
              out.push(`src="${escapeAttr(safeSrc)}"`);
              continue;
            }

            if (attrName === 'style') {
              const safeStyle = this._sanitizeStyle(attrVal);
              if (!safeStyle) continue;
              out.push(`style="${escapeAttr(safeStyle)}"`);
              continue;
            }

            if (tagName === 'button' && attrName === 'type') {
              out.push('type="button"');
              continue;
            }

            if (attrName === 'target') {
              if (attrVal === '_blank' || attrVal === '_self') {
                out.push(`target="${attrVal}"`);
              }
              continue;
            }

            out.push(match[2] !== undefined || match[3] !== undefined || match[4] !== undefined
              ? `${attrName}="${escapeAttr(decodeHtmlEntities(attrVal))}"`
              : attrName);
          }

          return out;
        }
      }

      // ===========================================================================
      // Attach to SHC Namespace & Export for Node.js
      // ===========================================================================

      SHC.HotkeyManager = HotkeyManager;
      SHC.ImageProcessor = ImageProcessor;
      SHC.CaptureManager = CaptureManager;
      SHC.MarkdownRenderer = MarkdownRenderer;

      if (typeof module !== 'undefined' && module.exports) {
        module.exports = SHC;
      }
    })(
      typeof globalThis !== 'undefined'
        ? globalThis
        : typeof window !== 'undefined'
          ? window
          : this,
      (function () {
        try {
          return typeof SHC !== 'undefined' ? SHC : undefined;
        } catch (_) {
          return undefined;
        }
      })()
    );
  }).call(globalScope, globalScope, undefined, undefined);

  // =========================================================================
  // Module: src/ui-shell.js
  // =========================================================================
  (function (globalScope, module, exports) {
    /**
     * Smart Homework Capture (Groq Edition) — UI Shell & Application Orchestrator
     *
     * Implements:
     *  - UIManager: Shadow DOM isolated dark/light AI assistant UI with Header,
     *    Collapsible Sidebar, Incremental Conversation View, Multi-Image Staging Tray,
     *    Composer, Status Bar, API Key Manager, 6-Section Settings Page, and Lightbox.
     *  - AppCore: Coordinates Core Engine, Capture/Render modules, and UIManager.
     *
     * Compatible with Tampermonkey/Userscript IIFE bundles, browser globals, and Node.js tests.
     */
    (function (root, existingSHC) {
      'use strict';

      const SHC = existingSHC || (root.SHC = root.SHC || {});

      const HOST_ID = 'shc-host-root';
      const KATEX_VERSION = '0.19.1';
      const KATEX_FONTS_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/fonts/`;

      // ---------------------------------------------------------------------------
      // Localization Dictionary (Vietnamese default + English)
      // ---------------------------------------------------------------------------

      const I18N = {
        vi: {
          appTitle: 'Smart Homework Capture',
          sidebarToggle: 'Lịch sử hội thoại',
          newChat: 'Cuộc trò chuyện mới',
          apiKeysBtn: 'API Keys',
          settingsBtn: 'Cài đặt',
          minimizeBtn: 'Thu gọn',
          closeBtn: 'Đóng (Insert)',
          restoreBtn: 'Mở rộng',
          quickCaptureBtn: 'Chụp nhanh',
          conversationsTitle: 'Lịch sử bài tập',
          exportJson: 'Xuất JSON',
          exportMd: 'Xuất Markdown',
          clearAllHistory: 'Xóa toàn bộ',
          confirmClearAll: 'Xác nhận xóa hết?',
          rename: 'Đổi tên',
          delete: 'Xóa',
          cancel: 'Hủy',
          save: 'Lưu',
          welcomeTitle: 'Chụp đề bài & Giải chi tiết với Groq AI',
          welcomeDesc:
            'Nhấn "Chụp bài tập" (hoặc phím Insert) để chọn vùng đề bài trên trang web, dán ảnh Ctrl+V, kéo thả hoặc tải ảnh lên rồi gửi cho AI.',
          welcomeNoKey: 'Bạn chưa cấu hình Groq API Key. Thêm key để bắt đầu gửi câu hỏi.',
          openKeyManager: 'Mở Trình quản lý API Key',
          captureExercise: 'Chụp bài tập',
          captureDomOption: 'DOM Capture (html2canvas-pro)',
          captureDomDesc: 'Chụp DOM nhanh trên trang; có thể hạn chế với iframe cross-origin / WebGL.',
          captureScreenOption: 'Screen Capture (Tab / Màn hình)',
          captureScreenDesc: 'Chụp khung hình thật qua trình duyệt rồi cắt vùng cần giải.',
          attachImage: 'Đính kèm ảnh',
          send: 'Gửi',
          cancelGen: 'Dừng tạo',
          composerPlaceholder:
            'Nhập câu hỏi hoặc ghi chú (Enter để gửi, Shift+Enter xuống dòng, Ctrl+V để dán ảnh)...',
          dropOverlay: 'Thả ảnh PNG / JPG / WEBP vào đây để đính kèm',
          stagingTitle: 'Ảnh chờ gửi',
          sendToAi: 'Gửi tới AI',
          captureAgain: 'Chụp lại',
          clearStaged: 'Xóa tất cả',
          zoom: 'Phóng to',
          cropAgain: 'Cắt lại',
          moveLeft: 'Sang trái',
          moveRight: 'Sang phải',
          replaceImage: 'Thay ảnh',
          removeImage: 'Gỡ bỏ',
          thinkingLabel: 'Quá trình suy luận (Reasoning)',
          thinkingLive: 'Đang suy luận...',
          copyResponse: 'Sao chép',
          copied: 'Đã chép!',
          retryResponse: 'Thử lại',
          deleteMessage: 'Xóa tin nhắn',
          imagePlaceholder: '[Ảnh đã đính kèm trong phiên trước]',
          copyCode: 'Chép code',
          switchToVision: 'Chuyển sang Vision Model',
          tryScreenCapture: 'Thử Screen Capture',
          dismiss: 'Ẩn',
          statusIdle: 'Sẵn sàng',
          statusSending: 'Đang gửi...',
          statusStreaming: 'Đang trả lời...',
          statusFailover: 'Đang chuyển key...',
          statusRetrying: 'Đang thử lại...',
          statusCooldown: 'Tạm chờ giới hạn',
          statusError: 'Lỗi yêu cầu',
          connUnconfigured: 'Chưa có key',
          connUntested: 'Chưa kiểm tra',
          connConnected: 'Đã kết nối Groq',
          connRateLimited: 'Giới hạn tốc độ',
          connError: 'Lỗi kết nối',
          noActiveKeyShort: 'Chưa có API Key',
          // API Key Manager
          keysTitle: 'Quản lý Groq API Keys',
          keysBackChat: 'Quay lại Chat',
          keysSecurityNotice:
            'Lưu ý bảo mật: Tampermonkey lưu khóa trong bộ nhớ cục bộ của tiện ích (GM_setValue), KHÔNG phải mã hóa phần cứng. Khóa chỉ được gửi trực tiếp tới api.groq.com và không bao giờ lưu vào lịch sử chat hay bản xuất mặc định.',
          keyNameLabel: 'Tên gợi nhớ',
          keyNamePlaceholder: 'Ví dụ: Groq Key chính',
          keySecretLabel: 'Groq API Key',
          keySecretPlaceholder: 'gsk_...',
          setAsPrimary: 'Đặt làm Primary',
          addKeyBtn: 'Thêm Key',
          testKeyBtn: 'Kiểm tra',
          testingKeyBtn: 'Đang kiểm...',
          enableBtn: 'Bật',
          disableBtn: 'Tắt',
          editBtn: 'Sửa',
          setPrimaryBtn: 'Đặt Primary',
          resetStatusBtn: 'Đặt lại trạng thái',
          removeBtn: 'Xóa',
          confirmRemove: 'Xóa?',
          colName: 'Tên / Vai trò',
          colMasked: 'Khóa (đã che)',
          colStatus: 'Trạng thái',
          colStats: 'Thành công / Lỗi',
          colLastUsed: 'Dùng gần nhất',
          colCooldown: 'Hồi chờ',
          colActions: 'Thao tác',
          neverUsed: 'Chưa dùng',
          noKeysYet: 'Chưa có API Key nào được thêm.',
          keyEditSecretPlaceholder: 'Để trống nếu giữ nguyên key cũ',
          // Settings
          settingsTitle: 'Cài đặt hệ thống',
          settingsReset: 'Khôi phục mặc định',
          secGeneral: '1. Cài đặt chung (General)',
          secModel: '2. Mô hình AI (AI Model)',
          secApi: '3. Quản lý API (API Management)',
          secCapture: '4. Chụp bài tập (Capture)',
          secConversation: '5. Hội thoại (Conversation)',
          secPrivacy: '6. Quyền riêng tư (Privacy)',
          lblEnabled: 'Bật tiện ích & phím tắt',
          lblHotkey: 'Phím tắt bật/tắt bảng',
          recordHotkey: 'Ghi phím mới',
          pressAnyKey: 'Nhấn tổ hợp phím...',
          resetHotkey: 'Mặc định (Insert)',
          lblTheme: 'Giao diện',
          themeDark: 'Tối (Dark)',
          themeLight: 'Sáng (Light)',
          lblLanguage: 'Ngôn ngữ',
          lblPromptMode: 'Chế độ System Prompt',
          modeTutor: 'Gia sư từng bước (Tutor)',
          modeConcise: 'Ngắn gọn (Concise)',
          modeDetailed: 'Chi tiết chuyên sâu (Detailed)',
          modeCustom: 'Tùy chỉnh (Custom)',
          lblCustomPrompt: 'System Prompt tùy chỉnh',
          lblFloatingLauncher: 'Hiển thị nút nổi trên trang khi đóng bảng',
          fetchModelsBtn: 'Tải danh sách Model từ Groq',
          fetchingModels: 'Đang tải...',
          lblActiveModel: 'Model đang hoạt động (Active Model)',
          lblCustomModelId: 'Hoặc nhập Model ID tùy chỉnh',
          lblVisionModel: 'Vision Model mặc định',
          lblTextModel: 'Text Model mặc định',
          lblTemperature: 'Temperature (0.0 – 2.0)',
          lblMaxTokens: 'Max Completion Tokens',
          lblTopP: 'Top P (0.0 – 1.0)',
          lblReasoningEffort: 'Reasoning Effort',
          lblReasoningFormat: 'Reasoning Format',
          lblStream: 'Bật phản hồi trực tiếp (SSE Streaming)',
          modelVisionOk: 'Model này hỗ trợ nhận diện ảnh (Vision).',
          modelVisionWarn:
            'Cảnh báo: Model đang chọn chỉ hỗ trợ văn bản, KHÔNG đọc được ảnh chụp bài tập!',
          lblChatEndpoint: 'Groq Chat Endpoint',
          lblModelsEndpoint: 'Groq Models Endpoint',
          lblAutoFailover: 'Tự động chuyển key khi lỗi 401/403 (Auto Failover)',
          lblRetryLimit: 'Số lần thử lại lỗi 5xx/498 (Retry Limit)',
          lblCooldownSec: 'Thời gian chờ mặc định khi giới hạn (giây)',
          lblTimeoutMs: 'Timeout yêu cầu (ms)',
          lblCaptureMethod: 'Phương thức chụp mặc định',
          captureArchNote:
            'Ghi chú kỹ thuật: DOM Capture (html2canvas-pro) chụp nhanh trên trang hiện tại nhưng không thể đọc nội dung bên trong iframe khác tên miền (cross-origin), video DRM hoặc canvas bị tainted. Khi gặp các trang này, hãy dùng Screen Capture (getDisplayMedia). Nếu cần chụp pixel chính xác mọi trang web chỉ với 1 lần nhấn mà không hiện hộp thoại chia sẻ màn hình, phương án tối ưu là chuyển sang Chrome Extension dùng API chrome.tabs.captureVisibleTab.',
          lblImageQuality: 'Chất lượng nén ảnh (0.1 – 1.0)',
          lblMaxImageSizeMB: 'Giới hạn dung lượng mỗi ảnh (MB)',
          lblMaxImagesPerMsg: 'Số ảnh tối đa mỗi lượt gửi',
          lblPreviewBeforeSend: 'Luôn xem trước & chỉnh sửa ảnh trước khi gửi',
          lblSaveHistory: 'Lưu lịch sử hội thoại cục bộ',
          lblSaveImagesHistory: 'Lưu ảnh Base64 trong lịch sử dài hạn (tốn dung lượng bộ nhớ)',
          lblMaxMessages: 'Số tin nhắn tối đa giữ trong ngữ cảnh gửi API',
          lblAutoSummarize: 'Tự động tóm tắt đề bài & công thức khi cắt bớt hội thoại dài',
          lblNeverAutoSend: 'Không bao giờ tự động gửi ảnh khi chưa nhấn Gửi',
          lblMaskKeysLogs: 'Che toàn bộ API Key trong lỗi & nhật ký',
          privacyPolicyNotice:
            'Chính sách Zero-Telemetry: Tiện ích không thu thập dữ liệu, không gửi thông tin tới máy chủ bên thứ ba nào ngoài api.groq.com khi bạn chủ động nhấn Gửi hoặc Kiểm tra Key.',
          wipeAllBtn: 'Xóa toàn bộ dữ liệu cục bộ',
          confirmWipeAll: 'Chắc chắn xóa toàn bộ Keys, Cài đặt & Lịch sử?',
        },
        en: {
          appTitle: 'Smart Homework Capture',
          sidebarToggle: 'Conversation History',
          newChat: 'New Chat',
          apiKeysBtn: 'API Keys',
          settingsBtn: 'Settings',
          minimizeBtn: 'Minimize',
          closeBtn: 'Close (Insert)',
          restoreBtn: 'Restore',
          quickCaptureBtn: 'Quick Capture',
          conversationsTitle: 'Homework History',
          exportJson: 'Export JSON',
          exportMd: 'Export Markdown',
          clearAllHistory: 'Clear All',
          confirmClearAll: 'Confirm Clear All?',
          rename: 'Rename',
          delete: 'Delete',
          cancel: 'Cancel',
          save: 'Save',
          welcomeTitle: 'Capture Homework & Solve Step-by-Step with Groq AI',
          welcomeDesc:
            'Click "Capture Exercise" (or press Insert) to select an exercise region on the page, paste an image (Ctrl+V), drag & drop, or upload files before sending.',
          welcomeNoKey: 'No Groq API key is configured yet. Add a key to start asking questions.',
          openKeyManager: 'Open API Key Manager',
          captureExercise: 'Capture Exercise',
          captureDomOption: 'DOM Capture (html2canvas-pro)',
          captureDomDesc: 'Fast page DOM capture; limited on cross-origin iframes / tainted canvas.',
          captureScreenOption: 'Screen Capture (Tab / Screen)',
          captureScreenDesc: 'Captures a real browser frame via getDisplayMedia and lets you crop.',
          attachImage: 'Attach Image',
          send: 'Send',
          cancelGen: 'Cancel Generation',
          composerPlaceholder:
            'Ask a question or add instructions (Enter to send, Shift+Enter for newline, Ctrl+V to paste image)...',
          dropOverlay: 'Drop PNG / JPG / WEBP images here to stage',
          stagingTitle: 'Pending Images',
          sendToAi: 'Send to AI',
          captureAgain: 'Capture Again',
          clearStaged: 'Clear All',
          zoom: 'Zoom',
          cropAgain: 'Crop Again',
          moveLeft: 'Move Left',
          moveRight: 'Move Right',
          replaceImage: 'Replace',
          removeImage: 'Remove',
          thinkingLabel: 'Reasoning / Thinking',
          thinkingLive: 'Thinking...',
          copyResponse: 'Copy Response',
          copied: 'Copied!',
          retryResponse: 'Retry Response',
          deleteMessage: 'Delete Message',
          imagePlaceholder: '[Image attached in previous session]',
          copyCode: 'Copy Code',
          switchToVision: 'Switch to Vision Model',
          tryScreenCapture: 'Try Screen Capture',
          dismiss: 'Dismiss',
          statusIdle: 'Idle',
          statusSending: 'Sending...',
          statusStreaming: 'Streaming...',
          statusFailover: 'Failover...',
          statusRetrying: 'Retrying...',
          statusCooldown: 'Cooldown',
          statusError: 'Error',
          connUnconfigured: 'No Key',
          connUntested: 'Untested',
          connConnected: 'Connected',
          connRateLimited: 'Rate Limited',
          connError: 'Error',
          noActiveKeyShort: 'No active key',
          // API Key Manager
          keysTitle: 'Groq API Key Manager',
          keysBackChat: 'Back to Chat',
          keysSecurityNotice:
            'Security Notice: Tampermonkey Storage (GM_setValue) is local browser storage and NOT hardware encryption. Keys are sent only to api.groq.com and are never written to chat history or default exports.',
          keyNameLabel: 'Key Name',
          keyNamePlaceholder: 'e.g. Primary Groq Key',
          keySecretLabel: 'Groq API Key',
          keySecretPlaceholder: 'gsk_...',
          setAsPrimary: 'Set as Primary',
          addKeyBtn: 'Add Key',
          testKeyBtn: 'Test Key',
          testingKeyBtn: 'Testing...',
          enableBtn: 'Enable',
          disableBtn: 'Disable',
          editBtn: 'Edit',
          setPrimaryBtn: 'Set Primary',
          resetStatusBtn: 'Reset Status',
          removeBtn: 'Remove',
          confirmRemove: 'Remove?',
          colName: 'Name / Role',
          colMasked: 'Masked Key',
          colStatus: 'Status',
          colStats: 'Success / Errors',
          colLastUsed: 'Last Used',
          colCooldown: 'Cooldown',
          colActions: 'Actions',
          neverUsed: 'Never',
          noKeysYet: 'No API keys added yet.',
          keyEditSecretPlaceholder: 'Leave blank to keep existing key',
          // Settings
          settingsTitle: 'Settings',
          settingsReset: 'Reset Defaults',
          secGeneral: '1. General',
          secModel: '2. AI Model',
          secApi: '3. API Management',
          secCapture: '4. Capture',
          secConversation: '5. Conversation',
          secPrivacy: '6. Privacy',
          lblEnabled: 'Enable Assistant & Hotkey',
          lblHotkey: 'Panel Toggle Hotkey',
          recordHotkey: 'Record Hotkey',
          pressAnyKey: 'Press key combo...',
          resetHotkey: 'Default (Insert)',
          lblTheme: 'Theme',
          themeDark: 'Dark',
          themeLight: 'Light',
          lblLanguage: 'Language',
          lblPromptMode: 'System Prompt Mode',
          modeTutor: 'Step-by-Step Tutor',
          modeConcise: 'Concise',
          modeDetailed: 'Detailed',
          modeCustom: 'Custom',
          lblCustomPrompt: 'Custom System Prompt',
          lblFloatingLauncher: 'Show floating toggle button when closed',
          fetchModelsBtn: 'Fetch Models from Groq',
          fetchingModels: 'Fetching...',
          lblActiveModel: 'Active Model',
          lblCustomModelId: 'Or enter Custom Model ID',
          lblVisionModel: 'Default Vision Model',
          lblTextModel: 'Default Text Model',
          lblTemperature: 'Temperature (0.0 – 2.0)',
          lblMaxTokens: 'Max Completion Tokens',
          lblTopP: 'Top P (0.0 – 1.0)',
          lblReasoningEffort: 'Reasoning Effort',
          lblReasoningFormat: 'Reasoning Format',
          lblStream: 'Enable Streaming (SSE)',
          modelVisionOk: 'This model supports multimodal Vision inputs.',
          modelVisionWarn:
            'Warning: Selected model is text-only and CANNOT read homework images!',
          lblChatEndpoint: 'Groq Chat Endpoint',
          lblModelsEndpoint: 'Groq Models Endpoint',
          lblAutoFailover: 'Auto Failover on 401/403 errors',
          lblRetryLimit: '5xx/498 Retry Limit',
          lblCooldownSec: 'Default Cooldown (seconds)',
          lblTimeoutMs: 'Request Timeout (ms)',
          lblCaptureMethod: 'Default Capture Method',
          captureArchNote:
            'Technical Note: DOM Capture (html2canvas-pro) captures fast directly from the DOM, but cannot render cross-origin <iframe>, DRM video, or tainted <canvas> elements. Use Screen Capture (getDisplayMedia) for those sites. For one-click pixel-exact capture across every site without browser picker prompts, migrating to a Chrome Extension using chrome.tabs.captureVisibleTab is the cleanest upgrade path.',
          lblImageQuality: 'Image Compression Quality (0.1 – 1.0)',
          lblMaxImageSizeMB: 'Max Image Size (MB)',
          lblMaxImagesPerMsg: 'Max Images per Message',
          lblPreviewBeforeSend: 'Always stage & preview images before sending',
          lblSaveHistory: 'Persist conversation history locally',
          lblSaveImagesHistory: 'Persist Base64 images in long-term history (uses more storage)',
          lblMaxMessages: 'Max messages retained per API context',
          lblAutoSummarize: 'Auto-summarize problem statement & formulas when trimming',
          lblNeverAutoSend: 'Never auto-upload images before clicking Send',
          lblMaskKeysLogs: 'Mask all API keys in logs and errors',
          privacyPolicyNotice:
            'Zero-Telemetry Policy: No analytics, no external logging, and no third-party servers. Data is only sent to api.groq.com when you explicitly click Send or Test Key.',
          wipeAllBtn: 'Clear All Local Data',
          confirmWipeAll: 'Permanently wipe all API Keys, Settings & History?',
        },
      };

      // ---------------------------------------------------------------------------
      // SVG Icons (Crisp Minimal Vectors)
      // ---------------------------------------------------------------------------

      const SVG_PATHS = {
        logo: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 7.5l1.35 3.15L16.5 12l-3.15 1.35L12 16.5l-1.35-3.15L7.5 12l3.15-1.35L12 7.5z" fill="currentColor"/>',
        sidebar: '<rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M9 4v16" stroke="currentColor" stroke-width="1.7"/>',
        plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
        key: '<circle cx="8.5" cy="14.5" r="3.5" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M11 12l7.5-7.5M16 7l2.5 2.5M14 9l2 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
        settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.78 1.02 1.41 1.09H21a2 2 0 1 1 0 4h-.09c-.66.06-1.22.49-1.51 1.1z" stroke="currentColor" stroke-width="1.5" fill="none"/>',
        minimize: '<path d="M5 12h14" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
        close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
        capture: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="8" y="8" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/>',
        attach: '<path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>',
        send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
        copy: '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="1.7" fill="none"/>',
        check: '<path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        retry: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>',
        edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>',
        zoom: '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
        crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>',
        left: '<path d="M15 18l-6-6 6-6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        right: '<path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        chevronDown: '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        warning: '<path d="M12 3L2 20h20L12 3z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7" fill="none"/>',
        eyeOff: '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.8 21.8 0 0 1 5.06-5.94M9.9 4.24A10.8 10.8 0 0 1 12 4c7 0 11 7 11 7a21.8 21.8 0 0 1-2.16 3.19M1 1l22 22" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/>',
        refresh: '<path d="M23 4v6h-6M1 20v-6h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
        shield: '<path d="M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z" stroke="currentColor" stroke-width="1.7" fill="none"/>',
      };

      function createIcon(doc, name, size = 16) {
        const svgNS = 'http://www.w3.org/2000/svg';
        let svg;
        if (typeof doc.createElementNS === 'function') {
          svg = doc.createElementNS(svgNS, 'svg');
        } else {
          svg = doc.createElement('svg');
        }
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('fill', 'none');
        svg.setAttribute('aria-hidden', 'true');
        if (svg.classList) svg.classList.add('shc-icon');
        svg.innerHTML = SVG_PATHS[name] || '';
        return svg;
      }

      // ---------------------------------------------------------------------------
      // DOM & Format Helpers
      // ---------------------------------------------------------------------------

      function el(doc, tag, props = {}, children = []) {
        const node = doc.createElement(tag);
        if (props) {
          if (props.id) node.id = props.id;
          if (props.className) node.className = props.className;
          if (props.text !== undefined && props.text !== null) {
            node.textContent = String(props.text);
          }
          if (props.type) node.type = props.type;
          if (props.value !== undefined) node.value = props.value;
          if (props.checked !== undefined) node.checked = Boolean(props.checked);
          if (props.disabled !== undefined) node.disabled = Boolean(props.disabled);
          if (props.placeholder !== undefined) node.placeholder = props.placeholder;
          if (props.title !== undefined && typeof node.setAttribute === 'function') {
            node.setAttribute('title', props.title);
          }
          if (props.attrs && typeof node.setAttribute === 'function') {
            for (const [k, v] of Object.entries(props.attrs)) {
              if (v !== undefined && v !== null) node.setAttribute(k, String(v));
            }
          }
          if (props.dataset && node.dataset) {
            for (const [k, v] of Object.entries(props.dataset)) {
              if (v !== undefined && v !== null) node.dataset[k] = String(v);
            }
          }
          if (props.style && node.style) {
            for (const [k, v] of Object.entries(props.style)) {
              node.style[k] = v;
            }
          }
          if (props.on && typeof node.addEventListener === 'function') {
            for (const [ev, handler] of Object.entries(props.on)) {
              if (typeof handler === 'function') node.addEventListener(ev, handler);
            }
          }
        }
        const list = Array.isArray(children) ? children : [children];
        for (const child of list) {
          if (child === null || child === undefined || child === false) continue;
          if (typeof child === 'string' || typeof child === 'number') {
            node.appendChild(doc.createTextNode(String(child)));
          } else {
            node.appendChild(child);
          }
        }
        return node;
      }

      function clearChildren(node) {
        if (!node) return;
        if (Array.isArray(node.children)) {
          while (node.children.length > 0) {
            const last = node.children[node.children.length - 1];
            if (typeof node.removeChild === 'function') {
              node.removeChild(last);
            } else {
              node.children.pop();
            }
          }
        }
        node.innerHTML = '';
      }

      function formatBytes(bytes) {
        const n = Number(bytes || 0);
        if (!n || n <= 0) return '0 B';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(2)} MB`;
      }

      function formatTimestamp(ts, lang = 'vi') {
        if (!ts) return '';
        try {
          const d = new Date(ts);
          if (Number.isNaN(d.getTime())) return '';
          return d.toLocaleTimeString(lang === 'en' ? 'en-US' : 'vi-VN', {
            hour: '2-digit',
            minute: '2-digit',
          });
        } catch (_) {
          return '';
        }
      }

      function formatDateTimeShort(ts, lang = 'vi') {
        if (!ts) return '';
        try {
          const d = new Date(ts);
          if (Number.isNaN(d.getTime())) return '';
          return d.toLocaleString(lang === 'en' ? 'en-US' : 'vi-VN', {
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          });
        } catch (_) {
          return '';
        }
      }

      function formatHotkeyLabel(hk) {
        if (!hk) return 'Insert';
        const parts = [];
        if (hk.ctrl) parts.push('Ctrl');
        if (hk.alt) parts.push('Alt');
        if (hk.shift) parts.push('Shift');
        if (hk.meta) parts.push('Meta');
        const keyLabel = hk.key === ' ' ? 'Space' : hk.key || hk.code || 'Insert';
        parts.push(keyLabel.length === 1 ? keyLabel.toUpperCase() : keyLabel);
        return parts.join(' + ');
      }

      function splitThinkContent(content, explicitReasoning) {
        const raw = String(content || '');
        let extracted = [];
        let body = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => {
          if (inner && inner.trim()) extracted.push(inner.trim());
          return '';
        });

        let isThinkingInProgress = false;
        const unclosedMatch = body.match(/<think>([\s\S]*)$/i);
        if (unclosedMatch) {
          isThinkingInProgress = true;
          if (unclosedMatch[1] && unclosedMatch[1].trim()) {
            extracted.push(unclosedMatch[1].trim());
          }
          body = body.slice(0, unclosedMatch.index);
        }

        const parts = [];
        if (explicitReasoning && String(explicitReasoning).trim()) {
          parts.push(String(explicitReasoning).trim());
        }
        if (extracted.length > 0) {
          const joinedExtracted = extracted.join('\n\n');
          if (!parts.includes(joinedExtracted)) parts.push(joinedExtracted);
        }

        return {
          reasoning: parts.join('\n\n'),
          body: body.trim(),
          isThinkingInProgress,
        };
      }

      async function copyToClipboard(doc, win, text) {
        const str = String(text || '');
        if (!str) return false;
        try {
          if (win?.navigator?.clipboard?.writeText) {
            await win.navigator.clipboard.writeText(str);
            return true;
          }
        } catch (_) {
          // Fallback below
        }
        try {
          const ta = doc.createElement('textarea');
          ta.value = str;
          if (ta.style) {
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            ta.style.top = '-9999px';
          }
          (doc.body || doc.documentElement).appendChild(ta);
          if (typeof ta.select === 'function') ta.select();
          const ok = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false;
          ta.remove();
          return Boolean(ok);
        } catch (_) {
          return false;
        }
      }

      function downloadFile(doc, win, filename, content, mimeType) {
        try {
          const URLObj = win?.URL || (typeof URL !== 'undefined' ? URL : null);
          const BlobCtor = win?.Blob || (typeof Blob !== 'undefined' ? Blob : null);
          if (!URLObj || !BlobCtor || typeof URLObj.createObjectURL !== 'function') return false;
          const blob = new BlobCtor([content], { type: mimeType });
          const url = URLObj.createObjectURL(blob);
          const a = doc.createElement('a');
          a.setAttribute('href', url);
          a.setAttribute('download', filename);
          if (a.style) a.style.display = 'none';
          (doc.body || doc.documentElement).appendChild(a);
          if (typeof a.click === 'function') a.click();
          a.remove();
          setTimeout(() => URLObj.revokeObjectURL(url), 1000);
          return true;
        } catch (_) {
          return false;
        }
      }

      function resolveKaTeXCSS(globalScope) {
        let rawCss = '';
        try {
          if (typeof GM_getResourceText === 'function') {
            rawCss = GM_getResourceText('katexCSS') || '';
          } else if (globalScope && typeof globalScope.GM_getResourceText === 'function') {
            rawCss = globalScope.GM_getResourceText('katexCSS') || '';
          }
        } catch (_) {
          rawCss = '';
        }
        if (!rawCss) return '';
        return rawCss.replace(/url\((['"]?)(?:\.\/)?fonts\//gi, `url($1${KATEX_FONTS_URL}`);
      }

      // ---------------------------------------------------------------------------
      // Shadow DOM Stylesheet
      // ---------------------------------------------------------------------------

      function buildStylesheet(katexCss) {
        return `
    ${katexCss || ''}

    :host {
      all: initial;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color-scheme: dark;
    }

    *, *::before, *::after {
      box-sizing: border-box;
    }

    .shc-root {
      --shc-bg: #0b0f17;
      --shc-surface: #111827;
      --shc-elevated: #172033;
      --shc-card: #1b2538;
      --shc-input: #0f1623;
      --shc-border: rgba(148, 163, 184, 0.16);
      --shc-border-strong: rgba(148, 163, 184, 0.28);
      --shc-text: #f1f5f9;
      --shc-muted: #94a3b8;
      --shc-subtle: #64748b;
      --shc-accent: #6366f1;
      --shc-accent-hover: #818cf8;
      --shc-accent-soft: rgba(99, 102, 241, 0.16);
      --shc-cyan: #38bdf8;
      --shc-success: #10b981;
      --shc-success-soft: rgba(16, 185, 129, 0.15);
      --shc-warn: #f59e0b;
      --shc-warn-soft: rgba(245, 158, 11, 0.15);
      --shc-danger: #ef4444;
      --shc-danger-soft: rgba(239, 68, 68, 0.15);
      --shc-user-bg: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%);
      --shc-ai-bg: #151e30;
      --shc-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13.5px;
      color: var(--shc-text);
    }

    .shc-root[data-theme="light"] {
      --shc-bg: #f8fafc;
      --shc-surface: #ffffff;
      --shc-elevated: #f1f5f9;
      --shc-card: #ffffff;
      --shc-input: #f8fafc;
      --shc-border: rgba(15, 23, 42, 0.12);
      --shc-border-strong: rgba(15, 23, 42, 0.22);
      --shc-text: #0f172a;
      --shc-muted: #475569;
      --shc-subtle: #64748b;
      --shc-accent: #4f46e5;
      --shc-accent-hover: #4338ca;
      --shc-accent-soft: rgba(79, 70, 229, 0.1);
      --shc-ai-bg: #f1f5f9;
      --shc-shadow: 0 20px 50px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(15, 23, 42, 0.08);
      color-scheme: light;
    }

    /* Built-in KaTeX fallback & MathML hide rule */
    .katex .katex-mathml {
      position: absolute;
      clip: rect(1px, 1px, 1px, 1px);
      padding: 0;
      border: 0;
      height: 1px;
      width: 1px;
      overflow: hidden;
    }
    .katex-display {
      display: block;
      margin: 10px 0;
      overflow-x: auto;
      overflow-y: hidden;
      text-align: center;
      padding: 4px 0;
    }
    .shc-math-inline {
      font-family: 'Cambria Math', 'Times New Roman', serif;
      background: rgba(99, 102, 241, 0.1);
      padding: 1px 5px;
      border-radius: 4px;
      font-style: italic;
    }
    .shc-math-block {
      display: block;
      font-family: 'Cambria Math', 'Times New Roman', serif;
      background: rgba(15, 23, 42, 0.35);
      border: 1px solid var(--shc-border);
      border-radius: 8px;
      padding: 10px 12px;
      margin: 8px 0;
      overflow-x: auto;
      text-align: center;
    }

    /* Main Floating Panel */
    .shc-panel {
      position: fixed;
      display: flex;
      flex-direction: column;
      background: var(--shc-bg);
      color: var(--shc-text);
      border: 1px solid var(--shc-border-strong);
      border-radius: 14px;
      box-shadow: var(--shc-shadow);
      overflow: hidden;
      pointer-events: auto;
      opacity: 0;
      transform: scale(0.96) translateY(10px);
      transition: opacity 0.18s ease, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 10;
    }

    .shc-panel.is-open {
      opacity: 1;
      transform: scale(1) translateY(0);
    }

    .shc-panel.is-hidden {
      display: none;
      pointer-events: none;
    }

    .shc-panel.is-dragging, .shc-panel.is-resizing {
      transition: none !important;
      user-select: none;
    }

    /* Resize handles */
    .shc-resize {
      position: absolute;
      z-index: 30;
    }
    .shc-resize-n { top: 0; left: 8px; right: 8px; height: 5px; cursor: ns-resize; }
    .shc-resize-s { bottom: 0; left: 8px; right: 8px; height: 5px; cursor: ns-resize; }
    .shc-resize-e { top: 8px; bottom: 8px; right: 0; width: 5px; cursor: ew-resize; }
    .shc-resize-w { top: 8px; bottom: 8px; left: 0; width: 5px; cursor: ew-resize; }
    .shc-resize-nw { top: 0; left: 0; width: 10px; height: 10px; cursor: nwse-resize; }
    .shc-resize-ne { top: 0; right: 0; width: 10px; height: 10px; cursor: nesw-resize; }
    .shc-resize-sw { bottom: 0; left: 0; width: 10px; height: 10px; cursor: nesw-resize; }
    .shc-resize-se { bottom: 0; right: 0; width: 12px; height: 12px; cursor: nwse-resize; }

    /* Header */
    .shc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 12px;
      background: var(--shc-surface);
      border-bottom: 1px solid var(--shc-border);
      cursor: move;
      user-select: none;
      flex-shrink: 0;
    }

    .shc-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .shc-brand {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .shc-logo {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      background: linear-gradient(135deg, #6366f1 0%, #0ea5e9 100%);
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .shc-title {
      font-size: 13.5px;
      font-weight: 700;
      letter-spacing: -0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .shc-conn-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: var(--shc-elevated);
      border: 1px solid var(--shc-border);
      color: var(--shc-muted);
      white-space: nowrap;
    }

    .shc-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--shc-subtle);
      flex-shrink: 0;
    }
    .shc-dot.is-connected { background: var(--shc-success); box-shadow: 0 0 8px rgba(16, 185, 129, 0.6); }
    .shc-dot.is-working { background: var(--shc-cyan); box-shadow: 0 0 8px rgba(56, 189, 248, 0.6); }
    .shc-dot.is-warn { background: var(--shc-warn); }
    .shc-dot.is-error { background: var(--shc-danger); }

    .shc-header-actions {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .shc-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 7px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--shc-muted);
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      position: relative;
    }
    .shc-icon-btn:hover {
      background: var(--shc-elevated);
      color: var(--shc-text);
      border-color: var(--shc-border);
    }
    .shc-icon-btn.is-active {
      background: var(--shc-accent-soft);
      color: var(--shc-accent-hover);
      border-color: rgba(99, 102, 241, 0.35);
    }
    .shc-icon-btn.is-danger:hover {
      background: var(--shc-danger-soft);
      color: var(--shc-danger);
    }
    .shc-alert-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--shc-warn);
    }

    /* Body Layout */
    .shc-body {
      position: relative;
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /* Sidebar */
    .shc-sidebar {
      width: 250px;
      flex-shrink: 0;
      background: var(--shc-surface);
      border-right: 1px solid var(--shc-border);
      display: flex;
      flex-direction: column;
      min-height: 0;
      z-index: 20;
    }
    .shc-sidebar.is-closed {
      display: none;
    }
    .shc-panel.is-narrow .shc-sidebar {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 260px;
      max-width: 86%;
      box-shadow: 12px 0 32px rgba(0, 0, 0, 0.45);
    }

    .shc-sidebar-top {
      padding: 10px;
      border-bottom: 1px solid var(--shc-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .shc-sidebar-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .shc-conv-item {
      padding: 8px 9px;
      border-radius: 9px;
      border: 1px solid transparent;
      background: transparent;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 4px;
      transition: background 0.14s ease, border-color 0.14s ease;
    }
    .shc-conv-item:hover {
      background: var(--shc-elevated);
    }
    .shc-conv-item.is-active {
      background: var(--shc-accent-soft);
      border-color: rgba(99, 102, 241, 0.35);
    }
    .shc-conv-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
    .shc-conv-title {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--shc-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .shc-conv-actions {
      display: flex;
      gap: 2px;
      opacity: 0.7;
    }
    .shc-conv-item:hover .shc-conv-actions { opacity: 1; }
    .shc-conv-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 11px;
      color: var(--shc-muted);
    }
    .shc-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 6px;
      border-radius: 5px;
      font-size: 10.5px;
      font-weight: 600;
      background: var(--shc-elevated);
      border: 1px solid var(--shc-border);
      color: var(--shc-muted);
    }
    .shc-badge.is-primary { background: var(--shc-accent-soft); color: var(--shc-accent-hover); border-color: rgba(99,102,241,0.3); }
    .shc-badge.is-active { background: var(--shc-success-soft); color: var(--shc-success); border-color: rgba(16,185,129,0.3); }
    .shc-badge.is-warn { background: var(--shc-warn-soft); color: var(--shc-warn); border-color: rgba(245,158,11,0.3); }
    .shc-badge.is-danger { background: var(--shc-danger-soft); color: var(--shc-danger); border-color: rgba(239,68,68,0.3); }

    .shc-sidebar-footer {
      padding: 8px 10px;
      border-top: 1px solid var(--shc-border);
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    /* Main Content Area */
    .shc-main {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .shc-view {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .shc-view.is-hidden {
      display: none;
    }

    /* Banners */
    .shc-banners {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 12px 0 12px;
      flex-shrink: 0;
    }
    .shc-banners:empty {
      display: none;
    }
    .shc-banner {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 9px;
      font-size: 12px;
      border: 1px solid var(--shc-border);
      background: var(--shc-elevated);
    }
    .shc-banner.is-warn {
      background: var(--shc-warn-soft);
      border-color: rgba(245, 158, 11, 0.35);
      color: #fde68a;
    }
    .shc-root[data-theme="light"] .shc-banner.is-warn { color: #92400e; }
    .shc-banner.is-error {
      background: var(--shc-danger-soft);
      border-color: rgba(239, 68, 68, 0.35);
      color: #fecaca;
    }
    .shc-root[data-theme="light"] .shc-banner.is-error { color: #991b1b; }
    .shc-banner.is-info {
      background: var(--shc-accent-soft);
      border-color: rgba(99, 102, 241, 0.35);
    }
    .shc-banner-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }
    .shc-banner-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }

    /* Conversation Area */
    .shc-messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 0;
    }

    .shc-welcome {
      margin: auto 0;
      padding: 20px 18px;
      border-radius: 12px;
      background: var(--shc-surface);
      border: 1px dashed var(--shc-border-strong);
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .shc-welcome h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
    }
    .shc-welcome p {
      margin: 0;
      font-size: 12.5px;
      color: var(--shc-muted);
      max-width: 420px;
    }
    .shc-welcome-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-top: 4px;
    }

    .shc-msg {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-width: 92%;
    }
    .shc-msg.is-user {
      align-self: flex-end;
      align-items: flex-end;
    }
    .shc-msg.is-assistant {
      align-self: flex-start;
      align-items: flex-start;
      width: 100%;
      max-width: 100%;
    }

    .shc-msg-bubble {
      padding: 10px 13px;
      border-radius: 12px;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      max-width: 100%;
    }
    .shc-msg.is-user .shc-msg-bubble {
      background: var(--shc-user-bg);
      color: #ffffff;
      border-bottom-right-radius: 4px;
      box-shadow: 0 4px 14px rgba(59, 130, 246, 0.25);
    }
    .shc-msg.is-assistant .shc-msg-bubble {
      background: var(--shc-ai-bg);
      border: 1px solid var(--shc-border);
      border-bottom-left-radius: 4px;
      width: 100%;
    }

    .shc-msg-text {
      white-space: pre-wrap;
      font-size: 13.5px;
      line-height: 1.55;
    }

    .shc-msg-images {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .shc-msg-img-thumb {
      width: 92px;
      height: 70px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      cursor: zoom-in;
      background: #0b0f17;
    }
    .shc-msg-img-placeholder {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.14);
      font-size: 11px;
    }

    .shc-msg-meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 11px;
      color: var(--shc-muted);
    }

    .shc-msg-actions {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    /* Thinking / Reasoning Block */
    .shc-thinking {
      margin-bottom: 10px;
      border: 1px solid var(--shc-border);
      border-radius: 9px;
      background: rgba(15, 23, 42, 0.35);
      overflow: hidden;
    }
    .shc-root[data-theme="light"] .shc-thinking {
      background: rgba(15, 23, 42, 0.04);
    }
    .shc-thinking summary {
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 600;
      color: var(--shc-cyan);
      cursor: pointer;
      user-select: none;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .shc-thinking summary::-webkit-details-marker { display: none; }
    .shc-thinking-body {
      padding: 8px 10px 10px;
      border-top: 1px solid var(--shc-border);
      font-size: 12px;
      color: var(--shc-muted);
      white-space: pre-wrap;
      max-height: 220px;
      overflow-y: auto;
    }

    /* Markdown Body inside AI response */
    .shc-md-body {
      font-size: 13.5px;
      line-height: 1.62;
      color: var(--shc-text);
    }
    .shc-md-body > *:first-child { margin-top: 0; }
    .shc-md-body > *:last-child { margin-bottom: 0; }
    .shc-md-body p { margin: 8px 0; }
    .shc-md-body h1, .shc-md-body h2, .shc-md-body h3, .shc-md-body h4 {
      margin: 12px 0 6px;
      font-weight: 700;
      line-height: 1.3;
    }
    .shc-md-body h1 { font-size: 17px; }
    .shc-md-body h2 { font-size: 15.5px; }
    .shc-md-body h3 { font-size: 14.5px; }
    .shc-md-body ul, .shc-md-body ol {
      margin: 6px 0;
      padding-left: 20px;
    }
    .shc-md-body li { margin: 3px 0; }
    .shc-md-body blockquote {
      margin: 8px 0;
      padding: 6px 12px;
      border-left: 3px solid var(--shc-accent);
      background: rgba(99, 102, 241, 0.08);
      border-radius: 0 6px 6px 0;
      color: var(--shc-muted);
    }
    .shc-md-body code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      background: rgba(148, 163, 184, 0.14);
      padding: 1px 5px;
      border-radius: 4px;
    }
    .shc-md-body pre, .shc-code-block {
      margin: 10px 0;
      border-radius: 9px;
      border: 1px solid var(--shc-border);
      background: #090d14;
      overflow: hidden;
    }
    .shc-code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 10px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid var(--shc-border);
      font-size: 11px;
      color: var(--shc-muted);
    }
    .shc-code-copy-btn {
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid var(--shc-border);
      background: var(--shc-elevated);
      color: var(--shc-text);
      font-size: 11px;
      cursor: pointer;
    }
    .shc-code-copy-btn:hover { border-color: var(--shc-accent); }
    .shc-md-body pre code {
      display: block;
      padding: 10px 12px;
      overflow-x: auto;
      background: transparent;
      color: #e2e8f0;
      line-height: 1.5;
    }
    .shc-md-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 10px 0;
      font-size: 12.5px;
      overflow-x: auto;
      display: block;
    }
    .shc-md-body th, .shc-md-body td {
      border: 1px solid var(--shc-border);
      padding: 6px 9px;
      text-align: left;
    }
    .shc-md-body th {
      background: var(--shc-elevated);
      font-weight: 600;
    }
    .shc-md-body a {
      color: var(--shc-cyan);
      text-decoration: underline;
    }

    .shc-msg-error-box {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--shc-danger-soft);
      border: 1px solid rgba(239, 68, 68, 0.35);
      color: #fecaca;
      font-size: 12px;
    }
    .shc-root[data-theme="light"] .shc-msg-error-box { color: #991b1b; }

    .shc-streaming-cursor::after {
      content: '▍';
      display: inline-block;
      margin-left: 2px;
      color: var(--shc-cyan);
      animation: shc-blink 0.9s infinite;
    }
    @keyframes shc-blink {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }

    /* Staging Tray & Composer */
    .shc-composer {
      border-top: 1px solid var(--shc-border);
      background: var(--shc-surface);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex-shrink: 0;
      position: relative;
    }

    .shc-drop-overlay {
      position: absolute;
      inset: 6px;
      border-radius: 10px;
      border: 2px dashed var(--shc-cyan);
      background: rgba(14, 165, 233, 0.14);
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 600;
      color: var(--shc-cyan);
      z-index: 25;
      pointer-events: none;
    }
    .shc-composer.is-dragover .shc-drop-overlay,
    .shc-panel.is-dragover .shc-drop-overlay {
      display: flex;
    }

    .shc-staging {
      display: flex;
      flex-direction: column;
      gap: 7px;
      padding: 8px;
      border-radius: 10px;
      background: var(--shc-elevated);
      border: 1px solid var(--shc-border);
    }
    .shc-staging.is-hidden { display: none; }

    .shc-staging-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
    }
    .shc-staging-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 5px;
    }

    .shc-staging-grid {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .shc-stage-card {
      width: 148px;
      flex-shrink: 0;
      border-radius: 8px;
      border: 1px solid var(--shc-border);
      background: var(--shc-card);
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .shc-stage-thumb-wrap {
      position: relative;
      height: 76px;
      border-radius: 6px;
      overflow: hidden;
      background: #090d14;
      cursor: zoom-in;
    }
    .shc-stage-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .shc-stage-meta {
      font-size: 10.5px;
      color: var(--shc-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .shc-stage-btns {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 2px;
    }
    .shc-mini-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 5px;
      border: 1px solid var(--shc-border);
      background: var(--shc-elevated);
      color: var(--shc-muted);
      cursor: pointer;
      font-size: 11px;
    }
    .shc-mini-icon-btn:hover:not(:disabled) {
      color: var(--shc-text);
      border-color: var(--shc-accent);
    }
    .shc-mini-icon-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .shc-textarea {
      width: 100%;
      min-height: 44px;
      max-height: 140px;
      resize: none;
      border-radius: 10px;
      border: 1px solid var(--shc-border-strong);
      background: var(--shc-input);
      color: var(--shc-text);
      padding: 9px 11px;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.45;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .shc-textarea:focus {
      border-color: var(--shc-accent);
    }

    .shc-composer-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px;
    }
    .shc-composer-left, .shc-composer-right {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }

    /* Split Capture Button */
    .shc-split-btn {
      position: relative;
      display: inline-flex;
      align-items: stretch;
    }
    .shc-split-main {
      border-top-right-radius: 0 !important;
      border-bottom-right-radius: 0 !important;
    }
    .shc-split-caret {
      border-top-left-radius: 0 !important;
      border-bottom-left-radius: 0 !important;
      border-left: 1px solid rgba(255, 255, 255, 0.18) !important;
      padding: 0 7px !important;
    }
    .shc-popover {
      position: absolute;
      bottom: calc(100% + 6px);
      left: 0;
      width: 265px;
      background: var(--shc-surface);
      border: 1px solid var(--shc-border-strong);
      border-radius: 10px;
      box-shadow: var(--shc-shadow);
      padding: 5px;
      z-index: 40;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .shc-popover.is-hidden { display: none; }
    .shc-popover-item {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      padding: 7px 9px;
      border-radius: 7px;
      border: none;
      background: transparent;
      color: var(--shc-text);
      text-align: left;
      cursor: pointer;
    }
    .shc-popover-item:hover { background: var(--shc-elevated); }
    .shc-popover-title { font-size: 12px; font-weight: 600; }
    .shc-popover-desc { font-size: 11px; color: var(--shc-muted); }

    /* Buttons & Inputs */
    .shc-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 6px 11px;
      border-radius: 8px;
      border: 1px solid var(--shc-border-strong);
      background: var(--shc-elevated);
      color: var(--shc-text);
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
    }
    .shc-btn:hover:not(:disabled) {
      border-color: var(--shc-accent);
    }
    .shc-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .shc-btn-sm {
      padding: 4px 8px;
      font-size: 11.5px;
      border-radius: 6px;
    }
    .shc-btn-primary {
      background: var(--shc-accent);
      border-color: var(--shc-accent);
      color: #ffffff;
    }
    .shc-btn-primary:hover:not(:disabled) {
      background: var(--shc-accent-hover);
      border-color: var(--shc-accent-hover);
    }
    .shc-btn-danger {
      background: var(--shc-danger-soft);
      border-color: rgba(239, 68, 68, 0.4);
      color: var(--shc-danger);
    }
    .shc-btn-ghost {
      background: transparent;
      border-color: transparent;
      color: var(--shc-muted);
    }
    .shc-btn-ghost:hover:not(:disabled) {
      background: var(--shc-elevated);
      color: var(--shc-text);
    }

    .shc-input, .shc-select {
      width: 100%;
      padding: 7px 9px;
      border-radius: 7px;
      border: 1px solid var(--shc-border-strong);
      background: var(--shc-input);
      color: var(--shc-text);
      font-family: inherit;
      font-size: 12.5px;
      outline: none;
    }
    .shc-input:focus, .shc-select:focus { border-color: var(--shc-accent); }

    /* Status Bar */
    .shc-statusbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      padding: 5px 12px;
      background: var(--shc-surface);
      border-top: 1px solid var(--shc-border);
      font-size: 11px;
      color: var(--shc-muted);
      flex-shrink: 0;
    }
    .shc-status-group {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }
    .shc-status-link {
      background: transparent;
      border: none;
      padding: 0;
      color: var(--shc-muted);
      font-family: inherit;
      font-size: 11px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .shc-status-link:hover { color: var(--shc-text); text-decoration: underline; }

    /* Sub-views (API Keys & Settings) */
    .shc-subview {
      flex: 1;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: 0;
    }
    .shc-subview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }
    .shc-subview-title {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
    }
    .shc-card {
      background: var(--shc-surface);
      border: 1px solid var(--shc-border);
      border-radius: 11px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .shc-card-title {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--shc-cyan);
    }
    .shc-form-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
      gap: 10px;
    }
    .shc-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .shc-label {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--shc-muted);
    }
    .shc-check-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12.5px;
      cursor: pointer;
    }

    .shc-key-table-wrap {
      overflow-x: auto;
    }
    .shc-key-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    .shc-key-table th, .shc-key-table td {
      padding: 8px 7px;
      border-bottom: 1px solid var(--shc-border);
      text-align: left;
      vertical-align: top;
    }
    .shc-key-table th {
      font-size: 11px;
      color: var(--shc-muted);
      font-weight: 600;
      white-space: nowrap;
    }
    .shc-mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    /* Minimized Pill & Floating Launcher */
    .shc-mini-pill {
      position: fixed;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border-radius: 999px;
      background: var(--shc-surface);
      border: 1px solid var(--shc-border-strong);
      box-shadow: var(--shc-shadow);
      color: var(--shc-text);
      pointer-events: auto;
      cursor: move;
      user-select: none;
      z-index: 15;
    }
    .shc-mini-pill.is-hidden { display: none; pointer-events: none; }

    .shc-launcher {
      position: fixed;
      right: 18px;
      bottom: 18px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 8px 13px;
      border-radius: 999px;
      background: linear-gradient(135deg, #4f46e5 0%, #0ea5e9 100%);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.22);
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.45);
      font-size: 12.5px;
      font-weight: 700;
      cursor: pointer;
      pointer-events: auto;
      z-index: 8;
      transition: transform 0.15s ease, opacity 0.15s ease;
    }
    .shc-launcher:hover { transform: translateY(-2px); }
    .shc-launcher.is-hidden { display: none; pointer-events: none; }

    /* Lightbox Modal */
    .shc-lightbox {
      position: fixed;
      inset: 0;
      background: rgba(2, 6, 23, 0.86);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      pointer-events: auto;
      z-index: 50;
    }
    .shc-lightbox.is-hidden { display: none; pointer-events: none; }
    .shc-lightbox-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      background: var(--shc-surface);
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--shc-border-strong);
    }
    .shc-lightbox-stage {
      max-width: 92vw;
      max-height: 82vh;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .shc-lightbox-img {
      max-width: 100%;
      max-height: 80vh;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      transform-origin: center center;
      transition: transform 0.15s ease;
    }
    `;
      }

      // ---------------------------------------------------------------------------
      // UIManager
      // ---------------------------------------------------------------------------

      class UIManager {
        /**
         * @param {Object} options
         * @param {Document} [options.document]
         * @param {Window} [options.window]
         * @param {Object} [options.settingsManager]
         * @param {Object} [options.markdownRenderer]
         * @param {Object} [options.handlers]
         */
        constructor(options = {}) {
          this._doc = options.document || (typeof document !== 'undefined' ? document : null);
          this._win = options.window || (typeof window !== 'undefined' ? window : root);
          this._settings = options.settingsManager || null;
          this._markdown = options.markdownRenderer || null;
          this._handlers = options.handlers || {};

          this._host = null;
          this._shadow = null;
          this._root = null;
          this._panel = null;
          this._miniPill = null;
          this._launcher = null;
          this._lightbox = null;

          this._state = {
            isOpen: false,
            isMinimized: false,
            sidebarOpen: false,
            view: 'chat', // 'chat' | 'keys' | 'settings'
            requestStatus: 'idle', // 'idle' | 'sending' | 'streaming' | 'failover' | 'retrying' | 'cooldown' | 'error'
            connectionStatus: 'unconfigured', // 'unconfigured' | 'untested' | 'connected' | 'rate_limited' | 'error'
            connectionDetail: '',
            activeModel: 'qwen/qwen3.8-27b',
            primaryMaskedKey: '',
            pendingImages: [],
            captureMenuOpen: false,
            testingKeyId: null,
            editingKeyId: null,
            confirmRemoveKeyId: null,
            confirmClearAllHistory: false,
            confirmWipeAll: false,
            renamingConvId: null,
            recordingHotkey: false,
            fetchingModels: false,
            discoveredModels: [],
            lightboxZoom: 1,
            lightboxImage: null,
            lightboxStageIndex: -1,
            banners: [],
          };

          this._bounds = {
            x: null,
            y: null,
            width: 500,
            height: 660,
            pillX: null,
            pillY: null,
          };

          this._messageElements = new Map();
          this._streamRenderTimer = null;
          this._cooldownTimer = null;
          this._cleanupListeners = [];
          this._replaceIndex = -1;
          this._activeRenderConvId = null;
        }

        /**
         * Updates event callback handlers wired by AppCore.
         * @param {Object} handlers
         */
        setHandlers(handlers) {
          this._handlers = { ...this._handlers, ...(handlers || {}) };
        }

        /** @private */
        _t(key) {
          const lang = this._settings?.get?.('general.language', 'vi') === 'en' ? 'en' : 'vi';
          return (I18N[lang] && I18N[lang][key]) || I18N.vi[key] || key;
        }

        /** @private */
        _lang() {
          return this._settings?.get?.('general.language', 'vi') === 'en' ? 'en' : 'vi';
        }

        /**
         * Mounts the isolated Shadow DOM host into the page (idempotent).
         */
        mount() {
          if (!this._doc || typeof this._doc.createElement !== 'function') return false;
          if (this._host && this._host.parentElement) return true;

          const existing = typeof this._doc.getElementById === 'function' ? this._doc.getElementById(HOST_ID) : null;
          if (existing) existing.remove();

          const host = this._doc.createElement('div');
          host.id = HOST_ID;
          host.setAttribute('data-shc-ui', 'true');
          if (host.style) {
            host.style.all = 'initial';
            host.style.position = 'fixed';
            host.style.top = '0';
            host.style.left = '0';
            host.style.width = '0';
            host.style.height = '0';
            host.style.zIndex = '2147483646';
            host.style.pointerEvents = 'none';
            host.style.overflow = 'visible';
          }

          const mountTarget = this._doc.documentElement || this._doc.body;
          if (!mountTarget) return false;
          mountTarget.appendChild(host);

          const shadow = typeof host.attachShadow === 'function'
            ? host.attachShadow({ mode: 'open' })
            : host;

          const styleEl = this._doc.createElement('style');
          styleEl.textContent = buildStylesheet(resolveKaTeXCSS(this._win));
          shadow.appendChild(styleEl);

          this._host = host;
          this._shadow = shadow;
          this._buildShellDOM();
          this._attachGlobalListeners();
          this._initDefaultBounds();
          this._applyTheme();
          this.syncAllVisibility();
          return true;
        }

        /** @private */
        _buildShellDOM() {
          const d = this._doc;

          // Hidden file inputs
          this._fileInput = el(d, 'input', {
            type: 'file',
            attrs: { accept: 'image/png,image/jpeg,image/webp', multiple: 'multiple' },
            style: { display: 'none' },
            on: {
              change: (e) => {
                const files = e.target?.files ? Array.from(e.target.files) : [];
                e.target.value = '';
                if (files.length > 0 && this._handlers.onFilesSelected) {
                  this._handlers.onFilesSelected(files, { replaceIndex: -1, source: 'upload' });
                }
              },
            },
          });

          this._replaceFileInput = el(d, 'input', {
            type: 'file',
            attrs: { accept: 'image/png,image/jpeg,image/webp' },
            style: { display: 'none' },
            on: {
              change: (e) => {
                const files = e.target?.files ? Array.from(e.target.files) : [];
                const idx = this._replaceIndex;
                this._replaceIndex = -1;
                e.target.value = '';
                if (files.length > 0 && idx >= 0 && this._handlers.onFilesSelected) {
                  this._handlers.onFilesSelected([files[0]], { replaceIndex: idx, source: 'upload' });
                }
              },
            },
          });

          // Header
          this._btnSidebar = this._makeHeaderBtn('sidebar', 'sidebarToggle', () => this.toggleSidebar());
          this._btnNewChat = this._makeHeaderBtn('plus', 'newChat', () => this._handlers.onNewConversation?.());
          this._btnKeys = this._makeHeaderBtn('key', 'apiKeysBtn', () =>
            this.setView(this._state.view === 'keys' ? 'chat' : 'keys')
          );
          this._keyAlertDot = el(d, 'span', { className: 'shc-alert-badge' });
          this._btnKeys.appendChild(this._keyAlertDot);

          this._btnSettings = this._makeHeaderBtn('settings', 'settingsBtn', () =>
            this.setView(this._state.view === 'settings' ? 'chat' : 'settings')
          );
          this._btnMinimize = this._makeHeaderBtn('minimize', 'minimizeBtn', () => this.minimize());
          this._btnClose = this._makeHeaderBtn('close', 'closeBtn', () => this.close(), 'is-danger');

          this._connDot = el(d, 'span', { className: 'shc-dot' });
          this._connLabel = el(d, 'span', { text: this._t('connUnconfigured') });
          this._connPill = el(d, 'div', { className: 'shc-conn-pill' }, [this._connDot, this._connLabel]);
          this._titleSpan = el(d, 'span', { className: 'shc-title', text: this._t('appTitle') });

          const logoBox = el(d, 'div', { className: 'shc-logo' }, [createIcon(d, 'logo', 15)]);
          const headerLeft = el(d, 'div', { className: 'shc-header-left' }, [
            this._btnSidebar,
            el(d, 'div', { className: 'shc-brand' }, [logoBox, this._titleSpan]),
            this._connPill,
          ]);

          const headerActions = el(d, 'div', { className: 'shc-header-actions' }, [
            this._btnNewChat,
            this._btnKeys,
            this._btnSettings,
            this._btnMinimize,
            this._btnClose,
          ]);

          this._headerEl = el(d, 'div', { className: 'shc-header' }, [headerLeft, headerActions]);
          this._bindDrag(this._headerEl, 'panel');

          // Sidebar
          this._sidebarNewLabel = el(d, 'span', { text: this._t('newChat') });
          this._sidebarNewBtn = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-btn-primary shc-btn-sm',
              style: { flex: '1' },
              on: { click: () => this._handlers.onNewConversation?.() },
            },
            [createIcon(d, 'plus', 13), this._sidebarNewLabel]
          );
          this._sidebarListEl = el(d, 'div', { className: 'shc-sidebar-list' });
          this._btnExportJson = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm',
            text: this._t('exportJson'),
            on: { click: () => this._handlers.onExportConversation?.('json') },
          });
          this._btnExportMd = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm',
            text: this._t('exportMd'),
            on: { click: () => this._handlers.onExportConversation?.('markdown') },
          });
          this._btnClearHistory = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm shc-btn-danger',
            text: this._t('clearAllHistory'),
            on: {
              click: () => {
                if (!this._state.confirmClearAllHistory) {
                  this._state.confirmClearAllHistory = true;
                  this._btnClearHistory.textContent = this._t('confirmClearAll');
                  setTimeout(() => {
                    this._state.confirmClearAllHistory = false;
                    if (this._btnClearHistory) this._btnClearHistory.textContent = this._t('clearAllHistory');
                  }, 3500);
                  return;
                }
                this._state.confirmClearAllHistory = false;
                this._btnClearHistory.textContent = this._t('clearAllHistory');
                this._handlers.onClearAllHistory?.();
              },
            },
          });

          this._sidebarEl = el(d, 'aside', { className: 'shc-sidebar is-closed' }, [
            el(d, 'div', { className: 'shc-sidebar-top' }, [this._sidebarNewBtn]),
            this._sidebarListEl,
            el(d, 'div', { className: 'shc-sidebar-footer' }, [
              this._btnExportJson,
              this._btnExportMd,
              this._btnClearHistory,
            ]),
          ]);

          // Chat View: Banners + Messages + Staging + Composer
          this._bannersEl = el(d, 'div', { className: 'shc-banners' });
          this._messagesEl = el(d, 'div', { className: 'shc-messages' });
          this._messagesEl.addEventListener('click', (e) => {
            const copyBtn = e.target?.closest?.('[data-code-copy]');
            if (copyBtn) {
              const pre = copyBtn.closest('pre, .shc-code-block');
              const codeEl = pre ? pre.querySelector('code') : null;
              const codeText = codeEl ? codeEl.textContent : '';
              copyToClipboard(this._doc, this._win, codeText).then((ok) => {
                if (ok) {
                  const prev = copyBtn.textContent;
                  copyBtn.textContent = this._t('copied');
                  setTimeout(() => {
                    copyBtn.textContent = prev;
                  }, 1400);
                }
              });
            }
          });

          // Staging tray
          this._stagingHeadLabel = el(d, 'span', { text: this._t('stagingTitle') });
          this._btnCaptureAgain = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm',
            text: this._t('captureAgain'),
            on: { click: () => this._handlers.onCapture?.() },
          });
          this._btnClearStaged = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm shc-btn-ghost',
            text: this._t('clearStaged'),
            on: { click: () => this.clearPendingImages() },
          });
          this._stagingGridEl = el(d, 'div', { className: 'shc-staging-grid' });
          this._stagingWarnEl = el(d, 'div', { className: 'shc-banner is-warn', style: { display: 'none' } });
          this._stagingEl = el(d, 'div', { className: 'shc-staging is-hidden' }, [
            el(d, 'div', { className: 'shc-staging-head' }, [
              this._stagingHeadLabel,
              el(d, 'div', { className: 'shc-staging-actions' }, [this._btnCaptureAgain, this._btnClearStaged]),
            ]),
            this._stagingWarnEl,
            this._stagingGridEl,
          ]);

          // Textarea
          this._textarea = el(d, 'textarea', {
            className: 'shc-textarea',
            placeholder: this._t('composerPlaceholder'),
            attrs: { rows: '2' },
            on: {
              input: () => this._autoResizeTextarea(),
              keydown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault();
                  this._triggerSend();
                }
              },
              paste: (e) => this._handlePaste(e),
            },
          });

          // Split Capture Button
          this._captureMainLabel = el(d, 'span', { text: this._t('captureExercise') });
          this._btnCaptureMain = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-split-main',
              on: {
                click: () => {
                  this._closeCaptureMenu();
                  this._handlers.onCapture?.();
                },
              },
            },
            [createIcon(d, 'capture', 14), this._captureMainLabel]
          );
          this._btnCaptureCaret = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-split-caret',
              title: 'Choose Capture Method',
              on: {
                click: (e) => {
                  e.stopPropagation();
                  this._state.captureMenuOpen = !this._state.captureMenuOpen;
                  this._capturePopover.classList.toggle('is-hidden', !this._state.captureMenuOpen);
                },
              },
            },
            [createIcon(d, 'chevronDown', 13)]
          );
          this._domOptTitle = el(d, 'span', { className: 'shc-popover-title', text: this._t('captureDomOption') });
          this._domOptDesc = el(d, 'span', { className: 'shc-popover-desc', text: this._t('captureDomDesc') });
          this._screenOptTitle = el(d, 'span', { className: 'shc-popover-title', text: this._t('captureScreenOption') });
          this._screenOptDesc = el(d, 'span', { className: 'shc-popover-desc', text: this._t('captureScreenDesc') });
          this._capturePopover = el(d, 'div', { className: 'shc-popover is-hidden' }, [
            el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-popover-item',
                on: {
                  click: () => {
                    this._closeCaptureMenu();
                    this._handlers.onCapture?.('dom');
                  },
                },
              },
              [this._domOptTitle, this._domOptDesc]
            ),
            el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-popover-item',
                on: {
                  click: () => {
                    this._closeCaptureMenu();
                    this._handlers.onCapture?.('screen');
                  },
                },
              },
              [this._screenOptTitle, this._screenOptDesc]
            ),
          ]);
          const splitCapture = el(d, 'div', { className: 'shc-split-btn' }, [
            this._btnCaptureMain,
            this._btnCaptureCaret,
            this._capturePopover,
          ]);

          this._attachLabel = el(d, 'span', { text: this._t('attachImage') });
          this._btnAttach = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn',
              on: { click: () => this._fileInput.click() },
            },
            [createIcon(d, 'attach', 14), this._attachLabel]
          );

          this._sendLabel = el(d, 'span', { text: this._t('send') });
          this._btnSend = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-btn-primary',
              on: { click: () => this._triggerSend() },
            },
            [createIcon(d, 'send', 14), this._sendLabel]
          );

          this._cancelGenLabel = el(d, 'span', { text: this._t('cancelGen') });
          this._btnCancelGen = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-btn-danger',
              style: { display: 'none' },
              on: { click: () => this._handlers.onCancelGeneration?.() },
            },
            [createIcon(d, 'stop', 13), this._cancelGenLabel]
          );

          this._dropOverlay = el(d, 'div', {
            className: 'shc-drop-overlay',
            text: this._t('dropOverlay'),
          });

          this._composerEl = el(d, 'div', { className: 'shc-composer' }, [
            this._stagingEl,
            this._textarea,
            el(d, 'div', { className: 'shc-composer-bar' }, [
              el(d, 'div', { className: 'shc-composer-left' }, [splitCapture, this._btnAttach]),
              el(d, 'div', { className: 'shc-composer-right' }, [this._btnCancelGen, this._btnSend]),
            ]),
          ]);

          this._chatViewEl = el(d, 'div', { className: 'shc-view' }, [
            this._bannersEl,
            this._messagesEl,
            this._composerEl,
          ]);

          // Keys Sub-View & Settings Sub-View
          this._keysViewEl = el(d, 'div', { className: 'shc-view is-hidden' });
          this._settingsViewEl = el(d, 'div', { className: 'shc-view is-hidden' });

          this._mainEl = el(d, 'div', { className: 'shc-main' }, [
            this._dropOverlay,
            this._chatViewEl,
            this._keysViewEl,
            this._settingsViewEl,
          ]);
          this._bindDragAndDrop(this._mainEl);

          // Status bar
          this._statusModelBtn = el(d, 'button', {
            type: 'button',
            className: 'shc-status-link',
            on: { click: () => this.setView('settings') },
          });
          this._statusKeyBtn = el(d, 'button', {
            type: 'button',
            className: 'shc-status-link',
            on: { click: () => this.setView('keys') },
          });
          this._statusRequestEl = el(d, 'span', { text: this._t('statusIdle') });
          this._statusConnEl = el(d, 'span', { text: this._t('connUnconfigured') });

          this._statusBarEl = el(d, 'footer', { className: 'shc-statusbar' }, [
            el(d, 'div', { className: 'shc-status-group' }, [
              this._statusModelBtn,
              el(d, 'span', { text: '·' }),
              this._statusKeyBtn,
            ]),
            el(d, 'div', { className: 'shc-status-group' }, [
              this._statusRequestEl,
              el(d, 'span', { text: '·' }),
              this._statusConnEl,
            ]),
          ]);

          // Resize handles
          const resizeHandles = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map((dir) => {
            const h = el(d, 'div', { className: `shc-resize shc-resize-${dir}` });
            this._bindResize(h, dir);
            return h;
          });

          this._panel = el(d, 'section', { className: 'shc-panel is-hidden', attrs: { role: 'dialog', 'aria-label': 'Smart Homework Capture' } }, [
            ...resizeHandles,
            this._headerEl,
            el(d, 'div', { className: 'shc-body' }, [this._sidebarEl, this._mainEl]),
            this._statusBarEl,
          ]);

          // Minimized Pill
          this._pillDot = el(d, 'span', { className: 'shc-dot' });
          this._pillText = el(d, 'span', {
            style: { fontSize: '12px', fontWeight: '600' },
            text: 'SHC · qwen3.8-27b',
          });
          this._miniPill = el(d, 'div', { className: 'shc-mini-pill is-hidden' }, [
            createIcon(d, 'logo', 15),
            this._pillDot,
            this._pillText,
            el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-btn shc-btn-sm shc-btn-primary',
                text: this._t('restoreBtn'),
                on: {
                  click: (e) => {
                    e.stopPropagation();
                    this.restore();
                  },
                },
              }
            ),
            el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-btn shc-btn-sm',
                text: this._t('quickCaptureBtn'),
                on: {
                  click: (e) => {
                    e.stopPropagation();
                    this.restore();
                    this._handlers.onCapture?.();
                  },
                },
              }
            ),
            el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-icon-btn is-danger',
                title: this._t('closeBtn'),
                on: {
                  click: (e) => {
                    e.stopPropagation();
                    this.close();
                  },
                },
              },
              [createIcon(d, 'close', 13)]
            ),
          ]);
          this._bindDrag(this._miniPill, 'pill');

          // Floating Launcher
          this._launcher = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-launcher',
              title: `${this._t('appTitle')} (${formatHotkeyLabel(this._settings?.get?.('general.hotkey'))})`,
              on: { click: () => this.open() },
            },
            [createIcon(d, 'logo', 15), el(d, 'span', { text: 'AI Tutor' })]
          );

          // Lightbox Modal
          this._lightboxImg = el(d, 'img', { className: 'shc-lightbox-img', attrs: { alt: 'Homework Preview' } });
          this._lightboxInfo = el(d, 'span', { style: { fontSize: '12px', color: '#94a3b8' } });
          this._lightboxCropBtn = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm',
            text: this._t('cropAgain'),
            on: {
              click: () => {
                const idx = this._state.lightboxStageIndex;
                this.closeLightbox();
                if (idx >= 0) this._handlers.onCropStagedImage?.(idx);
              },
            },
          });
          this._lightbox = el(
            d,
            'div',
            {
              className: 'shc-lightbox is-hidden',
              on: {
                click: (e) => {
                  if (e.target === this._lightbox) this.closeLightbox();
                },
              },
            },
            [
              el(d, 'div', { className: 'shc-lightbox-toolbar' }, [
                this._lightboxInfo,
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm',
                  text: '−',
                  on: { click: () => this._setLightboxZoom(this._state.lightboxZoom - 0.25) },
                }),
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm',
                  text: '100%',
                  on: { click: () => this._setLightboxZoom(1) },
                }),
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm',
                  text: '+',
                  on: { click: () => this._setLightboxZoom(this._state.lightboxZoom + 0.25) },
                }),
                this._lightboxCropBtn,
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm shc-btn-danger',
                  text: this._t('closeBtn'),
                  on: { click: () => this.closeLightbox() },
                }),
              ]),
              el(d, 'div', { className: 'shc-lightbox-stage' }, [this._lightboxImg]),
            ]
          );

          this._root = el(d, 'div', { className: 'shc-root', dataset: { theme: 'dark' } }, [
            this._fileInput,
            this._replaceFileInput,
            this._panel,
            this._miniPill,
            this._launcher,
            this._lightbox,
          ]);

          this._shadow.appendChild(this._root);
        }

        /** @private */
        _makeHeaderBtn(iconName, titleKey, onClick, extraClass = '') {
          const btn = el(
            this._doc,
            'button',
            {
              type: 'button',
              className: `shc-icon-btn ${extraClass}`.trim(),
              title: this._t(titleKey),
              on: { click: onClick },
            },
            [createIcon(this._doc, iconName, 16)]
          );
          return btn;
        }

        /** @private */
        _attachGlobalListeners() {
          const onResize = () => this._clampBoundsToViewport();
          const onDocClick = (e) => {
            if (this._state.captureMenuOpen) {
              const inside = this._capturePopover?.contains?.(e.target) || this._btnCaptureCaret?.contains?.(e.target);
              if (!inside) this._closeCaptureMenu();
            }
          };
          const onKeyDown = (e) => {
            if (e.key === 'Escape' && this._lightbox && !this._lightbox.classList.contains('is-hidden')) {
              this.closeLightbox();
            }
          };

          if (this._win && typeof this._win.addEventListener === 'function') {
            this._win.addEventListener('resize', onResize);
            this._cleanupListeners.push(() => this._win.removeEventListener('resize', onResize));
          }
          if (this._shadow && typeof this._shadow.addEventListener === 'function') {
            this._shadow.addEventListener('click', onDocClick);
            this._cleanupListeners.push(() => this._shadow.removeEventListener('click', onDocClick));
          }
          if (this._doc && typeof this._doc.addEventListener === 'function') {
            this._doc.addEventListener('keydown', onKeyDown);
            this._cleanupListeners.push(() => this._doc.removeEventListener('keydown', onKeyDown));
          }
        }

        /** @private */
        _initDefaultBounds() {
          const vw = Number(this._win?.innerWidth) || 1280;
          const vh = Number(this._win?.innerHeight) || 800;
          const w = Math.min(520, Math.max(360, vw - 24));
          const h = Math.min(680, Math.max(420, vh - 32));
          this._bounds.width = w;
          this._bounds.height = h;
          this._bounds.x = Math.max(8, vw - w - 18);
          this._bounds.y = Math.max(8, vh - h - 18);
          this._bounds.pillX = Math.max(8, vw - 310);
          this._bounds.pillY = Math.max(8, vh - 56);
          this._applyBounds();
        }

        /** @private */
        _clampBoundsToViewport() {
          const vw = Number(this._win?.innerWidth) || 1280;
          const vh = Number(this._win?.innerHeight) || 800;
          const minW = Math.min(360, Math.max(280, vw - 16));
          const minH = Math.min(400, Math.max(300, vh - 16));

          this._bounds.width = Math.min(Math.max(this._bounds.width, minW), vw - 12);
          this._bounds.height = Math.min(Math.max(this._bounds.height, minH), vh - 12);

          if (this._bounds.x === null) this._bounds.x = vw - this._bounds.width - 18;
          if (this._bounds.y === null) this._bounds.y = vh - this._bounds.height - 18;

          this._bounds.x = Math.min(Math.max(6, this._bounds.x), Math.max(6, vw - this._bounds.width - 6));
          this._bounds.y = Math.min(Math.max(6, this._bounds.y), Math.max(6, vh - this._bounds.height - 6));

          if (this._bounds.pillX !== null) {
            this._bounds.pillX = Math.min(Math.max(6, this._bounds.pillX), Math.max(6, vw - 220));
            this._bounds.pillY = Math.min(Math.max(6, this._bounds.pillY), Math.max(6, vh - 46));
          }

          this._applyBounds();
        }

        /** @private */
        _applyBounds() {
          if (!this._panel || !this._panel.style) return;
          this._panel.style.left = `${Math.round(this._bounds.x || 16)}px`;
          this._panel.style.top = `${Math.round(this._bounds.y || 16)}px`;
          this._panel.style.width = `${Math.round(this._bounds.width)}px`;
          this._panel.style.height = `${Math.round(this._bounds.height)}px`;
          if (this._panel.classList) {
            this._panel.classList.toggle('is-narrow', this._bounds.width < 680);
          }

          if (this._miniPill && this._miniPill.style) {
            this._miniPill.style.left = `${Math.round(this._bounds.pillX || 16)}px`;
            this._miniPill.style.top = `${Math.round(this._bounds.pillY || 16)}px`;
          }
        }

        /** @private */
        _bindDrag(handleEl, targetKind) {
          if (!handleEl || typeof handleEl.addEventListener !== 'function') return;
          handleEl.addEventListener('mousedown', (startEvt) => {
            if (startEvt.button !== 0) return;
            if (startEvt.target?.closest?.('button, input, select, a')) return;
            startEvt.preventDefault();
            const startX = startEvt.clientX;
            const startY = startEvt.clientY;
            const origX = targetKind === 'pill' ? this._bounds.pillX : this._bounds.x;
            const origY = targetKind === 'pill' ? this._bounds.pillY : this._bounds.y;
            if (targetKind === 'panel' && this._panel?.classList) {
              this._panel.classList.add('is-dragging');
            }

            const onMove = (ev) => {
              const dx = ev.clientX - startX;
              const dy = ev.clientY - startY;
              if (targetKind === 'pill') {
                this._bounds.pillX = (origX || 0) + dx;
                this._bounds.pillY = (origY || 0) + dy;
              } else {
                this._bounds.x = (origX || 0) + dx;
                this._bounds.y = (origY || 0) + dy;
              }
              this._clampBoundsToViewport();
            };
            const onUp = () => {
              if (targetKind === 'panel' && this._panel?.classList) {
                this._panel.classList.remove('is-dragging');
              }
              this._doc.removeEventListener('mousemove', onMove);
              this._doc.removeEventListener('mouseup', onUp);
            };
            this._doc.addEventListener('mousemove', onMove);
            this._doc.addEventListener('mouseup', onUp);
          });
        }

        /** @private */
        _bindResize(handleEl, dir) {
          if (!handleEl || typeof handleEl.addEventListener !== 'function') return;
          handleEl.addEventListener('mousedown', (startEvt) => {
            if (startEvt.button !== 0) return;
            startEvt.preventDefault();
            startEvt.stopPropagation();
            const startX = startEvt.clientX;
            const startY = startEvt.clientY;
            const orig = { ...this._bounds };
            const vw = Number(this._win?.innerWidth) || 1280;
            const vh = Number(this._win?.innerHeight) || 800;
            const minW = Math.min(360, vw - 16);
            const minH = Math.min(400, vh - 16);
            if (this._panel?.classList) this._panel.classList.add('is-resizing');

            const onMove = (ev) => {
              const dx = ev.clientX - startX;
              const dy = ev.clientY - startY;
              let { x, y, width, height } = orig;

              if (dir.includes('e')) width = Math.min(vw - x - 6, Math.max(minW, orig.width + dx));
              if (dir.includes('s')) height = Math.min(vh - y - 6, Math.max(minH, orig.height + dy));
              if (dir.includes('w')) {
                const nextW = Math.max(minW, orig.width - dx);
                const delta = orig.width - nextW;
                const nextX = Math.max(6, orig.x + delta);
                width = orig.x + orig.width - nextX;
                x = nextX;
              }
              if (dir.includes('n')) {
                const nextH = Math.max(minH, orig.height - dy);
                const delta = orig.height - nextH;
                const nextY = Math.max(6, orig.y + delta);
                height = orig.y + orig.height - nextY;
                y = nextY;
              }

              this._bounds.x = x;
              this._bounds.y = y;
              this._bounds.width = width;
              this._bounds.height = height;
              this._clampBoundsToViewport();
            };
            const onUp = () => {
              if (this._panel?.classList) this._panel.classList.remove('is-resizing');
              this._doc.removeEventListener('mousemove', onMove);
              this._doc.removeEventListener('mouseup', onUp);
            };
            this._doc.addEventListener('mousemove', onMove);
            this._doc.addEventListener('mouseup', onUp);
          });
        }

        /** @private */
        _bindDragAndDrop(targetEl) {
          if (!targetEl || typeof targetEl.addEventListener !== 'function') return;
          let dragDepth = 0;
          const hasFiles = (e) => {
            const types = e.dataTransfer?.types;
            if (!types) return false;
            return Array.from(types).includes('Files');
          };
          targetEl.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth++;
            this._panel?.classList?.add('is-dragover');
          });
          targetEl.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          });
          targetEl.addEventListener('dragleave', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth = Math.max(0, dragDepth - 1);
            if (dragDepth === 0) this._panel?.classList?.remove('is-dragover');
          });
          targetEl.addEventListener('drop', (e) => {
            e.preventDefault();
            dragDepth = 0;
            this._panel?.classList?.remove('is-dragover');
            const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
            if (files.length > 0 && this._handlers.onFilesSelected) {
              this._handlers.onFilesSelected(files, { replaceIndex: -1, source: 'drop' });
            }
          });
        }

        /** @private */
        _handlePaste(e) {
          const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
          const files = [];
          for (const item of items) {
            if (item && item.kind === 'file' && String(item.type || '').startsWith('image/')) {
              const f = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
              if (f) files.push(f);
            }
          }
          if (files.length === 0 && e.clipboardData?.files?.length) {
            for (const f of Array.from(e.clipboardData.files)) {
              if (String(f.type || '').startsWith('image/')) files.push(f);
            }
          }
          if (files.length > 0) {
            e.preventDefault();
            this._handlers.onFilesSelected?.(files, { replaceIndex: -1, source: 'paste' });
          }
        }

        /** @private */
        _closeCaptureMenu() {
          this._state.captureMenuOpen = false;
          this._capturePopover?.classList?.add('is-hidden');
        }

        /** @private */
        _autoResizeTextarea() {
          const ta = this._textarea;
          if (!ta || !ta.style) return;
          ta.style.height = 'auto';
          const sh = Number(ta.scrollHeight) || 44;
          ta.style.height = `${Math.min(140, Math.max(44, sh))}px`;
        }

        /** @private */
        _applyTheme() {
          if (!this._root) return;
          const theme = this._settings?.get?.('general.theme', 'dark') === 'light' ? 'light' : 'dark';
          this._root.setAttribute('data-theme', theme);
        }

        // -------------------------------------------------------------------------
        // Public Open / Close / Minimize / View Controls
        // -------------------------------------------------------------------------

        isOpen() {
          return this._state.isOpen;
        }

        open() {
          this.mount();
          this._state.isOpen = true;
          this._state.isMinimized = false;
          this._clampBoundsToViewport();
          this.syncAllVisibility();
          if (typeof this._textarea?.focus === 'function' && this._state.view === 'chat') {
            setTimeout(() => this._textarea?.focus?.(), 40);
          }
        }

        close() {
          this._state.isOpen = false;
          this._state.isMinimized = false;
          this._closeCaptureMenu();
          this._stopCooldownTicker();
          this.syncAllVisibility();
        }

        toggle() {
          if (this._state.isOpen && !this._state.isMinimized) {
            this.close();
          } else {
            this.open();
          }
        }

        minimize() {
          if (!this._state.isOpen) return;
          this._state.isMinimized = true;
          this._closeCaptureMenu();
          this.syncAllVisibility();
        }

        restore() {
          this._state.isOpen = true;
          this._state.isMinimized = false;
          this._clampBoundsToViewport();
          this.syncAllVisibility();
        }

        toggleSidebar(forceState) {
          this._state.sidebarOpen = typeof forceState === 'boolean' ? forceState : !this._state.sidebarOpen;
          this._sidebarEl?.classList?.toggle('is-closed', !this._state.sidebarOpen);
          this._btnSidebar?.classList?.toggle('is-active', this._state.sidebarOpen);
        }

        setView(view) {
          if (!['chat', 'keys', 'settings'].includes(view)) return;
          this._state.view = view;
          this._chatViewEl?.classList?.toggle('is-hidden', view !== 'chat');
          this._keysViewEl?.classList?.toggle('is-hidden', view !== 'keys');
          this._settingsViewEl?.classList?.toggle('is-hidden', view !== 'settings');
          this._btnKeys?.classList?.toggle('is-active', view === 'keys');
          this._btnSettings?.classList?.toggle('is-active', view === 'settings');

          if (view === 'keys') {
            this._handlers.onRequestKeysRefresh?.();
            this._startCooldownTicker();
          } else {
            this._stopCooldownTicker();
          }
          if (view === 'settings') {
            this._handlers.onRequestSettingsRefresh?.();
          }
        }

        syncAllVisibility() {
          if (!this._panel) return;
          const showPanel = this._state.isOpen && !this._state.isMinimized;
          const showPill = this._state.isOpen && this._state.isMinimized;
          const showFloating = this._settings?.get?.('general.showFloatingButton', true) !== false;
          const showLauncher = !this._state.isOpen && showFloating && this._settings?.get?.('general.enabled', true) !== false;

          if (showPanel) {
            this._panel.classList.remove('is-hidden');
            this._panel.classList.add('is-open');
          } else {
            this._panel.classList.remove('is-open');
            this._panel.classList.add('is-hidden');
          }
          this._miniPill?.classList?.toggle('is-hidden', !showPill);
          this._launcher?.classList?.toggle('is-hidden', !showLauncher);
        }

        /**
         * Temporarily hides all SHC floating UI during DOM/Screen capture without altering open state.
         * @param {boolean} hidden
         */
        setTemporaryHidden(hidden) {
          const val = hidden ? 'hidden' : '';
          if (this._panel?.style) this._panel.style.visibility = val;
          if (this._miniPill?.style) this._miniPill.style.visibility = val;
          if (this._launcher?.style) this._launcher.style.visibility = val;
        }

        refreshLocale() {
          this._applyTheme();
          if (this._titleSpan) this._titleSpan.textContent = this._t('appTitle');
          if (this._btnSidebar) this._btnSidebar.setAttribute('title', this._t('sidebarToggle'));
          if (this._btnNewChat) this._btnNewChat.setAttribute('title', this._t('newChat'));
          if (this._btnKeys) this._btnKeys.setAttribute('title', this._t('apiKeysBtn'));
          if (this._btnSettings) this._btnSettings.setAttribute('title', this._t('settingsBtn'));
          if (this._btnMinimize) this._btnMinimize.setAttribute('title', this._t('minimizeBtn'));
          if (this._btnClose) this._btnClose.setAttribute('title', this._t('closeBtn'));
          if (this._sidebarNewLabel) this._sidebarNewLabel.textContent = this._t('newChat');
          if (this._captureMainLabel) this._captureMainLabel.textContent = this._t('captureExercise');
          if (this._domOptTitle) this._domOptTitle.textContent = this._t('captureDomOption');
          if (this._domOptDesc) this._domOptDesc.textContent = this._t('captureDomDesc');
          if (this._screenOptTitle) this._screenOptTitle.textContent = this._t('captureScreenOption');
          if (this._screenOptDesc) this._screenOptDesc.textContent = this._t('captureScreenDesc');
          if (this._attachLabel) this._attachLabel.textContent = this._t('attachImage');
          if (this._sendLabel) this._sendLabel.textContent = this._t('send');
          if (this._cancelGenLabel) this._cancelGenLabel.textContent = this._t('cancelGen');
          if (this._textarea) this._textarea.placeholder = this._t('composerPlaceholder');
          if (this._dropOverlay) this._dropOverlay.textContent = this._t('dropOverlay');
          if (this._stagingHeadLabel) this._stagingHeadLabel.textContent = this._t('stagingTitle');
          if (this._btnCaptureAgain) this._btnCaptureAgain.textContent = this._t('captureAgain');
          if (this._btnClearStaged) this._btnClearStaged.textContent = this._t('clearStaged');
          if (this._btnExportJson) this._btnExportJson.textContent = this._t('exportJson');
          if (this._btnExportMd) this._btnExportMd.textContent = this._t('exportMd');
          if (this._btnClearHistory) this._btnClearHistory.textContent = this._t('clearAllHistory');
          if (this._lightboxCropBtn) this._lightboxCropBtn.textContent = this._t('cropAgain');
          this._renderStagingTray();
          this._updateStatusDisplay();
          this.syncAllVisibility();
          if (this._state.view === 'keys') this._handlers.onRequestKeysRefresh?.();
          if (this._state.view === 'settings') this._handlers.onRequestSettingsRefresh?.();
        }

        // -------------------------------------------------------------------------
        // Status, Banners & Composer State
        // -------------------------------------------------------------------------

        setStatus({ requestStatus, connectionStatus, connectionDetail, activeModel, primaryMaskedKey } = {}) {
          if (requestStatus !== undefined) this._state.requestStatus = requestStatus;
          if (connectionStatus !== undefined) this._state.connectionStatus = connectionStatus;
          if (connectionDetail !== undefined) this._state.connectionDetail = connectionDetail;
          if (activeModel !== undefined) this._state.activeModel = activeModel;
          if (primaryMaskedKey !== undefined) this._state.primaryMaskedKey = primaryMaskedKey;
          this._updateStatusDisplay();
        }

        /** @private */
        _updateStatusDisplay() {
          const reqMap = {
            idle: this._t('statusIdle'),
            sending: this._t('statusSending'),
            streaming: this._t('statusStreaming'),
            failover: this._t('statusFailover'),
            retrying: this._t('statusRetrying'),
            cooldown: this._t('statusCooldown'),
            error: this._t('statusError'),
          };
          const connMap = {
            unconfigured: this._t('connUnconfigured'),
            untested: this._t('connUntested'),
            connected: this._t('connConnected'),
            rate_limited: this._t('connRateLimited'),
            error: this._t('connError'),
          };

          const isBusy = ['sending', 'streaming', 'failover', 'retrying'].includes(this._state.requestStatus);
          const reqLabel = reqMap[this._state.requestStatus] || this._t('statusIdle');
          const connLabel = connMap[this._state.connectionStatus] || this._t('connUnconfigured');

          let dotClass = 'shc-dot';
          if (isBusy) dotClass += ' is-working';
          else if (this._state.connectionStatus === 'connected') dotClass += ' is-connected';
          else if (this._state.connectionStatus === 'rate_limited' || this._state.connectionStatus === 'unconfigured') dotClass += ' is-warn';
          else if (this._state.connectionStatus === 'error') dotClass += ' is-error';

          if (this._connDot) this._connDot.className = dotClass;
          if (this._pillDot) this._pillDot.className = dotClass;
          if (this._connLabel) this._connLabel.textContent = isBusy ? reqLabel : connLabel;
          if (this._connPill && this._state.connectionDetail) {
            this._connPill.setAttribute('title', this._state.connectionDetail);
          }

          if (this._keyAlertDot && this._keyAlertDot.style) {
            this._keyAlertDot.style.display = this._state.connectionStatus === 'unconfigured' ? 'block' : 'none';
          }

          const shortModel = (this._state.activeModel || '').split('/').pop() || this._state.activeModel;
          if (this._pillText) this._pillText.textContent = `SHC · ${shortModel}`;
          if (this._statusModelBtn) this._statusModelBtn.textContent = `Model: ${this._state.activeModel || '—'}`;
          if (this._statusKeyBtn) {
            this._statusKeyBtn.textContent = `Key: ${this._state.primaryMaskedKey || this._t('noActiveKeyShort')}`;
          }
          if (this._statusRequestEl) this._statusRequestEl.textContent = reqLabel;
          if (this._statusConnEl) this._statusConnEl.textContent = connLabel;

          if (this._btnSend) this._btnSend.disabled = isBusy;
          if (this._btnCancelGen && this._btnCancelGen.style) {
            this._btnCancelGen.style.display = isBusy ? 'inline-flex' : 'none';
          }
        }

        setBanners(banners = []) {
          this._state.banners = Array.isArray(banners) ? banners : [];
          if (!this._bannersEl) return;
          clearChildren(this._bannersEl);
          for (const b of this._state.banners) {
            const cls = b.level === 'error' ? 'is-error' : b.level === 'info' ? 'is-info' : 'is-warn';
            const actions = [];
            if (Array.isArray(b.actions)) {
              for (const act of b.actions) {
                actions.push(
                  el(this._doc, 'button', {
                    type: 'button',
                    className: 'shc-btn shc-btn-sm',
                    text: act.label,
                    on: { click: () => act.onClick?.() },
                  })
                );
              }
            }
            const dismissBtn = el(
              this._doc,
              'button',
              {
                type: 'button',
                className: 'shc-icon-btn',
                title: this._t('dismiss'),
                on: { click: () => this.dismissBanner(b.id) },
              },
              [createIcon(this._doc, 'close', 13)]
            );

            const bannerEl = el(this._doc, 'div', { className: `shc-banner ${cls}` }, [
              el(this._doc, 'div', { className: 'shc-banner-body' }, [
                el(this._doc, 'div', { text: b.message }),
                actions.length > 0 ? el(this._doc, 'div', { className: 'shc-banner-actions' }, actions) : null,
              ]),
              dismissBtn,
            ]);
            this._bannersEl.appendChild(bannerEl);
          }
        }

        addBanner(banner) {
          const next = this._state.banners.filter((b) => b.id !== banner.id);
          next.push(banner);
          this.setBanners(next);
        }

        dismissBanner(id) {
          this.setBanners(this._state.banners.filter((b) => b.id !== id));
        }

        getDraftText() {
          return this._textarea ? String(this._textarea.value || '') : '';
        }

        setDraftText(text) {
          if (this._textarea) {
            this._textarea.value = String(text || '');
            this._autoResizeTextarea();
          }
        }

        getPendingImages() {
          return [...this._state.pendingImages];
        }

        setPendingImages(images = []) {
          this._state.pendingImages = Array.isArray(images) ? [...images] : [];
          this._renderStagingTray();
        }

        addPendingImages(newImages = []) {
          const list = Array.isArray(newImages) ? newImages : [newImages];
          for (const img of list) {
            if (img) this._state.pendingImages.push(img);
          }
          this._renderStagingTray();
        }

        clearPendingImages() {
          for (const img of this._state.pendingImages) {
            this._handlers.onDisposeImage?.(img);
          }
          this._state.pendingImages = [];
          this._renderStagingTray();
          this._handlers.onPendingImagesChanged?.([]);
        }

        /** @private */
        _renderStagingTray() {
          if (!this._stagingEl || !this._stagingGridEl) return;
          const imgs = this._state.pendingImages;
          this._stagingEl.classList.toggle('is-hidden', imgs.length === 0);
          clearChildren(this._stagingGridEl);

          if (imgs.length === 0) {
            if (this._stagingWarnEl?.style) this._stagingWarnEl.style.display = 'none';
            return;
          }

          const activeModel = this._state.activeModel || this._settings?.getActiveModel?.() || 'qwen/qwen3.8-27b';
          const constraints = SHC.GroqAPIClient?.getModelConstraints?.(activeModel) || {
            vision: true,
            maxImagesPerRequest: 3,
          };
          const maxAllowed = Math.min(
            Number(this._settings?.get?.('capture.maxImagesPerMessage', 3) || 3),
            constraints.maxImagesPerRequest || 3
          );

          if (!constraints.vision) {
            this._stagingWarnEl.textContent = this._t('modelVisionWarn');
            this._stagingWarnEl.style.display = 'flex';
          } else if (imgs.length > maxAllowed) {
            this._stagingWarnEl.textContent =
              this._lang() === 'en'
                ? `Model ${activeModel} allows at most ${maxAllowed} images per request (currently staged: ${imgs.length}). Remove extra images before sending.`
                : `Model ${activeModel} chỉ hỗ trợ tối đa ${maxAllowed} ảnh/lượt gửi (đang chọn ${imgs.length}). Hãy gỡ bớt ảnh trước khi gửi.`;
            this._stagingWarnEl.style.display = 'flex';
          } else {
            this._stagingWarnEl.style.display = 'none';
          }

          this._stagingHeadLabel.textContent = `${this._t('stagingTitle')} (${imgs.length}${constraints.vision ? ` / ${maxAllowed}` : ''})`;

          imgs.forEach((img, idx) => {
            const d = this._doc;
            const dims = img.width && img.height ? `${img.width}×${img.height}` : '';
            const metaStr = [dims, formatBytes(img.sizeBytes)].filter(Boolean).join(' · ');

            const thumb = el(d, 'img', {
              className: 'shc-stage-thumb',
              attrs: { src: img.dataUrl || img.previewUrl || img.objectUrl || '', alt: img.name || `Image ${idx + 1}` },
            });
            const thumbChildren = [thumb];
            if (Array.isArray(img.warnings) && img.warnings.length > 0) {
              thumbChildren.push(
                el(d, 'span', {
                  className: 'shc-badge is-warn',
                  text: '!',
                  title: img.warnings.join(' '),
                  style: { position: 'absolute', top: '4px', right: '4px' },
                })
              );
            }
            const thumbWrap = el(
              d,
              'div',
              {
                className: 'shc-stage-thumb-wrap',
                on: { click: () => this.openLightbox(img, idx) },
              },
              thumbChildren
            );

            const moveLeftBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('moveLeft'),
                disabled: idx === 0,
                on: { click: () => this._movePendingImage(idx, -1) },
              },
              [createIcon(d, 'left', 12)]
            );
            const moveRightBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('moveRight'),
                disabled: idx === imgs.length - 1,
                on: { click: () => this._movePendingImage(idx, 1) },
              },
              [createIcon(d, 'right', 12)]
            );
            const zoomBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('zoom'),
                on: { click: () => this.openLightbox(img, idx) },
              },
              [createIcon(d, 'zoom', 12)]
            );
            const cropBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('cropAgain'),
                on: { click: () => this._handlers.onCropStagedImage?.(idx) },
              },
              [createIcon(d, 'crop', 12)]
            );
            const replaceBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('replaceImage'),
                on: {
                  click: () => {
                    this._replaceIndex = idx;
                    this._replaceFileInput.click();
                  },
                },
              },
              [createIcon(d, 'refresh', 12)]
            );
            const removeBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('removeImage'),
                style: { color: '#ef4444' },
                on: { click: () => this._removePendingImage(idx) },
              },
              [createIcon(d, 'close', 12)]
            );

            const card = el(d, 'div', { className: 'shc-stage-card' }, [
              thumbWrap,
              el(d, 'div', { className: 'shc-stage-meta', text: metaStr || img.name || `Image ${idx + 1}`, title: img.name || '' }),
              el(d, 'div', { className: 'shc-stage-btns' }, [
                moveLeftBtn,
                moveRightBtn,
                zoomBtn,
                cropBtn,
                replaceBtn,
                removeBtn,
              ]),
            ]);
            this._stagingGridEl.appendChild(card);
          });
        }

        /** @private */
        _movePendingImage(idx, dir) {
          const imgs = this._state.pendingImages;
          const target = idx + dir;
          if (target < 0 || target >= imgs.length) return;
          const [moved] = imgs.splice(idx, 1);
          imgs.splice(target, 0, moved);
          this._renderStagingTray();
          this._handlers.onPendingImagesChanged?.([...imgs]);
        }

        /** @private */
        _removePendingImage(idx) {
          const [removed] = this._state.pendingImages.splice(idx, 1);
          if (removed) this._handlers.onDisposeImage?.(removed);
          this._renderStagingTray();
          this._handlers.onPendingImagesChanged?.([...this._state.pendingImages]);
        }

        /** @private */
        _triggerSend() {
          const text = this.getDraftText();
          const images = this.getPendingImages();
          if (!text.trim() && images.length === 0) return;
          this._handlers.onSendMessage?.({ text, images });
        }

        // -------------------------------------------------------------------------
        // Lightbox
        // -------------------------------------------------------------------------

        openLightbox(img, stageIndex = -1) {
          if (!this._lightbox || !img || !img.dataUrl && !img.previewUrl) return;
          this._state.lightboxImage = img;
          this._state.lightboxStageIndex = stageIndex;
          this._lightboxImg.setAttribute('src', img.dataUrl || img.previewUrl);
          const dims = img.width && img.height ? `${img.width}×${img.height}` : '';
          this._lightboxInfo.textContent = [img.name || 'Image', dims, formatBytes(img.sizeBytes)].filter(Boolean).join(' · ');
          if (this._lightboxCropBtn?.style) {
            this._lightboxCropBtn.style.display = stageIndex >= 0 ? 'inline-flex' : 'none';
          }
          this._setLightboxZoom(1);
          this._lightbox.classList.remove('is-hidden');
        }

        closeLightbox() {
          this._lightbox?.classList?.add('is-hidden');
          this._state.lightboxImage = null;
          this._state.lightboxStageIndex = -1;
        }

        /** @private */
        _setLightboxZoom(z) {
          const clamped = Math.min(3, Math.max(0.5, z));
          this._state.lightboxZoom = clamped;
          if (this._lightboxImg?.style) {
            this._lightboxImg.style.transform = `scale(${clamped})`;
          }
        }

        // -------------------------------------------------------------------------
        // Sidebar Rendering
        // -------------------------------------------------------------------------

        renderSidebar(summaryList = []) {
          if (!this._sidebarListEl) return;
          clearChildren(this._sidebarListEl);
          const d = this._doc;
          const lang = this._lang();

          for (const conv of summaryList) {
            const isRenaming = this._state.renamingConvId === conv.id;
            let titleNode;

            if (isRenaming) {
              const renameInput = el(d, 'input', {
                type: 'text',
                className: 'shc-input',
                value: conv.title,
                style: { padding: '3px 6px', fontSize: '12px' },
                on: {
                  click: (e) => e.stopPropagation(),
                  keydown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      this._state.renamingConvId = null;
                      this._handlers.onRenameConversation?.(conv.id, renameInput.value);
                    } else if (e.key === 'Escape') {
                      this._state.renamingConvId = null;
                      this.renderSidebar(summaryList);
                    }
                  },
                  blur: () => {
                    this._state.renamingConvId = null;
                    this._handlers.onRenameConversation?.(conv.id, renameInput.value);
                  },
                },
              });
              titleNode = renameInput;
              setTimeout(() => renameInput?.focus?.(), 0);
            } else {
              titleNode = el(d, 'span', { className: 'shc-conv-title', text: conv.title || 'Chat' });
            }

            const renameBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('rename'),
                on: {
                  click: (e) => {
                    e.stopPropagation();
                    this._state.renamingConvId = conv.id;
                    this.renderSidebar(summaryList);
                  },
                },
              },
              [createIcon(d, 'edit', 11)]
            );
            const delBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('delete'),
                on: {
                  click: (e) => {
                    e.stopPropagation();
                    this._handlers.onDeleteConversation?.(conv.id);
                  },
                },
              },
              [createIcon(d, 'trash', 11)]
            );

            const shortModel = (conv.model || '').split('/').pop() || 'groq';
            const itemEl = el(
              d,
              'div',
              {
                className: `shc-conv-item ${conv.isActive ? 'is-active' : ''}`.trim(),
                on: {
                  click: () => {
                    if (this._state.renamingConvId !== conv.id) {
                      this._handlers.onSwitchConversation?.(conv.id);
                      if (this._bounds.width < 680) this.toggleSidebar(false);
                    }
                  },
                },
              },
              [
                el(d, 'div', { className: 'shc-conv-row' }, [
                  titleNode,
                  el(d, 'div', { className: 'shc-conv-actions' }, [renameBtn, delBtn]),
                ]),
                el(d, 'div', { className: 'shc-conv-meta' }, [
                  el(d, 'span', { className: 'shc-badge', text: shortModel }),
                  el(d, 'span', { text: `${conv.messageCount || 0} · ${formatDateTimeShort(conv.updatedAt, lang)}` }),
                ]),
              ]
            );
            this._sidebarListEl.appendChild(itemEl);
          }
        }

        // -------------------------------------------------------------------------
        // Incremental Conversation Rendering
        // -------------------------------------------------------------------------

        renderConversation(conversation, { hasActiveKey = true } = {}) {
          if (!this._messagesEl) return;
          clearChildren(this._messagesEl);
          this._messageElements.clear();
          this._activeRenderConvId = conversation?.id || null;

          const msgs = Array.isArray(conversation?.messages) ? conversation.messages : [];
          if (msgs.length === 0) {
            this._renderEmptyWelcome(hasActiveKey);
            return;
          }

          for (const msg of msgs) {
            this.appendMessage(msg);
          }
          this._scrollToBottom();
        }

        /** @private */
        _renderEmptyWelcome(hasActiveKey) {
          const d = this._doc;
          const btns = [
            el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-btn shc-btn-primary',
                on: { click: () => this._handlers.onCapture?.() },
              },
              [createIcon(d, 'capture', 15), el(d, 'span', { text: this._t('captureExercise') })]
            ),
            el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-btn',
                on: { click: () => this._fileInput.click() },
              },
              [createIcon(d, 'attach', 15), el(d, 'span', { text: this._t('attachImage') })]
            ),
          ];
          if (!hasActiveKey) {
            btns.push(
              el(
                d,
                'button',
                {
                  type: 'button',
                  className: 'shc-btn',
                  on: { click: () => this.setView('keys') },
                },
                [createIcon(d, 'key', 15), el(d, 'span', { text: this._t('openKeyManager') })]
              )
            );
          }

          const welcome = el(d, 'div', { className: 'shc-welcome' }, [
            el(d, 'div', { className: 'shc-logo', style: { width: '38px', height: '38px', borderRadius: '11px' } }, [
              createIcon(d, 'logo', 22),
            ]),
            el(d, 'h3', { text: this._t('welcomeTitle') }),
            el(d, 'p', { text: hasActiveKey ? this._t('welcomeDesc') : this._t('welcomeNoKey') }),
            el(d, 'div', { className: 'shc-welcome-actions' }, btns),
          ]);
          this._messagesEl.appendChild(welcome);
        }

        /**
         * Appends ONE message incrementally without re-rendering existing messages.
         * @param {Object} msg
         */
        appendMessage(msg) {
          if (!this._messagesEl || !msg) return;
          const existingWelcome = this._messagesEl.querySelector?.('.shc-welcome');
          if (existingWelcome) existingWelcome.remove();

          if (this._messageElements.has(msg.id)) {
            this.updateMessageElement(msg);
            return;
          }

          const refs = this._createMessageNode(msg);
          this._messageElements.set(msg.id, refs);
          this._messagesEl.appendChild(refs.rootEl);
          this._scrollToBottom();
        }

        /**
         * Incrementally updates a single existing message (for streaming or final completion).
         * @param {Object} msg
         */
        updateMessageElement(msg) {
          if (!msg || !this._messageElements.has(msg.id)) return;
          const refs = this._messageElements.get(msg.id);

          if (msg.role === 'user') {
            if (refs.textEl) refs.textEl.textContent = msg.content || '';
            return;
          }

          // Assistant message incremental update
          const { reasoning, body, isThinkingInProgress } = splitThinkContent(msg.content, msg.reasoning);

          if (refs.thinkingDetails) {
            if (reasoning) {
              refs.thinkingDetails.style.display = 'block';
              const liveThinking = msg.status === 'streaming' && (isThinkingInProgress || !body);
              refs.thinkingSummary.textContent = liveThinking
                ? `▸ ${this._t('thinkingLive')}`
                : `▸ ${this._t('thinkingLabel')}`;
              refs.thinkingBody.textContent = reasoning;
            } else {
              refs.thinkingDetails.style.display = 'none';
            }
          }

          const renderMarkdownIntoBody = () => {
            if (!refs.mdBody) return;
            const html = this._renderMarkdown(body);
            refs.mdBody.innerHTML = html;
            if (refs.mdBody.classList) {
              refs.mdBody.classList.toggle('shc-streaming-cursor', msg.status === 'streaming');
            }
          };

          if (msg.status === 'streaming') {
            if (!this._streamRenderTimer) {
              this._streamRenderTimer = setTimeout(() => {
                this._streamRenderTimer = null;
                renderMarkdownIntoBody();
                this._scrollToBottom();
              }, 55);
            }
          } else {
            if (this._streamRenderTimer) {
              clearTimeout(this._streamRenderTimer);
              this._streamRenderTimer = null;
            }
            renderMarkdownIntoBody();
          }

          if (refs.errorBox) {
            if (msg.error) {
              refs.errorBox.textContent = msg.error;
              refs.errorBox.style.display = 'block';
            } else {
              refs.errorBox.style.display = 'none';
            }
          }

          if (refs.metaModel && msg.model) {
            refs.metaModel.textContent = msg.model.split('/').pop() || msg.model;
          }
          if (refs.rootEl?.dataset) {
            refs.rootEl.dataset.status = msg.status || 'complete';
          }
        }

        removeMessageElement(msgId) {
          const refs = this._messageElements.get(msgId);
          if (refs && refs.rootEl) {
            refs.rootEl.remove();
            this._messageElements.delete(msgId);
          }
          if (this._messageElements.size === 0) {
            this._renderEmptyWelcome(this._state.connectionStatus !== 'unconfigured');
          }
        }

        /** @private */
        _createMessageNode(msg) {
          const d = this._doc;
          const lang = this._lang();

          if (msg.role === 'user') {
            const textEl = msg.content
              ? el(d, 'div', { className: 'shc-msg-text', text: msg.content })
              : null;

            let imagesWrap = null;
            if (Array.isArray(msg.images) && msg.images.length > 0) {
              const items = msg.images.map((img) => {
                if (img.dataUrl || img.previewUrl) {
                  return el(d, 'img', {
                    className: 'shc-msg-img-thumb',
                    attrs: { src: img.dataUrl || img.previewUrl, alt: img.name || 'Homework image' },
                    on: { click: () => this.openLightbox(img, -1) },
                  });
                }
                return el(d, 'span', {
                  className: 'shc-msg-img-placeholder',
                  text: img.placeholder || this._t('imagePlaceholder'),
                });
              });
              imagesWrap = el(d, 'div', { className: 'shc-msg-images' }, items);
            }

            const bubble = el(d, 'div', { className: 'shc-msg-bubble' }, [textEl, imagesWrap]);
            const retryBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('retryResponse'),
                on: { click: () => this._handlers.onRetryMessage?.(msg.id) },
              },
              [createIcon(d, 'retry', 11)]
            );
            const delBtn = el(
              d,
              'button',
              {
                type: 'button',
                className: 'shc-mini-icon-btn',
                title: this._t('deleteMessage'),
                on: { click: () => this._handlers.onDeleteMessage?.(msg.id) },
              },
              [createIcon(d, 'trash', 11)]
            );

            const meta = el(d, 'div', { className: 'shc-msg-meta' }, [
              el(d, 'span', { text: formatTimestamp(msg.timestamp, lang) }),
              el(d, 'div', { className: 'shc-msg-actions' }, [retryBtn, delBtn]),
            ]);

            const rootEl = el(d, 'div', { className: 'shc-msg is-user', dataset: { msgId: msg.id } }, [bubble, meta]);
            return { rootEl, textEl };
          }

          // Assistant message
          const { reasoning, body, isThinkingInProgress } = splitThinkContent(msg.content, msg.reasoning);
          const thinkingSummary = el(d, 'summary', {
            text:
              msg.status === 'streaming' && isThinkingInProgress
                ? `▸ ${this._t('thinkingLive')}`
                : `▸ ${this._t('thinkingLabel')}`,
          });
          const thinkingBody = el(d, 'div', { className: 'shc-thinking-body', text: reasoning });
          const thinkingDetails = el(
            d,
            'details',
            { className: 'shc-thinking', style: { display: reasoning ? 'block' : 'none' } },
            [thinkingSummary, thinkingBody]
          );

          const mdBody = el(d, 'div', {
            className: `shc-md-body ${msg.status === 'streaming' ? 'shc-streaming-cursor' : ''}`.trim(),
          });
          mdBody.innerHTML = this._renderMarkdown(body);

          const errorBox = el(d, 'div', {
            className: 'shc-msg-error-box',
            text: msg.error || '',
            style: { display: msg.error ? 'block' : 'none' },
          });

          const bubble = el(d, 'div', { className: 'shc-msg-bubble' }, [thinkingDetails, mdBody, errorBox]);

          const copyLabel = el(d, 'span', { text: this._t('copyResponse') });
          const copyBtn = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-btn-sm shc-btn-ghost',
              on: {
                click: () => {
                  const latestText = this._handlers.getMessageContent?.(msg.id) ?? body;
                  copyToClipboard(this._doc, this._win, latestText).then((ok) => {
                    if (ok) {
                      copyLabel.textContent = this._t('copied');
                      setTimeout(() => {
                        copyLabel.textContent = this._t('copyResponse');
                      }, 1400);
                    }
                  });
                },
              },
            },
            [createIcon(d, 'copy', 12), copyLabel]
          );

          const retryBtn = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-btn-sm shc-btn-ghost',
              on: { click: () => this._handlers.onRetryMessage?.(msg.id) },
            },
            [createIcon(d, 'retry', 12), el(d, 'span', { text: this._t('retryResponse') })]
          );

          const delBtn = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-btn shc-btn-sm shc-btn-ghost',
              on: { click: () => this._handlers.onDeleteMessage?.(msg.id) },
            },
            [createIcon(d, 'trash', 12), el(d, 'span', { text: this._t('deleteMessage') })]
          );

          const metaModel = el(d, 'span', {
            className: 'shc-badge',
            text: (msg.model || 'groq').split('/').pop(),
          });

          const meta = el(d, 'div', { className: 'shc-msg-meta' }, [
            metaModel,
            el(d, 'span', { text: formatTimestamp(msg.timestamp, lang) }),
            el(d, 'div', { className: 'shc-msg-actions' }, [copyBtn, retryBtn, delBtn]),
          ]);

          const rootEl = el(
            d,
            'div',
            { className: 'shc-msg is-assistant', dataset: { msgId: msg.id, status: msg.status || 'complete' } },
            [bubble, meta]
          );

          return { rootEl, thinkingDetails, thinkingSummary, thinkingBody, mdBody, errorBox, metaModel };
        }

        /** @private */
        _renderMarkdown(text) {
          const mdText = String(text || '');
          if (!mdText) return '';
          if (this._markdown && typeof this._markdown.render === 'function') {
            return this._markdown.render(mdText);
          }
          if (SHC.MarkdownRenderer && typeof SHC.MarkdownRenderer.render === 'function') {
            return SHC.MarkdownRenderer.render(mdText);
          }
          const escaped = mdText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
        }

        /** @private */
        _scrollToBottom() {
          if (!this._messagesEl) return;
          try {
            this._messagesEl.scrollTop = this._messagesEl.scrollHeight || 0;
          } catch (_) {}
        }

        // -------------------------------------------------------------------------
        // API Key Manager View
        // -------------------------------------------------------------------------

        renderKeysView(keys = []) {
          if (!this._keysViewEl) return;
          clearChildren(this._keysViewEl);
          const d = this._doc;
          const lang = this._lang();

          const header = el(d, 'div', { className: 'shc-subview-header' }, [
            el(d, 'h2', { className: 'shc-subview-title', text: this._t('keysTitle') }),
            el(d, 'button', {
              type: 'button',
              className: 'shc-btn shc-btn-sm',
              text: this._t('keysBackChat'),
              on: { click: () => this.setView('chat') },
            }),
          ]);

          const notice = el(d, 'div', { className: 'shc-banner is-warn' }, [
            createIcon(d, 'shield', 16),
            el(d, 'div', { className: 'shc-banner-body', text: this._t('keysSecurityNotice') }),
          ]);

          // Add key card
          const nameInput = el(d, 'input', {
            type: 'text',
            className: 'shc-input',
            placeholder: this._t('keyNamePlaceholder'),
          });
          const secretInput = el(d, 'input', {
            type: 'password',
            className: 'shc-input shc-mono',
            placeholder: this._t('keySecretPlaceholder'),
            attrs: { autocomplete: 'off', spellcheck: 'false' },
          });
          let secretVisible = false;
          const toggleEyeBtn = el(
            d,
            'button',
            {
              type: 'button',
              className: 'shc-icon-btn',
              on: {
                click: () => {
                  secretVisible = !secretVisible;
                  secretInput.type = secretVisible ? 'text' : 'password';
                  clearChildren(toggleEyeBtn);
                  toggleEyeBtn.appendChild(createIcon(d, secretVisible ? 'eyeOff' : 'eye', 15));
                },
              },
            },
            [createIcon(d, 'eye', 15)]
          );
          const primaryChk = el(d, 'input', { type: 'checkbox', checked: keys.length === 0 });
          const addErrEl = el(d, 'div', { style: { color: '#ef4444', fontSize: '12px', display: 'none' } });

          const addCard = el(d, 'div', { className: 'shc-card' }, [
            el(d, 'div', { className: 'shc-form-grid' }, [
              el(d, 'div', { className: 'shc-field' }, [
                el(d, 'label', { className: 'shc-label', text: this._t('keyNameLabel') }),
                nameInput,
              ]),
              el(d, 'div', { className: 'shc-field' }, [
                el(d, 'label', { className: 'shc-label', text: this._t('keySecretLabel') }),
                el(d, 'div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [
                  secretInput,
                  toggleEyeBtn,
                ]),
              ]),
            ]),
            el(d, 'div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } }, [
              el(d, 'label', { className: 'shc-check-row' }, [primaryChk, el(d, 'span', { text: this._t('setAsPrimary') })]),
              el(d, 'button', {
                type: 'button',
                className: 'shc-btn shc-btn-primary',
                text: this._t('addKeyBtn'),
                on: {
                  click: () => {
                    const rawVal = String(secretInput.value || '').trim();
                    const nameVal = String(nameInput.value || '').trim() || `Key ${keys.length + 1}`;
                    try {
                      this._handlers.onAddKey?.({ name: nameVal, key: rawVal, isPrimary: primaryChk.checked });
                      secretInput.value = '';
                      nameInput.value = '';
                      addErrEl.style.display = 'none';
                    } catch (err) {
                      addErrEl.textContent = SHC.ErrorHandler?.sanitize?.(err?.message || 'Error') || 'Error';
                      addErrEl.style.display = 'block';
                    }
                  },
                },
              }),
            ]),
            addErrEl,
          ]);

          // Keys Table Card
          const tableWrap = el(d, 'div', { className: 'shc-card' });
          if (keys.length === 0) {
            tableWrap.appendChild(el(d, 'div', { style: { color: 'var(--shc-muted)', fontSize: '12.5px' }, text: this._t('noKeysYet') }));
          } else {
            const thead = el(d, 'thead', {}, [
              el(d, 'tr', {}, [
                el(d, 'th', { text: this._t('colName') }),
                el(d, 'th', { text: this._t('colMasked') }),
                el(d, 'th', { text: this._t('colStatus') }),
                el(d, 'th', { text: this._t('colStats') }),
                el(d, 'th', { text: this._t('colLastUsed') }),
                el(d, 'th', { text: this._t('colCooldown') }),
                el(d, 'th', { text: this._t('colActions') }),
              ]),
            ]);

            const tbody = el(d, 'tbody');
            const now = Date.now();
            for (const k of keys) {
              const isEditing = this._state.editingKeyId === k.id;
              const isTesting = this._state.testingKeyId === k.id;
              const remainingSec = k.cooldownUntil && k.cooldownUntil > now ? Math.ceil((k.cooldownUntil - now) / 1000) : 0;

              const statusBadgeCls =
                k.status === 'active'
                  ? 'is-active'
                  : k.status === 'cooldown' || k.status === 'rate_limited'
                    ? 'is-warn'
                    : k.status === 'disabled'
                      ? ''
                      : 'is-danger';

              const nameCell = el(d, 'td');
              if (isEditing) {
                const editName = el(d, 'input', { type: 'text', className: 'shc-input', value: k.name });
                const editKey = el(d, 'input', {
                  type: 'password',
                  className: 'shc-input shc-mono',
                  placeholder: this._t('keyEditSecretPlaceholder'),
                  style: { marginTop: '4px' },
                });
                nameCell.appendChild(editName);
                nameCell.appendChild(editKey);
                nameCell.appendChild(
                  el(d, 'div', { style: { display: 'flex', gap: '4px', marginTop: '4px' } }, [
                    el(d, 'button', {
                      type: 'button',
                      className: 'shc-btn shc-btn-sm shc-btn-primary',
                      text: this._t('save'),
                      on: {
                        click: () => {
                          const patch = { name: editName.value };
                          if (editKey.value.trim()) patch.key = editKey.value.trim();
                          this._state.editingKeyId = null;
                          this._handlers.onUpdateKey?.(k.id, patch);
                        },
                      },
                    }),
                    el(d, 'button', {
                      type: 'button',
                      className: 'shc-btn shc-btn-sm',
                      text: this._t('cancel'),
                      on: {
                        click: () => {
                          this._state.editingKeyId = null;
                          this._handlers.onRequestKeysRefresh?.();
                        },
                      },
                    }),
                  ])
                );
              } else {
                nameCell.appendChild(el(d, 'div', { text: k.name, style: { fontWeight: '600' } }));
                if (k.isPrimary) {
                  nameCell.appendChild(el(d, 'span', { className: 'shc-badge is-primary', text: 'Primary' }));
                }
              }

              const statusCell = el(d, 'td', {}, [
                el(d, 'span', { className: `shc-badge ${statusBadgeCls}`, text: k.status }),
                k.lastError
                  ? el(d, 'div', {
                      text: k.lastError,
                      style: { fontSize: '11px', color: '#f87171', marginTop: '3px', maxWidth: '180px' },
                    })
                  : null,
              ]);

              const cooldownCell = el(d, 'td', {
                className: 'shc-mono',
                dataset: k.cooldownUntil ? { cooldownUntil: String(k.cooldownUntil) } : {},
                text: remainingSec > 0 ? `${remainingSec}s` : '—',
              });

              const actionsCell = el(d, 'td');
              const actWrap = el(d, 'div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } }, [
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm',
                  disabled: isTesting,
                  text: isTesting ? this._t('testingKeyBtn') : this._t('testKeyBtn'),
                  on: { click: () => this._handlers.onTestKey?.(k.id) },
                }),
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm',
                  text: k.enabled ? this._t('disableBtn') : this._t('enableBtn'),
                  on: { click: () => this._handlers.onToggleKeyEnabled?.(k.id, !k.enabled) },
                }),
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm',
                  text: this._t('editBtn'),
                  on: {
                    click: () => {
                      this._state.editingKeyId = k.id;
                      this._handlers.onRequestKeysRefresh?.();
                    },
                  },
                }),
                !k.isPrimary
                  ? el(d, 'button', {
                      type: 'button',
                      className: 'shc-btn shc-btn-sm',
                      text: this._t('setPrimaryBtn'),
                      on: { click: () => this._handlers.onSetPrimaryKey?.(k.id) },
                    })
                  : null,
                k.status !== 'active' && k.status !== 'disabled'
                  ? el(d, 'button', {
                      type: 'button',
                      className: 'shc-btn shc-btn-sm',
                      text: this._t('resetStatusBtn'),
                      on: { click: () => this._handlers.onResetKeyStatus?.(k.id) },
                    })
                  : null,
                el(d, 'button', {
                  type: 'button',
                  className: 'shc-btn shc-btn-sm shc-btn-danger',
                  text: this._state.confirmRemoveKeyId === k.id ? this._t('confirmRemove') : this._t('removeBtn'),
                  on: {
                    click: () => {
                      if (this._state.confirmRemoveKeyId !== k.id) {
                        this._state.confirmRemoveKeyId = k.id;
                        this._handlers.onRequestKeysRefresh?.();
                        return;
                      }
                      this._state.confirmRemoveKeyId = null;
                      this._handlers.onRemoveKey?.(k.id);
                    },
                  },
                }),
              ]);
              actionsCell.appendChild(actWrap);

              const row = el(d, 'tr', {}, [
                nameCell,
                el(d, 'td', { className: 'shc-mono', text: k.maskedKey }),
                statusCell,
                el(d, 'td', { text: `${k.successCount} / ${k.errorCount}` }),
                el(d, 'td', { text: k.lastUsedAt ? formatDateTimeShort(k.lastUsedAt, lang) : this._t('neverUsed') }),
                cooldownCell,
                actionsCell,
              ]);
              tbody.appendChild(row);
            }

            tableWrap.appendChild(el(d, 'div', { className: 'shc-key-table-wrap' }, [el(d, 'table', { className: 'shc-key-table' }, [thead, tbody])]));
          }

          const subview = el(d, 'div', { className: 'shc-subview' }, [header, notice, addCard, tableWrap]);
          this._keysViewEl.appendChild(subview);
        }

        setTestingKeyId(id) {
          this._state.testingKeyId = id || null;
          if (this._state.view === 'keys') this._handlers.onRequestKeysRefresh?.();
        }

        /** @private */
        _startCooldownTicker() {
          this._stopCooldownTicker();
          this._cooldownTimer = setInterval(() => {
            if (this._state.view !== 'keys' || !this._keysViewEl) return;
            const cells = this._keysViewEl.querySelectorAll?.('[data-cooldown-until]') || [];
            const now = Date.now();
            let anyChanged = false;
            for (const cell of cells) {
              const until = Number(cell.dataset?.cooldownUntil || 0);
              if (until > now) {
                cell.textContent = `${Math.ceil((until - now) / 1000)}s`;
              } else if (until > 0 && cell.textContent !== '—') {
                cell.textContent = '—';
                anyChanged = true;
              }
            }
            if (anyChanged) this._handlers.onRequestKeysRefresh?.();
          }, 1000);
        }

        /** @private */
        _stopCooldownTicker() {
          if (this._cooldownTimer) {
            clearInterval(this._cooldownTimer);
            this._cooldownTimer = null;
          }
        }

        // -------------------------------------------------------------------------
        // Settings View (All 6 Sections)
        // -------------------------------------------------------------------------

        renderSettingsView(settings) {
          if (!this._settingsViewEl || !settings) return;
          clearChildren(this._settingsViewEl);
          const d = this._doc;

          const header = el(d, 'div', { className: 'shc-subview-header' }, [
            el(d, 'h2', { className: 'shc-subview-title', text: this._t('settingsTitle') }),
            el(d, 'div', { style: { display: 'flex', gap: '6px' } }, [
              el(d, 'button', {
                type: 'button',
                className: 'shc-btn shc-btn-sm',
                text: this._t('settingsReset'),
                on: { click: () => this._handlers.onResetSettings?.() },
              }),
              el(d, 'button', {
                type: 'button',
                className: 'shc-btn shc-btn-sm shc-btn-primary',
                text: this._t('keysBackChat'),
                on: { click: () => this.setView('chat') },
              }),
            ]),
          ]);

          // Helper builders for controls
          const makeCheck = (labelKey, checked, onChange) => {
            const inp = el(d, 'input', {
              type: 'checkbox',
              checked: Boolean(checked),
              on: { change: () => onChange(inp.checked) },
            });
            return el(d, 'label', { className: 'shc-check-row' }, [inp, el(d, 'span', { text: this._t(labelKey) })]);
          };

          const makeSelect = (labelKey, value, options, onChange) => {
            const sel = el(d, 'select', {
              className: 'shc-select',
              on: { change: () => onChange(sel.value) },
            });
            for (const opt of options) {
              const optEl = el(d, 'option', { value: opt.value, text: opt.label });
              if (String(opt.value) === String(value)) optEl.selected = true;
              sel.appendChild(optEl);
            }
            return el(d, 'div', { className: 'shc-field' }, [
              el(d, 'label', { className: 'shc-label', text: this._t(labelKey) }),
              sel,
            ]);
          };

          const makeInput = (labelKey, type, value, extraAttrs, onChange) => {
            const inp = el(d, 'input', {
              type,
              className: 'shc-input',
              value: value !== undefined && value !== null ? String(value) : '',
              attrs: extraAttrs || {},
              on: { change: () => onChange(inp.value) },
            });
            return el(d, 'div', { className: 'shc-field' }, [
              el(d, 'label', { className: 'shc-label', text: this._t(labelKey) }),
              inp,
            ]);
          };

          // Section 1: General
          const hotkeyLabel = formatHotkeyLabel(settings.general.hotkey);
          const recordBtn = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm',
            text: this._state.recordingHotkey ? this._t('pressAnyKey') : `${this._t('recordHotkey')} (${hotkeyLabel})`,
            on: {
              click: () => {
                if (this._state.recordingHotkey) return;
                this._state.recordingHotkey = true;
                this._handlers.onHotkeyRecording?.(true);
                recordBtn.textContent = this._t('pressAnyKey');
                const captureKey = (ev) => {
                  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(ev.key)) return;
                  ev.preventDefault();
                  ev.stopPropagation();
                  this._doc.removeEventListener('keydown', captureKey, true);
                  this._state.recordingHotkey = false;
                  this._handlers.onHotkeyRecording?.(false);
                  this._handlers.onUpdateSetting?.('general.hotkey', {
                    key: ev.key,
                    code: ev.code || ev.key,
                    ctrl: Boolean(ev.ctrlKey),
                    alt: Boolean(ev.altKey),
                    shift: Boolean(ev.shiftKey),
                    meta: Boolean(ev.metaKey),
                  });
                };
                this._doc.addEventListener('keydown', captureKey, true);
              },
            },
          });
          const resetHotkeyBtn = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm',
            text: this._t('resetHotkey'),
            on: {
              click: () =>
                this._handlers.onUpdateSetting?.('general.hotkey', {
                  key: 'Insert',
                  code: 'Insert',
                  ctrl: false,
                  alt: false,
                  shift: false,
                  meta: false,
                }),
            },
          });

          const sec1 = el(d, 'div', { className: 'shc-card' }, [
            el(d, 'h3', { className: 'shc-card-title', text: this._t('secGeneral') }),
            makeCheck('lblEnabled', settings.general.enabled, (v) => this._handlers.onUpdateSetting?.('general.enabled', v)),
            makeCheck('lblFloatingLauncher', settings.general.showFloatingButton !== false, (v) =>
              this._handlers.onUpdateSetting?.('general.showFloatingButton', v)
            ),
            el(d, 'div', { className: 'shc-field' }, [
              el(d, 'label', { className: 'shc-label', text: this._t('lblHotkey') }),
              el(d, 'div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [recordBtn, resetHotkeyBtn]),
            ]),
            el(d, 'div', { className: 'shc-form-grid' }, [
              makeSelect(
                'lblTheme',
                settings.general.theme,
                [
                  { value: 'dark', label: this._t('themeDark') },
                  { value: 'light', label: this._t('themeLight') },
                ],
                (v) => this._handlers.onUpdateSetting?.('general.theme', v)
              ),
              makeSelect(
                'lblLanguage',
                settings.general.language,
                [
                  { value: 'vi', label: 'Tiếng Việt' },
                  { value: 'en', label: 'English' },
                ],
                (v) => this._handlers.onUpdateSetting?.('general.language', v)
              ),
              makeSelect(
                'lblPromptMode',
                settings.general.systemPromptMode,
                [
                  { value: 'tutor', label: this._t('modeTutor') },
                  { value: 'concise', label: this._t('modeConcise') },
                  { value: 'detailed', label: this._t('modeDetailed') },
                  { value: 'custom', label: this._t('modeCustom') },
                ],
                (v) => this._handlers.onUpdateSetting?.('general.systemPromptMode', v)
              ),
            ]),
            settings.general.systemPromptMode === 'custom'
              ? el(d, 'div', { className: 'shc-field' }, [
                  el(d, 'label', { className: 'shc-label', text: this._t('lblCustomPrompt') }),
                  el(d, 'textarea', {
                    className: 'shc-textarea',
                    value: settings.general.customSystemPrompt || '',
                    on: { change: (e) => this._handlers.onUpdateSetting?.('general.customSystemPrompt', e.target.value) },
                  }),
                ])
              : null,
          ]);

          // Section 2: AI Model
          const builtInModels = SHC.GroqAPIClient?.getSupportedModels?.() || [];
          const modelOptionsMap = new Map();
          for (const m of builtInModels) {
            modelOptionsMap.set(m.id, { value: m.id, label: m.displayName || m.id });
          }
          for (const dm of this._state.discoveredModels) {
            const id = dm.id || dm;
            if (id && !modelOptionsMap.has(id)) {
              modelOptionsMap.set(id, { value: id, label: `${id} (Groq API)` });
            }
          }
          const activeModelId = settings.model.activeModel || settings.model.visionModel;
          if (activeModelId && !modelOptionsMap.has(activeModelId)) {
            modelOptionsMap.set(activeModelId, { value: activeModelId, label: `${activeModelId} (Custom)` });
          }
          const modelOptions = Array.from(modelOptionsMap.values());
          const activeConstraints = SHC.GroqAPIClient?.getModelConstraints?.(activeModelId) || {
            vision: true,
            maxImagesPerRequest: 3,
          };

          const fetchModelsBtn = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-sm',
            disabled: this._state.fetchingModels,
            text: this._state.fetchingModels ? this._t('fetchingModels') : this._t('fetchModelsBtn'),
            on: { click: () => this._handlers.onFetchModels?.() },
          });

          const visionBanner = el(d, 'div', {
            className: `shc-banner ${activeConstraints.vision ? 'is-info' : 'is-warn'}`,
            text: activeConstraints.vision
              ? `${this._t('modelVisionOk')} (Max ${activeConstraints.maxImagesPerRequest || 3} imgs/req, ${activeConstraints.maxImageSizeMB || 20}MB, ${activeConstraints.tokensPerImage || 2048} tok/img)`
              : this._t('modelVisionWarn'),
          });

          const sec2 = el(d, 'div', { className: 'shc-card' }, [
            el(d, 'div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
              el(d, 'h3', { className: 'shc-card-title', text: this._t('secModel') }),
              fetchModelsBtn,
            ]),
            visionBanner,
            el(d, 'div', { className: 'shc-form-grid' }, [
              makeSelect('lblActiveModel', activeModelId, modelOptions, (v) =>
                this._handlers.onUpdateSetting?.('model.activeModel', v)
              ),
              makeInput('lblCustomModelId', 'text', activeModelId, {}, (v) => {
                if (v.trim()) this._handlers.onUpdateSetting?.('model.activeModel', v.trim());
              }),
              makeInput('lblVisionModel', 'text', settings.model.visionModel, {}, (v) =>
                this._handlers.onUpdateSetting?.('model.visionModel', v.trim())
              ),
              makeInput('lblTextModel', 'text', settings.model.textModel, {}, (v) =>
                this._handlers.onUpdateSetting?.('model.textModel', v.trim())
              ),
              makeInput('lblTemperature', 'number', settings.model.temperature, { min: '0', max: '2', step: '0.1' }, (v) =>
                this._handlers.onUpdateSetting?.('model.temperature', Number(v))
              ),
              makeInput('lblMaxTokens', 'number', settings.model.maxCompletionTokens, { min: '64', max: '131072', step: '256' }, (v) =>
                this._handlers.onUpdateSetting?.('model.maxCompletionTokens', Number(v))
              ),
              makeInput('lblTopP', 'number', settings.model.topP, { min: '0', max: '1', step: '0.05' }, (v) =>
                this._handlers.onUpdateSetting?.('model.topP', Number(v))
              ),
              makeSelect(
                'lblReasoningEffort',
                settings.model.reasoningEffort,
                ['none', 'default', 'low', 'medium', 'high', 'xhigh'].map((x) => ({ value: x, label: x })),
                (v) => this._handlers.onUpdateSetting?.('model.reasoningEffort', v)
              ),
              makeSelect(
                'lblReasoningFormat',
                settings.model.reasoningFormat,
                ['parsed', 'raw', 'hidden'].map((x) => ({ value: x, label: x })),
                (v) => this._handlers.onUpdateSetting?.('model.reasoningFormat', v)
              ),
            ]),
            makeCheck('lblStream', settings.model.stream, (v) => this._handlers.onUpdateSetting?.('model.stream', v)),
          ]);

          // Section 3: API Management
          const sec3 = el(d, 'div', { className: 'shc-card' }, [
            el(d, 'h3', { className: 'shc-card-title', text: this._t('secApi') }),
            el(d, 'div', { className: 'shc-form-grid' }, [
              makeInput('lblChatEndpoint', 'text', settings.model.endpoint, {}, (v) =>
                this._handlers.onUpdateSetting?.('model.endpoint', v.trim())
              ),
              makeInput('lblModelsEndpoint', 'text', settings.model.modelsEndpoint, {}, (v) =>
                this._handlers.onUpdateSetting?.('model.modelsEndpoint', v.trim())
              ),
              makeInput('lblRetryLimit', 'number', settings.api.retryLimit, { min: '0', max: '5', step: '1' }, (v) =>
                this._handlers.onUpdateSetting?.('api.retryLimit', Number(v))
              ),
              makeInput('lblCooldownSec', 'number', settings.api.defaultCooldownSec, { min: '1', max: '3600', step: '5' }, (v) =>
                this._handlers.onUpdateSetting?.('api.defaultCooldownSec', Number(v))
              ),
              makeInput('lblTimeoutMs', 'number', settings.api.requestTimeoutMs, { min: '1000', max: '300000', step: '1000' }, (v) =>
                this._handlers.onUpdateSetting?.('api.requestTimeoutMs', Number(v))
              ),
            ]),
            makeCheck('lblAutoFailover', settings.api.autoFailover, (v) =>
              this._handlers.onUpdateSetting?.('api.autoFailover', v)
            ),
          ]);

          // Section 4: Capture
          const sec4 = el(d, 'div', { className: 'shc-card' }, [
            el(d, 'h3', { className: 'shc-card-title', text: this._t('secCapture') }),
            el(d, 'div', { className: 'shc-form-grid' }, [
              makeSelect(
                'lblCaptureMethod',
                settings.capture.method,
                [
                  { value: 'dom', label: this._t('captureDomOption') },
                  { value: 'screen', label: this._t('captureScreenOption') },
                ],
                (v) => this._handlers.onUpdateSetting?.('capture.method', v)
              ),
              makeInput('lblImageQuality', 'number', settings.capture.imageQuality, { min: '0.1', max: '1', step: '0.02' }, (v) =>
                this._handlers.onUpdateSetting?.('capture.imageQuality', Number(v))
              ),
              makeInput('lblMaxImageSizeMB', 'number', settings.capture.maxImageSizeMB, { min: '0.5', max: '20', step: '0.5' }, (v) =>
                this._handlers.onUpdateSetting?.('capture.maxImageSizeMB', Number(v))
              ),
              makeInput('lblMaxImagesPerMsg', 'number', settings.capture.maxImagesPerMessage, { min: '1', max: '5', step: '1' }, (v) =>
                this._handlers.onUpdateSetting?.('capture.maxImagesPerMessage', Number(v))
              ),
            ]),
            makeCheck('lblPreviewBeforeSend', settings.capture.previewBeforeSend, (v) =>
              this._handlers.onUpdateSetting?.('capture.previewBeforeSend', v)
            ),
            el(d, 'div', { className: 'shc-banner is-info', text: this._t('captureArchNote') }),
          ]);

          // Section 5: Conversation
          const sec5 = el(d, 'div', { className: 'shc-card' }, [
            el(d, 'h3', { className: 'shc-card-title', text: this._t('secConversation') }),
            makeCheck('lblSaveHistory', settings.conversation.saveHistory, (v) =>
              this._handlers.onUpdateSetting?.('conversation.saveHistory', v)
            ),
            makeCheck('lblSaveImagesHistory', settings.conversation.saveImagesInHistory, (v) =>
              this._handlers.onUpdateSetting?.('conversation.saveImagesInHistory', v)
            ),
            makeCheck('lblAutoSummarize', settings.conversation.autoSummarize, (v) =>
              this._handlers.onUpdateSetting?.('conversation.autoSummarize', v)
            ),
            makeInput('lblMaxMessages', 'number', settings.conversation.maxMessages, { min: '2', max: '200', step: '2' }, (v) =>
              this._handlers.onUpdateSetting?.('conversation.maxMessages', Number(v))
            ),
          ]);

          // Section 6: Privacy
          const wipeBtn = el(d, 'button', {
            type: 'button',
            className: 'shc-btn shc-btn-danger',
            text: this._state.confirmWipeAll ? this._t('confirmWipeAll') : this._t('wipeAllBtn'),
            on: {
              click: () => {
                if (!this._state.confirmWipeAll) {
                  this._state.confirmWipeAll = true;
                  wipeBtn.textContent = this._t('confirmWipeAll');
                  return;
                }
                this._state.confirmWipeAll = false;
                this._handlers.onWipeAllData?.();
              },
            },
          });

          const sec6 = el(d, 'div', { className: 'shc-card' }, [
            el(d, 'h3', { className: 'shc-card-title', text: this._t('secPrivacy') }),
            makeCheck('lblNeverAutoSend', settings.privacy.neverAutoSend, (v) =>
              this._handlers.onUpdateSetting?.('privacy.neverAutoSend', v)
            ),
            makeCheck('lblMaskKeysLogs', settings.privacy.maskKeysInLogs, (v) =>
              this._handlers.onUpdateSetting?.('privacy.maskKeysInLogs', v)
            ),
            el(d, 'div', { className: 'shc-banner is-info', text: this._t('privacyPolicyNotice') }),
            el(d, 'div', {}, [wipeBtn]),
          ]);

          const subview = el(d, 'div', { className: 'shc-subview' }, [header, sec1, sec2, sec3, sec4, sec5, sec6]);
          this._settingsViewEl.appendChild(subview);
        }

        setFetchingModels(flag, discoveredModels = null) {
          this._state.fetchingModels = Boolean(flag);
          if (Array.isArray(discoveredModels)) {
            this._state.discoveredModels = discoveredModels;
          }
          if (this._state.view === 'settings') {
            this._handlers.onRequestSettingsRefresh?.();
          }
        }

        /**
         * Unmounts Shadow DOM and tears down listeners/timers cleanly.
         */
        destroy() {
          this._stopCooldownTicker();
          if (this._streamRenderTimer) {
            clearTimeout(this._streamRenderTimer);
            this._streamRenderTimer = null;
          }
          for (const off of this._cleanupListeners) {
            try {
              off();
            } catch (_) {}
          }
          this._cleanupListeners = [];
          this._messageElements.clear();
          if (this._host) {
            this._host.remove();
            this._host = null;
          }
          this._shadow = null;
          this._root = null;
        }
      }

      // ---------------------------------------------------------------------------
      // AppCore (Application Orchestrator)
      // ---------------------------------------------------------------------------

      class AppCore {
        /**
         * @param {Object} [options] Optional dependency overrides for tests.
         */
        constructor(options = {}) {
          this._doc = options.document || (typeof document !== 'undefined' ? document : null);
          this._win = options.window || (typeof window !== 'undefined' ? window : root);

          this.storage = options.storage || new SHC.StorageManager();
          this.settings = options.settingsManager || new SHC.SettingsManager(this.storage);
          this.errorHandler =
            options.errorHandler || new SHC.ErrorHandler({ language: () => this.settings.get('general.language', 'vi') });
          this.keyManager = options.keyManager || new SHC.APIKeyManager(this.storage, this.errorHandler);
          this.apiClient =
            options.apiClient ||
            new SHC.GroqAPIClient({
              endpoint: this.settings.get('model.endpoint'),
              modelsEndpoint: this.settings.get('model.modelsEndpoint'),
              timeoutMs: this.settings.get('api.requestTimeoutMs', 60000),
              errorHandler: this.errorHandler,
            });
          this.failoverEngine =
            options.failoverEngine ||
            new SHC.FailoverEngine({
              apiClient: this.apiClient,
              keyManager: this.keyManager,
              settingsManager: this.settings,
              errorHandler: this.errorHandler,
              storageManager: this.storage,
            });
          this.contextManager = options.contextManager || new SHC.ContextManager(this.settings);
          this.conversationManager = options.conversationManager || new SHC.ConversationManager(this.storage, this.settings);

          this.imageProcessor =
            options.imageProcessor ||
            (SHC.ImageProcessor ? new SHC.ImageProcessor({ settingsManager: this.settings }) : null);
          this.captureManager =
            options.captureManager ||
            (SHC.CaptureManager
              ? new SHC.CaptureManager({
                  document: this._doc,
                  window: this._win,
                  imageProcessor: this.imageProcessor,
                  settingsManager: this.settings,
                })
              : null);
          this.markdownRenderer =
            options.markdownRenderer ||
            (SHC.MarkdownRenderer ? new SHC.MarkdownRenderer() : null);
          this.hotkeyManager = options.hotkeyManager || null;

          this.ui =
            options.ui ||
            new UIManager({
              document: this._doc,
              window: this._win,
              settingsManager: this.settings,
              markdownRenderer: this.markdownRenderer,
            });

          this._abortController = null;
          this._isSending = false;
          this._initialized = false;
          this._unsubscribers = [];
          this._lastConnectionState = this._deriveInitialConnectionStatus();
        }

        /** @private */
        _deriveInitialConnectionStatus() {
          const keys = this.keyManager.getKeys();
          const enabledActive = keys.filter((k) => k.enabled && k.status === 'active');
          if (enabledActive.length === 0) {
            return keys.some((k) => k.enabled && (k.status === 'rate_limited' || k.status === 'cooldown'))
              ? { status: 'rate_limited', detail: '' }
              : { status: 'unconfigured', detail: '' };
          }
          const testedOrUsed = enabledActive.some((k) => k.successCount > 0 || k.lastUsedAt);
          return { status: testedOrUsed ? 'connected' : 'untested', detail: '' };
        }

        /**
         * Initializes UI mount, hotkey listener, and module subscriptions (idempotent).
         */
        init() {
          if (this._initialized) return this;
          if (this._win && this._win.top && this._win.self && this._win.top !== this._win.self) {
            return this;
          }

          this._initialized = true;
          this.ui.setHandlers(this._buildUIHandlers());
          this.ui.mount();
          this._setupHotkey();

          this._unsubscribers.push(
            this.settings.onChange((next) => {
              this.apiClient._endpoint = next.model.endpoint;
              this.apiClient._modelsEndpoint = next.model.modelsEndpoint;
              this.apiClient._timeoutMs = next.api.requestTimeoutMs;
              this.hotkeyManager?.updateHotkey?.(next.general.hotkey);
              this.hotkeyManager?.setEnabled?.(next.general.enabled);
              this.ui.refreshLocale();
              this._syncHeaderAndStatus();
              this._refreshModelCompatibilityBanner();
            })
          );

          this._unsubscribers.push(
            this.keyManager.onChange(() => {
              this._lastConnectionState = this._deriveInitialConnectionStatus();
              this._syncHeaderAndStatus();
              if (this.ui._state.view === 'keys') {
                this.ui.renderKeysView(this.keyManager.getKeys());
              }
            })
          );

          this._unsubscribers.push(
            this.conversationManager.onChange((summaryList) => {
              this.ui.renderSidebar(summaryList);
            })
          );

          this._syncHeaderAndStatus();
          this.ui.renderSidebar(this.conversationManager.getSummaryList());
          this.ui.renderConversation(this.conversationManager.getActive(), {
            hasActiveKey: this.keyManager.getCandidateOrder().length > 0,
          });
          this._refreshModelCompatibilityBanner();
          return this;
        }

        /** @private */
        _setupHotkey() {
          if (!this.hotkeyManager && SHC.HotkeyManager && this._doc) {
            this.hotkeyManager = new SHC.HotkeyManager({
              document: this._doc,
              window: this._win,
              hotkey: this.settings.get('general.hotkey'),
              enabled: this.settings.get('general.enabled', true),
              onTrigger: () => {
                if (this.settings.get('general.enabled', true)) {
                  this.ui.toggle();
                }
              },
            });
          } else if (this.hotkeyManager) {
            this.hotkeyManager.updateHotkey?.(this.settings.get('general.hotkey'));
            this.hotkeyManager.setEnabled?.(this.settings.get('general.enabled', true));
          }
        }

        /** @private */
        _syncHeaderAndStatus(requestStatusOverride) {
          const activeModel = this.settings.getActiveModel();
          const primary = this.keyManager.getPrimaryKey();
          const candidate = this.keyManager.getCandidateOrder()[0] || primary;

          this.ui.setStatus({
            requestStatus: requestStatusOverride,
            connectionStatus: this._lastConnectionState.status,
            connectionDetail: this._lastConnectionState.detail,
            activeModel,
            primaryMaskedKey: candidate ? candidate.maskedKey : '',
          });
        }

        /** @private */
        _refreshModelCompatibilityBanner() {
          const conv = this.conversationManager.getActive();
          const model = this.settings.getActiveModel();
          const compat = this.contextManager.checkModelCompatibility(conv, model);

          if (!compat.compatible && compat.warnings.length > 0) {
            const visionModel = this.settings.get('model.visionModel', 'qwen/qwen3.8-27b');
            this.ui.addBanner({
              id: 'vision-mismatch',
              level: 'warn',
              message: compat.warnings[0].message,
              actions: [
                {
                  label: this.ui._t('switchToVision'),
                  onClick: () => {
                    this.settings.setActiveModel(visionModel);
                    this.ui.dismissBanner('vision-mismatch');
                  },
                },
              ],
            });
          } else {
            this.ui.dismissBanner('vision-mismatch');
          }
        }

        /** @private */
        _buildUIHandlers() {
          return {
            onSendMessage: ({ text, images }) => this.sendMessage({ text, images }),
            onCancelGeneration: () => this.cancelGeneration(),
            onCapture: (method) => this.captureExercise(method),
            onFilesSelected: (files, opts) => this.handleFilesSelected(files, opts),
            onCropStagedImage: (idx) => this.cropStagedImage(idx),
            onDisposeImage: (img) => img?.objectUrl && this.imageProcessor?.revokeObjectUrl?.(img.objectUrl),
            onPendingImagesChanged: () => this._refreshModelCompatibilityBanner(),
            onHotkeyRecording: (active) =>
              this.hotkeyManager?.setEnabled?.(!active && this.settings.get('general.enabled', true)),
            onNewConversation: () => {
              const conv = this.conversationManager.create();
              this.ui.renderConversation(conv, { hasActiveKey: this.keyManager.getCandidateOrder().length > 0 });
              this.ui.setView('chat');
              this._refreshModelCompatibilityBanner();
            },
            onSwitchConversation: (id) => {
              const conv = this.conversationManager.switch(id);
              this.ui.renderConversation(conv, { hasActiveKey: this.keyManager.getCandidateOrder().length > 0 });
              this.ui.setView('chat');
              this._refreshModelCompatibilityBanner();
            },
            onRenameConversation: (id, title) => {
              this.conversationManager.rename(id, title);
            },
            onDeleteConversation: (id) => {
              this.conversationManager.delete(id);
              this.ui.renderConversation(this.conversationManager.getActive(), {
                hasActiveKey: this.keyManager.getCandidateOrder().length > 0,
              });
              this._refreshModelCompatibilityBanner();
            },
            onClearAllHistory: () => {
              const fresh = this.conversationManager.clearAll();
              this.ui.renderConversation(fresh, { hasActiveKey: this.keyManager.getCandidateOrder().length > 0 });
              this._refreshModelCompatibilityBanner();
            },
            onExportConversation: (format) => this.exportActiveConversation(format),
            onRetryMessage: (msgId) => this.retryFromMessage(msgId),
            onDeleteMessage: (msgId) => {
              if (this.conversationManager.deleteMessage(msgId)) {
                this.ui.removeMessageElement(msgId);
                this._refreshModelCompatibilityBanner();
              }
            },
            getMessageContent: (msgId) => {
              const conv = this.conversationManager.getActive();
              const m = conv.messages.find((x) => x.id === msgId);
              return m ? splitThinkContent(m.content, m.reasoning).body : '';
            },
            onRequestKeysRefresh: () => this.ui.renderKeysView(this.keyManager.getKeys()),
            onAddKey: (data) => this.keyManager.addKey(data),
            onUpdateKey: (id, patch) => this.keyManager.updateKey(id, patch),
            onRemoveKey: (id) => this.keyManager.removeKey(id),
            onToggleKeyEnabled: (id, enabled) => this.keyManager.setEnabled(id, enabled),
            onSetPrimaryKey: (id) => this.keyManager.setPrimary(id),
            onResetKeyStatus: (id) => this.keyManager.resetStatus(id),
            onTestKey: (id) => this.testKey(id),
            onRequestSettingsRefresh: () => this.ui.renderSettingsView(this.settings.getAll()),
            onUpdateSetting: (path, val) => {
              this.settings.set(path, val);
            },
            onResetSettings: () => {
              this.settings.reset();
              if (this.ui._state.view === 'settings') {
                this.ui.renderSettingsView(this.settings.getAll());
              }
            },
            onFetchModels: () => this.fetchModelsFromGroq(),
            onWipeAllData: () => this.wipeAllData(),
          };
        }

        /**
         * Stages selected/dropped/pasted image files after validating & processing them.
         * NEVER auto-uploads before user clicks Send.
         */
        async handleFilesSelected(files, { replaceIndex = -1, source = 'upload' } = {}) {
          if (!files || files.length === 0) return;
          const processed = [];
          const errors = [];

          for (const file of files) {
            try {
              const img = await this._processInputImage(file, { source });
              if (img) processed.push(img);
            } catch (err) {
              const classified = this.errorHandler.classify(err);
              errors.push(classified.userMessage);
            }
          }

          if (errors.length > 0) {
            this.ui.addBanner({
              id: 'image-error',
              level: 'error',
              message: errors.join(' '),
            });
          } else {
            this.ui.dismissBanner('image-error');
          }

          if (processed.length > 0) {
            if (replaceIndex >= 0) {
              const list = this.ui.getPendingImages();
              if (list[replaceIndex]?.objectUrl) {
                this.imageProcessor?.revokeObjectUrl?.(list[replaceIndex].objectUrl);
              }
              list[replaceIndex] = processed[0];
              this.ui.setPendingImages(list);
            } else {
              this.ui.addPendingImages(processed);
            }
            this.ui.setView('chat');
          }
        }

        /** @private */
        async _processInputImage(fileOrDataUrl, opts = {}) {
          if (this.imageProcessor && typeof this.imageProcessor.processImage === 'function') {
            return this.imageProcessor.processImage(fileOrDataUrl, opts);
          }
          if (this.imageProcessor && typeof this.imageProcessor.processFile === 'function') {
            return this.imageProcessor.processFile(fileOrDataUrl, opts);
          }
          // Safe fallback if ImageProcessor not present in minimal unit tests
          if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.startsWith('data:image/')) {
            return {
              name: 'image.png',
              mimeType: 'image/png',
              width: 0,
              height: 0,
              sizeBytes: fileOrDataUrl.length,
              dataUrl: fileOrDataUrl,
            };
          }
          throw this.errorHandler.toError({ code: 'IMAGE_ERROR', message: 'ImageProcessor unavailable.' });
        }

        /**
         * Executes DOM Capture or Screen Capture and places result in Pending Image Staging Tray.
         * @param {'dom'|'screen'} [method]
         */
        async captureExercise(method) {
          const chosen = method || this.settings.get('capture.method', 'dom');
          if (!this.captureManager) {
            this.ui.addBanner({
              id: 'capture-warn',
              level: 'error',
              message: this.errorHandler.classify({ code: 'CAPTURE_ERROR' }).userMessage,
            });
            return null;
          }

          const wasOpen = this.ui.isOpen();
          if (wasOpen) {
            this.ui.setTemporaryHidden(true);
          }
          try {
            let result = null;
            if (chosen === 'screen') {
              if (wasOpen) await new Promise((r) => setTimeout(r, 40));
              result = await this.captureManager.captureScreen();
            } else {
              result = await this.captureManager.captureDOM();
            }

            if (!result || result.cancelled) return null;

            if (Array.isArray(result.warnings) && result.warnings.length > 0) {
              this.ui.addBanner({
                id: 'capture-warn',
                level: 'warn',
                message: result.warnings.join(' '),
                actions: chosen === 'dom'
                  ? [
                      {
                        label: this.ui._t('tryScreenCapture'),
                        onClick: () => {
                          this.ui.dismissBanner('capture-warn');
                          this.captureExercise('screen');
                        },
                      },
                    ]
                  : [],
              });
            } else {
              this.ui.dismissBanner('capture-warn');
            }

            const imgObj = result.image || result;
            if (imgObj && imgObj.dataUrl) {
              if (Array.isArray(result.warnings) && result.warnings.length > 0) {
                imgObj.warnings = [...result.warnings];
              }
              this.ui.addPendingImages([imgObj]);
              if (!wasOpen) this.ui.open();
              this.ui.setView('chat');
            }
            return result;
          } catch (err) {
            const classified = this.errorHandler.classify({
              code: err?.code || 'CAPTURE_ERROR',
              message: err?.message || 'Capture failed',
            });
            if (!classified.isAbort) {
              this.ui.addBanner({
                id: 'capture-warn',
                level: 'error',
                message: classified.userMessage,
              });
            }
            return null;
          } finally {
            if (wasOpen) {
              this.ui.setTemporaryHidden(false);
            }
          }
        }

        /**
         * Re-crops an image currently in the staging tray.
         * @param {number} index
         */
        async cropStagedImage(index) {
          const list = this.ui.getPendingImages();
          const target = list[index];
          if (!target || !this.captureManager || typeof this.captureManager.cropImage !== 'function') return;
          try {
            const cropped = await this.captureManager.cropImage(target);
            if (cropped && !cropped.cancelled) {
              list[index] = cropped.image || cropped;
              this.ui.setPendingImages(list);
            }
          } catch (err) {
            const classified = this.errorHandler.classify({ code: 'CAPTURE_ERROR', message: err?.message });
            this.ui.addBanner({ id: 'capture-warn', level: 'error', message: classified.userMessage });
          }
        }

        /**
         * Sends a new user prompt + pending images through ContextManager & FailoverEngine.
         * Preserves composer text & pending images if the request fails before completing!
         */
        async sendMessage({ text = '', images = [] } = {}) {
          if (this._isSending || this.failoverEngine.isBusy()) {
            return null;
          }
          const cleanText = String(text || '');
          const stagedImages = Array.isArray(images) ? images : [];
          if (!cleanText.trim() && stagedImages.length === 0) return null;

          const model = this.settings.getActiveModel();
          const conv = this.conversationManager.getActive();
          const draftSnapshot = { text: cleanText, images: [...stagedImages] };

          // Pre-check vision support & limits without mutating history or clearing composer
          const previewConv = {
            ...conv,
            messages: [...conv.messages, { role: 'user', content: cleanText, images: stagedImages }],
          };
          const builtCheck = this.contextManager.buildMessages(previewConv, { model });
          if (builtCheck.containsUnsupportedImages) {
            const errObj = this.errorHandler.classify({ code: 'NON_VISION_MODEL' }, { model });
            this.ui.addBanner({ id: 'send-error', level: 'error', message: errObj.userMessage });
            return null;
          }

          const caps = SHC.GroqAPIClient.getModelConstraints(model);
          if (stagedImages.length > 0 && caps.vision && caps.maxImagesPerRequest && stagedImages.length > caps.maxImagesPerRequest) {
            const errObj = this.errorHandler.classify(
              {
                code: 'IMAGE_LIMIT_EXCEEDED',
                message: `Model "${model}" allows at most ${caps.maxImagesPerRequest} image(s) per request.`,
              },
              { model }
            );
            this.ui.addBanner({ id: 'send-error', level: 'error', message: errObj.userMessage });
            return null;
          }

          this.ui.dismissBanner('send-error');

          const userMsg = this.conversationManager.addMessage({
            role: 'user',
            content: cleanText,
            images: stagedImages,
            model,
          });
          this.ui.appendMessage(userMsg);

          // Clear composer provisionally (restored automatically on failure)
          this.ui.setDraftText('');
          this.ui.setPendingImages([]);

          const assistantMsg = this.conversationManager.addMessage({
            role: 'assistant',
            content: '',
            reasoning: null,
            model,
            status: 'streaming',
          });
          this.ui.appendMessage(assistantMsg);

          try {
            const result = await this._executeAssistantTurn(assistantMsg.id, model);
            return result;
          } catch (err) {
            // Restore draft text & images on failed request if user has not typed a new draft
            if (!this.ui.getDraftText().trim() && this.ui.getPendingImages().length === 0) {
              this.ui.setDraftText(draftSnapshot.text);
              this.ui.setPendingImages(draftSnapshot.images);
            }
            // Remove empty failed placeholder & unsent user message ONLY if zero content was streamed
            const activeConv = this.conversationManager.getActive();
            const latestAsst = activeConv.messages.find((m) => m.id === assistantMsg.id);
            if (latestAsst && !latestAsst.content && !latestAsst.reasoning) {
              this.conversationManager.deleteMessage(assistantMsg.id);
              this.ui.removeMessageElement(assistantMsg.id);
              this.conversationManager.deleteMessage(userMsg.id);
              this.ui.removeMessageElement(userMsg.id);
            }
            return null;
          }
        }

        /**
         * Retries generation from a user or assistant message without duplicating turns.
         * @param {string} msgId
         */
        async retryFromMessage(msgId) {
          if (this._isSending || this.failoverEngine.isBusy()) return null;
          const { userMessage } = this.conversationManager.retryFromMessage(msgId);
          if (!userMessage) return null;

          const model = this.settings.getActiveModel();
          this.ui.renderConversation(this.conversationManager.getActive(), {
            hasActiveKey: this.keyManager.getCandidateOrder().length > 0,
          });

          const assistantMsg = this.conversationManager.addMessage({
            role: 'assistant',
            content: '',
            reasoning: null,
            model,
            status: 'streaming',
          });
          this.ui.appendMessage(assistantMsg);

          try {
            return await this._executeAssistantTurn(assistantMsg.id, model);
          } catch (_) {
            return null;
          }
        }

        /** @private */
        async _executeAssistantTurn(assistantMsgId, model) {
          this._isSending = true;
          this._abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
          this._syncHeaderAndStatus('sending');

          const conv = this.conversationManager.getActive();
          const contextBuilt = this.contextManager.buildMessages(conv, { model });

          let accContent = '';
          let accReasoning = '';

          try {
            const result = await this.failoverEngine.sendChatCompletion({
              messages: contextBuilt.messages,
              model,
              signal: this._abortController ? this._abortController.signal : undefined,
              onStatusChange: (status, info) => {
                if (status === 'cooldown') {
                  this._lastConnectionState = { status: 'rate_limited', detail: info?.error?.userMessage || '' };
                } else if (status === 'error') {
                  this._lastConnectionState = { status: 'error', detail: info?.error?.userMessage || '' };
                }
                this._syncHeaderAndStatus(status);
              },
              onChunk: (chunk) => {
                if (chunk.content !== undefined) accContent = chunk.content;
                if (chunk.reasoning !== undefined) accReasoning = chunk.reasoning;
                const updated = this.conversationManager.updateMessage(assistantMsgId, {
                  content: accContent,
                  reasoning: accReasoning || null,
                  status: 'streaming',
                  persist: false,
                });
                if (updated) this.ui.updateMessageElement(updated);
              },
            });

            this._lastConnectionState = { status: 'connected', detail: `OK (${result.maskedKey || ''})` };
            const finalMsg = this.conversationManager.updateMessage(assistantMsgId, {
              content: result.content || accContent,
              reasoning: result.reasoning || accReasoning || null,
              model: result.model || model,
              usage: result.usage || null,
              status: 'complete',
              error: null,
              persist: true,
            });
            if (finalMsg) this.ui.updateMessageElement(finalMsg);
            this._syncHeaderAndStatus('idle');
            return result;
          } catch (err) {
            const classified = this.errorHandler.classify(err, { model });
            if (classified.isAbort) {
              this._lastConnectionState = this._deriveInitialConnectionStatus();
              const finalMsg = this.conversationManager.updateMessage(assistantMsgId, {
                content: accContent,
                reasoning: accReasoning || null,
                status: accContent ? 'complete' : 'error',
                error: accContent ? null : classified.userMessage,
                persist: true,
              });
              if (finalMsg) this.ui.updateMessageElement(finalMsg);
              this._syncHeaderAndStatus('idle');
            } else {
              this._lastConnectionState = {
                status: classified.isRateLimit ? 'rate_limited' : 'error',
                detail: classified.userMessage,
              };
              const updated = this.conversationManager.updateMessage(assistantMsgId, {
                content: accContent,
                reasoning: accReasoning || null,
                status: 'error',
                error: classified.userMessage,
                persist: true,
              });
              if (updated) this.ui.updateMessageElement(updated);

              const actions = [];
              if (classified.code === 'NO_KEY' || classified.code === 'NO_ACTIVE_KEY' || classified.status === 401) {
                actions.push({
                  label: this.ui._t('openKeyManager'),
                  onClick: () => this.ui.setView('keys'),
                });
              }
              this.ui.addBanner({
                id: 'send-error',
                level: 'error',
                message: classified.userMessage,
                actions,
              });
              this._syncHeaderAndStatus(classified.isRateLimit ? 'cooldown' : 'error');
            }
            throw err;
          } finally {
            this._isSending = false;
            this._abortController = null;
          }
        }

        cancelGeneration() {
          if (this._abortController) {
            try {
              this._abortController.abort();
            } catch (_) {}
          }
          this.failoverEngine.abort();
        }

        async testKey(id) {
          this.ui.setTestingKeyId(id);
          try {
            const res = await this.keyManager.testKey(id, this.apiClient);
            if (res.ok) {
              this._lastConnectionState = { status: 'connected', detail: `Verified (${res.key.maskedKey})` };
              if (Array.isArray(res.models) && res.models.length > 0) {
                this.ui.setFetchingModels(false, res.models);
              }
            } else {
              this._lastConnectionState = {
                status: res.error?.isRateLimit ? 'rate_limited' : 'error',
                detail: res.error?.userMessage || '',
              };
            }
            this._syncHeaderAndStatus();
            return res;
          } finally {
            this.ui.setTestingKeyId(null);
          }
        }

        async fetchModelsFromGroq() {
          const candidate = this.keyManager.getCandidateOrder()[0] || this.keyManager.getPrimaryKey();
          if (!candidate) {
            const err = this.errorHandler.classify({ code: 'NO_ACTIVE_KEY' });
            this.ui.addBanner({ id: 'models-fetch-err', level: 'error', message: err.userMessage });
            return null;
          }
          this.ui.setFetchingModels(true);
          try {
            const res = await this.keyManager.testKey(candidate.id, this.apiClient);
            if (res.ok) {
              this.ui.dismissBanner('models-fetch-err');
              this._lastConnectionState = { status: 'connected', detail: 'Models synced' };
              this._syncHeaderAndStatus();
              this.ui.setFetchingModels(false, res.models || []);
              return res.models;
            }
            this.ui.addBanner({
              id: 'models-fetch-err',
              level: 'error',
              message: res.error?.userMessage || 'Failed to fetch models',
            });
            this.ui.setFetchingModels(false);
            return null;
          } catch (err) {
            this.ui.setFetchingModels(false);
            return null;
          }
        }

        exportActiveConversation(format) {
          const conv = this.conversationManager.getActive();
          const slug = (conv.title || 'homework').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'homework';
          if (format === 'json') {
            const json = this.conversationManager.exportJSON(conv.id, { includeImages: false });
            if (!downloadFile(this._doc, this._win, `${slug}.json`, json, 'application/json')) {
              copyToClipboard(this._doc, this._win, json);
            }
          } else {
            const md = this.conversationManager.exportMarkdown(conv.id);
            if (!downloadFile(this._doc, this._win, `${slug}.md`, md, 'text/markdown;charset=utf-8')) {
              copyToClipboard(this._doc, this._win, md);
            }
          }
        }

        wipeAllData() {
          this.storage.wipeAll();
          this.settings.load();
          this.keyManager.load();
          const fresh = this.conversationManager.clearAll();
          this._lastConnectionState = { status: 'unconfigured', detail: '' };
          this.ui.clearPendingImages();
          this.ui.setDraftText('');
          this.ui.renderConversation(fresh, { hasActiveKey: false });
          this.ui.renderSidebar(this.conversationManager.getSummaryList());
          this.ui.renderKeysView(this.keyManager.getKeys());
          this.ui.renderSettingsView(this.settings.getAll());
          this._syncHeaderAndStatus('idle');
          this.ui.setView('chat');
        }

        destroy() {
          this.cancelGeneration();
          for (const off of this._unsubscribers) {
            try {
              off();
            } catch (_) {}
          }
          this._unsubscribers = [];
          this.hotkeyManager?.destroy?.();
          this.imageProcessor?.revokeAll?.();
          this.ui?.destroy?.();
          this._initialized = false;
        }
      }

      /**
       * Singleton bootstrap helper for browser Userscript runtime.
       * @param {Object} [options]
       * @returns {AppCore}
       */
      function bootstrap(options = {}) {
        if (root.__SHC_APP__ && root.__SHC_APP__._initialized) {
          return root.__SHC_APP__;
        }
        const app = new AppCore(options);
        app.init();
        root.__SHC_APP__ = app;
        return app;
      }

      SHC.UIManager = UIManager;
      SHC.AppCore = AppCore;
      SHC.bootstrap = bootstrap;

      // Auto-bootstrap only in real browser document contexts (skipped in iframes and headless unit tests unless UA is set)
      const shouldAutoInit =
        !root.__SHC_NO_AUTO_INIT__ &&
        typeof document !== 'undefined' &&
        typeof window !== 'undefined' &&
        typeof navigator !== 'undefined' &&
        typeof navigator.userAgent === 'string' &&
        navigator.userAgent.length > 0 &&
        !(window.top && window.self && window.top !== window.self);

      if (shouldAutoInit) {
        if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
          document.addEventListener('DOMContentLoaded', () => bootstrap(), { once: true });
        } else {
          bootstrap();
        }
      }

      if (typeof module !== 'undefined' && module.exports) {
        module.exports = SHC;
      }
    })(
      typeof globalThis !== 'undefined'
        ? globalThis
        : typeof window !== 'undefined'
          ? window
          : this,
      typeof SHC !== 'undefined' ? SHC : undefined
    );
  }).call(globalScope, globalScope, undefined, undefined);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SHC;
  }

  if (typeof globalScope.__SHC_AUTO_BOOTSTRAP__ === 'function') {
    globalScope.__SHC_AUTO_BOOTSTRAP__(SHC);
  }
})(
  typeof globalThis !== 'undefined'
    ? globalThis
    : typeof window !== 'undefined'
      ? window
      : typeof self !== 'undefined'
        ? self
        : this
);
