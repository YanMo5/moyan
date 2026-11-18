/**
 * lib/mailer.cjs — 站点通知邮件发送器 (CommonJS)
 *
 * 为什么是 .cjs：根目录 package.json 声明了 "type": "module"，
 * 而 server/server.js 与 api/[...route].js 都使用 require()，
 * 用 .cjs 后缀可保证文件始终按 CommonJS 解析。
 *
 * 配置全部来自环境变量（本地写在根目录 .env，Vercel 写在项目环境变量）：
 *   SMTP_HOST    smtp.qq.com
 *   SMTP_PORT    465
 *   SMTP_SECURE  true（465 端口用 true；587 端口用 false，会走 STARTTLS）
 *   SMTP_USER    发信账号，例如 3351708803@qq.com
 *   SMTP_PASS    邮箱 SMTP 授权码（不是登录密码）
 *   CONTACT_TO   收信地址，默认与 SMTP_USER 相同
 *   SMTP_FROM    发件人显示，默认 "YanMo 博客 <SMTP_USER>"
 *
 * 未配置时不抛错：调用方拿到 { ok:false, reason:'not_configured' }，
 * 留言照样入库，前端据此提示"已保存但未开启邮件通知"。
 */

'use strict';

const DEFAULT_TIMEOUTS = {
    connection: 8000,
    greeting: 6000,
    socket: 12000
};

// 硬性时间上限：保证 Vercel 函数（maxDuration 10s）不会因发信卡住而超时
const HARD_TIMEOUT_MS = 9000;

let cachedTransport = null;
let cachedKey = '';
let lastResult = null;

function toInt(value, fallback) {
    const n = parseInt(String(value == null ? '' : value), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readConfig() {
    const host = String(process.env.SMTP_HOST || '').trim();
    const user = String(process.env.SMTP_USER || '').trim();
    const pass = String(process.env.SMTP_PASS || '').trim();
    const to = String(process.env.CONTACT_TO || user || '').trim();
    const from = String(process.env.SMTP_FROM || '').trim() || (user ? `YanMo 博客 <${user}>` : '');
    const port = toInt(process.env.SMTP_PORT, 465);
    const secureRaw = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
    const secure = secureRaw ? (secureRaw !== 'false' && secureRaw !== '0') : port === 465;

    return {
        host,
        port,
        secure,
        user,
        pass,
        to,
        from,
        timeouts: {
            connection: toInt(process.env.SMTP_CONNECTION_TIMEOUT, DEFAULT_TIMEOUTS.connection),
            greeting: toInt(process.env.SMTP_GREETING_TIMEOUT, DEFAULT_TIMEOUTS.greeting),
            socket: toInt(process.env.SMTP_SOCKET_TIMEOUT, DEFAULT_TIMEOUTS.socket)
        }
    };
}

function isMailConfigured() {
    const cfg = readConfig();
    return Boolean(cfg.host && cfg.user && cfg.pass && cfg.to);
}

function missingHints(cfg) {
    const hints = [];
    if (!cfg.host) hints.push('缺少 SMTP_HOST，例如 smtp.qq.com');
    if (!cfg.user) hints.push('缺少 SMTP_USER（发信邮箱账号）');
    if (!cfg.pass) hints.push('缺少 SMTP_PASS（邮箱 SMTP 授权码，不是登录密码）');
    if (!cfg.to) hints.push('缺少 CONTACT_TO（收信邮箱）');
    return hints;
}

function getStatus() {
    const cfg = readConfig();
    const configured = isMailConfigured();
    return {
        configured,
        host: cfg.host || null,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.user || null,
        to: cfg.to || null,
        last_result: lastResult,
        hints: configured ? [] : missingHints(cfg)
    };
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

function cleanHeaderText(value, maxLength) {
    return String(value == null ? '' : value)
        .replace(/[\r\n]+/g, ' ')
        .trim()
        .slice(0, maxLength || 200);
}

function loadNodemailer() {
    try {
        return require('nodemailer');
    } catch (error) {
        return null;
    }
}

function getTransport(cfg) {
    const key = [cfg.host, cfg.port, cfg.secure, cfg.user, cfg.pass].join('|');
    if (cachedTransport && cachedKey === key) {
        return { ok: true, transport: cachedTransport };
    }

    const nodemailer = loadNodemailer();
    if (!nodemailer) {
        return {
            ok: false,
            reason: 'nodemailer_missing',
            error: '未安装 nodemailer，请在项目根目录和 server/ 目录分别运行 npm install nodemailer'
        };
    }

    try {
        cachedTransport = nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            auth: { user: cfg.user, pass: cfg.pass },
            connectionTimeout: cfg.timeouts.connection,
            greetingTimeout: cfg.timeouts.greeting,
            socketTimeout: cfg.timeouts.socket,
            tls: { minVersion: 'TLSv1.2' }
        });
        cachedKey = key;
        return { ok: true, transport: cachedTransport };
    } catch (error) {
        return { ok: false, reason: 'transport_init_failed', error: error.message };
    }
}

function buildSubject(payload) {
    const subject = cleanHeaderText(payload.subject, 120) || '无主题';
    const name = cleanHeaderText(payload.name, 60) || '匿名访客';
    return `[博客留言] ${subject} — ${name}`;
}

function buildText(payload) {
    return [
        '来自博客「联系我」页面的新留言',
        '',
        `姓名：${payload.name || '-'}`,
        `邮箱：${payload.email || '-'}`,
        `主题：${payload.subject || '-'}`,
        `时间：${payload.received_at || new Date().toISOString()}`,
        payload.client_ip ? `来源 IP：${payload.client_ip}` : null,
        '',
        '留言内容：',
        String(payload.message || '').trim(),
        '',
        '—— 直接回复本邮件即可回到访客邮箱 ——'
    ].filter((line) => line !== null).join('\n');
}

function buildHtml(payload) {
    const rows = [
        ['姓名', payload.name],
        ['邮箱', payload.email],
        ['主题', payload.subject],
        ['时间', payload.received_at || new Date().toISOString()],
        ['来源 IP', payload.client_ip]
    ].filter((row) => row[1]);

    const rowHtml = rows.map(([label, value]) => `
            <tr>
                <th align="left" style="padding:6px 12px 6px 0;color:#64748b;font-weight:600;white-space:nowrap;">${escapeHtml(label)}</th>
                <td style="padding:6px 0;color:#0f172a;">${escapeHtml(value)}</td>
            </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>博客新留言</title></head>
<body style="margin:0;padding:24px;background:#f5f7fa;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <div style="padding:18px 22px;background:#0f172a;color:#e2e8f0;">
            <div style="font-size:13px;letter-spacing:2px;color:#7dd3fc;">YANMO // CONTACT_FORM</div>
            <h1 style="margin:8px 0 0;font-size:18px;font-weight:600;">收到一条新的站内留言</h1>
        </div>
        <div style="padding:20px 22px;">
            <table style="border-collapse:collapse;width:100%;font-size:14px;">${rowHtml}
            </table>
            <div style="margin-top:18px;padding-top:16px;border-top:1px solid #e2e8f0;">
                <div style="font-size:12px;color:#64748b;margin-bottom:8px;">留言内容</div>
                <div style="white-space:pre-wrap;font-size:14px;line-height:1.7;color:#0f172a;">${escapeHtml(payload.message)}</div>
            </div>
        </div>
        <div style="padding:14px 22px;background:#f8fafc;color:#64748b;font-size:12px;">
            直接回复本邮件即可发送到访客邮箱。此邮件由站点自动发送。
        </div>
    </div>
</body>
</html>`;
}

function withHardTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', error: '发送超时（' + ms + 'ms）' }), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 发送“联系我”通知邮件。永不抛错，统一返回 { ok, reason?, error?, messageId? }。
 */
async function sendContactNotification(payload, options) {
    const opts = options || {};
    const cfg = readConfig();

    if (!isMailConfigured()) {
        lastResult = { ok: false, reason: 'not_configured', at: new Date().toISOString() };
        if (opts.log !== false) {
            console.warn('[mailer] 邮件通知未配置：' + missingHints(cfg).join('；'));
        }
        return { ok: false, reason: 'not_configured', error: missingHints(cfg).join('；') };
    }

    const built = getTransport(cfg);
    if (!built.ok) {
        lastResult = { ok: false, reason: built.reason, error: built.error, at: new Date().toISOString() };
        console.error('[mailer] ' + built.error);
        return built;
    }

    const data = {
        name: cleanHeaderText(payload && payload.name, 80),
        email: cleanHeaderText(payload && payload.email, 160),
        subject: cleanHeaderText(payload && payload.subject, 160),
        message: String((payload && payload.message) || '').slice(0, 8000),
        received_at: (payload && payload.received_at) || new Date().toISOString(),
        client_ip: cleanHeaderText(payload && payload.client_ip, 60)
    };

    const mail = {
        from: cfg.from,
        to: cfg.to,
        subject: buildSubject(data),
        text: buildText(data),
        html: buildHtml(data),
        replyTo: data.email && /.+@.+\..+/.test(data.email) ? data.email : undefined
    };

    try {
        const info = await withHardTimeout(
            built.transport.sendMail(mail),
            toInt(process.env.SMTP_HARD_TIMEOUT, HARD_TIMEOUT_MS)
        );

        lastResult = info && info.ok === false
            ? { ok: false, reason: info.reason, error: info.error, at: new Date().toISOString() }
            : { ok: true, messageId: (info && info.messageId) || null, at: new Date().toISOString() };

        if (lastResult.ok) {
            console.log('[mailer] 留言通知已发送 -> ' + cfg.to + (lastResult.messageId ? ' (' + lastResult.messageId + ')' : ''));
        } else {
            console.error('[mailer] 发送失败：' + (lastResult.error || lastResult.reason));
        }
        return lastResult;
    } catch (error) {
        lastResult = {
            ok: false,
            reason: 'send_failed',
            error: error && error.message ? error.message : String(error),
            at: new Date().toISOString()
        };
        console.error('[mailer] 发送失败：' + lastResult.error);
        return lastResult;
    }
}

/**
 * 验证 SMTP 配置是否可用（用于后台自检接口）。
 */
async function verifyTransport() {
    const cfg = readConfig();
    if (!isMailConfigured()) {
        return { ok: false, reason: 'not_configured', error: missingHints(cfg).join('；') };
    }
    const built = getTransport(cfg);
    if (!built.ok) {
        return built;
    }
    try {
        await withHardTimeout(built.transport.verify(), toInt(process.env.SMTP_HARD_TIMEOUT, HARD_TIMEOUT_MS));
        return { ok: true };
    } catch (error) {
        return { ok: false, reason: 'verify_failed', error: error && error.message ? error.message : String(error) };
    }
}

module.exports = {
    isMailConfigured,
    getStatus,
    sendContactNotification,
    verifyTransport
};
