'use strict';

/**
 * server/rag.js — RAG Engine (Retrieval-Augmented Generation)
 * Usa Gemini text-embedding-004 e pgvector para injetar contexto relevante
 * nos prompts do assistente usando o mínimo de tokens possível.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const cache = require('./cache');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-004';
const RAG_HISTORICO_LIMITE = parseInt(process.env.RAG_HISTORICO_LIMITE || '5', 10);
const RAG_LEADS_SIMILARES = parseInt(process.env.RAG_LEADS_SIMILARES || '2', 10);

// Gera Embedding para um texto
async function getEmbedding(text) {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent(text);
  return result.embedding.values; // Array de floats (768 dimensões)
}

// ─── MONTAGEM DO CONTEXTO (RAG) ───────────────────────────────────────────────

async function buildContextoRAG(lead, mensagemCliente) {
  // 1. Gera embedding da mensagem do cliente para entender a intenção/contexto
  let similaresStr = '';
  let knowledgeStr = '';
  try {
    const embeddingMensagem = await getEmbedding(mensagemCliente);
    
    // 2. Busca leads similares (para o agente usar como cases/referência implicitamente)
    const similares = await db.findSimilarLeads(embeddingMensagem, {
      limit: RAG_LEADS_SIMILARES,
      excludeCnpj: lead.cnpj
    });

    if (similares.length > 0) {
      similaresStr = '\n\n## REFERÊNCIA (Cases):\n' + 
        similares.map(s => `- Cliente similar: ${s.razao}. Dor: '${s.dor_principal}'.`).join('\n');
    }

    // 2.5 Busca fragmentos do Treinamento (Knowledge Base)
    const conhecimentosBase = await db.searchKnowledge(embeddingMensagem, 3);
    if (conhecimentosBase.length > 0) {
      knowledgeStr = '\n\n## CONHECIMENTO BASE (Tabela de preços, portfólio, manuais institucionais):\n' +
        conhecimentosBase.map(k => `- [${k.titulo}]: ${k.conteudo}`).join('\n\n');
    }

  } catch (e) {
    console.warn('Falha ao buscar contexto semântico (RAG fallback):', e.message);
  }

  // 3. Monta o Perfil Sintético do Lead Atual (Economiza tokens do System Prompt)
  const perfilSintetico = `
## SOBRE O LEAD ATUAL
Empresa: ${lead.fantasia || lead.razao} (${lead.cidade})
Segmento: ${lead.cnae || 'Variado'}
Dor Principal: ${lead.dor_principal || lead.dorPrincipal || 'Atrair clientes'}
Oferta Recomendada: ${lead.oferta_principal || lead.ofertaPrincipal || 'OOH Geral'}
Pitch Sugerido: "${lead.discurso_consultivo || lead.discursoConsultivo || 'Mostre valor local'}"
`;

  // 4. Combina com o Base System Prompt Configurável
  const agente = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const cargo  = process.env.BDR_AGENTE_CARGO || 'Consultora de Mídia';

  // Se o Prompt não foi configurado na UI ainda, usamos o padrão!
  let promptCustomizado = process.env.BDR_SYSTEM_PROMPT;
  if (!promptCustomizado || promptCustomizado.trim().length === 0) {
    promptCustomizado = `Você é {{agente}}, {{cargo}} da SA Comunicação (Cajazeiras/PB, 11 anos de mercado).
Soluções: Painel de LED (DOOH), Outdoor, Rádio, Carro de Som e Marketing.
Atitude: Humana, consultiva, natural (tom de WhatsApp). Mensagens Curtas (máximo 3 parágrafos).
Objetivo: Agendar apresentação/reunião.`;
  }

  // Substitui tags
  let promptInjetado = promptCustomizado
    .replace(/\{\{agente\}\}/g, agente)
    .replace(/\{\{cargo\}\}/g, cargo);
  // Compatibilidade caso usem ${agente} no text area:
  promptInjetado = promptInjetado
    .replace(/\$\{agente\}/g, agente)
    .replace(/\$\{cargo\}/g, cargo);

  const systemPrompt = `${promptInjetado}
${perfilSintetico}${knowledgeStr}${similaresStr}

## DETECÇÃO DE INTENÇÃO (OCULTA)
Se o lead demonstrar interesse (querer proposta, agendar), adicione APENAS ao final da sua resposta:
<intent>{"interesse": true, "tipo": "agendamento|proposta", "urgencia": "alta|media|baixa"}</intent>
`;

  return systemPrompt;
}

// ─── CHAT COM RAG ─────────────────────────────────────────────────────────────

async function processarMensagemRAG(lead, mensagemCliente) {
  // 1. Monta o contexto injetado (System Instruction)
  const systemInstructionText = await buildContextoRAG(lead, mensagemCliente);

  // 2. Pega as últimas mensagens do histórico para manter a continuidade (via Redis/PG)
  const historico = await cache.getConversaContexto(lead.cnpj, RAG_HISTORICO_LIMITE);
  
  // Converte formato interno {role, text} para formato do Gemini
  const geminiHistory = historico.map(m => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  // 3. Inicializa modelo
  const chatModel = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      maxOutputTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '1024', 10),
      temperature: parseFloat(process.env.GEMINI_TEMPERATURA || '0.7'),
    },
  });

  const chat = chatModel.startChat({
    history: geminiHistory,
    systemInstruction: {
      role: 'user',
      parts: [{ text: systemInstructionText }],
    },
  });

  // 4. Envia mensagem para a IA
  const result = await chat.sendMessage(mensagemCliente);
  const respostaCompleta = result.response.text();

  // 5. Salva mensagens no banco e no cache
  await cache.appendMensagemConversa(lead.cnpj, 'user', mensagemCliente);

  // 6. Extrai intent
  const intentMatch = respostaCompleta.match(/<intent>([\s\S]+?)<\/intent>/);
  let intent = null;
  const respostaLimpa = respostaCompleta.replace(/<intent>[\s\S]*?<\/intent>/, '').trim();

  if (intentMatch) {
    try { intent = JSON.parse(intentMatch[1]); } catch { /* ignora */ }
  }

  // Salva resposta da IA
  await cache.appendMensagemConversa(lead.cnpj, 'model', respostaCompleta);

  return { resposta: respostaLimpa, intent };
}

module.exports = {
  getEmbedding,
  processarMensagemRAG,
};
