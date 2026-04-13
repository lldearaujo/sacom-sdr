'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', '.cache');
const HISTORICO_FILE = path.join(CACHE_DIR, 'conversas.json');

// ─── Inicialização do cliente Gemini ──────────────────────────────────────────
function getModel(temperatura) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    generationConfig: {
      maxOutputTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '1024', 10),
      temperature: temperatura ?? parseFloat(process.env.GEMINI_TEMPERATURA || '0.7'),
    },
  });
}

// ─── Histórico de conversas por CNPJ (.cache/conversas.json) ─────────────────
function loadHistorico() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(HISTORICO_FILE)) return {};
    return JSON.parse(fs.readFileSync(HISTORICO_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveHistorico(data) {
  try {
    fs.writeFileSync(HISTORICO_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Falha ao salvar histórico de conversas:', err.message);
  }
}

// ─── System Prompt — "Cérebro" da SA Comunicação ────────────────────────────
function buildSystemPrompt(lead) {
  const agente = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const cargo  = process.env.BDR_AGENTE_CARGO || 'Consultora de Mídia';

  return `Você é ${agente}, ${cargo} da SA Comunicação.

## SOBRE A SA COMUNICAÇÃO
- Agência de publicidade fundada em 2015 — 11 anos de mercado
- Sede: Cajazeiras/PB — atende todo o alto sertão paraibano e região
- Diferencial ÚNICO: única agência da região com o mix completo:
  Painel de LED (DOOH) + Outdoor tradicional + Rádio Centro + Carro de Som + Marketing Digital
- Cases reconhecidos: Chilli Beans Cajazeiras, Brisanet (~5 anos de parceria), SEST SENAT Cajazeiras
- Contato: (83) 9 9986-3252 | atendimento@sacomunicacao.com.br

## NOSSOS SERVIÇOS
- **Painel de LED (DOOH)**: painéis digitais — 16h/dia, até 272 inserções da marca por dia
- **Outdoor Tradicional (OOH)**: alto impacto visual em pontos estratégicos da cidade
- **Rádio Centro Cajazeiras**: sistema de som a cabo distribuído nas principais ruas
- **Carro de Som**: propaganda volante nas ruas — ideal para sazonais e promoções
- **Mídias Visuais**: murodoor e banner de rua em semáforos
- **Marketing Digital**: gestão de tráfego (Google/Meta Ads), criação de conteúdo, design gráfico, vídeos

## SOBRE O LEAD COM QUEM VOCÊ ESTÁ CONVERSANDO
- Empresa: ${lead.fantasia || lead.razao || 'não identificada'}
- Cidade: ${lead.cidade || 'não informada'}/${lead.uf || ''}
- Segmento: ${lead.cnae || 'não informado'}
- Porte: ${lead.porte || 'não informado'}
- Classificação BDR: ${lead.classificacao || ''}
- Segmento prioritário SA: ${lead.segmentoPrioritario || ''}
- Oferta recomendada: ${lead.ofertaPrincipal || ''}
- Pacote sugerido: ${lead.pacoteSugerido || ''}
- Dor principal identificada: ${lead.dorPrincipal || ''}
- Objetivo de curto prazo: ${lead.objetivoCurtoPrazo || ''}
- Potencial de recorrência: ${lead.potencialRecorrencia || ''}

## COMO AGIR
1. Você é uma consultora HUMANA — NUNCA revele que é IA ou bot
2. Seja cordial, empática e direta — sem ser genérica
3. Use linguagem natural e descontraída, mas profissional
4. Sempre conduza para agendar uma reunião ou apresentação
5. Aplique o método BANT naturalmente ao longo da conversa:
   - Budget: descubra se há verba para marketing (pergunte indiretamente)
   - Authority: confirme se fala com o decisor
   - Need: aprofunde a necessidade de visibilidade local
   - Timing: pergunte quando quer começar
6. Mensagens CURTAS — máximo 3 parágrafos, tom de WhatsApp (não de e-mail)
7. Use emojis com moderação (1-2 por mensagem no máximo)
8. Quando o cliente demonstrar interesse → pergunte: "Posso te ligar para apresentar nossa proposta?"
9. Se o cliente disser NÃO AGORA → registre o motivo e encerre gentilmente, deixando a porta aberta

## COMO TRATAR OBJEÇÕES
- "Está caro" → Fale em ROI: "São até 272 vezes que sua marca aparece por dia para quem passa na cidade"
- "Não funciona" → Use cases: "A Brisanet está com a gente há 5 anos, a Chilli Beans também"
- "Já tenho fornecedor" → "Nossa solução é complementar — a maioria dos nossos clientes também usava outro canal antes"
- "Não tenho verba agora" → "Sem problema! Quando seria uma boa época para conversar?"
- "Preciso pensar" → "O que te falta para tomar uma decisão? Posso ajudar com alguma informação?"

## DETECÇÃO DE INTENÇÃO (OCULTA — não mostrar ao cliente)
Se o lead demonstrar interesse real (querer proposta, agendar, pedir mais informação concreta),
adicione APENAS ao final da sua resposta, em linha separada e invisível:
<intent>{"interesse": true, "tipo": "agendamento|proposta|informacao", "urgencia": "alta|media|baixa"}</intent>

Se não houver interesse claro, NÃO inclua a tag <intent>.`;
}

// ─── Processa resposta do lead via Gemini (agente conversacional) ─────────────
async function processarRespostaLead(lead, mensagemDoLead) {
  const historico = loadHistorico();
  const cnpj = lead.cnpj;

  if (!historico[cnpj]) {
    historico[cnpj] = { messages: [], inicioEm: new Date().toISOString() };
  }

  // Histórico no formato Gemini (sem a mensagem atual)
  const historyParaGemini = historico[cnpj].messages.map(m => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  const model = getModel(0.7);
  const chat = model.startChat({
    history: historyParaGemini,
    systemInstruction: {
      role: 'user',
      parts: [{ text: buildSystemPrompt(lead) }],
    },
  });

  const result = await chat.sendMessage(mensagemDoLead);
  const respostaCompleta = result.response.text();

  // Extrai intent oculto
  const intentMatch = respostaCompleta.match(/<intent>([\s\S]+?)<\/intent>/);
  let intent = null;
  const respostaLimpa = respostaCompleta.replace(/<intent>[\s\S]*?<\/intent>/, '').trim();

  if (intentMatch) {
    try { intent = JSON.parse(intentMatch[1]); } catch { /* ignora JSON inválido */ }
  }

  // Salva histórico completo
  historico[cnpj].messages.push({ role: 'user',  text: mensagemDoLead });
  historico[cnpj].messages.push({ role: 'model', text: respostaCompleta });
  historico[cnpj].ultimaInteracaoEm = new Date().toISOString();
  if (intent) historico[cnpj].intentDetectado = intent;
  saveHistorico(historico);

  return { resposta: respostaLimpa, intent };
}

// ─── Gera mensagem de prospecção inicial personalizada com IA ─────────────────
async function gerarMensagemProspeccao(lead) {
  const agente = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const model = getModel(0.85);

  const prompt = `Você é ${agente}, consultora da SA Comunicação, agência de publicidade de Cajazeiras/PB.
A SA tem 11 anos de mercado (fundada em 2015) e é a única agência do alto sertão paraibano com o mix completo:
Painel de LED (DOOH), Outdoor, Rádio Centro e Marketing Digital.

Escreva uma mensagem de WhatsApp de PRIMEIRO CONTATO para prospecção:
- Empresa: ${lead.fantasia || lead.razao}
- Cidade: ${lead.cidade}
- Segmento/atividade: ${lead.cnae}
- Dor identificada: ${lead.dorPrincipal}
- Oferta adequada: ${lead.ofertaPrincipal}
- Frase consultiva base: "${lead.discursoConsultivo}"

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

// ─── Analisa lote de leads e gera insights estratégicos ───────────────────────
async function analisarLeadsComIA(leads) {
  const model = getModel(0.3);

  const resumo = leads.slice(0, 30).map(l =>
    `${l.razao} | ${l.cidade} | ${l.cnae} | Score: ${l.scoreComercial} | ${l.classificacao} | ${l.segmentoPrioritario}`
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
    // Tenta extrair JSON se vier com texto extra
    const match = texto.match(/\{[\s\S]+\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignora */ }
    }
    return { raw: texto, erro: 'Falha ao parsear JSON do Gemini' };
  }
}

// ─── Retorna histórico de conversa de um CNPJ ────────────────────────────────
function getHistoricoConversa(cnpj) {
  const historico = loadHistorico();
  return historico[cnpj] || null;
}

module.exports = {
  processarRespostaLead,
  gerarMensagemProspeccao,
  analisarLeadsComIA,
  getHistoricoConversa,
  buildSystemPrompt,
};
