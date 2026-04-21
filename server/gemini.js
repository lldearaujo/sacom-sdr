'use strict';

const rag = require('./rag');
const { trunc } = require('./token-utils');
const aiObs = require('./ai-observability');

// No novo fluxo RAG + Banco de Dados, a lógica agora passa pela engine RAG.
// Vamos manter os mapeamentos compatíveis com o resto do código.

async function processarRespostaLead(lead, mensagemDoLead) {
  const traceId = aiObs.startTrace({
    flow: 'whatsapp_rag_response',
    channel: 'whatsapp',
    leadCnpj: lead && lead.cnpj,
    leadName: lead && (lead.fantasia || lead.razao),
    inputPreview: typeof mensagemDoLead === 'string' ? mensagemDoLead : (mensagemDoLead?.text || ''),
  });
  aiObs.addStep(traceId, { stage: 'rag', status: 'running', message: 'Processando mensagem com contexto RAG.' });
  try {
    // Passa para a nova engine RAG que já gerencia contexto e histórico (Redis/PG)
    const result = await rag.processarMensagemRAG(lead, mensagemDoLead, { traceId });
    aiObs.finishTrace(traceId, {
      status: 'ok',
      outputPreview: result && result.resposta,
    });
    return result;
  } catch (err) {
    aiObs.finishTrace(traceId, {
      status: 'error',
      error: err && err.message,
    });
    throw err;
  }
}

// ─── Gera mensagem de prospecção inicial personalizada com IA ─────────────────
async function gerarMensagemProspeccao(lead) {
  const traceId = aiObs.startTrace({
    flow: 'prospeccao_mensagem',
    channel: 'whatsapp',
    leadCnpj: lead && lead.cnpj,
    leadName: lead && (lead.fantasia || lead.razao),
    inputPreview: `Lead ${lead?.cnpj || ''} ${lead?.fantasia || lead?.razao || ''}`,
  });
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

  aiObs.addStep(traceId, { stage: 'gemini_generate', status: 'running', message: 'Gerando mensagem inicial de prospecção.' });
  try {
    const result = await model.generateContent(prompt);
    const message = result.response.text().trim();
    aiObs.finishTrace(traceId, { status: 'ok', outputPreview: message });
    return message;
  } catch (err) {
    aiObs.finishTrace(traceId, { status: 'error', error: err && err.message });
    throw err;
  }
}

async function analisarLeadsComIA(leads) {
  const traceId = aiObs.startTrace({
    flow: 'insights_estrategicos',
    channel: 'dashboard',
    inputPreview: `Analise de ${Array.isArray(leads) ? leads.length : 0} leads.`,
  });
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

  aiObs.addStep(traceId, { stage: 'gemini_insights', status: 'running', message: 'Gerando insights estratégicos.' });
  try {
    const result = await model.generateContent(prompt);
    const texto = result.response.text().trim();

    try {
      const parsed = JSON.parse(texto);
      aiObs.finishTrace(traceId, { status: 'ok', outputPreview: JSON.stringify(parsed) });
      return parsed;
    } catch {
      const match = texto.match(/\{[\s\S]+\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          aiObs.finishTrace(traceId, { status: 'ok', outputPreview: JSON.stringify(parsed) });
          return parsed;
        } catch { /* ignora */ }
      }
      const fallback = { raw: texto, erro: 'Falha ao parsear JSON do Gemini' };
      aiObs.finishTrace(traceId, { status: 'fallback', outputPreview: texto, fallbackUsed: true, error: fallback.erro });
      return fallback;
    }
  } catch (err) {
    aiObs.finishTrace(traceId, { status: 'error', error: err && err.message });
    throw err;
  }
}

module.exports = {
  processarRespostaLead,
  gerarMensagemProspeccao,
  analisarLeadsComIA,
};
