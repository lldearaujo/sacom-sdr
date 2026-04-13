'use strict';

const rag = require('./rag');

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
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      temperature: 0.85,
    },
  });

  const agente = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const prompt = `Você é ${agente}, consultora da SA Comunicação, agência de publicidade de Cajazeiras/PB.
A SA tem 11 anos de mercado (fundada em 2015) e é a única agência do alto sertão paraibano com o mix completo:
Painel de LED (DOOH), Outdoor, Rádio Centro e Marketing Digital.

Escreva uma mensagem de WhatsApp de PRIMEIRO CONTATO para prospecção:
- Empresa: ${lead.fantasia || lead.razao}
- Cidade: ${lead.cidade}
- Segmento/atividade: ${lead.cnae}
- Dor identificada: ${lead.dor_principal || lead.dorPrincipal || ''}
- Oferta adequada: ${lead.oferta_principal || lead.ofertaPrincipal || ''}
- Frase consultiva base: "${lead.discurso_consultivo || lead.discursoConsultivo || ''}"

REGRAS OBRIGATÓRIAS:
1. Máximo 5 linhas curtas — tom de WhatsApp real, não de e-mail comercial
2. Mencione Cajazeiras ou a cidade do lead para gerar identificação
3. Seja consultivo, não vendedor — mostre que entende o negócio deles
4. Termine com UMA pergunta aberta e simples
5. NÃO use: "incrível oportunidade", "oferta exclusiva", "não perca", clichês de spam
6. Use no máximo 2 emojis
7. Varie o início — não comece sempre com "Olá"
8. Assine como ${agente} — SA Comunicação (apenas na primeira mensagem)`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function analisarLeadsComIA(leads) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: { temperature: 0.3 },
  });

  const resumo = leads.slice(0, 30).map(l =>
    `${l.razao} | ${l.cidade} | ${l.cnae} | Score: ${l.score_comercial || l.scoreComercial} | ${l.classificacao} | ${l.segmento_prioritario || l.segmentoPrioritario}`
  ).join('\n');

  const prompt = `Analise esta lista de leads da SA Comunicação (agência OOH/DOOH, Cajazeiras/PB, 11 anos).
Retorne APENAS um JSON válido (sem markdown, sem \`\`\`), com:
{
  "melhores_segmentos": ["seg1", "seg2", "seg3"],
  "cidade_prioridade": "nome da cidade",
  "total_hot": número,
  "total_warm": número,
  "gatilho_sazonal": "oportunidade sazonal detectada ou null",
  "recomendacao_estrategica": "2-3 frases de estratégia comercial para a SA",
  "alerta": "algum risco ou ponto de atenção ou null"
}

Leads (máx 30 primeiros):
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
