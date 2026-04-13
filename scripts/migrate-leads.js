'use strict';

require('dotenv').config();

// Sobrescreve chamadas locais para usar a porta externa do Easypanel em vez do DNS interno do Docker
if (process.env.DATABASE_URL_EXTERNAL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_EXTERNAL;
}
if (process.env.REDIS_URL_EXTERNAL) {
  process.env.REDIS_URL = process.env.REDIS_URL_EXTERNAL;
}

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const iconv = require('iconv-lite');

// Para utilizar funções antigas de server.js que calculavam scores.
// Como server.js não exporta isso de forma limpa, vamos re-implementar ou ler via db.js se pudermos.
// No nosso caso o cálculo estava no processo antigo. Eu vou trazer as regras principais para cá.
// Para facilitar, a migração lê e classifica como server.js fazia, então vou extrair a lógica.

const db = require('../server/db');
const rag = require('../server/rag');

const FONTES_DIR = path.join(__dirname, '..', 'Fontes');

// ─── LÓGICA DE CLASSIFICAÇÃO (COPIADA DE SERVER.JS) ─────────────────────────
const FILE_SEGMENT_MAP = {
  'Grandes Agencias Fortaleza.csv': { segmento: 'Grandes Agências – Fortaleza', score: 45 },
  'Grandes Agencias Recife.csv': { segmento: 'Grandes Agências – Recife', score: 45 },
  'Grandes Agencias Salvador.csv': { segmento: 'Grandes Agências – Salvador', score: 45 },
  'Agencias João Pessoa.csv': { segmento: 'Agências – João Pessoa', score: 40 },
  'Agencias Paraíba.csv': { segmento: 'Agências – Paraíba', score: 40 },
  'Agencias Juazeiro.csv': { segmento: 'Agências – Juazeiro', score: 35 },
  'Conscessionárias Cajazeiars, Sousa e Pombal.csv': { segmento: 'Concessionárias – CZ/Sousa', score: 35 },
  'Conscessionárias Juazeiro e Crato.csv': { segmento: 'Concessionárias – Juazeiro', score: 35 },
  'Empresas - Médicos - Cajazeiras.csv': { segmento: 'Saúde – Médicos CZ', score: 30 },
  'Dentistas - Cajazeiras.csv': { segmento: 'Saúde – Dentistas CZ', score: 30 },
  'Empresas - Todas as atividades voltadas a saúde - Cajazeiras.csv': { segmento: 'Saúde – Geral CZ', score: 25 },
  'Empresas SJP.csv': { segmento: 'Empresas – SJP', score: 20 },
  'Todos os CNPJs de Cajazeiras.csv': { segmento: 'Base Geral – Cajazeiras', score: 15 },
  'exportacao-empresaqui-05012026-143759-0007139229-0000315496.csv': { segmento: 'Base Geral – Cajazeiras', score: 15 },
  'MEIs - SJP.csv': { segmento: 'MEIs – SJP', score: 5 },
};

function scoreCNAE(texto) {
  if (!texto) return 3;
  const t = texto.toLowerCase();
  if (/publicidade|marketing|propaganda|agência|agencia|comunicaç|mídia|midia/.test(t)) return 20;
  if (/veículos|veiculos|automóveis|automoveis|concession|moto/.test(t)) return 15;
  if (/saúde|saude|médico|medico|dentista|odonto|clínica|clinica|hospital|farmácia|farma/.test(t)) return 15;
  if (/educaç|educac|ensino|faculdade|escola|curso|colégio|colegio|universidade/.test(t)) return 12;
  if (/supermercado|mercearia|hipermercado|alimentaç|alimentac|restaurante|padaria/.test(t)) return 12;
  if (/comércio|comercio|loja|moda|vestuário|vestuario|calçado|calcado|varejista/.test(t)) return 10;
  if (/banco|financ|seguro|crédito|credito|fintech|capitaliz/.test(t)) return 10;
  if (/imobil|constru|incorpora|loteamento/.test(t)) return 8;
  return 3;
}
function scorePorte(porte) {
  if (!porte) return 0;
  const p = porte.toUpperCase();
  if (p.includes('GRANDE') || p.includes('DEMAIS')) return 20;
  if (p.includes('MÉDIA') || p.includes('MEDIA')) return 15;
  if (p.includes('MICRO')) return 8;
  if (p.includes('MEI')) return 3;
  return 5;
}
function scoreFaturamento(fat) {
  if (!fat) return 0;
  if (fat.includes('3.600.001') || /acima/i.test(fat)) return 20;
  if (fat.includes('3.600.000')) return 20;
  if (fat.includes('360.0')) return 15;
  if (fat.includes('81.00') && fat.includes('360')) return 10;
  if (fat.includes('81.001') || fat.includes('78.')) return 10;
  return 3;
}
function scoreContatos(row) {
  let s = 0;
  if (row['E-mail'] && row['E-mail'].trim() && row['E-mail'].includes('@')) s += 10;
  if (row['Site'] && row['Site'].trim() && row['Site'].length > 4) s += 8;
  if (row['Telefone 1'] && row['Telefone 1'].trim().replace(/\\D/g, '').length >= 8) s += 8;
  if (row['Telefone 2'] && row['Telefone 2'].trim().replace(/\\D/g, '').length >= 8) s += 4;
  return s;
}
function scoreSaude(row) {
  let s = 0;
  const sit = (row['Situação Cad.'] || row['Situa??o Cad.'] || '').toUpperCase();
  if (sit.includes('ATIVA')) s += 15;
  const dividas = (row['Total Dívidas'] || row['Total D?vidas'] || row['Dívidas Federais Ativas'] || '').trim();
  if (!dividas || dividas === 'R$' || dividas === '') s += 10;
  else if (parseFloat(dividas.replace(/[^\\d,]/g, '').replace(',', '.')) > 0) s -= 20;
  return s;
}
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

function processarRow(row, fname, segInfo) {
  const cnpj = (row['CNPJ'] || '').trim();
  if (!cnpj || cnpj.length < 14) return null;

  const score = segInfo.score + scoreCNAE(row['Texto CNAE Principal']) + scorePorte(row['Porte Empresa'] || row['Porte da Empresa'] || '') + scoreFaturamento(row['Faturamento Estimado'] || '') + scoreContatos(row) + scoreSaude(row);

  const classificacao = classificar(score);
  const canalPreferencial = (row['E-mail'] && row['E-mail'].includes('@')) ? 'Email' : 'Telefone';
  const cnae = (row['Texto CNAE Principal'] || '').trim();
  const dorPrincipal = /saúde|medico|dentista/i.test(cnae) ? 'Ganhar autoridade e confianca local' : 'Atrair mais clientes para loja';
  const oferta = /saúde|medico/i.test(cnae) ? 'OOH Institucional' : 'OOH + Radio Centro';

  return {
    cnpj,
    razao: (row['Razão'] || row['Raz?o'] || '').trim(),
    fantasia: (row['Fantasia'] || '').trim(),
    cidade: (row['Cidade'] || '').trim(),
    uf: (row['UF'] || '').trim(),
    telefone1: (row['Telefone 1'] || '').trim(),
    telefone2: (row['Telefone 2'] || '').trim(),
    email: (row['E-mail'] || '').trim(),
    site: (row['Site'] || '').trim(),
    cnae,
    porte: (row['Porte Empresa'] || row['Porte da Empresa'] || '').trim(),
    situacao: (row['Situação Cad.'] || row['Situa??o Cad.'] || '').trim(),
    faturamento: (row['Faturamento Estimado'] || '').trim(),
    segmento: segInfo.segmento,
    fonte: fname,
    score,
    scoreComercial: score + 15, // Aproximação pra migração rápida
    classificacao,
    consciencia: inferirConsciencia(classificacao),
    canalPreferencial,
    viabilidade: score > 50 ? 'Media' : 'Baixa',
    dorPrincipal,
    objetivoCurtoPrazo: 'Aumentar vendas',
    segmentoPrioritario: 'Varejo',
    potencialRecorrencia: 'Media',
    ofertaPrincipal: oferta,
    pacoteSugerido: 'Plano Presença',
    prioridadeComercial: score > 70 ? 'Alta Prioridade' : 'Baixa Prioridade',
    etapaFunil: 'Mapeamento de Mercado',
    proximoPasso: 'Iniciar contato',
    discursoConsultivo: 'Sustentar fluxo constante',
    gatilhosDetectados: ['Janela sazonal'],
  };
}

async function migrate() {
  console.log('Iniciando migração dos Leads para o PostgreSQL...');
  await db.init();

  const csvFiles = fs.readdirSync(FONTES_DIR).filter(f => f.endsWith('.csv'));
  const leadsMap = new Map();

  for (const fname of csvFiles) {
    const fpath = path.join(FONTES_DIR, fname);
    const buffer = fs.readFileSync(fpath);
    const raw = iconv.decode(buffer, 'iso-8859-1');
    const content = raw.split('\\n').filter(line => !line.trimStart().startsWith('<') && !line.trimStart().startsWith('\\u0000')).join('\\n');

    let rows;
    try {
      rows = parse(content, { delimiter: ';', columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, bom: true });
    } catch (e) {
      console.warn(`Erro ao parsear ${fname}:`, e.message);
      continue;
    }

    const segInfo = FILE_SEGMENT_MAP[fname] || { segmento: 'Outros', score: 10 };

    for (const row of rows) {
      const lead = processarRow(row, fname, segInfo);
      if (lead) {
        if (!leadsMap.has(lead.cnpj) || leadsMap.get(lead.cnpj).scoreComercial < lead.scoreComercial) {
          leadsMap.set(lead.cnpj, lead);
        }
      }
    }
  }

  const leadsUnicos = Array.from(leadsMap.values());
  console.log(`Encontrados ${leadsUnicos.length} leads únicos. Iniciando inserções...`);

  let convertidos = 0;
  for (const lead of leadsUnicos) {
    convertidos++;

    lead.perfilTexto = `Empresa: ${lead.fantasia || lead.razao}. Segmento: ${lead.segmento}. Cidade: ${lead.cidade}. CNAE: ${lead.cnae}. Dor: ${lead.dorPrincipal}. Oferta: ${lead.ofertaPrincipal}`;

    try {
      await db.upsertLead(lead);

      // Gera o embedding e salva com retry de segurança para limites da API
      let embedding = null;
      let tentativas = 0;
      while (tentativas < 3 && !embedding) {
        try {
          embedding = await rag.getEmbedding(lead.perfilTexto);
        } catch (err) {
          if (err.status === 429 || err.message.includes('429')) {
             console.warn(`[429] Rate limit atingido no CNPJ ${lead.cnpj}. Aguardando 10s...`);
             await new Promise(r => setTimeout(r, 10000));
             tentativas++;
          } else {
             throw err;
          }
        }
      }

      if (embedding) {
        await db.updateLeadEmbedding(lead.cnpj, embedding);
      }

      if (convertidos % 50 === 0) {
        console.log(`Progresso: ${convertidos} / ${leadsUnicos.length}`);
      }
    } catch (e) {
      console.error(`Erro ao upsertar/embeddar cnpj ${lead.cnpj}:`, e.message);
    }
  }

  console.log('Migração concluída com sucesso!');
  process.exit(0);
}

migrate();
