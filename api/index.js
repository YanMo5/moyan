module.exports = function handler(req, res) {
    res.status(200).json({
        ok: true,
        mode: 'server-api',
        route: '/api',
        method: req.method || 'GET',
        message: 'Cloud API is active. Use /api/* routes for shared data and admin operations.'
    });
};
