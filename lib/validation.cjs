'use strict';

/** Shared input validation for local Node and Vercel APIs. */

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function text(value, maxLength) {
    let result = String(value == null ? '' : value)
        .normalize('NFKC')
        .replace(CONTROL_CHARS, '');
    if (maxLength && result.length > maxLength) {
        result = result.slice(0, maxLength);
    }
    return result;
}

function trimmed(value, maxLength) {
    return text(value, maxLength).trim();
}

function isEmail(value) {
    const email = trimmed(value, 254);
    return email.length >= 3 &&
        email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) &&
        !/[\r\n]/.test(email);
}

function parseId(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : null;
}

function intInRange(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function isPrivateHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' ||
        host.endsWith('.local') ||
        /^127\./.test(host) ||
        /^10\./.test(host) ||
        /^192\.168\./.test(host) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
        /^169\.254\./.test(host) ||
        /^::1$/.test(host) ||
        /^::ffff:/i.test(host) ||
        /^f[cd][0-9a-f]{2}:/i.test(host) ||
        /^0\./.test(host);
}

function httpUrl(value, maxLength) {
    const raw = trimmed(value, maxLength || 2048);
    if (!raw) return null;
    let parsed;
    try {
        parsed = new URL(raw);
    } catch (error) {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname || isPrivateHost(parsed.hostname)) return null;
    return parsed.href;
}

function imageDataUrl(value, maxLength) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    if (raw.length > (maxLength || 300000)) return null;
    if (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(raw)) return null;
    return raw;
}

module.exports = {
    isPlainObject,
    text,
    trimmed,
    isEmail,
    parseId,
    intInRange,
    isPrivateHost,
    httpUrl,
    imageDataUrl
};
