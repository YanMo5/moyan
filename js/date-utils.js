(function (global) {
    'use strict';

    function formatLocalDate(value) {
        if (!value) return '--';
        var s = String(value).replace(' ', 'T').replace(/\.\d+$/, '');
        var d = /([Zz]|[+-]\d{2}:?\d{2})$/.test(s) ? new Date(s) : new Date(s + 'Z');
        if (isNaN(d.getTime())) return String(value).split(' ')[0] || '--';
        return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    }

    function formatLocalDateTime(value) {
        if (!value) return '--';
        var s = String(value).replace(' ', 'T').replace(/\.\d+$/, '');
        var d = /([Zz]|[+-]\d{2}:?\d{2})$/.test(s) ? new Date(s) : new Date(s + 'Z');
        if (isNaN(d.getTime())) return String(value).split(' ')[0] || '--';
        return d.toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }

    function relativeTime(value) {
        if (!value) return '--';
        var s = String(value).replace(' ', 'T').replace(/\.\d+$/, '');
        var d = /([Zz]|[+-]\d{2}:?\d{2})$/.test(s) ? new Date(s) : new Date(s + 'Z');
        if (isNaN(d.getTime())) return '--';
        var diffMs = Date.now() - d.getTime();
        var diffSec = Math.floor(diffMs / 1000);
        if (diffSec < 60) return '刚刚';
        var diffMin = Math.floor(diffSec / 60);
        if (diffMin < 60) return diffMin + '分钟前';
        var diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return diffHr + '小时前';
        var diffDay = Math.floor(diffHr / 24);
        if (diffDay < 30) return diffDay + '天前';
        return formatLocalDate(value);
    }

    global.formatLocalDate = formatLocalDate;
    global.formatLocalDateTime = formatLocalDateTime;
    global.relativeTime = relativeTime;

})(typeof window !== 'undefined' ? window : globalThis);