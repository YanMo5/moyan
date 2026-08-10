'use strict';

const cron = require('node-cron');
const Parser = require('rss-parser');
const http = require('http');

const POLL_INTERVAL = '*/15 * * * *'; // every 15 minutes
const API_BASE = 'http://127.0.0.1:3000';
const FETCH_TIMEOUT_MS = 8000;

const rssParser = new Parser({ timeout: FETCH_TIMEOUT_MS });

// Common RSS/Atom feed path suffixes to probe in order
const FEED_PATHS = [
    '/feed.xml',
    '/feed',
    '/rss.xml',
    '/rss',
    '/atom.xml',
    '/index.xml',
    '/feed/atom',
    '/blog/feed',
];

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

async function probeRssFeed(siteUrl) {
    const base = siteUrl.replace(/\/$/, '');
    for (const suffix of FEED_PATHS) {
        try {
            const feed = await rssParser.parseURL(base + suffix);
            const latest = feed.items && feed.items[0];
            return {
                is_online: true,
                latest_post_title: (latest && latest.title) ? String(latest.title).slice(0, 200) : '',
                latest_post_url: (latest && latest.link) ? String(latest.link).slice(0, 500) : '',
            };
        } catch (_) {
            // try next suffix
        }
    }
    return null;
}

async function probeLiveness(siteUrl) {
    try {
        const res = await fetchWithTimeout(siteUrl, { method: 'HEAD' });
        return res.status < 500;
    } catch (_) {
        return false;
    }
}

async function getApprovedLinks() {
    const res = await fetchWithTimeout(`${API_BASE}/api/links`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const all = await res.json();
    return all.filter(l => l.status === 'approved');
}

async function pushStatusUpdates(updates) {
    const body = JSON.stringify(updates);
    const res = await fetchWithTimeout(`${API_BASE}/api/link-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
    });
    if (!res.ok) {
        const text = await res.text();
        console.error(`[rss-poller] status push failed: ${res.status} ${text}`);
    }
}

async function pollAll() {
    console.log(`[rss-poller] ${new Date().toISOString()} — starting probe cycle`);
    let links;
    try {
        links = await getApprovedLinks();
    } catch (err) {
        console.error('[rss-poller] failed to fetch links:', err.message);
        return;
    }

    if (!links.length) {
        console.log('[rss-poller] no approved links to probe');
        return;
    }

    const results = await Promise.allSettled(
        links.map(async link => {
            const rssResult = await probeRssFeed(link.site_url);
            if (rssResult) {
                return { id: link.id, ...rssResult };
            }
            // RSS not found — fall back to plain liveness check
            const alive = await probeLiveness(link.site_url);
            return {
                id: link.id,
                is_online: alive,
                latest_post_title: '',
                latest_post_url: '',
            };
        })
    );

    const updates = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    if (updates.length) {
        await pushStatusUpdates(updates);
    }
    console.log(`[rss-poller] cycle done — probed ${links.length}, updated ${updates.length}`);
}

function start() {
    // Run once immediately on startup, then on schedule
    pollAll().catch(err => console.error('[rss-poller] initial poll error:', err.message));
    cron.schedule(POLL_INTERVAL, () => {
        pollAll().catch(err => console.error('[rss-poller] poll error:', err.message));
    });
    console.log(`[rss-poller] scheduled — ${POLL_INTERVAL}`);
}

module.exports = { start };
