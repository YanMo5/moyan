const catchAllHandler = require('./[...route]');

module.exports = function handler(req, res) {
    const originalUrl = String(req.url || '/');

    // Keep a simple health-style response for exact /api requests.
    if (originalUrl === '/' || originalUrl === '' || originalUrl.startsWith('/?')) {
        return res.status(200).json({
            ok: true,
            mode: 'server-api',
            route: '/api',
            method: req.method || 'GET',
            message: 'Cloud API is active.'
        });
    }

    // Fallback: when platform routing sends /api/* to api/index.js,
    // convert path to the shape expected by api/[...route].js.
    const pathWithoutQuery = originalUrl.split('?')[0];
    const cleanedPath = pathWithoutQuery.replace(/^\//, '');
    const segments = cleanedPath.split('/').filter(Boolean);

    req.query = req.query || {};
    if (!req.query.route) {
        req.query.route = segments;
    }

    return catchAllHandler(req, res);
};
