'use strict';

const buckets = new Map();

function hit(key, limit, windowMs) {
    const now = Date.now();
    const bucketKey = String(key || 'unknown');
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;

    // Keep the in-memory map bounded on long-running Node processes.
    if (buckets.size > 5000) {
        for (const [k, value] of buckets) {
            if (value.resetAt <= now) buckets.delete(k);
        }
    }

    return {
        allowed: bucket.count <= limit,
        retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
}

module.exports = { hit };
