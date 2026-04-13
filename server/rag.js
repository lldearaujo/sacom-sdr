'use strict';

/**
 * server/rag.js — RAG Engine (Retrieval-Augmented Generation)
 * Usa Gemini text-embedding-004 e pgvector para injetar contexto relevante
 * nos prompts do assistente usando o mínimo de tokens possível.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const cache = require('./cache');
const media = require('./media');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function readEnvMultiline(key) {
  const v = process.env[key];
  if (v == null || v === '') return '';
  return String(v).replace(/\\n/g, '\n');
}

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

  const objetivoConversa =
    readEnvMultiline('BDR_OBJETIVO_CONVERSA').trim() ||
    'Agendar apresentação/reunião.';

  // Se o Prompt não foi configurado na UI ainda, usamos o padrão!
  let promptCustomizado = process.env.BDR_SYSTEM_PROMPT;
  if (!promptCustomizado || promptCustomizado.trim().length === 0) {
    promptCustomizado = `Você é {{agente}}, {{cargo}} da SA Comunicação (Cajazeiras/PB, 11 anos de mercado).
Soluções: Painel de LED (DOOH), Outdoor, Rádio, Carro de Som e Marketing.
Atitude: Humana, consultiva, natural (tom de WhatsApp). Mensagens Curtas (máximo 3 parágrafos).
Objetivo: ${objetivoConversa}`;
  }

  // Substitui tags
  let promptInjetado = promptCustomizado
    .replace(/\{\{agente\}\}/g, agente)
    .replace(/\{\{cargo\}\}/g, cargo);
  // Compatibilidade caso usem ${agente} no text area:
  promptInjetado = promptInjetado
    .replace(/\$\{agente\}/g, agente)
    .replace(/\$\{cargo\}/g, cargo);

  const intentPadrao = `## DETECÇÃO DE INTENÇÃO (OCULTA)
Se o lead demonstrar interesse (querer proposta, agendar), adicione APENAS ao final da sua resposta:
<intent>{"interesse": true, "tipo": "agendamento|proposta", "urgencia": "alta|media|baixa"}</intent>`;

  const intentCustom = readEnvMultiline('BDR_INTENT_DETECCAO').trim();
  const blocoIntent = intentCustom.length > 0 ? intentCustom : intentPadrao;

  const blocoMidia = media.blocoPromptMidia();

  const systemPrompt = `${promptInjetado}
${perfilSintetico}${knowledgeStr}${similaresStr}
${blocoMidia}

${blocoIntent}
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
  let geminiHistory = historico.map(m => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  // A API do Gemini exige que o primeiro item do histórico seja role 'user'.
  // No nosso fluxo, é comum o bot iniciar a conversa (role 'model'), então
  // garantimos um "marcador" user sintético para evitar erro.
  if (geminiHistory.length > 0 && geminiHistory[0]?.role !== 'user') {
    geminiHistory = [
      { role: 'user', parts: [{ text: '(início)' }] },
      ...geminiHistory,
    ];
  }

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

  // 6. Extrai intent e mídias [[MEDIA:chave]]
  const intentMatch = respostaCompleta.match(/<intent>([\s\S]+?)<\/intent>/);
  let intent = null;
  const semIntent = respostaCompleta.replace(/<intent>[\s\S]*?<\/intent>/, '').trim();

  if (intentMatch) {
    try { intent = JSON.parse(intentMatch[1]); } catch { /* ignora */ }
  }

  const { texto: respostaLimpa, mediaKeys } = media.extrairMidiasDaResposta(semIntent);

  // Salva no histórico só o texto exibido ao lead (sem tags internas)
  await cache.appendMensagemConversa(lead.cnpj, 'model', respostaLimpa);

  return { resposta: respostaLimpa, intent, mediaKeys };
}

module.exports = {
  getEmbedding,
  processarMensagemRAG,
};
