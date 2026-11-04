/**
 * Dev Log Bridge — UI side bootstrap (classic script).
 *
 * sidepanel.html loads classic <script> tags (not modules), so we cannot
 * `import` from lib/devLogger.js. This file inlines the same logic for
 * the UI realm and self-installs as PRIMO script in sidepanel.html.
 *
 * No-op in production: gated on the version string containing "dev"
 * (e.g. a local "9.13.0-dev" build). SEC FIX (2026-08-27): this file used
 * to ALSO gate on `!manifest.update_url` ("unpacked = dev"), but this
 * project is *always* distributed unpacked (never via the Chrome Web
 * Store — see README) — so that condition was true for every real user's
 * install, not just a developer's machine, silently streaming scraped
 * business PII (found emails, page content) to a localhost log server for
 * every team member who installed it. The version-string marker is the
 * only signal left that a developer sets deliberately on their own local
 * copy and a distributed build won't carry. Same env detection as
 * lib/config.js — keep both in sync.
 */
(function gmpDevBootstrap() {
    'use strict';
    try {
        const manifest = chrome?.runtime?.getManifest?.();
        if (!manifest) return;
        const isDev = (manifest.version || '').includes('dev');
        if (!isDev) return;
    } catch { return; }

    const ENDPOINT = 'http://127.0.0.1:9876/log';
    const BATCH_DEBOUNCE_MS = 100;
    const KILL_AFTER_FAILS = 5;
    const FETCH_TIMEOUT_MS = 2000;
    const BUFFER_HARD_CAP = 5000;
    const SOURCE = 'UI';

    let buffer = [];
    let timer = null;
    let fails = 0;
    let alive = true;

    function safeStr(v) {
        if (typeof v === 'string') return v;
        if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ''}`;
        try { return JSON.stringify(v); } catch { return String(v); }
    }
    function push(level, args) {
        if (!alive) return;
        if (buffer.length >= BUFFER_HARD_CAP) buffer.shift();
        buffer.push({
            ts: Date.now(),
            source: SOURCE,
            level,
            msg: Array.prototype.map.call(args, safeStr).join(' ')
        });
        if (!timer) timer = setTimeout(flush, BATCH_DEBOUNCE_MS);
    }
    async function flush() {
        timer = null;
        if (buffer.length === 0) return;
        const batch = buffer;
        buffer = [];
        try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
            try {
                await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(batch),
                    signal: ctrl.signal
                });
                fails = 0;
            } finally { clearTimeout(to); }
        } catch (_) {
            fails++;
            if (fails >= KILL_AFTER_FAILS) {
                alive = false;
                // Use the ORIGINAL console.warn captured before patching,
                // to avoid recursing through the patched method.
                if (typeof window.__gmpOrigConsoleWarn === 'function') {
                    window.__gmpOrigConsoleWarn('[devLogger] sink unreachable — disabling bridge until reload');
                }
            }
        }
    }

    // Monkey-patch console.* — keep originals callable.
    try {
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
            const orig = console[level];
            if (typeof orig !== 'function') continue;
            if (level === 'warn') window.__gmpOrigConsoleWarn = orig;
            console[level] = function patched() {
                try { push(level, arguments); } catch { /* never throw */ }
                return orig.apply(console, arguments);
            };
        }
    } catch { /* ignore */ }

    // Window-level error handlers.
    window.addEventListener('error', (ev) => {
        try {
            push('error', [
                '[unhandled]',
                ev?.message || ev?.error?.message || '(no message)',
                ev?.error?.stack || `${ev?.filename}:${ev?.lineno}:${ev?.colno}`
            ]);
        } catch { /* never throw */ }
    });
    window.addEventListener('unhandledrejection', (ev) => {
        try {
            const r = ev?.reason;
            push('error', [
                '[unhandledrejection]',
                r?.message || safeStr(r),
                r?.stack || ''
            ]);
        } catch { /* never throw */ }
    });

    push('info', [`[devLogger] online (source=${SOURCE})`]);
})();
