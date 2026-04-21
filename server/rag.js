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
const whatsappInbound = require('./whatsapp-inbound');
const { trunc } = require('./token-utils');
const aiObs = require('./ai-observability');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function readEnvMultiline(key) {
  const v = process.env[key];
  if (v == null || v === '') return '';
  return String(v).replace(/\\n/g, '\n');
}

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-004';
const RAG_HISTORICO_LIMITE = parseInt(process.env.RAG_HISTORICO_LIMITE || '4', 10);
const RAG_LEADS_SIMILARES = parseInt(process.env.RAG_LEADS_SIMILARES || '2', 10);
const RAG_KNOWLEDGE_CHUNKS = parseInt(process.env.RAG_KNOWLEDGE_CHUNKS || '2', 10);
/** Texto do usuário para embedding + busca vetorial (não precisa do texto inteiro). */
const RAG_QUERY_MAX_CHARS = parseInt(process.env.RAG_QUERY_MAX_CHARS || '2000', 10);
const RAG_KNOWLEDGE_MAX_CHARS = parseInt(process.env.RAG_KNOWLEDGE_MAX_CHARS || '520', 10);
const RAG_SIMILAR_LINE_MAX = parseInt(process.env.RAG_SIMILAR_LINE_MAX || '120', 10);
const RAG_PERFIL_CAMPO_MAX = parseInt(process.env.RAG_PERFIL_CAMPO_MAX || '220', 10);
/** Cada mensagem no histórico enviada ao Gemini (role user/model). */
const RAG_HISTORICO_MSG_MAX_CHARS = parseInt(process.env.RAG_HISTORICO_MSG_MAX_CHARS || '900', 10);

// Gera Embedding para um texto
async function getEmbedding(text) {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const payload = trunc(text, RAG_QUERY_MAX_CHARS);
  const result = await model.embedContent(payload);
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
      similaresStr = '\n## Cases\n' +
        similares.map((s) =>
          `- ${trunc(s.razao, 60)} | dor: ${trunc(s.dor_principal || '', RAG_SIMILAR_LINE_MAX)}`
        ).join('\n');
    }

    // 2.5 Busca fragmentos do Treinamento (Knowledge Base)
    const conhecimentosBase = await db.searchKnowledge(embeddingMensagem, RAG_KNOWLEDGE_CHUNKS);
    if (conhecimentosBase.length > 0) {
      knowledgeStr = '\n## KB\n' +
        conhecimentosBase.map((k) => `- ${trunc(k.titulo, 80)}: ${trunc(k.conteudo, RAG_KNOWLEDGE_MAX_CHARS)}`).join('\n');
    }

  } catch (e) {
    console.warn('Falha ao buscar contexto semântico (RAG fallback):', e.message);
  }

  // 3. Monta o Perfil Sintético do Lead Atual (Economiza tokens do System Prompt)
  const perfilSintetico = `
## Lead
${trunc(lead.fantasia || lead.razao, 80)} · ${trunc(lead.cidade || '', 40)} | ${trunc(lead.cnae || 'Variado', 80)}
Status: ${lead.etapaFunil || 'Qualificação'} (Score BDR: ${lead.scoreComercial || 0}/40)
Dor: ${trunc(lead.dor_principal || lead.dorPrincipal || 'Atrair clientes', RAG_PERFIL_CAMPO_MAX)}
Pitch sugerido: ${trunc(lead.discurso_consultivo || lead.discursoConsultivo || 'Mostre valor local', RAG_PERFIL_CAMPO_MAX)}
`;

  // 4. Combina com o Base System Prompt Configurável
  const agente = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const cargo  = process.env.BDR_AGENTE_CARGO || 'Consultora de Mídia';

  const objetivoConversa =
    readEnvMultiline('BDR_OBJETIVO_CONVERSA').trim() ||
    'Qualificar o lead (BANT) e gerar valor/curiosidade. Responder dúvidas com a KB.';

  // Lógica de "Paciência Comercial": bloqueia reunião se o lead for frio
  let diretrizStatus = '';
  const score = lead.scoreComercial || 0;
  const etapa = lead.etapaFunil || 'Qualificação';
  
  if (etapa === 'Qualificação' || score < 25) {
      diretrizStatus = `\nSTATUS DO LEAD: EM QUALIFICAÇÃO (Frio). 
⚠️ REGRA CRÍTICA: Você está PROIBIDO de sugerir reuniões, call de 15 min ou pedir horários agora. 
Sua missão é APENAS responder dúvidas, enviar mídias se solicitado e entender a dor do cliente. NÃO force o fechamento ainda.`;
  } else {
      diretrizStatus = `\nSTATUS DO LEAD: PRONTO (Quente). 
Pode sugerir uma conversa breve se sentir que as dúvidas foram sanadas.`;
  }

  // Se o Prompt não foi configurado na UI ainda, usamos o padrão (compacto).
  let promptCustomizado = process.env.BDR_SYSTEM_PROMPT;
  const usaPromptPadraoInterno = !promptCustomizado || promptCustomizado.trim().length === 0;
  if (usaPromptPadraoInterno) {
    promptCustomizado = `Você é {{agente}}, {{cargo}} na SA Comunicação (Cajazeiras/PB). 
DIRETRIZES GERAIS:
1. Tom humano, WhatsApp: 2-3 blocos curtos.
2. Seja um consultor, não um vendedor de telemarketing.
3. Se perguntar preço/como funciona: Explique via KB e gere curiosidade.
${diretrizStatus}
Objetivo: ${objetivoConversa}`;
  } else {
      // Se houver prompt customizado, injetamos a diretriz de status no final para garantir obediência
      promptCustomizado += `\n\n${diretrizStatus}`;
  }

  // Substitui tags
  let promptInjetado = promptCustomizado
    .replace(/\{\{agente\}\}/g, agente)
    .replace(/\{\{cargo\}\}/g, cargo);

  const intentPadrao = `Ao final da resposta, se houver qualquer sinal de evolução na conversa, inclua obrigatoriamente a tag:
<intent>{
  "interesse": true|false,
  "tipo": "agendamento|proposta|fechamento|duvida|negativa",
  "urgencia": "alta|media|baixa",
  "sugestao_score": 0-40,
  "sugestao_etapa": "Qualificação|Apresentação|Negociação|Fechamento",
  "motivo": "resumo breve do porquê da sugestão"
}</intent>

Critérios Retomada (BANT/Score):
- Budget (Orçamento): Possui verba? (0-10 pts)
- Authority (Autoridade): É o decisor? (0-10 pts)
- Need (Necessidade): O problema é real? (0-10 pts)
- Timing (Tempo): Prazo próximo? (0-10 pts)`;

  const intentCustom = readEnvMultiline('BDR_INTENT_DETECCAO').trim();
  const blocoIntent = intentCustom.length > 0 ? intentCustom : intentPadrao;

  const blocoMidia = await media.blocoPromptMidia();

  // Evita repetir instruções de estilo quando o prompt padrão já as inclui (economiza tokens).
  const blocoEstiloWhats = usaPromptPadraoInterno
    ? ''
    : '\nEstilo: WhatsApp — blocos curtos separados por linha em branco.\n';

  const systemPrompt = `${promptInjetado}
${perfilSintetico}${knowledgeStr}${similaresStr}
${blocoMidia}${blocoEstiloWhats}
${blocoIntent}
`;

  return systemPrompt;
}

// ─── CHAT COM RAG ─────────────────────────────────────────────────────────────

async function processarMensagemRAG(lead, userInput, { traceId = null } = {}) {
  const userText =
    typeof userInput === 'string' ? userInput : (userInput && userInput.text) || '';
  const mediaParts =
    typeof userInput === 'object' && userInput && Array.isArray(userInput.parts)
      ? userInput.parts
      : [];

  const textoParaEmbedding = userText.trim() || '(conteúdo multimodal)';

  // 1. Monta o contexto injetado (System Instruction)
  const t1 = Date.now();
  const systemInstructionText = await buildContextoRAG(lead, textoParaEmbedding);
  if (traceId) {
    aiObs.addStep(traceId, {
      stage: 'contexto_rag',
      status: 'ok',
      durationMs: Date.now() - t1,
      message: 'Contexto RAG montado com histórico e conhecimento.',
    });
  }

  // 2. Pega as últimas mensagens do histórico para manter a continuidade (via Redis/PG)
  const t2 = Date.now();
  const historico = await cache.getConversaContexto(lead.cnpj, RAG_HISTORICO_LIMITE);
  if (traceId) {
    aiObs.addStep(traceId, {
      stage: 'historico',
      status: 'ok',
      durationMs: Date.now() - t2,
      message: `Histórico carregado (${historico.length} mensagens).`,
    });
  }
  
  // Converte formato interno {role, text} para formato do Gemini
  let geminiHistory = historico.map((m) => ({
    role: m.role,
    parts: [{ text: trunc(m.text, RAG_HISTORICO_MSG_MAX_CHARS) }],
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
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    generationConfig: {
      maxOutputTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '768', 10),
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

  // 4. Envia mensagem para a IA (texto e/ou mídia multimodal)
  const t3 = Date.now();
  let result;
  if (mediaParts.length > 0) {
    const prompt =
      userText.trim() ||
      'Analise o material enviado pelo cliente e responda no contexto da conversa BDR.';
    result = await chat.sendMessage([{ text: prompt }, ...mediaParts]);
  } else {
    result = await chat.sendMessage(userText);
  }
  if (traceId) {
    aiObs.addStep(traceId, {
      stage: 'gemini_response',
      status: 'ok',
      durationMs: Date.now() - t3,
      message: 'Resposta gerada pelo Gemini.',
      meta: { multimodal: mediaParts.length > 0 },
    });
  }
  const respostaCompleta = result.response.text();
  
  // Debug para truncamento: logar resposta bruta se for menor que o esperado ou terminar de forma estranha
  if (respostaCompleta.length < 100 || !respostaCompleta.includes('</intent>')) {
    console.log(`[Gemini Debug] Resposta bruta (${respostaCompleta.length} chars): ${respostaCompleta}`);
  }

  // 5. Salva mensagens no banco e no cache
  const historicoUser = whatsappInbound.textoParaHistorico(userInput);
  await cache.appendMensagemConversa(lead.cnpj, 'user', historicoUser);

  // 6. Extrai intent e mídias [[MEDIA:chave]]
  // Regex global (/g) e case-insensitive (/i) para garantir remoção total
  const intentMatch = respostaCompleta.match(/<intent>([\s\S]+?)<\/intent>/i);
  let intent = null;
  
  // Limpa todas as tags <intent>...</intent> e também tags órfãs se houver
  const semIntent = respostaCompleta
    .replace(/<intent>[\s\S]*?<\/intent>/gi, '')
    .replace(/<intent>|<\/intent>/gi, '') // Camada extra de limpeza para tags mal formadas
    .trim();

  if (intentMatch) {
    try { intent = JSON.parse(intentMatch[1]); } catch { /* ignora */ }
  }

  const { texto: respostaLimpa, mediaKeys } = await media.extrairMidiasDaResposta(semIntent);
  let finalResponse = respostaLimpa;

  // 7. Lógica de Handoff Humano (Se detectou intenção de fechamento)
  if (intent && intent.tipo === 'fechamento') {
    const contatoHumano = process.env.BDR_CONTATO_HUMANO || '8335313352';
    const handoffMsg = `\n\n👉 Para formalizar e fechar o negócio agora, fale com nossa equipe financeira/comercial neste link: https://wa.me/55${contatoHumano.replace(/\D/g, '')}`;
    finalResponse += handoffMsg;
    console.log(`🤝 HANDOFF: Lead ${lead.cnpj} pronto para fechamento. Encaminhando para ${contatoHumano}`);
  }

  // Salva no histórico só o texto exibido ao lead (sem tags internas)
  await cache.appendMensagemConversa(lead.cnpj, 'model', finalResponse);
  if (traceId) {
    aiObs.addStep(traceId, {
      stage: 'saida',
      status: 'ok',
      message: 'Resposta final preparada e gravada no histórico.',
      meta: { hasIntent: Boolean(intent), mediaKeys: mediaKeys.length },
    });
  }

  return { resposta: finalResponse, intent, mediaKeys };
}

module.exports = {
  getEmbedding,
  processarMensagemRAG,
};
