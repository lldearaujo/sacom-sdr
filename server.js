const express = require('express');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');
require('dotenv').config();

// ─── Módulos de IA e WhatsApp ─────────────────────────────────────────────────
const gemini   = require('./server/gemini');
const whatsapp = require('./server/whatsapp');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const FONTES_DIR = path.join(__dirname, 'Fontes');
const CACHE_DIR = path.join(__dirname, '.cache');
const ENRICHMENT_CACHE_FILE = path.join(CACHE_DIR, 'lead-enrichment.json');
const ENRICHMENT_TTL_HOURS = Number.parseInt(process.env.ENRICHMENT_TTL_HOURS || '168', 10);
const MAX_ENRICHMENTS_PER_REQUEST = Number.parseInt(process.env.MAX_ENRICHMENTS_PER_REQUEST || '20', 10);
const MAX_ENRICHMENT_CONCURRENCY = Number.parseInt(process.env.MAX_ENRICHMENT_CONCURRENCY || '4', 10);
const ENRICHMENT_DOMAIN_COOLDOWN_MS = Number.parseInt(process.env.ENRICHMENT_DOMAIN_COOLDOWN_MS || '600', 10);
const ENRICHMENT_FETCH_TIMEOUT_MS = Number.parseInt(process.env.ENRICHMENT_FETCH_TIMEOUT_MS || '4000', 10);

let enrichmentCache = null;
const domainThrottleState = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// ─── Mapeamento de arquivos → segmento e score base ─────────────────────────
const FILE_SEGMENT_MAP = {
  'Grandes Agencias Fortaleza.csv':                              { segmento: 'Grandes Agências – Fortaleza',  score: 45 },
  'Grandes Agencias Recife.csv':                                 { segmento: 'Grandes Agências – Recife',     score: 45 },
  'Grandes Agencias Salvador.csv':                               { segmento: 'Grandes Agências – Salvador',   score: 45 },
  'Agencias João Pessoa.csv':                                    { segmento: 'Agências – João Pessoa',        score: 40 },
  'Agencias Paraíba.csv':                                        { segmento: 'Agências – Paraíba',            score: 40 },
  'Agencias Juazeiro.csv':                                       { segmento: 'Agências – Juazeiro',           score: 35 },
  'Conscessionárias Cajazeiars, Sousa e Pombal.csv':             { segmento: 'Concessionárias – CZ/Sousa',   score: 35 },
  'Conscessionárias Juazeiro e Crato.csv':                       { segmento: 'Concessionárias – Juazeiro',   score: 35 },
  'Empresas - Médicos - Cajazeiras.csv':                         { segmento: 'Saúde – Médicos CZ',           score: 30 },
  'Dentistas - Cajazeiras.csv':                                  { segmento: 'Saúde – Dentistas CZ',         score: 30 },
  'Empresas - Todas as atividades voltadas a saúde - Cajazeiras.csv': { segmento: 'Saúde – Geral CZ',       score: 25 },
  'Empresas SJP.csv':                                            { segmento: 'Empresas – SJP',               score: 20 },
  'Todos os CNPJs de Cajazeiras.csv':                            { segmento: 'Base Geral – Cajazeiras',      score: 15 },
  'exportacao-empresaqui-05012026-143759-0007139229-0000315496.csv': { segmento: 'Base Geral – Cajazeiras',  score: 15 },
  'MEIs - SJP.csv':                                              { segmento: 'MEIs – SJP',                   score: 5  },
};

// ─── Bônus por CNAE (keywords no Texto CNAE Principal) ──────────────────────
function scoreCNAE(texto) {
  if (!texto) return 3;
  const t = texto.toLowerCase();
  if (/publicidade|marketing|propaganda|agência|agencia|comunicaç|mídia|midia/.test(t))   return 20;
  if (/veículos|veiculos|automóveis|automoveis|concession|moto/.test(t))                  return 15;
  if (/saúde|saude|médico|medico|dentista|odonto|clínica|clinica|hospital|farmácia|farma/.test(t)) return 15;
  if (/educaç|educac|ensino|faculdade|escola|curso|colégio|colegio|universidade/.test(t)) return 12;
  if (/supermercado|mercearia|hipermercado|alimentaç|alimentac|restaurante|padaria/.test(t)) return 12;
  if (/comércio|comercio|loja|moda|vestuário|vestuario|calçado|calcado|varejista/.test(t)) return 10;
  if (/banco|financ|seguro|crédito|credito|fintech|capitaliz/.test(t))                    return 10;
  if (/imobil|constru|incorpora|loteamento/.test(t))                                      return 8;
  return 3;
}

// ─── Bônus por Porte da Empresa ─────────────────────────────────────────────
function scorePorte(porte) {
  if (!porte) return 0;
  const p = porte.toUpperCase();
  if (p.includes('GRANDE') || p.includes('DEMAIS')) return 20;
  if (p.includes('MÉDIA') || p.includes('MEDIA'))    return 15;
  if (p.includes('MICRO'))                           return 8;
  if (p.includes('MEI'))                             return 3;
  return 5;
}

// ─── Score de Faturamento ────────────────────────────────────────────────────
function scoreFaturamento(fat) {
  if (!fat) return 0;
  if (fat.includes('3.600.001') || /acima/i.test(fat)) return 20;
  if (fat.includes('3.600.000'))                        return 20;
  if (fat.includes('360.0'))                            return 15;
  if (fat.includes('81.00') && fat.includes('360'))     return 10;
  if (fat.includes('81.001') || fat.includes('78.'))    return 10;
  return 3;
}

// ─── Score de Contatos ───────────────────────────────────────────────────────
function scoreContatos(row) {
  let s = 0;
  if (row['E-mail'] && row['E-mail'].trim() && row['E-mail'].includes('@')) s += 10;
  if (row['Site']   && row['Site'].trim()   && row['Site'].length > 4)      s += 8;
  if (row['Telefone 1'] && row['Telefone 1'].trim().replace(/\D/g,'').length >= 8) s += 8;
  if (row['Telefone 2'] && row['Telefone 2'].trim().replace(/\D/g,'').length >= 8) s += 4;
  return s;
}

// ─── Score de Saúde Cadastral ─────────────────────────────────────────────────
function scoreSaude(row) {
  let s = 0;
  const sit = (row['Situação Cad.'] || row['Situa??o Cad.'] || '').toUpperCase();
  if (sit.includes('ATIVA')) s += 15;
  const dividas = (row['Total Dívidas'] || row['Total D?vidas'] || row['Dívidas Federais Ativas'] || '').trim();
  if (!dividas || dividas === 'R$' || dividas === '') s += 10;
  else if (parseFloat(dividas.replace(/[^\d,]/g,'').replace(',','.')) > 0) s -= 20;
  return s;
}

// ─── Classificação Final ─────────────────────────────────────────────────────
function classificar(score) {
  if (score >= 90) return '🔴 HOT';
  if (score >= 70) return '🟠 WARM';
  if (score >= 50) return '🟡 MEDIUM';
  if (score >= 30) return '🔵 COOL';
  return '⚪ COLD';
}

function inferirConsciencia(classificacao) {
  if (classificacao.includes('HOT') || classificacao.includes('WARM')) return 'Consciente da Solucao';
  if (classificacao.includes('MEDIUM')) return 'Consciente do Problema';
  return 'Inconsciente';
}

function inferirCanal(row) {
  const temEmail = row.email && row.email.includes('@');
  const temSite = row.site && row.site.length > 4;
  const temTelefone = row.telefone1 && row.telefone1.replace(/\D/g, '').length >= 8;

  if (temEmail && temSite) return 'Digital (Site + Email)';
  if (temEmail) return 'Email';
  if (temTelefone) return 'Telefone';
  return 'Dados insuficientes';
}

function inferirViabilidade(lead) {
  const p = (lead.porte || '').toUpperCase();
  const fat = (lead.faturamento || '').toUpperCase();
  if (
    p.includes('GRANDE') ||
    p.includes('DEMAIS') ||
    fat.includes('3.600.001') ||
    fat.includes('ACIMA')
  ) return 'Alta';
  if (p.includes('MEDIO') || p.includes('MÉDIA') || fat.includes('3.600.000')) return 'Media';
  return 'Baixa';
}

function inferirDorObjetivo(cnae, segmento) {
  const texto = `${cnae || ''} ${segmento || ''}`.toLowerCase();

  if (/publicidade|marketing|agência|agencia|mídia|midia/.test(texto)) {
    return {
      dorPrincipal: 'Escalar entrega para clientes',
      objetivoCurtoPrazo: 'Aumentar receita por campanha',
    };
  }
  if (/veículo|veiculo|automóv|automov|concession/.test(texto)) {
    return {
      dorPrincipal: 'Gerar fluxo qualificado no ponto',
      objetivoCurtoPrazo: 'Aumentar visitas e test-drives',
    };
  }
  if (/saúde|saude|médico|medico|dentista|odonto|hospital|clínica|clinica/.test(texto)) {
    return {
      dorPrincipal: 'Ganhar autoridade e confianca local',
      objetivoCurtoPrazo: 'Aumentar agendamentos',
    };
  }
  if (/comércio|comercio|loja|varejo|supermercado|restaurante/.test(texto)) {
    return {
      dorPrincipal: 'Atrair mais clientes para loja',
      objetivoCurtoPrazo: 'Elevar vendas no curto prazo',
    };
  }

  return {
    dorPrincipal: 'Melhorar visibilidade da marca',
    objetivoCurtoPrazo: 'Gerar mais oportunidades comerciais',
  };
}

function extrairTextoLead(lead) {
  return `${lead.cnae || ''} ${lead.segmento || ''} ${lead.razao || ''} ${lead.fantasia || ''}`.toLowerCase();
}

function inferirSegmentoPrioritario(lead) {
  const texto = extrairTextoLead(lead);
  if (/supermercado|atacarejo|farm[aá]cia|drogaria|varejo|material de constru|loja de m[oó]veis|moveis/.test(texto)) return 'Varejo';
  if (/cl[ií]nica|clinica|hospital|laborat[oó]rio|laboratorio|odont|m[eé]dico|medico|sa[uú]de|saude/.test(texto)) return 'Saude';
  if (/faculdade|escola|curso|educa[cç][aã]o|universidade|matr[ií]cula/.test(texto)) return 'Educacao';
  if (/concession|revenda|ve[ií]culo|veiculo|autom[oó]vel|automovel|oficina/.test(texto)) return 'Automotivo';
  if (/construtora|imobili[aá]ria|imobiliaria|loteamento|empreendimento|incorpora/.test(texto)) return 'Construcao e Imoveis';
  if (/prefeitura|governo|secretaria|campanha institucional|pol[ií]tic/.test(texto)) return 'Institucional';
  return 'Outros';
}

function scoreFitSA(lead) {
  let score = 0;
  if (['Varejo', 'Saude', 'Educacao', 'Automotivo', 'Construcao e Imoveis', 'Institucional'].includes(lead.segmentoPrioritario)) score += 20;
  if (lead.canalPreferencial === 'Digital (Site + Email)') score += 8;
  if (lead.viabilidade === 'Alta') score += 12;
  if (lead.viabilidade === 'Media') score += 7;
  if (lead.classificacao.includes('HOT') || lead.classificacao.includes('WARM')) score += 10;
  return score;
}

function scoreTerritorial(lead) {
  const cidade = (lead.cidade || '').toUpperCase();
  const cidadesNucleo = ['CAJAZEIRAS', 'SAO JOSE DE PIRANHAS', 'SOUSA', 'POMBAL'];
  const cidadesExpansao = ['PATOS', 'JOAO PESSOA', 'CAMPINA GRANDE', 'JUAZEIRO DO NORTE'];
  let score = 0;
  if (cidadesNucleo.includes(cidade)) score += 15;
  else if (cidadesExpansao.includes(cidade)) score += 8;
  else if (cidade) score += 4;
  if (lead.segmentoPrioritario !== 'Outros') score += 5;
  return score;
}

function inferirPotencialRecorrencia(lead) {
  if (['Varejo', 'Saude', 'Automotivo'].includes(lead.segmentoPrioritario)) return 'Alta';
  if (['Educacao', 'Construcao e Imoveis', 'Institucional'].includes(lead.segmentoPrioritario)) return 'Media';
  return 'Baixa';
}

function inferirOfertaPrincipal(lead) {
  if (lead.segmentoPrioritario === 'Varejo') return 'OOH + Radio Centro';
  if (lead.segmentoPrioritario === 'Saude') return 'OOH Institucional';
  if (lead.segmentoPrioritario === 'Educacao') return 'OOH + DOOH';
  if (lead.segmentoPrioritario === 'Automotivo') return 'OOH + DOOH de Impacto';
  if (lead.segmentoPrioritario === 'Construcao e Imoveis') return 'Dominio Territorial OOH';
  if (lead.segmentoPrioritario === 'Institucional') return 'Campanha Institucional Multicanal';
  return 'Presenca Basica OOH';
}

function inferirPacoteSugerido(lead) {
  if (lead.scoreComercial >= 140 || (lead.viabilidade === 'Alta' && lead.segmentoPrioritario !== 'Outros')) return 'Plano Dominio da Cidade';
  if (lead.scoreComercial >= 110) return 'Plano Impacto';
  return 'Plano Presenca';
}

function inferirGatilhos(lead) {
  const gatilhos = [];
  if (lead.segmentoPrioritario === 'Educacao') gatilhos.push('Janela sazonal de matriculas');
  if (lead.segmentoPrioritario === 'Varejo') gatilhos.push('Promocoes recorrentes e alta concorrencia');
  if (lead.segmentoPrioritario === 'Saude') gatilhos.push('Busca por autoridade e confianca local');
  if (lead.segmentoPrioritario === 'Automotivo') gatilhos.push('Campanhas de condicao especial e lancamentos');
  if (lead.segmentoPrioritario === 'Construcao e Imoveis') gatilhos.push('Campanha de longo prazo para empreendimento');
  if (lead.viabilidade === 'Alta') gatilhos.push('Capacidade de investimento continuo');
  if (!gatilhos.length) gatilhos.push('Necessidade de presenca local');
  return gatilhos;
}

function inferirPrioridadeComercial(scoreComercial) {
  if (scoreComercial >= 145) return 'Prioridade Maxima';
  if (scoreComercial >= 120) return 'Alta Prioridade';
  if (scoreComercial >= 95) return 'Media Prioridade';
  return 'Baixa Prioridade';
}

function inferirEtapaFunil(lead) {
  if (lead.prioridadeComercial === 'Prioridade Maxima') return 'Proposta de Campanha';
  if (lead.prioridadeComercial === 'Alta Prioridade') return 'Apresentacao Estrategica';
  if (lead.prioridadeComercial === 'Media Prioridade') return 'Abordagem Consultiva';
  return 'Mapeamento de Mercado';
}

function inferirProximoPasso(lead) {
  if (lead.pacoteSugerido === 'Plano Dominio da Cidade') return 'Apresentar mapa de territorio com pacote de 60 dias';
  if (lead.pacoteSugerido === 'Plano Impacto') return 'Agendar reuniao para proposta com 3 pecas e reforco em radio';
  return 'Iniciar contato com proposta de entrada e calendario mensal';
}

function inferirDiscursoConsultivo(lead) {
  if (lead.segmentoPrioritario === 'Varejo') return 'Sua marca precisa aparecer toda semana para sustentar fluxo na loja.';
  if (lead.segmentoPrioritario === 'Saude') return 'Presenca urbana recorrente aumenta autoridade e confianca percebida.';
  if (lead.segmentoPrioritario === 'Automotivo') return 'Campanhas de impacto visual aceleram visitas e testes no ponto.';
  return 'Quem domina a presenca visual da cidade tende a liderar a lembranca de marca.';
}

function loadEnrichmentCache() {
  if (enrichmentCache) return enrichmentCache;
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(ENRICHMENT_CACHE_FILE)) {
      enrichmentCache = {};
      fs.writeFileSync(ENRICHMENT_CACHE_FILE, JSON.stringify(enrichmentCache, null, 2), 'utf-8');
      return enrichmentCache;
    }
    const raw = fs.readFileSync(ENRICHMENT_CACHE_FILE, 'utf-8');
    enrichmentCache = raw ? JSON.parse(raw) : {};
    return enrichmentCache;
  } catch (err) {
    console.warn('Falha ao carregar cache de enrichment:', err.message);
    enrichmentCache = {};
    return enrichmentCache;
  }
}

function saveEnrichmentCache() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(ENRICHMENT_CACHE_FILE, JSON.stringify(loadEnrichmentCache(), null, 2), 'utf-8');
  } catch (err) {
    console.warn('Falha ao salvar cache de enrichment:', err.message);
  }
}

function isEnrichmentExpirado(entry) {
  if (!entry || !entry.atualizadoEm) return true;
  const atualizadoMs = Date.parse(entry.atualizadoEm);
  if (Number.isNaN(atualizadoMs)) return true;
  const ttlMs = ENRICHMENT_TTL_HOURS * 60 * 60 * 1000;
  return Date.now() - atualizadoMs > ttlMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizarSite(site) {
  if (!site) return null;
  const trimmed = site.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

function extrairDominio(siteUrl) {
  try {
    const url = new URL(siteUrl);
    return url.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return null;
  }
}

async function waitForDomainSlot(dominio) {
  if (!dominio) return;
  while (true) {
    const state = domainThrottleState.get(dominio) || { active: 0, lastFinishedAt: 0 };
    const elapsed = Date.now() - state.lastFinishedAt;
    const cooldownOk = elapsed >= ENRICHMENT_DOMAIN_COOLDOWN_MS;
    if (state.active === 0 && cooldownOk) return;
    await sleep(120);
  }
}

async function withDomainThrottle(siteUrl, action) {
  const dominio = extrairDominio(siteUrl);
  if (!dominio) return action();

  await waitForDomainSlot(dominio);
  const state = domainThrottleState.get(dominio) || { active: 0, lastFinishedAt: 0 };
  state.active += 1;
  domainThrottleState.set(dominio, state);
  try {
    return await action();
  } finally {
    const updated = domainThrottleState.get(dominio) || { active: 1, lastFinishedAt: 0 };
    updated.active = Math.max(0, updated.active - 1);
    updated.lastFinishedAt = Date.now();
    domainThrottleState.set(dominio, updated);
  }
}

async function runWithConcurrency(items, limit, handler) {
  const safeLimit = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  const workers = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      await handler(items[current], current);
    }
  });
  await Promise.allSettled(workers);
}

function extrairSinaisSite(html) {
  const titulo = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  const hasInstagram = /instagram\.com/i.test(html);
  const hasFacebook = /facebook\.com/i.test(html);
  const hasLinkedin = /linkedin\.com/i.test(html);
  const hasWhatsapp = /whatsapp|wa\.me/i.test(html);
  const hasForm = /<form/i.test(html);
  const hasMetaDescription = /<meta[^>]*name=["']description["']/i.test(html);
  return {
    titulo: titulo.trim(),
    hasInstagram,
    hasFacebook,
    hasLinkedin,
    hasWhatsapp,
    hasForm,
    hasMetaDescription,
  };
}

function inferirMaturidadeDigital(sinais) {
  let pontos = 0;
  if (sinais.hasMetaDescription) pontos += 1;
  if (sinais.hasForm) pontos += 1;
  if (sinais.hasInstagram) pontos += 1;
  if (sinais.hasFacebook) pontos += 1;
  if (sinais.hasLinkedin) pontos += 1;
  if (sinais.hasWhatsapp) pontos += 1;
  if (pontos >= 5) return 'Alta';
  if (pontos >= 3) return 'Media';
  return 'Baixa';
}

async function enriquecerLead(lead, options = {}) {
  const { forceRefresh = false } = options;
  const cache = loadEnrichmentCache();
  if (!forceRefresh && cache[lead.cnpj] && !isEnrichmentExpirado(cache[lead.cnpj])) {
    return cache[lead.cnpj];
  }

  const siteUrl = normalizarSite(lead.site);
  if (!siteUrl) {
    const semSite = {
      status: 'sem_site',
      maturidadeDigital: 'Baixa',
      sinais: {},
      fonte: 'cache_enrichment',
      atualizadoEm: new Date().toISOString(),
    };
    cache[lead.cnpj] = semSite;
    saveEnrichmentCache();
    return semSite;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ENRICHMENT_FETCH_TIMEOUT_MS);
  try {
    const res = await withDomainThrottle(siteUrl, () => fetch(siteUrl, { signal: controller.signal }));
    const html = await res.text();
    const sinais = extrairSinaisSite(html);
    const enrichment = {
      status: 'ok',
      siteUrl,
      tituloSite: sinais.titulo || '',
      maturidadeDigital: inferirMaturidadeDigital(sinais),
      sinais,
      fonte: 'fetch_site',
      atualizadoEm: new Date().toISOString(),
    };
    cache[lead.cnpj] = enrichment;
    saveEnrichmentCache();
    return enrichment;
  } catch (err) {
    const fallback = {
      status: 'erro',
      erro: err.message,
      siteUrl,
      maturidadeDigital: 'Nao identificado',
      sinais: {},
      fonte: 'fallback_erro',
      atualizadoEm: new Date().toISOString(),
    };
    cache[lead.cnpj] = fallback;
    saveEnrichmentCache();
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

async function enriquecerLeadsLote(leads, options = {}) {
  const {
    limit = 10,
    forceRefresh = false,
    concurrency = MAX_ENRICHMENT_CONCURRENCY,
  } = options;
  const limiteFinal = Math.max(0, Math.min(Number.parseInt(limit, 10) || 0, MAX_ENRICHMENTS_PER_REQUEST));
  const selecionados = leads.slice(0, limiteFinal);
  if (!selecionados.length) return;
  await runWithConcurrency(selecionados, concurrency, async (lead) => {
    await enriquecerLead(lead, { forceRefresh });
  });
}

// ─── Leitura e processamento de todos os CSVs ───────────────────────────────
function processarLeads() {
  const csvFiles = fs.readdirSync(FONTES_DIR).filter(f => f.endsWith('.csv'));
  const leadsMap = new Map(); // deduplicação por CNPJ

  for (const fname of csvFiles) {
    const fpath = path.join(FONTES_DIR, fname);
    const buffer = fs.readFileSync(fpath);
    const raw = iconv.decode(buffer, 'iso-8859-1');

    // Remove linhas HTML espúrias que os exportadores web inserem no final dos CSVs
    const content = raw
      .split('\n')
      .filter(line => !line.trimStart().startsWith('<') && !line.trimStart().startsWith('\u0000'))
      .join('\n');

    let rows;
    try {
      rows = parse(content, {
        delimiter: ';',
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        bom: true,
      });
    } catch (e) {
      console.warn(`Erro ao parsear ${fname}:`, e.message);
      continue;
    }

    const segInfo = FILE_SEGMENT_MAP[fname] || { segmento: 'Outros', score: 10 };

    for (const row of rows) {
      const cnpj = (row['CNPJ'] || '').trim();
      if (!cnpj || cnpj.length < 14) continue;

      // Score total
      const score =
        segInfo.score +
        scoreCNAE(row['Texto CNAE Principal']) +
        scorePorte(row['Porte Empresa'] || row['Porte da Empresa'] || '') +
        scoreFaturamento(row['Faturamento Estimado'] || '') +
        scoreContatos(row) +
        scoreSaude(row);

      const lead = {
        cnpj,
        razao:      (row['Razão']    || row['Raz?o']    || '').trim(),
        fantasia:   (row['Fantasia'] || '').trim(),
        cidade:     (row['Cidade']   || '').trim(),
        uf:         (row['UF']       || '').trim(),
        telefone1:  (row['Telefone 1'] || '').trim(),
        telefone2:  (row['Telefone 2'] || '').trim(),
        email:      (row['E-mail']    || '').trim(),
        site:       (row['Site']      || '').trim(),
        cnae:       (row['Texto CNAE Principal'] || '').trim(),
        porte:      (row['Porte Empresa'] || row['Porte da Empresa'] || '').trim(),
        situacao:   (row['Situação Cad.'] || row['Situa??o Cad.'] || '').trim(),
        faturamento:(row['Faturamento Estimado'] || '').trim(),
        funcionarios:(row['Quadro de Funcionários'] || row['Quadro de Funcion?rios'] || '').trim(),
        dividas:    (row['Total Dívidas']  || row['Total D?vidas'] || '').trim(),
        segmento:   segInfo.segmento,
        fonte:      fname,
        score,
        classificacao: classificar(score),
      };

      const doresObjetivos = inferirDorObjetivo(lead.cnae, segInfo.segmento);
      lead.consciencia = inferirConsciencia(lead.classificacao);
      lead.canalPreferencial = inferirCanal(lead);
      lead.viabilidade = inferirViabilidade(lead);
      lead.dorPrincipal = doresObjetivos.dorPrincipal;
      lead.objetivoCurtoPrazo = doresObjetivos.objetivoCurtoPrazo;
      lead.segmentoPrioritario = inferirSegmentoPrioritario(lead);
      lead.scoreFitSA = scoreFitSA(lead);
      lead.scoreTerritorial = scoreTerritorial(lead);
      lead.scoreComercial = lead.score + lead.scoreFitSA + lead.scoreTerritorial;
      lead.potencialRecorrencia = inferirPotencialRecorrencia(lead);
      lead.ofertaPrincipal = inferirOfertaPrincipal(lead);
      lead.pacoteSugerido = inferirPacoteSugerido(lead);
      lead.gatilhosDetectados = inferirGatilhos(lead);
      lead.prioridadeComercial = inferirPrioridadeComercial(lead.scoreComercial);
      lead.etapaFunil = inferirEtapaFunil(lead);
      lead.proximoPasso = inferirProximoPasso(lead);
      lead.discursoConsultivo = inferirDiscursoConsultivo(lead);

      // Deduplicação: mantém o de maior score
      if (!leadsMap.has(cnpj) || leadsMap.get(cnpj).scoreComercial < lead.scoreComercial) {
        leadsMap.set(cnpj, lead);
      }
    }
  }

  return Array.from(leadsMap.values()).sort((a, b) => b.scoreComercial - a.scoreComercial);
}

// ─── Cache dos leads ──────────────────────────────────────────────────────────
let cachedLeads = null;
function getLeads() {
  if (!cachedLeads) {
    console.log('Processando leads...');
    cachedLeads = processarLeads();
    console.log(`Total de leads únicos: ${cachedLeads.length}`);
  }
  return cachedLeads;
}

// ─── APIs ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/leads', async (req, res) => {
  const leads = getLeads();
  const {
    classificacao,
    segmento,
    cidade,
    search,
    porte,
    consciencia,
    viabilidade,
    canal,
    dor,
    objetivo,
    segmento_prioritario,
    recorrencia,
    oferta,
    pacote,
    prioridade,
    etapa_funil,
    gatilho,
    order_by = 'score_comercial',
    include_enrichment,
    force_refresh,
    enrich_limit,
    enrich_concurrency,
    page = 1,
    limit = 50,
  } = req.query;

  let filtered = leads;
  if (classificacao) filtered = filtered.filter(l => l.classificacao === classificacao);
  if (segmento)      filtered = filtered.filter(l => l.segmento === segmento);
  if (cidade)        filtered = filtered.filter(l => l.cidade.toLowerCase().includes(cidade.toLowerCase()));
  if (porte)         filtered = filtered.filter(l => (l.porte || '').toLowerCase().includes(porte.toLowerCase()));
  if (consciencia)   filtered = filtered.filter(l => l.consciencia === consciencia);
  if (viabilidade)   filtered = filtered.filter(l => l.viabilidade === viabilidade);
  if (canal)         filtered = filtered.filter(l => l.canalPreferencial === canal);
  if (dor)           filtered = filtered.filter(l => l.dorPrincipal === dor);
  if (objetivo)      filtered = filtered.filter(l => l.objetivoCurtoPrazo === objetivo);
  if (segmento_prioritario) filtered = filtered.filter(l => l.segmentoPrioritario === segmento_prioritario);
  if (recorrencia)   filtered = filtered.filter(l => l.potencialRecorrencia === recorrencia);
  if (oferta)        filtered = filtered.filter(l => l.ofertaPrincipal === oferta);
  if (pacote)        filtered = filtered.filter(l => l.pacoteSugerido === pacote);
  if (prioridade)    filtered = filtered.filter(l => l.prioridadeComercial === prioridade);
  if (etapa_funil)   filtered = filtered.filter(l => l.etapaFunil === etapa_funil);
  if (gatilho)       filtered = filtered.filter(l => l.gatilhosDetectados.includes(gatilho));
  if (search)        filtered = filtered.filter(l =>
    l.razao.toLowerCase().includes(search.toLowerCase()) ||
    l.fantasia.toLowerCase().includes(search.toLowerCase()) ||
    l.cnpj.includes(search) ||
    l.ofertaPrincipal.toLowerCase().includes(search.toLowerCase()) ||
    l.pacoteSugerido.toLowerCase().includes(search.toLowerCase())
  );

  if (order_by === 'score') filtered.sort((a, b) => b.score - a.score);
  else filtered.sort((a, b) => b.scoreComercial - a.scoreComercial);

  const total = filtered.length;
  const start = (parseInt(page) - 1) * parseInt(limit);
  const data  = filtered.slice(start, start + parseInt(limit));
  const shouldIncludeEnrichment = String(include_enrichment || '').toLowerCase() === 'true';
  const shouldForceRefresh = String(force_refresh || '').toLowerCase() === 'true';
  const enrichLimit = Number.parseInt(enrich_limit || String(data.length), 10);

  if (shouldIncludeEnrichment && data.length > 0) {
    const limiteFinal = Math.max(0, Math.min(Number.isNaN(enrichLimit) ? data.length : enrichLimit, data.length, MAX_ENRICHMENTS_PER_REQUEST));
    const concurrency = Number.parseInt(enrich_concurrency || String(MAX_ENRICHMENT_CONCURRENCY), 10);
    const selecionados = data.slice(0, limiteFinal);
    await enriquecerLeadsLote(selecionados, {
      limit: limiteFinal,
      forceRefresh: shouldForceRefresh,
      concurrency: Number.isNaN(concurrency) ? MAX_ENRICHMENT_CONCURRENCY : concurrency,
    });
    const cache = loadEnrichmentCache();
    selecionados.forEach((lead) => {
      lead.enrichment = cache[lead.cnpj] || null;
    });
  }

  res.json({
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    includesEnrichment: shouldIncludeEnrichment,
    enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
    maxEnrichmentConcurrency: MAX_ENRICHMENT_CONCURRENCY,
    data,
  });
});

app.get('/api/leads/:cnpj/enrichment', async (req, res) => {
  const leads = getLeads();
  const { cnpj } = req.params;
  const shouldForceRefresh = String(req.query.force_refresh || '').toLowerCase() === 'true';
  const lead = leads.find((l) => l.cnpj === cnpj);
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' });

  const enrichment = await enriquecerLead(lead, { forceRefresh: shouldForceRefresh });
  return res.json({
    cnpj: lead.cnpj,
    razao: lead.razao,
    fantasia: lead.fantasia,
    forceRefresh: shouldForceRefresh,
    enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
    enrichment,
  });
});

app.get('/api/enrichment/warmup', async (req, res) => {
  const leads = getLeads();
  const shouldForceRefresh = String(req.query.force_refresh || '').toLowerCase() === 'true';
  const limit = Number.parseInt(req.query.limit || '20', 10);
  const concurrency = Number.parseInt(req.query.concurrency || String(MAX_ENRICHMENT_CONCURRENCY), 10);
  const limiteFinal = Math.max(0, Math.min(Number.isNaN(limit) ? 20 : limit, MAX_ENRICHMENTS_PER_REQUEST));
  const concurrencyFinal = Math.max(1, Math.min(Number.isNaN(concurrency) ? MAX_ENRICHMENT_CONCURRENCY : concurrency, MAX_ENRICHMENT_CONCURRENCY));

  const selecionados = leads.slice(0, limiteFinal);
  await enriquecerLeadsLote(selecionados, {
    limit: limiteFinal,
    forceRefresh: shouldForceRefresh,
    concurrency: concurrencyFinal,
  });
  const cache = loadEnrichmentCache();

  return res.json({
    warmed: selecionados.length,
    forceRefresh: shouldForceRefresh,
    enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
    concurrency: concurrencyFinal,
    totalEnriquecidos: Object.keys(cache).length,
  });
});

app.get('/api/stats', (req, res) => {
  const leads = getLeads();

  // Contagem por classificação
  const porClassificacao = {};
  for (const l of leads) {
    porClassificacao[l.classificacao] = (porClassificacao[l.classificacao] || 0) + 1;
  }

  // Contagem por segmento
  const porSegmento = {};
  for (const l of leads) {
    porSegmento[l.segmento] = (porSegmento[l.segmento] || 0) + 1;
  }

  // Distribuição de perfis ICP
  const porConsciencia = {};
  const porViabilidade = {};
  const porCanal = {};
  const porDor = {};
  const porObjetivo = {};
  const porSegmentoPrioritario = {};
  const porRecorrencia = {};
  const porOferta = {};
  const porPacote = {};
  const porPrioridade = {};
  const porEtapaFunil = {};
  const porGatilho = {};
  for (const l of leads) {
    porConsciencia[l.consciencia] = (porConsciencia[l.consciencia] || 0) + 1;
    porViabilidade[l.viabilidade] = (porViabilidade[l.viabilidade] || 0) + 1;
    porCanal[l.canalPreferencial] = (porCanal[l.canalPreferencial] || 0) + 1;
    porDor[l.dorPrincipal] = (porDor[l.dorPrincipal] || 0) + 1;
    porObjetivo[l.objetivoCurtoPrazo] = (porObjetivo[l.objetivoCurtoPrazo] || 0) + 1;
    porSegmentoPrioritario[l.segmentoPrioritario] = (porSegmentoPrioritario[l.segmentoPrioritario] || 0) + 1;
    porRecorrencia[l.potencialRecorrencia] = (porRecorrencia[l.potencialRecorrencia] || 0) + 1;
    porOferta[l.ofertaPrincipal] = (porOferta[l.ofertaPrincipal] || 0) + 1;
    porPacote[l.pacoteSugerido] = (porPacote[l.pacoteSugerido] || 0) + 1;
    porPrioridade[l.prioridadeComercial] = (porPrioridade[l.prioridadeComercial] || 0) + 1;
    porEtapaFunil[l.etapaFunil] = (porEtapaFunil[l.etapaFunil] || 0) + 1;
    for (const gatilho of l.gatilhosDetectados) porGatilho[gatilho] = (porGatilho[gatilho] || 0) + 1;
  }

  // Contagem por cidade (top 10)
  const porCidade = {};
  for (const l of leads) {
    if (l.cidade) porCidade[l.cidade] = (porCidade[l.cidade] || 0) + 1;
  }
  const topCidades = Object.entries(porCidade)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cidade, count]) => ({ cidade, count }));

  // Contagem por porte
  const porPorte = {};
  for (const l of leads) {
    const p = l.porte || 'Não informado';
    porPorte[p] = (porPorte[p] || 0) + 1;
  }

  // Qualidade de contato
  const comEmail    = leads.filter(l => l.email && l.email.includes('@')).length;
  const comSite     = leads.filter(l => l.site && l.site.length > 4).length;
  const comTelefone = leads.filter(l => l.telefone1 && l.telefone1.replace(/\D/g,'').length >= 8).length;

  // Score médio
  const scoreTotal = leads.reduce((s, l) => s + l.score, 0);
  const scoreMedio = leads.length ? Math.round(scoreTotal / leads.length) : 0;
  const scoreComercialTotal = leads.reduce((s, l) => s + l.scoreComercial, 0);
  const scoreComercialMedio = leads.length ? Math.round(scoreComercialTotal / leads.length) : 0;

  const cache = loadEnrichmentCache();
  const totalEnriquecidos = Object.keys(cache).length;
  const totalEnriquecidosExpirados = Object.values(cache).filter(isEnrichmentExpirado).length;

  // Top 5 leads
  const top5 = leads.slice(0, 5).map(l => ({
    cnpj: l.cnpj, razao: l.razao, fantasia: l.fantasia,
    segmento: l.segmento, score: l.score, classificacao: l.classificacao,
    cidade: l.cidade, email: l.email, telefone1: l.telefone1,
  }));

  res.json({
    total: leads.length,
    scoreMedio,
    scoreComercialMedio,
    porClassificacao,
    porSegmento,
    porConsciencia,
    porViabilidade,
    porCanal,
    porDor,
    porObjetivo,
    porSegmentoPrioritario,
    porRecorrencia,
    porOferta,
    porPacote,
    porPrioridade,
    porEtapaFunil,
    porGatilho,
    topCidades,
    porPorte,
    comEmail,
    comSite,
    comTelefone,
    totalEnriquecidos,
    totalEnriquecidosExpirados,
    enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
    maxEnrichmentsPerRequest: MAX_ENRICHMENTS_PER_REQUEST,
    maxEnrichmentConcurrency: MAX_ENRICHMENT_CONCURRENCY,
    enrichmentDomainCooldownMs: ENRICHMENT_DOMAIN_COOLDOWN_MS,
    enrichmentFetchTimeoutMs: ENRICHMENT_FETCH_TIMEOUT_MS,
    top5,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PROSPECÇÃO WHATSAPP + GEMINI AI
// ══════════════════════════════════════════════════════════════════════════════

app.use(express.json());

// ── POST /api/prospeccao/disparar ─────────────────────────────────────────────
// Body: { classificacoes: ['🔴 HOT', '🟠 WARM'], limite: 10, usarIA: true }
app.post('/api/prospeccao/disparar', async (req, res) => {
  try {
    const leads = getLeads();
    const {
      classificacoes = ['🔴 HOT', '🟠 WARM'],
      limite = 10,
      usarIA = true,
    } = req.body || {};

    const selecionados = leads.filter(
      (l) => classificacoes.includes(l.classificacao) && (l.telefone1 || l.telefone2)
    );

    const gerarMensagemFn = usarIA ? gemini.gerarMensagemProspeccao : null;
    const resultado = await whatsapp.dispararLote(selecionados, { limite, gerarMensagemFn });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/prospeccao/status ────────────────────────────────────────────────
app.get('/api/prospeccao/status', (req, res) => {
  try {
    const cache = whatsapp.loadProspeccao();
    const leads = getLeads();

    const entries = Object.entries(cache).map(([cnpj, data]) => {
      const lead = leads.find((l) => l.cnpj === cnpj) || {};
      return {
        cnpj,
        razao:    lead.razao,
        fantasia: lead.fantasia,
        cidade:   lead.cidade,
        segmentoPrioritario: lead.segmentoPrioritario,
        classificacao: lead.classificacao,
        ...data,
      };
    });

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

// ── PUT /api/prospeccao/:cnpj/status ─────────────────────────────────────────
app.put('/api/prospeccao/:cnpj/status', (req, res) => {
  try {
    const cache = whatsapp.loadProspeccao();
    const { cnpj } = req.params;
    const { status, notas } = req.body || {};

    if (!cache[cnpj]) return res.status(404).json({ error: 'CNPJ não encontrado' });

    cache[cnpj].status = status;
    if (notas !== undefined) cache[cnpj].notas = notas;
    if (status === 'convertido') cache[cnpj].convertidoEm = new Date().toISOString();
    whatsapp.saveProspeccao(cache);

    res.json({ ok: true, cnpj, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/prospeccao/:cnpj/historico ───────────────────────────────────────
app.get('/api/prospeccao/:cnpj/historico', (req, res) => {
  try {
    const hist = gemini.getHistoricoConversa(req.params.cnpj);
    if (!hist) return res.status(404).json({ error: 'Sem histórico para este CNPJ' });
    res.json(hist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/prospeccao/webhook  (Z-API on-message-received) ────────────────
app.post('/api/prospeccao/webhook', async (req, res) => {
  // Responde Z-API imediatamente para evitar timeout
  res.json({ ok: true });

  try {
    const payload = req.body;

    // Ignora mensagens enviadas pelo próprio número ou sem texto
    if (!payload?.text?.message || payload.fromMe) return;

    const numero   = (payload.phone || '').replace(/\D/g, '');
    const mensagem = payload.text.message;

    const cache = whatsapp.loadProspeccao();
    const cnpj  = whatsapp.encontrarCnpjPorNumero(numero, cache);
    if (!cnpj) return;

    const leads = getLeads();
    const lead  = leads.find((l) => l.cnpj === cnpj);
    if (!lead) return;

    // 🤖 Gemini processa e gera resposta consultiva
    const { resposta, intent } = await gemini.processarRespostaLead(lead, mensagem);

    // Delay humanizado (2–4s) antes de responder
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

    // Envia resposta via Z-API
    await whatsapp.enviarMensagem(numero, resposta);

    // Atualiza status no cache de prospecção
    cache[cnpj].status        = 'respondido';
    cache[cnpj].respondidoEm  = cache[cnpj].respondidoEm || new Date().toISOString();
    cache[cnpj].ultimaResposta = mensagem;

    if (intent?.interesse) {
      cache[cnpj].intentDetectado = intent;
      cache[cnpj].status = intent.urgencia === 'alta' ? 'oportunidade' : 'respondido';
      console.log(`🔥 OPORTUNIDADE: ${lead.razao} (${lead.cidade}) — ${intent.tipo}`);
    }

    whatsapp.saveProspeccao(cache);
  } catch (err) {
    console.error('Erro no webhook Gemini/Z-API:', err.message);
  }
});

// ── GET /api/ai/insights ──────────────────────────────────────────────────────
app.get('/api/ai/insights', async (req, res) => {
  try {
    const leads    = getLeads();
    const insights = await gemini.analisarLeadsComIA(leads);
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/mensagem-preview/:cnpj ───────────────────────────────────────
// Gera preview da mensagem que seria enviada para um lead específico
app.get('/api/ai/mensagem-preview/:cnpj', async (req, res) => {
  try {
    const leads = getLeads();
    const lead  = leads.find((l) => l.cnpj === req.params.cnpj);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const mensagem = await gemini.gerarMensagemProspeccao(lead);
    res.json({
      cnpj: lead.cnpj,
      razao: lead.razao,
      fantasia: lead.fantasia,
      cidade: lead.cidade,
      mensagem,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ SA Comunicação BDR Dashboard rodando em http://0.0.0.0:${PORT}`);
  console.log(`   🤖 Gemini AI: ${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}`);
  console.log(`   📱 Z-API: ${process.env.ZAPI_INSTANCE_ID ? 'configurada' : 'não configurada (preencha .env)'}\n`);
  // Pré-carrega os leads no início
  getLeads();
});
