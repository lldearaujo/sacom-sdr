'use strict';

const MAX_TRACES = Math.max(50, Number.parseInt(process.env.AI_MONITOR_MAX_TRACES || '300', 10));

const traces = [];
const traceIndex = new Map();

function nowIso() {
  return new Date().toISOString();
}

function maskSensitive(text) {
  const raw = String(text || '');
  if (!raw) return '';
  return raw
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{10,16}\b/g, '[numero]');
}

function shortText(value, max = 400) {
  return maskSensitive(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max);
}

function buildTraceId(flow) {
  const safeFlow = String(flow || 'ia').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'ia';
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${safeFlow}`;
}

function compactMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  Object.keys(meta).forEach((key) => {
    const value = meta[key];
    if (value === undefined) return;
    if (value === null) {
      out[key] = null;
      return;
    }
    if (typeof value === 'string') {
      out[key] = shortText(value, 180);
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
      return;
    }
    out[key] = shortText(JSON.stringify(value), 180);
  });
  return out;
}

function trimOverflow() {
  while (traces.length > MAX_TRACES) {
    const removed = traces.shift();
    if (!removed) break;
    traceIndex.delete(removed.id);
  }
}

function startTrace({
  flow = 'unknown',
  channel = 'system',
  leadCnpj = null,
  leadName = null,
  inputPreview = '',
} = {}) {
  const id = buildTraceId(flow);
  const trace = {
    id,
    flow: String(flow),
    channel: String(channel),
    status: 'running',
    startedAt: nowIso(),
    endedAt: null,
    durationMs: null,
    leadCnpj: leadCnpj ? String(leadCnpj) : null,
    leadName: leadName ? shortText(leadName, 80) : null,
    inputPreview: shortText(inputPreview, 420),
    outputPreview: '',
    error: null,
    fallbackUsed: false,
    steps: [],
  };
  traces.push(trace);
  traceIndex.set(id, trace);
  trimOverflow();
  return id;
}

function addStep(traceId, {
  stage = 'step',
  status = 'ok',
  message = '',
  durationMs = null,
  meta = null,
} = {}) {
  const trace = traceIndex.get(traceId);
  if (!trace) return;
  trace.steps.push({
    at: nowIso(),
    stage: String(stage),
    status: String(status),
    message: shortText(message, 220),
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
    meta: compactMeta(meta),
  });
}

function finishTrace(traceId, {
  status = 'ok',
  outputPreview = '',
  error = '',
  fallbackUsed = false,
} = {}) {
  const trace = traceIndex.get(traceId);
  if (!trace) return;
  trace.status = String(status || 'ok');
  trace.endedAt = nowIso();
  trace.durationMs = Math.max(0, Date.parse(trace.endedAt) - Date.parse(trace.startedAt));
  trace.outputPreview = shortText(outputPreview, 420);
  trace.error = error ? shortText(error, 320) : null;
  trace.fallbackUsed = Boolean(fallbackUsed);
}

function listTraces({ limit = 80, flow = '', status = '', channel = '' } = {}) {
  const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 80, MAX_TRACES));
  const flowFilter = String(flow || '').toLowerCase();
  const statusFilter = String(status || '').toLowerCase();
  const channelFilter = String(channel || '').toLowerCase();
  return traces
    .slice()
    .reverse()
    .filter((item) => {
      if (flowFilter && String(item.flow).toLowerCase() !== flowFilter) return false;
      if (statusFilter && String(item.status).toLowerCase() !== statusFilter) return false;
      if (channelFilter && String(item.channel).toLowerCase() !== channelFilter) return false;
      return true;
    })
    .slice(0, safeLimit);
}

function getTraceById(id) {
  return traceIndex.get(String(id || '')) || null;
}

function getSummary() {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  const summary = {
    running: 0,
    ok: 0,
    fallback: 0,
    error: 0,
    totalLastHour: 0,
    avgDurationMsLastHour: 0,
  };
  let durationSum = 0;
  let durationCount = 0;
  traces.forEach((trace) => {
    const startedMs = Date.parse(trace.startedAt);
    if (!Number.isNaN(startedMs) && startedMs >= oneHourAgo) {
      summary.totalLastHour += 1;
      if (Number.isFinite(trace.durationMs)) {
        durationSum += trace.durationMs;
        durationCount += 1;
      }
    }
    const key = String(trace.status || '').toLowerCase();
    if (key === 'running') summary.running += 1;
    else if (key === 'ok') summary.ok += 1;
    else if (key === 'fallback') summary.fallback += 1;
    else summary.error += 1;
  });
  summary.avgDurationMsLastHour = durationCount ? Math.round(durationSum / durationCount) : 0;
  return summary;
}

module.exports = {
  startTrace,
  addStep,
  finishTrace,
  listTraces,
  getTraceById,
  getSummary,
};
