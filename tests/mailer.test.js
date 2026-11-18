/**
 * tests/mailer.test.js
 *
 * lib/mailer.cjs 的单元测试：用本地假 SMTP 服务器验证真实发信链路，
 * 不依赖外网，也不会真的把邮件发出去。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import net from 'net';

const require = createRequire(import.meta.url);
const MAILER_PATH = require.resolve('../lib/mailer.cjs');
const PORT = 12525;

let server;
let captured = [];
const smtpEnvKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'CONTACT_TO', 'SMTP_HARD_TIMEOUT'];

/** 每次重新 require，避免 mailer 内部的 transport 缓存串场 */
function freshMailer() {
    for (const key of smtpEnvKeys) {
        delete process.env[key];
    }
    delete require.cache[MAILER_PATH];
    return require(MAILER_PATH);
}

function startFakeSmtp() {
    return new Promise((resolve) => {
        const srv = net.createServer((socket) => {
            let buffer = '';
            let inData = false;
            let authStep = 0;

            socket.write('220 fake-smtp ready\r\n');

            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');

                if (inData) {
                    if (buffer.includes('\r\n.\r\n')) {
                        captured.push(buffer.split('\r\n.\r\n')[0]);
                        inData = false;
                        buffer = '';
                        socket.write('250 2.0.0 queued\r\n');
                    }
                    return;
                }

                let idx;
                while ((idx = buffer.indexOf('\r\n')) !== -1) {
                    const line = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const upper = line.toUpperCase();

                    if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
                        socket.write('250-fake-smtp\r\n250-AUTH LOGIN PLAIN\r\n250 OK\r\n');
                    } else if (upper.startsWith('AUTH LOGIN')) {
                        authStep = 1;
                        socket.write('334 VXNlcm5hbWU6\r\n');
                    } else if (authStep === 1) {
                        authStep = 2;
                        socket.write('334 UGFzc3dvcmQ6\r\n');
                    } else if (authStep === 2) {
                        authStep = 0;
                        socket.write('235 2.7.0 Authentication successful\r\n');
                    } else if (upper.startsWith('AUTH PLAIN')) {
                        socket.write('235 2.7.0 Authentication successful\r\n');
                    } else if (upper.startsWith('DATA')) {
                        inData = true;
                        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
                    } else if (upper.startsWith('QUIT')) {
                        socket.write('221 bye\r\n');
                        socket.end();
                    } else {
                        socket.write('250 OK\r\n');
                    }
                }
            });

            socket.on('error', () => {});
        });

        srv.listen(PORT, '127.0.0.1', () => resolve(srv));
    });
}

function quotedPrintable(text) {
    return [...Buffer.from(text, 'utf8')]
        .map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
}

/** 邮件正文可能是 quoted-printable（含软换行），先还原再匹配 */
function mailContains(body, needle) {
    if (body.includes(needle)) return true;
    const flat = body.replace(/=\r?\n/g, '');
    return flat.includes(needle) || flat.toLowerCase().includes(quotedPrintable(needle).toLowerCase());
}

beforeAll(async () => {
    server = await startFakeSmtp();
}, 10000);

afterAll(async () => {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
});

beforeEach(() => {
    captured = [];
});

describe('lib/mailer.cjs', () => {
    it('reports not configured when SMTP env vars are missing', async () => {
        const mailer = freshMailer();
        expect(mailer.isMailConfigured()).toBe(false);
        expect(mailer.getStatus().hints.length).toBeGreaterThan(0);

        const result = await mailer.sendContactNotification(
            { name: 'A', email: 'a@example.com', subject: 'S', message: 'M' },
            { log: false }
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('not_configured');
    });

    it('sends the notification email over SMTP and sets Reply-To to the visitor', async () => {
        const mailer = freshMailer();
        process.env.SMTP_HOST = '127.0.0.1';
        process.env.SMTP_PORT = String(PORT);
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_USER = 'bot@example.com';
        process.env.SMTP_PASS = 'app-password';
        process.env.CONTACT_TO = 'owner@example.com';
        process.env.SMTP_HARD_TIMEOUT = '4000';

        expect(mailer.isMailConfigured()).toBe(true);

        const result = await mailer.sendContactNotification({
            name: '测试访客',
            email: 'visitor@example.com',
            subject: 'CTF 交流',
            message: '这是一条邮件链路测试留言。',
            received_at: '2026-01-01T00:00:00.000Z',
            client_ip: '127.0.0.1'
        });

        expect(result.ok).toBe(true);
        expect(captured.length).toBe(1);

        const body = captured[0];
        expect(body).toMatch(/To: owner@example\.com/i);
        expect(body).toMatch(/Reply-To: visitor@example\.com/i);
        expect(mailContains(body, '测试访客')).toBe(true);
        expect(mailContains(body, '这是一条邮件链路测试留言。')).toBe(true);

        const status = mailer.getStatus();
        expect(status.configured).toBe(true);
        expect(status.last_result.ok).toBe(true);
    }, 15000);

    it('never throws when the SMTP server is unreachable', async () => {
        const mailer = freshMailer();
        process.env.SMTP_HOST = '127.0.0.1';
        process.env.SMTP_PORT = '1'; // 无服务监听，必然连接失败
        process.env.SMTP_SECURE = 'false';
        process.env.SMTP_USER = 'bot@example.com';
        process.env.SMTP_PASS = 'wrong';
        process.env.CONTACT_TO = 'owner@example.com';
        process.env.SMTP_HARD_TIMEOUT = '2000';

        const result = await mailer.sendContactNotification(
            { name: 'A', email: 'a@example.com', subject: 'S', message: 'M' },
            { log: false }
        );

        expect(result.ok).toBe(false);
        expect(typeof result.error).toBe('string');
    }, 15000);
});
