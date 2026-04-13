#!/usr/bin/env node
/* eslint-disable no-console */
const { spawn } = require('child_process');

const args = new Set(process.argv.slice(2));
const shouldSpawnServer = args.has('--spawn');
const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '30000', 10);

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(pathname) {
  const url = `${baseUrl}${pathname}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} em ${url}`);
  }
  return res.json();
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await requestJson('/api/health');
      if (health && health.status === 'ok') {
        return health;
      }
    } catch (_) {
      // Aguarda o servidor ficar pronto.
    }
    await wait(1000);
  }
  throw new Error(`Timeout aguardando /api/health (${timeoutMs}ms)`);
}

function validateHealth(payload) {
  if (!payload || payload.status !== 'ok') {
    throw new Error('Resposta invalida em /api/health');
  }
}

function validateStats(payload) {
  if (!payload || typeof payload.total !== 'number') {
    throw new Error('Resposta invalida em /api/stats: campo "total" ausente');
  }
  if (typeof payload.scoreComercialMedio !== 'number') {
    throw new Error('Resposta invalida em /api/stats: campo "scoreComercialMedio" ausente');
  }
  if (!payload.porPacote || !payload.porPrioridade) {
    throw new Error('Resposta invalida em /api/stats: distribuicoes comerciais ausentes');
  }
  if (typeof payload.enrichmentTtlHours !== 'number') {
    throw new Error('Resposta invalida em /api/stats: campo "enrichmentTtlHours" ausente');
  }
  if (typeof payload.maxEnrichmentConcurrency !== 'number') {
    throw new Error('Resposta invalida em /api/stats: campo "maxEnrichmentConcurrency" ausente');
  }
}

function validateLeads(payload) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error('Resposta invalida em /api/leads: campo "data" ausente');
  }
  if (payload.data.length > 0) {
    const first = payload.data[0];
    if (!first.scoreComercial || !first.pacoteSugerido || !first.prioridadeComercial) {
      throw new Error('Resposta invalida em /api/leads: campos comerciais ausentes');
    }
  }
}

async function runSmoke() {
  console.log(`\n[SMOKE] Iniciando validacao em ${baseUrl}`);

  const health = await requestJson('/api/health');
  validateHealth(health);
  console.log('[SMOKE] /api/health ok');

  const stats = await requestJson('/api/stats');
  validateStats(stats);
  console.log(`[SMOKE] /api/stats ok (total=${stats.total})`);

  const leads = await requestJson('/api/leads?page=1&limit=1');
  validateLeads(leads);
  console.log(`[SMOKE] /api/leads ok (itens=${leads.data.length})`);

  const leadsComEnrichment = await requestJson('/api/leads?page=1&limit=1&include_enrichment=true');
  validateLeads(leadsComEnrichment);
  if (!leadsComEnrichment.includesEnrichment) {
    throw new Error('Resposta invalida em /api/leads: include_enrichment nao aplicado');
  }
  if (typeof leadsComEnrichment.maxEnrichmentConcurrency !== 'number') {
    throw new Error('Resposta invalida em /api/leads: metadado de concorrencia ausente');
  }
  if (leadsComEnrichment.data.length > 0 && !leadsComEnrichment.data[0].enrichment) {
    throw new Error('Resposta invalida em /api/leads: enrichment ausente');
  }
  console.log('[SMOKE] /api/leads?include_enrichment=true ok');

  if (leads.data.length > 0) {
    const cnpj = encodeURIComponent(leads.data[0].cnpj);
    const enrichment = await requestJson(`/api/leads/${cnpj}/enrichment`);
    if (!enrichment || !enrichment.enrichment) {
      throw new Error('Resposta invalida em /api/leads/:cnpj/enrichment');
    }
    console.log('[SMOKE] /api/leads/:cnpj/enrichment ok');
  }

  const warmup = await requestJson('/api/enrichment/warmup?limit=1&concurrency=1');
  if (typeof warmup.warmed !== 'number') {
    throw new Error('Resposta invalida em /api/enrichment/warmup');
  }
  if (typeof warmup.concurrency !== 'number') {
    throw new Error('Resposta invalida em /api/enrichment/warmup: concorrencia ausente');
  }
  console.log('[SMOKE] /api/enrichment/warmup ok');

  console.log('[SMOKE] Todos os checks passaram com sucesso.\n');
}

async function main() {
  let serverProcess = null;
  try {
    if (shouldSpawnServer) {
      console.log('[SMOKE] Subindo servidor para o teste...');
      serverProcess = spawn('node', ['server.js'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      serverProcess.stdout.on('data', () => {});
      serverProcess.stderr.on('data', () => {});
      await waitForHealth();
      console.log('[SMOKE] Servidor pronto.');
    }

    await runSmoke();
  } catch (err) {
    console.error(`\n[SMOKE] Falhou: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    if (serverProcess && !serverProcess.killed) {
      console.log('[SMOKE] Encerrando servidor do teste...');
      serverProcess.kill('SIGTERM');
    }
  }
}

main();
