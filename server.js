'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const systemLogger = require('./server/logger');

// ─── Módulos de Banco, IA e WhatsApp ──────────────────────────────────────────
const db = require('./server/db');
const cache = require('./server/cache');
const gemini = require('./server/gemini');
const whatsapp = require('./server/whatsapp');
const whatsappInbound = require('./server/whatsapp-inbound');
const whatsappDebounce = require('./server/whatsapp-debounce');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

systemLogger.installConsoleCapture();

let dbReady = false;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Constantes antigas de enrichment (mantidas para compatibilidade com a UI)
const ENRICHMENT_TTL_HOURS = Number.parseInt(process.env.ENRICHMENT_TTL_HOURS || '168', 10);
const MAX_ENRICHMENTS_PER_REQUEST = Number.parseInt(process.env.MAX_ENRICHMENTS_PER_REQUEST || '20', 10);
const MAX_ENRICHMENT_CONCURRENCY = Number.parseInt(process.env.MAX_ENRICHMENT_CONCURRENCY || '4', 10);
const ENRICHMENT_DOMAIN_COOLDOWN_MS = Number.parseInt(process.env.ENRICHMENT_DOMAIN_COOLDOWN_MS || '600', 10);
const ENRICHMENT_FETCH_TIMEOUT_MS = Number.parseInt(process.env.ENRICHMENT_FETCH_TIMEOUT_MS || '4000', 10);
const ENRICHMENT_WARMUP_ENABLED = String(process.env.ENRICHMENT_WARMUP_ENABLED || 'true').toLowerCase() !== 'false';
const ENRICHMENT_WARMUP_HOUR = Number.parseInt(process.env.ENRICHMENT_WARMUP_HOUR || '7', 10);
const ENRICHMENT_WARMUP_MINUTE = Number.parseInt(process.env.ENRICHMENT_WARMUP_MINUTE || '0', 10);
const ENRICHMENT_WARMUP_LIMIT = Number.parseInt(process.env.ENRICHMENT_WARMUP_LIMIT || '30', 10);
const ENRICHMENT_WARMUP_ON_START = String(process.env.ENRICHMENT_WARMUP_ON_START || 'false').toLowerCase() === 'true';
const ENRICHMENT_WARMUP_SEGMENTS = (process.env.ENRICHMENT_WARMUP_SEGMENTS
  || 'Varejo,Saude,Automotivo,Educacao,Construcao e Imoveis')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const domainThrottleState = new Map();
let nextWarmupAt = null;
const warmupStatus = {
  running: false,
  lastSource: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastDurationMs: null,
  lastError: null,
  lastWarmed: 0,
  lastSegments: [],
};

const CAMPAIGN_WINDOWS = [
  { id: 'volta_as_aulas', label: 'Volta às aulas', months: [1], segmentos: ['Educacao'] },
  { id: 'carnaval_verao', label: 'Carnaval e verão', months: [2], segmentos: ['Varejo', 'Turismo', 'Outros'] },
  { id: 'dia_das_maes', label: 'Dia das mães', months: [5], segmentos: ['Varejo', 'Saude'] },
  { id: 'sao_joao', label: 'São João', months: [6], segmentos: ['Varejo', 'Automotivo', 'Outros'] },
  { id: 'ferias_julho', label: 'Férias de julho', months: [7], segmentos: ['Educacao', 'Varejo'] },
  { id: 'dia_dos_pais', label: 'Dia dos pais', months: [8], segmentos: ['Varejo', 'Automotivo'] },
  { id: 'aniversario_empresa', label: 'Aniversário da empresa', months: [1,2,3,4,5,6,7,8,9,10,11,12], segmentos: ['Varejo', 'Saude', 'Automotivo', 'Educacao', 'Construcao e Imoveis', 'Institucional', 'Outros'] },
  { id: 'dia_das_criancas', label: 'Dia das crianças', months: [10], segmentos: ['Varejo', 'Educacao'] },
  { id: 'black_friday', label: 'Black Friday', months: [11], segmentos: ['Varejo', 'Automotivo', 'Tecnologia', 'Outros'] },
  { id: 'natal', label: 'Natal', months: [12], segmentos: ['Varejo', 'Saude', 'Outros'] },
];

function getRecurringPotentialWeight(level) {
  if (level === 'Alta') return 3;
  if (level === 'Media') return 2;
  return 1;
}

function getPackageTicketWeight(packageName) {
  if (packageName === 'Plano Dominio da Cidade') return 3;
  if (packageName === 'Plano Impacto') return 2;
  return 1;
}

function getAnnualCampaignEstimate(lead) {
  const recurringWeight = getRecurringPotentialWeight(lead.potencialRecorrencia);
  if (recurringWeight === 3) return 10;
  if (recurringWeight === 2) return 6;
  return 3;
}

function getAnnualRecurringProjection(leads) {
  const projectionBySegment = {};
  let projectedCampaigns = 0;
  let projectedTicketWeight = 0;

  leads.forEach((lead) => {
    const segment = lead.segmentoPrioritario || 'Outros';
    const annualCampaigns = getAnnualCampaignEstimate(lead);
    const ticketWeight = getPackageTicketWeight(lead.pacoteSugerido);
    projectedCampaigns += annualCampaigns;
    projectedTicketWeight += annualCampaigns * ticketWeight;

    if (!projectionBySegment[segment]) {
      projectionBySegment[segment] = {
        leads: 0,
        projectedCampaigns: 0,
        projectedTicketWeight: 0,
      };
    }
    projectionBySegment[segment].leads += 1;
    projectionBySegment[segment].projectedCampaigns += annualCampaigns;
    projectionBySegment[segment].projectedTicketWeight += annualCampaigns * ticketWeight;
  });

  return {
    projectedCampaigns,
    projectedTicketWeight,
    bySegment: projectionBySegment,
  };
}

function getUpcomingCampaignWindows(segment, now = new Date()) {
  const currentMonth = now.getMonth() + 1;
  const candidates = CAMPAIGN_WINDOWS
    .filter((w) => w.segmentos.includes(segment) || w.segmentos.includes('Outros'))
    .map((w) => {
      const nextMonth = w.months.find((m) => m >= currentMonth) || w.months[0];
      const wrapsYear = nextMonth < currentMonth;
      const nextYear = now.getFullYear() + (wrapsYear ? 1 : 0);
      const nextDate = new Date(nextYear, nextMonth - 1, 1);
      return {
        id: w.id,
        label: w.label,
        nextDate: nextDate.toISOString(),
        nextMonth,
      };
    })
    .sort((a, b) => Date.parse(a.nextDate) - Date.parse(b.nextDate));
  return candidates.slice(0, 3);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEnrichmentExpired(entry) {
  if (!entry || !entry.atualizadoEm) return true;
  const updatedMs = Date.parse(entry.atualizadoEm);
  if (Number.isNaN(updatedMs)) return true;
  const ttlMs = ENRICHMENT_TTL_HOURS * 60 * 60 * 1000;
  return Date.now() - updatedMs > ttlMs;
}

function normalizeSite(site) {
  if (!site) return null;
  const trimmed = String(site).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function extractDomain(siteUrl) {
  try {
    const u = new URL(siteUrl);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return null;
  }
}

async function waitForDomainSlot(domain) {
  if (!domain) return;
  while (true) {
    const state = domainThrottleState.get(domain) || { active: 0, lastFinishedAt: 0 };
    const elapsed = Date.now() - state.lastFinishedAt;
    if (state.active === 0 && elapsed >= ENRICHMENT_DOMAIN_COOLDOWN_MS) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(120);
  }
}

async function withDomainThrottle(siteUrl, action) {
  const domain = extractDomain(siteUrl);
  if (!domain) return action();

  await waitForDomainSlot(domain);
  const state = domainThrottleState.get(domain) || { active: 0, lastFinishedAt: 0 };
  state.active += 1;
  domainThrottleState.set(domain, state);
  try {
    return await action();
  } finally {
    const updated = domainThrottleState.get(domain) || { active: 1, lastFinishedAt: 0 };
    updated.active = Math.max(0, updated.active - 1);
    updated.lastFinishedAt = Date.now();
    domainThrottleState.set(domain, updated);
  }
}

async function runWithConcurrency(items, limit, handler) {
  if (!items.length) return;
  const safeLimit = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      await handler(items[i], i);
    }
  });
  await Promise.allSettled(workers);
}

function extractSiteSignals(html) {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  return {
    titulo: title.trim(),
    hasInstagram: /instagram\.com/i.test(html),
    hasFacebook: /facebook\.com/i.test(html),
    hasLinkedin: /linkedin\.com/i.test(html),
    hasWhatsapp: /whatsapp|wa\.me/i.test(html),
    hasForm: /<form/i.test(html),
    hasMetaDescription: /<meta[^>]*name=["']description["']/i.test(html),
  };
}

function inferDigitalMaturity(signals) {
  let points = 0;
  if (signals.hasMetaDescription) points += 1;
  if (signals.hasForm) points += 1;
  if (signals.hasInstagram) points += 1;
  if (signals.hasFacebook) points += 1;
  if (signals.hasLinkedin) points += 1;
  if (signals.hasWhatsapp) points += 1;
  if (points >= 5) return 'Alta';
  if (points >= 3) return 'Media';
  return 'Baixa';
}

async function fetchAndPersistEnrichment(lead, { forceRefresh = false } = {}) {
  const cached = await db.getEnrichment(lead.cnpj);
  if (!forceRefresh && cached && !isEnrichmentExpired(cached)) return cached;

  const siteUrl = normalizeSite(lead.site);
  if (!siteUrl) {
    const fallback = {
      status: 'sem_site',
      maturidadeDigital: 'Baixa',
      sinais: {},
      fonte: 'sem_site',
    };
    await db.saveEnrichment(lead.cnpj, fallback);
    return db.getEnrichment(lead.cnpj);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENRICHMENT_FETCH_TIMEOUT_MS);
  try {
    const response = await withDomainThrottle(siteUrl, () => fetch(siteUrl, { signal: controller.signal }));
    const html = await response.text();
    const signals = extractSiteSignals(html);
    await db.saveEnrichment(lead.cnpj, {
      status: 'ok',
      siteUrl,
      tituloSite: signals.titulo || '',
      maturidadeDigital: inferDigitalMaturity(signals),
      sinais: signals,
      fonte: 'fetch_site',
    });
    return db.getEnrichment(lead.cnpj);
  } catch (err) {
    await db.saveEnrichment(lead.cnpj, {
      status: 'erro',
      siteUrl,
      maturidadeDigital: 'Nao identificado',
      sinais: {},
      erro: err.message,
      fonte: 'fallback_erro',
    });
    return db.getEnrichment(lead.cnpj);
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichLeadsBatch(leads, { limit = 10, concurrency = MAX_ENRICHMENT_CONCURRENCY, forceRefresh = false } = {}) {
  const cappedLimit = Math.max(0, Math.min(Number.parseInt(limit, 10) || 0, MAX_ENRICHMENTS_PER_REQUEST));
  const selected = leads.slice(0, cappedLimit);
  const safeConcurrency = Math.max(1, Math.min(Number.parseInt(concurrency, 10) || MAX_ENRICHMENT_CONCURRENCY, MAX_ENRICHMENT_CONCURRENCY));
  const enrichmentByCnpj = {};
  await runWithConcurrency(selected, safeConcurrency, async (lead) => {
    enrichmentByCnpj[lead.cnpj] = await fetchAndPersistEnrichment(lead, { forceRefresh });
  });
  return { selected, enrichmentByCnpj, concurrency: safeConcurrency };
}

async function buildWarmupCandidates({ limit, segmentos }) {
  const target = Math.max(1, Math.min(limit, MAX_ENRICHMENTS_PER_REQUEST));
  const unique = new Map();
  for (const seg of segmentos) {
    // eslint-disable-next-line no-await-in-loop
    const partial = await db.queryLeads({ segmento_prioritario: seg, limit: target, page: 1, order_by: 'score_comercial' });
    partial.data.forEach((lead) => {
      if (!unique.has(lead.cnpj) && unique.size < target * 2) unique.set(lead.cnpj, lead);
    });
    if (unique.size >= target * 2) break;
  }
  if (unique.size < target) {
    const fallback = await db.queryLeads({ limit: target * 2, page: 1, order_by: 'score_comercial' });
    fallback.data.forEach((lead) => {
      if (!unique.has(lead.cnpj) && unique.size < target * 2) unique.set(lead.cnpj, lead);
    });
  }

  const leads = Array.from(unique.values());
  const checks = await Promise.all(
    leads.map(async (lead) => ({ lead, enrichment: await db.getEnrichment(lead.cnpj) })),
  );
  const staleFirst = checks
    .filter(({ enrichment }) => !enrichment || isEnrichmentExpired(enrichment))
    .map(({ lead }) => lead);
  const freshFallback = checks
    .filter(({ enrichment }) => enrichment && !isEnrichmentExpired(enrichment))
    .map(({ lead }) => lead);

  return [...staleFirst, ...freshFallback].slice(0, target);
}

async function runWarmup({ source = 'manual', limit = ENRICHMENT_WARMUP_LIMIT, concurrency = MAX_ENRICHMENT_CONCURRENCY, forceRefresh = false, segmentos = ENRICHMENT_WARMUP_SEGMENTS } = {}) {
  const startedAt = Date.now();
  warmupStatus.running = true;
  warmupStatus.lastSource = source;
  warmupStatus.lastStartedAt = new Date(startedAt).toISOString();
  warmupStatus.lastError = null;
  warmupStatus.lastSegments = segmentos;
  try {
    const candidates = await buildWarmupCandidates({ limit, segmentos });
    const result = await enrichLeadsBatch(candidates, { limit: candidates.length, concurrency, forceRefresh });
    warmupStatus.lastWarmed = result.selected.length;
  } catch (err) {
    warmupStatus.lastError = err.message;
    throw err;
  } finally {
    warmupStatus.running = false;
    warmupStatus.lastFinishedAt = new Date().toISOString();
    warmupStatus.lastDurationMs = Date.now() - startedAt;
  }
}

function computeNextWarmupAt() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(ENRICHMENT_WARMUP_HOUR, ENRICHMENT_WARMUP_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function scheduleDailyWarmup() {
  if (!ENRICHMENT_WARMUP_ENABLED) return;
  const next = computeNextWarmupAt();
  nextWarmupAt = next.toISOString();
  const delayMs = Math.max(1000, next.getTime() - Date.now());
  setTimeout(async () => {
    try {
      await runWarmup({ source: 'scheduler' });
      console.log('[Warmup] Rotina diária executada com sucesso.');
    } catch (err) {
      console.error('[Warmup] Falha na rotina diária:', err.message);
    } finally {
      scheduleDailyWarmup();
    }
  }, delayMs);
}

// ─── APIs Core ────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const status = res.statusCode;
    if (req.path.startsWith('/api/')) {
      console.log(`[API] ${req.method} ${req.path} -> ${status} (${ms}ms)`);
    }
  });
  next();
});

app.get('/api/health', async (req, res) => {
  const isRedisOk = await cache.isRedisHealthy();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dbConectado: dbReady,
    redisConectado: isRedisOk,
  });
});

app.get('/api/system/logs', (req, res) => {
  const limit = req.query.limit || '200';
  const level = req.query.level || '';
  const logs = systemLogger.getLogs({ limit, level: level ? String(level) : undefined });
  res.json({ logs });
});

const mediaMod = require('./server/media');
app.get('/api/media/catalog', async (req, res) => {
  try {
    const m = await mediaMod.loadManifest();
    const entries = Object.entries(m)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => ({
        key: k,
        type: v && v.type,
        file: v && v.file,
        fileName: (v && v.fileName) || (v && v.file),
        descricao: (v && v.descricao) || '',
      }));
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const result = await db.queryLeads(req.query);
    
    // Anexa enrichment se solicitado
    const shouldIncludeEnrichment = String(req.query.include_enrichment || '').toLowerCase() === 'true';
    const enrichLimit = Number.parseInt(req.query.enrich_limit || String(result.data.length), 10);
    const enrichConcurrency = Number.parseInt(req.query.enrich_concurrency || String(MAX_ENRICHMENT_CONCURRENCY), 10);
    const shouldForceRefresh = String(req.query.force_refresh || '').toLowerCase() === 'true';
    if (shouldIncludeEnrichment) {
      const batch = await enrichLeadsBatch(result.data, {
        limit: Number.isNaN(enrichLimit) ? result.data.length : enrichLimit,
        concurrency: Number.isNaN(enrichConcurrency) ? MAX_ENRICHMENT_CONCURRENCY : enrichConcurrency,
        forceRefresh: shouldForceRefresh,
      });
      result.data.forEach((lead) => {
        lead.enrichment = batch.enrichmentByCnpj[lead.cnpj] || lead.enrichment || null;
      });
    }

    res.json({
      total: result.total,
      page: parseInt(req.query.page || 1, 10),
      limit: parseInt(req.query.limit || 50, 10),
      includesEnrichment: shouldIncludeEnrichment,
      enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
      maxEnrichmentConcurrency: MAX_ENRICHMENT_CONCURRENCY,
      enrichmentDomainCooldownMs: ENRICHMENT_DOMAIN_COOLDOWN_MS,
      enrichmentFetchTimeoutMs: ENRICHMENT_FETCH_TIMEOUT_MS,
      data: result.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const stats = await db.getStats();
    const leadsResult = await db.queryLeads({ limit: 5000, page: 1, order_by: 'score_comercial' });
    const annualProjection = getAnnualRecurringProjection(leadsResult.data);
    const topRecurringSegments = Object.entries(annualProjection.bySegment)
      .sort((a, b) => b[1].projectedCampaigns - a[1].projectedCampaigns)
      .slice(0, 5)
      .map(([segmento, data]) => ({
        segmento,
        leads: data.leads,
        projectedCampaigns: data.projectedCampaigns,
        projectedTicketWeight: data.projectedTicketWeight,
      }));

    res.json({
      ...stats,
      // compatibilidade com validações antigas / smoke test
      enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
      maxEnrichmentConcurrency: MAX_ENRICHMENT_CONCURRENCY,
      enrichmentDomainCooldownMs: ENRICHMENT_DOMAIN_COOLDOWN_MS,
      enrichmentFetchTimeoutMs: ENRICHMENT_FETCH_TIMEOUT_MS,
      recorrenciaAnual: {
        projectedCampaigns: annualProjection.projectedCampaigns,
        projectedTicketWeight: annualProjection.projectedTicketWeight,
        topRecurringSegments,
      },
      warmup: {
        ...warmupStatus,
        enabled: ENRICHMENT_WARMUP_ENABLED,
        scheduleHour: ENRICHMENT_WARMUP_HOUR,
        scheduleMinute: ENRICHMENT_WARMUP_MINUTE,
        scheduleSegments: ENRICHMENT_WARMUP_SEGMENTS,
        nextWarmupAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oportunidades/recorrencia', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const limit = Number.parseInt(req.query.limit || '1000', 10);
    const segmento = req.query.segmento ? String(req.query.segmento) : null;
    const query = {
      limit: Number.isNaN(limit) ? 1000 : Math.max(1, Math.min(limit, 5000)),
      page: 1,
      order_by: 'score_comercial',
    };
    if (segmento) query.segmento_prioritario = segmento;

    const leadsResult = await db.queryLeads(query);
    const projection = getAnnualRecurringProjection(leadsResult.data);
    const now = new Date();

    const windowsBySegment = Object.keys(projection.bySegment).map((seg) => ({
      segmento: seg,
      windows: getUpcomingCampaignWindows(seg, now),
      projectedCampaigns: projection.bySegment[seg].projectedCampaigns,
      projectedTicketWeight: projection.bySegment[seg].projectedTicketWeight,
      leads: projection.bySegment[seg].leads,
    })).sort((a, b) => b.projectedCampaigns - a.projectedCampaigns);

    res.json({
      totalLeadsConsiderados: leadsResult.data.length,
      projectedCampaigns: projection.projectedCampaigns,
      projectedTicketWeight: projection.projectedTicketWeight,
      windowsBySegment,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── APIs Enrichment ───────────────────────────────────────────────────────────
// Em uma refatoração total, o ideal seria mover a lógica de fetch pra um worker, 
// mas para manter a API intacta pro frontend:
app.get('/api/leads/:cnpj/enrichment', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const lead = await db.getLeadByCnpj(req.params.cnpj);
    if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' });
    const forceRefresh = String(req.query.force_refresh || '').toLowerCase() === 'true';
    const enrichment = await fetchAndPersistEnrichment(lead, { forceRefresh });
    res.json({
      cnpj: lead.cnpj,
      razao: lead.razao,
      fantasia: lead.fantasia,
      forceRefresh,
      enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
      enrichment,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/enrichment/warmup', (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  const limit = Number.parseInt(req.query.limit || String(ENRICHMENT_WARMUP_LIMIT), 10);
  const concurrency = Number.parseInt(req.query.concurrency || String(MAX_ENRICHMENT_CONCURRENCY), 10);
  const forceRefresh = String(req.query.force_refresh || '').toLowerCase() === 'true';
  const source = req.query.source ? String(req.query.source) : 'manual';
  const segmentos = (String(req.query.segmentos || ENRICHMENT_WARMUP_SEGMENTS.join(',')))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  runWarmup({
    source,
    limit: Number.isNaN(limit) ? ENRICHMENT_WARMUP_LIMIT : limit,
    concurrency: Number.isNaN(concurrency) ? MAX_ENRICHMENT_CONCURRENCY : concurrency,
    forceRefresh,
    segmentos,
  })
    .then(() => {
      res.json({
        warmed: warmupStatus.lastWarmed,
        concurrency: Number.isNaN(concurrency) ? MAX_ENRICHMENT_CONCURRENCY : concurrency,
        forceRefresh,
        source,
        segmentos,
        lastFinishedAt: warmupStatus.lastFinishedAt,
        lastDurationMs: warmupStatus.lastDurationMs,
      });
    })
    .catch((err) => {
      res.status(500).json({ error: err.message, warmup: warmupStatus });
    });
});

// ─── APIs Prospecção ─────────────────────────────────────────────────────────

app.post('/api/prospeccao/disparar', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const {
      classificacoes = ['🔴 HOT', '🟠 WARM'],
      limite = 10,
      usarIA = true,
    } = req.body || {};

    // Pega leads baseados na classe e que não estejam em cooldown
    const leadsRaw = await db.queryLeads({ limit: limite * 5 }); // pega sobra pra filtrar
    const selecionados = leadsRaw.data.filter(
      l => classificacoes.includes(l.classificacao) && (l.telefone1 || l.telefone2)
    );

    const gerarMensagemFn = usarIA ? gemini.gerarMensagemProspeccao : null;
    const resultado = await whatsapp.dispararLote(selecionados, { limite, gerarMensagemFn });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prospeccao/status', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const entries = await db.getAllProspeccoes();
    const stats = {
      total: entries.length,
      porStatus: entries.reduce((acc, e) => {
        acc[e.status] = (acc[e.status] || 0) + 1;
        return acc;
      }, {}),
    };
    res.json({ stats, entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/prospeccao/:cnpj/status', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const { cnpj } = req.params;
    const { status, notas } = req.body || {};
    
    await db.saveProspeccaoDB(cnpj, { status, notas });
    res.json({ ok: true, cnpj, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prospeccao/:cnpj/aprovar-sugestao', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const { cnpj } = req.params;
    const { score, etapa_funil, status } = req.body || {};
    
    const lead = await db.getLeadByCnpj(cnpj);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    // Atualiza o lead com os novos valores aprovados
    const leadUpdate = { ...lead };
    if (score !== undefined) leadUpdate.score = score;
    if (etapa_funil) leadUpdate.etapaFunil = etapa_funil;
    
    await db.upsertLead(leadUpdate);

    // Se houver mudança de status na prospecção/kanban
    if (status) {
      await db.saveProspeccaoDB(cnpj, { status });
    }

    res.json({ ok: true, cnpj, score, etapa_funil, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prospeccao/:cnpj/historico', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const hist = await db.getHistoricoConversa(req.params.cnpj);
    res.json({ messages: hist || [] }); // Frontend espera data.messages
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prospeccao/webhook', async (req, res) => {
  // Responde Z-API imediatamente para evitar timeout
  res.json({ ok: true });

  try {
    if (!dbReady) {
      console.warn('[Webhook] Banco indisponível: ignorando processamento.');
      return;
    }
    const payload = req.body;
    console.log('\n[Webhook Z-API Recebido]', JSON.stringify({
      phone: payload?.phone,
      fromMe: payload?.fromMe,
      type: payload?.type,
      text: payload?.text?.message,
      hasImage: !!payload?.image,
      hasAudio: !!payload?.audio,
      hasVideo: !!payload?.video,
      hasDocument: !!payload?.document,
    }));

    if (payload.fromMe) return;

    const userContent = await whatsappInbound.buildUserContentFromPayload(payload);
    if (!userContent) {
      console.log('[Webhook] Nenhum texto ou mídia suportada para processar.');
      return;
    }

    const numero = (payload.phone || '').replace(/\\D/g, '');

    let cnpj = await whatsapp.encontrarCnpjPorNumero(numero);
    let lead = await db.getLeadByCnpj(cnpj);

    if (!lead) {
      lead = await db.getLeadByNumero(numero);
      if (lead) cnpj = lead.cnpj;
    }

    // [MODO TESTE] Lê NUMEROS_TESTE diretamente do .env
    const rawTeste = process.env.NUMEROS_TESTE || '';
    const numerosAutorizados = rawTeste.split(/[,;\\s]+/).map(n => n.replace(/\\D/g, '')).filter(n => n.length > 5);
    const ehNumeroTeste = numerosAutorizados.some(nt => numero.includes(nt) || nt.includes(numero.substring(2)));

    if (!lead && ehNumeroTeste) {
       console.log(`[Webhook] MODO TESTE DE DIRETORIA: Autorizando ${numero}...`);
       cnpj = '00000000000000';
       lead = {
         cnpj, razao: 'Usuário de Testes Internos', fantasia: 'Empresa Teste', cidade: 'Brasil',
         segmento: 'Testes de Validação', dor_principal: 'Testar e validar comportamento da IA BDR',
         oferta_principal: 'Midia Exterior e OOH', classificacao: '🔴 HOT'
       };
    }

    if (!lead) {
       console.log(`[Webhook] IGNORADO: Número ${numero} não está registrado.`);
       return;
    }

    console.log(`[Webhook] Mensagem recebida — debounce ${whatsappDebounce.DEBOUNCE_MS}ms: ${lead.razao} (${cnpj})`);

    whatsappDebounce.scheduleBatchedReply(
      numero,
      { userContent, lead, cnpj },
      async ({ merged, lead: leadCtx, cnpj: cnpjCtx, phone }) => {
        const userInput =
          merged.parts && merged.parts.length > 0 ? merged : merged.text;

        console.log(`[Webhook] Processando lote agregado para: ${leadCtx.razao} (${cnpjCtx})`);

        const { resposta, intent, mediaKeys = [] } = await gemini.processarRespostaLead(leadCtx, userInput);

        if (intent?.interesse) {
          const type = intent.tipo || 'oportunidade';
          const isFechamento = type === 'fechamento';
          console.log(`${isFechamento ? '🤝 CONVERSÃO' : '🔥 OPORTUNIDADE'}: ${leadCtx.razao} (${leadCtx.cidade}) — ${type}`);
          
          let newStatus = intent.urgencia === 'alta' ? 'oportunidade' : 'respondido';
          if (isFechamento) newStatus = 'convertido';
          
          await db.saveProspeccaoDB(cnpjCtx, { status: newStatus });
        }

        await new Promise((r) => setTimeout(r, 800 + Math.random() * 1400));

        if (resposta && resposta.trim()) {
          await whatsapp.enviarTextoFracionado(phone, resposta);
        }
        if (mediaKeys.length) {
          const rMidia = await whatsapp.enviarMidiasCatalogo(phone, mediaKeys);
          if (rMidia.enviados) console.log(`[Webhook] Mídias enviadas: ${rMidia.enviados} (${mediaKeys.join(', ')})`);
        }
      }
    );

  } catch (err) {
    console.error('Erro no webhook Gemini/Z-API:', err.message);
  }
});

// ─── APIs AI & Insights ────────────────────────────────────────────────────────

app.get('/api/ai/insights', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const leadsRaw = await db.queryLeads({ limit: 100 }); 
    const insights = await gemini.analisarLeadsComIA(leadsRaw.data);
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai/mensagem-preview/:cnpj', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const lead = await db.getLeadByCnpj(req.params.cnpj);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const mensagem = await gemini.gerarMensagemProspeccao(lead);
    res.json({
      cnpj: lead.cnpj, razao: lead.razao, fantasia: lead.fantasia, cidade: lead.cidade, mensagem,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings API ──────────────────────────────────────────────────────────────

const MULTILINE_CONFIG_KEYS = new Set(['BDR_SYSTEM_PROMPT', 'BDR_OBJETIVO_CONVERSA', 'BDR_INTENT_DETECCAO']);

app.get('/api/config', (req, res) => {
  const keys = [
    'BDR_AGENTE_NOME', 'BDR_AGENTE_CARGO', 'BDR_SYSTEM_PROMPT', 'BDR_OBJETIVO_CONVERSA', 'BDR_INTENT_DETECCAO',
    'GEMINI_MODEL', 'GEMINI_TEMPERATURA',
    'PROSPECCAO_HORA_INICIO', 'PROSPECCAO_HORA_FIM', 'PROSPECCAO_COOLDOWN_DIAS', 'PROSPECCAO_LIMITE_DIARIO',
    'NUMEROS_TESTE', 'PUBLIC_BASE_URL',
    // Z-API (opcional expor apenas pra debug visual)
    'ZAPI_INSTANCE_ID',
  ];
  const responseConfig = {};
  keys.forEach(k => {
    let val = process.env[k] || '';
    if (MULTILINE_CONFIG_KEYS.has(k)) val = val.replace(/\\n/g, '\n');
    responseConfig[k] = val;
  });
  res.json(responseConfig);
});

app.post('/api/config', async (req, res) => {
  try {
    const envPath = path.join(__dirname, '.env');
    let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    
    const payload = req.body || {};
    const updates = payload.updates && typeof payload.updates === 'object' ? payload.updates : payload;

    for (const [key, rawValue] of Object.entries(updates || {})) {
      let value = rawValue;
      if (MULTILINE_CONFIG_KEYS.has(key)) {
        value = String(value).replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        value = String(value);
      }
      // Salva no process.env (runtime)
      process.env[key] = value;
      
      // Salva no PostgreSQL (persistência definitiva)
      if (dbReady) {
        await db.saveSetting(key, value).catch(e => console.error(`Erro ao salvar ${key} no PG:`, e.message));
      }

      const idx = lines.findIndex(l => l.startsWith(`${key}=`));
      if (idx !== -1) lines[idx] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
    }

    fs.writeFileSync(envPath, lines.join('\n').trim() + '\n', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Knowledge Base Upload API ────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage() });

app.get('/api/knowledge', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const list = await db.getKnowledgeList();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/knowledge/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
    const { originalname, buffer, mimetype } = req.file;
    let textoDeExtraida = '';

    if (mimetype === 'application/pdf') {
      const parsed = await pdfParse(buffer);
      textoDeExtraida = parsed.text;
    } else {
      textoDeExtraida = buffer.toString('utf8');
    }

    if (!textoDeExtraida || textoDeExtraida.trim().length === 0) {
      return res.status(400).json({ error: 'O arquivo não contém texto legível.' });
    }

    // Fatia o documento em pedaços de ~1000 caracteres para melhor embedding semântico
    const chunks = [];
    const paragraphs = textoDeExtraida.split(/\n\s*\n/);
    let currentChunk = '';
    
    for (const p of paragraphs) {
      if (currentChunk.length + p.length > 2000) {
        chunks.push(currentChunk.trim());
        currentChunk = p;
      } else {
        currentChunk += '\\n\\n' + p;
      }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());

    // Importar rag localmente para não causar erro top-level se ainda n foi carregado
    const rag = require('./server/rag');
    
    let inseridos = 0;
    for (const chunk of chunks) {
      if (chunk.length < 20) continue; // Pula fragmentos inúteis
      const embedding = await rag.getEmbedding(chunk);
      await db.saveKnowledge(`Fragmento de ${originalname}`, chunk, embedding, originalname);
      inseridos++;
    }

    res.json({ ok: true, file: originalname, inseridos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
    await db.deleteKnowledge(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Media Catalog Management API ─────────────────────────────────────────────

const uploadMedia = multer({ storage: multer.memoryStorage() });

app.post('/api/media/upload', uploadMedia.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    const { key, type, caption, descricao } = req.body;
    if (!key) return res.status(400).json({ error: 'A chave da mídia é obrigatória.' });

    // Gera um nome de arquivo seguro similar ao diskStorage anterior
    const ext = path.extname(req.file.originalname);
    const safeName = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${Date.now()}_${safeName}${ext}`;
    
    // Caminho da pasta física
    const mediaDir = path.join(__dirname, 'public', 'media');
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    
    // Grava no disco
    fs.writeFileSync(path.join(mediaDir, filename), req.file.buffer);

    const entry = {
      file: filename,
      type: type || 'document',
      fileName: req.file.originalname,
      caption: caption || '',
      descricao: descricao || ''
    };

    // Salva no banco (Passando o buffer agora que usamos memoryStorage)
    const result = await mediaMod.saveMedia(key, entry, req.file.buffer);
    res.json({ ok: true, key, entry: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/media/:key', async (req, res) => {
  try {
    const success = await mediaMod.deleteMedia(req.params.key);
    if (!success) return res.status(404).json({ error: 'Mídia não encontrada no catálogo.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT & START SERVER
// ══════════════════════════════════════════════════════════════════════════════

async function startServer() {
  try {
    await db.init();
    dbReady = true;
    
    // Bootstrap: Recupera tudo que está no Banco (Configs e Arquivos)
    // Isso evita perda de dados em ambientes efêmeros (Easypanel/Docker)
    await db.bootstrapSystem().catch(err => {
      console.error('⚠️ Falha no bootstrap de dados:', err.message);
    });

    if (ENRICHMENT_WARMUP_ENABLED) {
      scheduleDailyWarmup();
      console.log(`[Warmup] Agendado diariamente para ${String(ENRICHMENT_WARMUP_HOUR).padStart(2, '0')}:${String(ENRICHMENT_WARMUP_MINUTE).padStart(2, '0')}.`);
      if (ENRICHMENT_WARMUP_ON_START) {
        runWarmup({ source: 'startup' })
          .then(() => console.log('[Warmup] Execucao inicial concluida.'))
          .catch((err) => console.error('[Warmup] Falha na execucao inicial:', err.message));
      }
    }

  } catch (err) {
    dbReady = false;
    console.error('⚠️ Banco indisponível. Subindo API em modo degradado.', err.message);
    console.error('   Verifique DATABASE_URL no .env (host/porta/credenciais).');
  }
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ SA Comunicação - RAG + PGVector + Redis rodando em http://0.0.0.0:${PORT}`);
    console.log(`   🤖 Gemini AI: ${process.env.GEMINI_MODEL || 'gemini-1.5-flash'}`);
    console.log(`   📱 Z-API: ${process.env.ZAPI_INSTANCE_ID ? 'configurada' : 'não configurada'}\n`);
  });
}

startServer().catch(err => {
  console.error('Falha fatal ao iniciar servidor:', err);
  process.exit(1);
});
