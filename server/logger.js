'use strict';

const MAX_ENTRIES = Number.parseInt(process.env.SYSTEM_LOG_MAX || '500', 10);

/** @type {{ts:string, level:'log'|'warn'|'error', message:string}[]} */
const buffer = [];

function push(level, parts) {
  try {
    const message = parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p instanceof Error) return p.stack || p.message;
        try { return JSON.stringify(p); } catch { return String(p); }
      })
      .join(' ');

    buffer.push({ ts: new Date().toISOString(), level, message });
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  } catch {
    // nunca falhar por logging
  }
}

function installConsoleCapture() {
  if (console.__saLogCaptureInstalled) return;
  console.__saLogCaptureInstalled = true;

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => { push('log', args); orig.log(...args); };
  console.warn = (...args) => { push('warn', args); orig.warn(...args); };
  console.error = (...args) => { push('error', args); orig.error(...args); };
}

function getLogs({ limit = 200, level } = {}) {
  const lim = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 1000));
  const filtered = level ? buffer.filter((e) => e.level === level) : buffer;
  const slice = filtered.slice(-lim);
  return slice;
}

module.exports = {
  installConsoleCapture,
  getLogs,
};
