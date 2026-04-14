'use strict';

const rag = require('./rag');
const { trunc } = require('./token-utils');

// No novo fluxo RAG + Banco de Dados, a lógica agora passa pela engine RAG.
// Vamos manter os mapeamentos compatíveis com o resto do código.

async function processarRespostaLead(lead, mensagemDoLead) {
  // Passa para a nova engine RAG que já gerencia contexto e histórico (Redis/PG)
  return await rag.processarMensagemRAG(lead, mensagemDoLead);
}

// ─── Gera mensagem de prospecção inicial personalizada com IA ─────────────────
async function gerarMensagemProspeccao(lead) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.85,
      maxOutputTokens: parseInt(process.env.GEMINI_PROSPECCAO_MAX_TOKENS || '320', 10),
    },
  });

  const agente = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const prompt = `${agente} · SA Comunicação (Cajazeiras/PB) · DOOH/outdoor/rádio/digital.

Primeiro contato WhatsApp (máx. 5 linhas, tom humano, 1 pergunta no fim, 2 emojis no máx., sem clichês de spam):
Empresa: ${trunc(lead.fantasia || lead.razao, 80)} | ${trunc(lead.cidade, 40)}
CNAE: ${trunc(lead.cnae, 80)}
Dor: ${trunc(lead.dor_principal || lead.dorPrincipal, 120)}
Oferta: ${trunc(lead.oferta_principal || lead.ofertaPrincipal, 120)}
Pitch: ${trunc(lead.discurso_consultivo || lead.discursoConsultivo, 200)}
Assinar: ${agente} — SA Comunicação.`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function analisarLeadsComIA(leads) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: parseInt(process.env.GEMINI_INSIGHTS_MAX_TOKENS || '560', 10),
    },
  });

  const maxLeads = parseInt(process.env.GEMINI_INSIGHTS_MAX_LEADS || '22', 10);
  const resumo = leads.slice(0, maxLeads).map((l) =>
    `${String(l.razao || '').slice(0, 50)}|${String(l.cidade || '').slice(0, 24)}|${l.score_comercial || l.scoreComercial}|${l.classificacao}|${String(l.segmento_prioritario || l.segmentoPrioritario || '').slice(0, 40)}`
  ).join('\n');

  const prompt = `SA Comunicação OOH/DOOH Cajazeiras/PB. JSON puro (sem markdown):
{"melhores_segmentos":["","",""],"cidade_prioridade":"","total_hot":0,"total_warm":0,"gatilho_sazonal":null,"recomendacao_estrategica":"","alerta":null}
Leads:
${resumo}`;

  const result = await model.generateContent(prompt);
  const texto = result.response.text().trim();

  try {
    return JSON.parse(texto);
  } catch {
    const match = texto.match(/\{[\s\S]+\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignora */ }
    }
    return { raw: texto, erro: 'Falha ao parsear JSON do Gemini' };
  }
}

module.exports = {
  processarRespostaLead,
  gerarMensagemProspeccao,
  analisarLeadsComIA,
};
