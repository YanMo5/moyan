'use strict';

/**
 * Lightweight local moderation for public guestbook messages.
 * It intentionally does NOT block security vocabulary such as 攻击/漏洞/渗透/恶意软件;
 * it only targets direct abuse, threats, hate, adult spam and obvious link spam.
 */

const RULES = [
    {
        reason: 'abuse',
        re: /(傻逼|傻b|煞笔|沙比|脑残|弱智|废物东西|草泥马|操你妈|你妈死了|去死吧|nmsl|cnm|狗娘养|杂种|贱人)/i
    },
    {
        reason: 'threat',
        re: /(杀了你|弄死你|砍死你|炸死你|弄残你|让你消失|kill\s+you|i(?:'| a)?m going to kill you)/i
    },
    {
        reason: 'hate',
        re: /(\b(?:nigger|nigga|faggot|retard|chink|kike|spic)\b|支那猪|黑鬼|台巴子)/i
    },
    {
        reason: 'adult',
        re: /(裸聊|约炮|成人视频|色情网站|黄片|porn|onlyfans|escort\s+service)/i
    },
    {
        reason: 'spam',
        re: /(博彩|赌博网站|代考|办证|出售枪支|买枪|毒品交易|高额返利|日赚\d+|加微信领|点击领取|免费领|刷单)/i
    },
    {
        reason: 'abuse',
        re: /\b(?:fuck|fucking|shit|bitch|asshole|bastard)\b/i
    }
];

function normalize(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function checkMessage(input) {
    const name = normalize(input && input.name);
    const message = normalize(input && input.message);
    const text = name + '\n' + message;

    if (!text.trim()) {
        return { ok: false, reason: 'empty' };
    }

    for (const rule of RULES) {
        if (rule.re.test(text)) {
            return { ok: false, reason: rule.reason };
        }
    }

    // Link spam / repeated-character spam
    const links = text.match(/https?:\/\//g);
    if (links && links.length > 3) {
        return { ok: false, reason: 'spam' };
    }
    if (/(.)\1{24,}/.test(text)) {
        return { ok: false, reason: 'spam' };
    }

    return { ok: true, reason: null };
}

module.exports = { checkMessage };
