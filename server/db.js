'use strict';

/**
 * server/db.js — PostgreSQL + pgvector
 * Fonte da verdade para leads, conversas, enrichment e prospecção.
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Inicialização — cria tabelas e extensão vector ───────────────────────────
async function init() {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');

    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        cnpj                  TEXT PRIMARY KEY,
        razao                 TEXT,
        fantasia              TEXT,
        cidade                TEXT,
        uf                    TEXT,
        telefone1             TEXT,
        telefone2             TEXT,
        email                 TEXT,
        site                  TEXT,
        cnae                  TEXT,
        porte                 TEXT,
        situacao              TEXT,
        faturamento           TEXT,
        segmento              TEXT,
        classificacao         TEXT,
        score                 INTEGER DEFAULT 0,
        score_fit_sa          INTEGER DEFAULT 0,
        score_territorial     INTEGER DEFAULT 0,
        score_comercial       INTEGER DEFAULT 0,
        consciencia           TEXT,
        canal_preferencial    TEXT,
        viabilidade           TEXT,
        dor_principal         TEXT,
        objetivo_curto_prazo  TEXT,
        segmento_prioritario  TEXT,
        potencial_recorrencia TEXT,
        oferta_principal      TEXT,
        pacote_sugerido       TEXT,
        gatilhos_detectados   TEXT[],
        prioridade_comercial  TEXT,
        etapa_funil           TEXT,
        proximo_passo         TEXT,
        discurso_consultivo   TEXT,
        fonte                 TEXT,
        perfil_texto          TEXT,
        embedding             vector(3072),
        enrichment            JSONB,
        prospectado_em        TIMESTAMPTZ,
        ultima_interacao_em   TIMESTAMPTZ,
        criado_em             TIMESTAMPTZ DEFAULT NOW(),
        atualizado_em         TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversas (
        id         BIGSERIAL PRIMARY KEY,
        cnpj       TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user', 'model')),
        conteudo   TEXT NOT NULL,
        intent     JSONB,
        criado_em  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS conversas_cnpj_ts_idx ON conversas (cnpj, criado_em DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS enrichment_cache (
        cnpj               TEXT PRIMARY KEY,
        status             TEXT,
        site_url           TEXT,
        titulo_site        TEXT,
        maturidade_digital TEXT,
        sinais             JSONB,
        fonte              TEXT,
        atualizado_em      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS prospeccao (
        cnpj          TEXT PRIMARY KEY,
        status        TEXT,
        enviado_em    TIMESTAMPTZ,
        zaap_id       TEXT,
        message_id    TEXT,
        mensagem      TEXT,
        numero        TEXT,
        respondido_em TIMESTAMPTZ,
        notas         TEXT,
        tentativas    INTEGER DEFAULT 0,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Índice vetorial — só criado se já houver linhas
    const { rows } = await client.query('SELECT COUNT(*) FROM leads WHERE embedding IS NOT NULL');
    if (parseInt(rows[0].count) >= 100) {
      await client.query(`
        CREATE INDEX IF NOT EXISTS leads_embedding_idx
          ON leads USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
      `).catch(() => {});
    }

    console.log('✅ PostgreSQL + pgvector inicializado');
  } finally {
    client.release();
  }
}

// ─── LEADS ────────────────────────────────────────────────────────────────────

async function upsertLead(lead) {
  await pool.query(`
    INSERT INTO leads (
      cnpj, razao, fantasia, cidade, uf, telefone1, telefone2, email, site,
      cnae, porte, situacao, faturamento, segmento, classificacao,
      score, score_fit_sa, score_territorial, score_comercial,
      consciencia, canal_preferencial, viabilidade,
      dor_principal, objetivo_curto_prazo, segmento_prioritario,
      potencial_recorrencia, oferta_principal, pacote_sugerido,
      gatilhos_detectados, prioridade_comercial, etapa_funil,
      proximo_passo, discurso_consultivo, fonte, perfil_texto, atualizado_em
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
      $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
      $29,$30,$31,$32,$33,$34,$35, NOW()
    )
    ON CONFLICT (cnpj) DO UPDATE SET
      razao               = EXCLUDED.razao,
      fantasia            = EXCLUDED.fantasia,
      cidade              = EXCLUDED.cidade,
      classificacao       = EXCLUDED.classificacao,
      score_comercial     = EXCLUDED.score_comercial,
      dor_principal       = EXCLUDED.dor_principal,
      oferta_principal    = EXCLUDED.oferta_principal,
      discurso_consultivo = EXCLUDED.discurso_consultivo,
      perfil_texto        = EXCLUDED.perfil_texto,
      atualizado_em       = NOW()
  `, [
    lead.cnpj, lead.razao, lead.fantasia, lead.cidade, lead.uf,
    lead.telefone1, lead.telefone2, lead.email, lead.site,
    lead.cnae, lead.porte, lead.situacao, lead.faturamento,
    lead.segmento, lead.classificacao,
    lead.score, lead.scoreFitSA, lead.scoreTerritorial, lead.scoreComercial,
    lead.consciencia, lead.canalPreferencial, lead.viabilidade,
    lead.dorPrincipal, lead.objetivoCurtoPrazo, lead.segmentoPrioritario,
    lead.potencialRecorrencia, lead.ofertaPrincipal, lead.pacoteSugerido,
    lead.gatilhosDetectados || [], lead.prioridadeComercial, lead.etapaFunil,
    lead.proximoPasso, lead.discursoConsultivo, lead.fonte, lead.perfilTexto || null,
  ]);
}

async function updateLeadEmbedding(cnpj, embedding) {
  await pool.query(
    'UPDATE leads SET embedding = $1 WHERE cnpj = $2',
    [`[${embedding.join(',')}]`, cnpj],
  );
}

async function getLeadByCnpj(cnpj) {
  const { rows } = await pool.query('SELECT * FROM leads WHERE cnpj = $1', [cnpj]);
  return rows[0] ? dbLeadToObj(rows[0]) : null;
}

async function getLeadByNumero(numero) {
  const numLimpo = numero.replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT * FROM leads
     WHERE regexp_replace(telefone1, '\\D', '', 'g') = $1
        OR regexp_replace(telefone2, '\\D', '', 'g') = $1
     LIMIT 1`,
    [numLimpo],
  );
  return rows[0] ? dbLeadToObj(rows[0]) : null;
}

async function queryLeads({
  classificacao, segmento, cidade, search, porte, consciencia,
  viabilidade, canal, dor, objetivo, segmento_prioritario,
  recorrencia, oferta, pacote, prioridade, etapa_funil, gatilho,
  order_by = 'score_comercial', page = 1, limit = 50,
} = {}) {
  const conditions = [];
  const params = [];

  const addFilter = (col, val, op = '=') => {
    params.push(val);
    conditions.push(`${col} ${op} $${params.length}`);
  };
  const addIlike = (col, val) => {
    params.push(`%${val.toLowerCase()}%`);
    conditions.push(`LOWER(${col}) LIKE $${params.length}`);
  };

  if (classificacao)        addFilter('classificacao', classificacao);
  if (segmento)             addFilter('segmento', segmento);
  if (porte)                addIlike('porte', porte);
  if (consciencia)          addFilter('consciencia', consciencia);
  if (viabilidade)          addFilter('viabilidade', viabilidade);
  if (canal)                addFilter('canal_preferencial', canal);
  if (dor)                  addFilter('dor_principal', dor);
  if (objetivo)             addFilter('objetivo_curto_prazo', objetivo);
  if (segmento_prioritario) addFilter('segmento_prioritario', segmento_prioritario);
  if (recorrencia)          addFilter('potencial_recorrencia', recorrencia);
  if (oferta)               addFilter('oferta_principal', oferta);
  if (pacote)               addFilter('pacote_sugerido', pacote);
  if (prioridade)           addFilter('prioridade_comercial', prioridade);
  if (etapa_funil)          addFilter('etapa_funil', etapa_funil);
  if (cidade)               addIlike('cidade', cidade);
  if (gatilho) {
    params.push(gatilho);
    conditions.push(`$${params.length} = ANY(gatilhos_detectados)`);
  }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const n = params.length;
    conditions.push(`(LOWER(razao) LIKE $${n} OR LOWER(fantasia) LIKE $${n} OR cnpj LIKE $${n})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const col = order_by === 'score' ? 'score' : 'score_comercial';

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM leads ${where}`, params,
  );
  const total = parseInt(countRows[0].count, 10);

  params.push(limit, (parseInt(page, 10) - 1) * parseInt(limit, 10));
  const { rows } = await pool.query(
    `SELECT * FROM leads ${where} ORDER BY ${col} DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return { total, data: rows.map(dbLeadToObj) };
}

// Busca semântica via pgvector (cosine similarity)
async function findSimilarLeads(embedding, { limit = 2, excludeCnpj = null } = {}) {
  const vectorStr = `[${embedding.join(',')}]`;
  const params = [vectorStr, limit + (excludeCnpj ? 1 : 0)];
  let where = 'WHERE embedding IS NOT NULL';
  if (excludeCnpj) {
    params.push(excludeCnpj);
    where += ` AND cnpj != $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT cnpj, razao, cidade, segmento_prioritario, dor_principal,
            oferta_principal, discurso_consultivo, classificacao, score_comercial
     FROM leads ${where}
     ORDER BY embedding <=> $1
     LIMIT $2`,
    params,
  );
  return rows.slice(0, limit);
}

async function getLeadsCount() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM leads');
  return parseInt(rows[0].count, 10);
}

// ─── CONVERSAS ────────────────────────────────────────────────────────────────

async function saveConversa(cnpj, role, conteudo, intent = null) {
  await pool.query(
    'INSERT INTO conversas (cnpj, role, conteudo, intent) VALUES ($1, $2, $3, $4)',
    [cnpj, role, conteudo, intent ? JSON.stringify(intent) : null],
  );
  // Atualiza ultima_interacao_em no lead
  await pool.query(
    'UPDATE leads SET ultima_interacao_em = NOW() WHERE cnpj = $1',
    [cnpj],
  ).catch(() => {});
}

async function getHistoricoConversa(cnpj, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT role, conteudo, intent, criado_em
     FROM conversas WHERE cnpj = $1
     ORDER BY criado_em DESC LIMIT $2`,
    [cnpj, limit],
  );
  return rows.reverse(); // cronológico
}

// ─── ENRICHMENT ───────────────────────────────────────────────────────────────

async function getEnrichment(cnpj) {
  const { rows } = await pool.query(
    'SELECT * FROM enrichment_cache WHERE cnpj = $1', [cnpj],
  );
  if (!rows[0]) return null;
  return {
    status: rows[0].status,
    siteUrl: rows[0].site_url,
    tituloSite: rows[0].titulo_site,
    maturidadeDigital: rows[0].maturidade_digital,
    sinais: rows[0].sinais || {},
    fonte: rows[0].fonte,
    atualizadoEm: rows[0].atualizado_em,
  };
}

async function saveEnrichment(cnpj, data) {
  await pool.query(`
    INSERT INTO enrichment_cache
      (cnpj, status, site_url, titulo_site, maturidade_digital, sinais, fonte, atualizado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
    ON CONFLICT (cnpj) DO UPDATE SET
      status             = EXCLUDED.status,
      site_url           = EXCLUDED.site_url,
      titulo_site        = EXCLUDED.titulo_site,
      maturidade_digital = EXCLUDED.maturidade_digital,
      sinais             = EXCLUDED.sinais,
      fonte              = EXCLUDED.fonte,
      atualizado_em      = NOW()
  `, [
    cnpj, data.status, data.siteUrl || data.site_url || null,
    data.tituloSite || null, data.maturidadeDigital || null,
    JSON.stringify(data.sinais || {}), data.fonte || null,
  ]);
  // Espelha o enrichment no campo JSONB do lead para consultas rápidas
  await pool.query(
    'UPDATE leads SET enrichment = $1 WHERE cnpj = $2',
    [JSON.stringify(data), cnpj],
  ).catch(() => {});
}

// ─── PROSPECÇÃO ───────────────────────────────────────────────────────────────

async function getProspeccao(cnpj) {
  const { rows } = await pool.query(
    'SELECT * FROM prospeccao WHERE cnpj = $1', [cnpj],
  );
  return rows[0] || null;
}

async function getAllProspeccoes() {
  const { rows } = await pool.query(`
    SELECT p.*, l.razao, l.fantasia, l.cidade, l.segmento_prioritario AS "segmentoPrioritario", l.classificacao
    FROM prospeccao p
    LEFT JOIN leads l ON p.cnpj = l.cnpj
    ORDER BY p.atualizado_em DESC
  `);
  return rows.map(r => ({
    cnpj: r.cnpj,
    status: r.status,
    enviadoEm: r.enviado_em,
    zaapId: r.zaap_id,
    messageId: r.message_id,
    mensagem: r.mensagem,
    numero: r.numero,
    respondidoEm: r.respondido_em,
    notas: r.notas,
    tentativas: r.tentativas,
    atualizadoEm: r.atualizado_em,
    razao: r.razao,
    fantasia: r.fantasia,
    cidade: r.cidade,
    segmentoPrioritario: r.segmentoPrioritario,
    classificacao: r.classificacao,
  }));
}

async function saveProspeccaoDB(cnpj, data) {
  await pool.query(`
    INSERT INTO prospeccao
      (cnpj, status, enviado_em, zaap_id, message_id, mensagem, numero, tentativas, atualizado_em)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW())
    ON CONFLICT (cnpj) DO UPDATE SET
      status        = EXCLUDED.status,
      enviado_em    = EXCLUDED.enviado_em,
      zaap_id       = EXCLUDED.zaap_id,
      message_id    = EXCLUDED.message_id,
      mensagem      = EXCLUDED.mensagem,
      numero        = EXCLUDED.numero,
      tentativas    = EXCLUDED.tentativas,
      atualizado_em = NOW()
  `, [
    cnpj, data.status, data.enviadoEm || null,
    data.zaapId || null, data.messageId || null,
    data.mensagem || null, data.numero || null,
    data.tentativas || 1,
  ]);
  // Marca lead como prospectado
  await pool.query(
    'UPDATE leads SET prospectado_em = NOW() WHERE cnpj = $1 AND prospectado_em IS NULL',
    [cnpj],
  ).catch(() => {});
}

async function getLeadsProspectadosHoje() {
  const { rows } = await pool.query(`
    SELECT COUNT(*) FROM prospeccao
    WHERE DATE(enviado_em AT TIME ZONE 'America/Fortaleza') = CURRENT_DATE
      AND status = 'enviado'
  `);
  return parseInt(rows[0].count, 10);
}

async function emCooldownDB(cnpj) {
  const cooldownDias = parseInt(process.env.PROSPECCAO_COOLDOWN_DIAS || '30', 10);
  const { rows } = await pool.query(
    `SELECT 1 FROM prospeccao
     WHERE cnpj = $1
       AND enviado_em > NOW() - ($2 || ' days')::INTERVAL
       AND status = 'enviado'`,
    [cnpj, cooldownDias],
  );
  return rows.length > 0;
}

async function encontrarCnpjPorNumeroDB(numero) {
  const numLimpo = numero.replace(/\D/g, '');
  const { rows } = await pool.query(
    `SELECT cnpj FROM prospeccao
     WHERE regexp_replace(numero, '\\D', '', 'g') = $1
     LIMIT 1`,
    [numLimpo],
  );
  return rows[0]?.cnpj || null;
}

async function getStats() {
  const { rows: leads } = await pool.query('SELECT * FROM leads');
  const cache = await pool.query('SELECT * FROM enrichment_cache');

  // Recurso simplificado para manter compatibilidade exata com o frontend atual
  let totalEnriquecidos = cache.rows.length;
  let totalEnriquecidosExpirados = 0; // Para simplificar

  const stats = {
    total: leads.length,
    scoreMedio: 0,
    scoreComercialMedio: 0,
    porClassificacao: {},
    porSegmento: {},
    porConsciencia: {},
    porViabilidade: {},
    porCanal: {},
    porDor: {},
    porObjetivo: {},
    porSegmentoPrioritario: {},
    porRecorrencia: {},
    porOferta: {},
    porPacote: {},
    porPrioridade: {},
    porEtapaFunil: {},
    porGatilho: {},
    porPorte: {},
    comEmail: 0,
    comSite: 0,
    comTelefone: 0,
    topCidades: [],
    totalEnriquecidos,
    totalEnriquecidosExpirados,
    top5: [],
  };

  let scoreTotal = 0;
  let scoreComercialTotal = 0;
  const porCidade = {};

  leads.forEach(l => {
    scoreTotal += l.score || 0;
    scoreComercialTotal += l.score_comercial || 0;

    stats.porClassificacao[l.classificacao] = (stats.porClassificacao[l.classificacao] || 0) + 1;
    stats.porSegmento[l.segmento] = (stats.porSegmento[l.segmento] || 0) + 1;
    stats.porConsciencia[l.consciencia] = (stats.porConsciencia[l.consciencia] || 0) + 1;
    stats.porViabilidade[l.viabilidade] = (stats.porViabilidade[l.viabilidade] || 0) + 1;
    stats.porCanal[l.canal_preferencial] = (stats.porCanal[l.canal_preferencial] || 0) + 1;
    stats.porDor[l.dor_principal] = (stats.porDor[l.dor_principal] || 0) + 1;
    stats.porObjetivo[l.objetivo_curto_prazo] = (stats.porObjetivo[l.objetivo_curto_prazo] || 0) + 1;
    stats.porSegmentoPrioritario[l.segmento_prioritario] = (stats.porSegmentoPrioritario[l.segmento_prioritario] || 0) + 1;
    stats.porRecorrencia[l.potencial_recorrencia] = (stats.porRecorrencia[l.potencial_recorrencia] || 0) + 1;
    stats.porOferta[l.oferta_principal] = (stats.porOferta[l.oferta_principal] || 0) + 1;
    stats.porPacote[l.pacote_sugerido] = (stats.porPacote[l.pacote_sugerido] || 0) + 1;
    stats.porPrioridade[l.prioridade_comercial] = (stats.porPrioridade[l.prioridade_comercial] || 0) + 1;
    stats.porEtapaFunil[l.etapa_funil] = (stats.porEtapaFunil[l.etapa_funil] || 0) + 1;
    
    const p = l.porte || 'Não informado';
    stats.porPorte[p] = (stats.porPorte[p] || 0) + 1;

    if (l.cidade) porCidade[l.cidade] = (porCidade[l.cidade] || 0) + 1;
    if (l.email && l.email.includes('@')) stats.comEmail++;
    if (l.site && l.site.length > 4) stats.comSite++;
    if (l.telefone1 && l.telefone1.replace(/\\D/g, '').length >= 8) stats.comTelefone++;
    
    if (l.gatilhos_detectados) {
      l.gatilhos_detectados.forEach(g => stats.porGatilho[g] = (stats.porGatilho[g] || 0) + 1);
    }
  });

  stats.scoreMedio = leads.length ? Math.round(scoreTotal / leads.length) : 0;
  stats.scoreComercialMedio = leads.length ? Math.round(scoreComercialTotal / leads.length) : 0;

  stats.topCidades = Object.entries(porCidade)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cidade, count]) => ({ cidade, count }));

  stats.top5 = leads
    .sort((a, b) => (b.score_comercial || 0) - (a.score_comercial || 0))
    .slice(0, 5)
    .map(dbLeadToObj)
    .map(l => ({
      cnpj: l.cnpj, razao: l.razao, fantasia: l.fantasia,
      segmento: l.segmento, score: l.score, classificacao: l.classificacao,
      cidade: l.cidade, email: l.email, telefone1: l.telefone1,
    }));

  return stats;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dbLeadToObj(row) {
  if (!row) return null;
  return {
    cnpj: row.cnpj,
    razao: row.razao,
    fantasia: row.fantasia,
    cidade: row.cidade,
    uf: row.uf,
    telefone1: row.telefone1,
    telefone2: row.telefone2,
    email: row.email,
    site: row.site,
    cnae: row.cnae,
    porte: row.porte,
    situacao: row.situacao,
    faturamento: row.faturamento,
    segmento: row.segmento,
    classificacao: row.classificacao,
    score: row.score,
    scoreFitSA: row.score_fit_sa,
    scoreTerritorial: row.score_territorial,
    scoreComercial: row.score_comercial,
    consciencia: row.consciencia,
    canalPreferencial: row.canal_preferencial,
    viabilidade: row.viabilidade,
    dorPrincipal: row.dor_principal,
    objetivoCurtoPrazo: row.objetivo_curto_prazo,
    segmentoPrioritario: row.segmento_prioritario,
    potencialRecorrencia: row.potencial_recorrencia,
    ofertaPrincipal: row.oferta_principal,
    pacoteSugerido: row.pacote_sugerido,
    gatilhosDetectados: row.gatilhos_detectados || [],
    prioridadeComercial: row.prioridade_comercial,
    etapaFunil: row.etapa_funil,
    proximoPasso: row.proximo_passo,
    discursoConsultivo: row.discurso_consultivo,
    fonte: row.fonte,
    enrichment: row.enrichment,
    prospectadoEm: row.prospectado_em,
    ultimaInteracaoEm: row.ultima_interacao_em,
  };
}

module.exports = {
  pool,
  init,
  // leads
  upsertLead,
  updateLeadEmbedding,
  getLeadByCnpj,
  getLeadByNumero,
  queryLeads,
  findSimilarLeads,
  getLeadsCount,
  dbLeadToObj,
  // conversas
  saveConversa,
  getHistoricoConversa,
  // enrichment
  getEnrichment,
  saveEnrichment,
  // prospecção
  getProspeccao,
  getAllProspeccoes,
  saveProspeccaoDB,
  getLeadsProspectadosHoje,
  emCooldownDB,
  encontrarCnpjPorNumeroDB,
  // analytics
  getStats,
};
