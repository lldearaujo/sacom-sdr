'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');

// ─── Módulos de Banco, IA e WhatsApp ──────────────────────────────────────────
const db = require('./server/db');
const cache = require('./server/cache');
const gemini = require('./server/gemini');
const whatsapp = require('./server/whatsapp');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Constantes antigas de enrichment (mantidas para compatibilidade com a UI)
const ENRICHMENT_TTL_HOURS = Number.parseInt(process.env.ENRICHMENT_TTL_HOURS || '168', 10);
const MAX_ENRICHMENTS_PER_REQUEST = Number.parseInt(process.env.MAX_ENRICHMENTS_PER_REQUEST || '20', 10);
const MAX_ENRICHMENT_CONCURRENCY = Number.parseInt(process.env.MAX_ENRICHMENT_CONCURRENCY || '4', 10);
const ENRICHMENT_DOMAIN_COOLDOWN_MS = Number.parseInt(process.env.ENRICHMENT_DOMAIN_COOLDOWN_MS || '600', 10);
const ENRICHMENT_FETCH_TIMEOUT_MS = Number.parseInt(process.env.ENRICHMENT_FETCH_TIMEOUT_MS || '4000', 10);

// ─── APIs Core ────────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  const isRedisOk = await cache.isRedisHealthy();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dbConectado: true,
    redisConectado: isRedisOk,
  });
});

app.get('/api/leads', async (req, res) => {
  try {
    const result = await db.queryLeads(req.query);
    
    // Anexa enrichment se solicitado
    const shouldIncludeEnrichment = String(req.query.include_enrichment || '').toLowerCase() === 'true';
    if (shouldIncludeEnrichment) {
      for (const lead of result.data) {
        // Obter enrichment direto do banco (já mapeado no upsert do bot de enrichment)
        lead.enrichment = lead.enrichment || await db.getEnrichment(lead.cnpj);
      }
    }

    res.json({
      total: result.total,
      page: parseInt(req.query.page || 1, 10),
      limit: parseInt(req.query.limit || 50, 10),
      includesEnrichment: shouldIncludeEnrichment,
      enrichmentTtlHours: ENRICHMENT_TTL_HOURS,
      maxEnrichmentConcurrency: MAX_ENRICHMENT_CONCURRENCY,
      data: result.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── APIs Enrichment ───────────────────────────────────────────────────────────
// Em uma refatoração total, o ideal seria mover a lógica de fetch pra um worker, 
// mas para manter a API intacta pro frontend:
app.get('/api/leads/:cnpj/enrichment', async (req, res) => {
  try {
    const lead = await db.getLeadByCnpj(req.params.cnpj);
    if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' });
    
    // (Simplificado) Na arquitetura nova as infos são buscadas e salvas por um worker, 
    // ou usamos a url existente salva no banco.
    const enrichment = lead.enrichment || await db.getEnrichment(lead.cnpj) || null;
    res.json({
      cnpj: lead.cnpj,
      razao: lead.razao,
      fantasia: lead.fantasia,
      enrichment,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/enrichment/warmup', (req, res) => {
  res.json({ warmed: 0, status: 'Obsoleto na arquitetura atual - Use scripts externos' });
});

// ─── APIs Prospecção ─────────────────────────────────────────────────────────

app.post('/api/prospeccao/disparar', async (req, res) => {
  try {
    const {
      classificacoes = ['🔴 HOT', '🟠 WARM'],
      limite = 10,
      usarIA = true,
    } = req.body || {};

    // Pega leads baseados na classe e que não estejam em cooldown
    const leadsRaw = await db.queryLeads({ limit: limite * 5 }); // pega sobra pra filtrar
    const selecionados = leadsRaw.data.filter(
      l => classificacoes.includes(l.classificacao) && (l.telefone1 || l.telefone2)
    );

    const gerarMensagemFn = usarIA ? gemini.gerarMensagemProspeccao : null;
    const resultado = await whatsapp.dispararLote(selecionados, { limite, gerarMensagemFn });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prospeccao/status', async (req, res) => {
  try {
    const entries = await db.getAllProspeccoes();
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

app.put('/api/prospeccao/:cnpj/status', async (req, res) => {
  try {
    const { cnpj } = req.params;
    const { status, notas } = req.body || {};
    
    await db.saveProspeccaoDB(cnpj, { status, notas });
    res.json({ ok: true, cnpj, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prospeccao/:cnpj/historico', async (req, res) => {
  try {
    const hist = await db.getHistoricoConversa(req.params.cnpj);
    res.json({ messages: hist || [] }); // Frontend espera data.messages
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prospeccao/webhook', async (req, res) => {
  // Responde Z-API imediatamente para evitar timeout
  res.json({ ok: true });

  try {
    const payload = req.body;
    console.log('\n[Webhook Z-API Recebido]', JSON.stringify({ phone: payload?.phone, fromMe: payload?.fromMe, type: payload?.type, msg: payload?.text?.message }));

    if (!payload?.text?.message || payload.fromMe) return;

    const numero = (payload.phone || '').replace(/\\D/g, '');
    const mensagem = payload.text.message;

    let cnpj = await whatsapp.encontrarCnpjPorNumero(numero);
    let lead = await db.getLeadByCnpj(cnpj);

    if (!lead) {
      lead = await db.getLeadByNumero(numero);
      if (lead) cnpj = lead.cnpj;
    }

    // [MODO TESTE] Lê NUMEROS_TESTE diretamente do .env
    const rawTeste = process.env.NUMEROS_TESTE || '';
    const numerosAutorizados = rawTeste.split(/[,;\\s]+/).map(n => n.replace(/\\D/g, '')).filter(n => n.length > 5);
    const ehNumeroTeste = numerosAutorizados.some(nt => numero.includes(nt) || nt.includes(numero.substring(2)));

    if (!lead && ehNumeroTeste) {
       console.log(`[Webhook] MODO TESTE DE DIRETORIA: Autorizando ${numero}...`);
       cnpj = '00000000000000';
       lead = {
         cnpj, razao: 'Usuário de Testes Internos', fantasia: 'Empresa Teste', cidade: 'Brasil',
         segmento: 'Testes de Validação', dor_principal: 'Testar e validar comportamento da IA BDR',
         oferta_principal: 'Midia Exterior e OOH', classificacao: '🔴 HOT'
       };
    }

    if (!lead) {
       console.log(`[Webhook] IGNORADO: Número ${numero} não está registrado.`);
       return;
    }

    console.log(`[Webhook] Processando mensagem para: ${lead.razao} (${cnpj})`);

    // 🤖 Gemini processa via engine RAG
    const { resposta, intent } = await gemini.processarRespostaLead(lead, mensagem);

    // Salva intent se detectado
    if (intent?.interesse) {
      console.log(`🔥 OPORTUNIDADE: ${lead.razao} (${lead.cidade}) — ${intent.tipo}`);
      await db.saveProspeccaoDB(cnpj, { status: intent.urgencia === 'alta' ? 'oportunidade' : 'respondido' });
    }

    // Delay humanizado (2–4s)
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

    // Envia resposta via Z-API
    await whatsapp.enviarMensagem(numero, resposta);

  } catch (err) {
    console.error('Erro no webhook Gemini/Z-API:', err.message);
  }
});

// ─── APIs AI & Insights ────────────────────────────────────────────────────────

app.get('/api/ai/insights', async (req, res) => {
  try {
    const leadsRaw = await db.queryLeads({ limit: 100 }); 
    const insights = await gemini.analisarLeadsComIA(leadsRaw.data);
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai/mensagem-preview/:cnpj', async (req, res) => {
  try {
    const lead = await db.getLeadByCnpj(req.params.cnpj);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const mensagem = await gemini.gerarMensagemProspeccao(lead);
    res.json({
      cnpj: lead.cnpj, razao: lead.razao, fantasia: lead.fantasia, cidade: lead.cidade, mensagem,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Settings API ──────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const keys = ['BDR_AGENTE_NOME', 'BDR_AGENTE_CARGO', 'BDR_SYSTEM_PROMPT', 'GEMINI_MODEL', 'GEMINI_TEMPERATURA', 'PROSPECCAO_HORA_INICIO', 'PROSPECCAO_HORA_FIM', 'PROSPECCAO_COOLDOWN_DIAS', 'PROSPECCAO_LIMITE_DIARIO', 'NUMEROS_TESTE'];
  const responseConfig = {};
  keys.forEach(k => {
    let val = process.env[k] || '';
    if (k === 'BDR_SYSTEM_PROMPT') val = val.replace(/\\n/g, '\n');
    responseConfig[k] = val;
  });
  res.json(responseConfig);
});

app.post('/api/config', (req, res) => {
  try {
    const envPath = path.join(__dirname, '.env');
    let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    
    for (const [key, rawValue] of Object.entries(req.body || {})) {
      let value = rawValue;
      if (key === 'BDR_SYSTEM_PROMPT') {
        value = String(value).replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
      }
      process.env[key] = value;
      const idx = lines.findIndex(l => l.startsWith(`${key}=`));
      if (idx !== -1) lines[idx] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
    }

    fs.writeFileSync(envPath, lines.join('\n').trim() + '\n', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Knowledge Base Upload API ────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage() });

app.get('/api/knowledge', async (req, res) => {
  try {
    const list = await db.getKnowledgeList();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/knowledge/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    const { originalname, buffer, mimetype } = req.file;
    let textoDeExtraida = '';

    if (mimetype === 'application/pdf') {
      const parsed = await pdfParse(buffer);
      textoDeExtraida = parsed.text;
    } else {
      textoDeExtraida = buffer.toString('utf8');
    }

    if (!textoDeExtraida || textoDeExtraida.trim().length === 0) {
      return res.status(400).json({ error: 'O arquivo não contém texto legível.' });
    }

    // Fatia o documento em pedaços de ~1000 caracteres para melhor embedding semântico
    const chunks = [];
    const paragraphs = textoDeExtraida.split(/\n\s*\n/);
    let currentChunk = '';
    
    for (const p of paragraphs) {
      if (currentChunk.length + p.length > 2000) {
        chunks.push(currentChunk.trim());
        currentChunk = p;
      } else {
        currentChunk += '\\n\\n' + p;
      }
    }
    if (currentChunk.trim()) chunks.push(currentChunk.trim());

    // Importar rag localmente para não causar erro top-level se ainda n foi carregado
    const rag = require('./server/rag');
    
    let inseridos = 0;
    for (const chunk of chunks) {
      if (chunk.length < 20) continue; // Pula fragmentos inúteis
      const embedding = await rag.getEmbedding(chunk);
      await db.saveKnowledge(`Fragmento de ${originalname}`, chunk, embedding, originalname);
      inseridos++;
    }

    res.json({ ok: true, file: originalname, inseridos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/knowledge/:id', async (req, res) => {
  try {
    await db.deleteKnowledge(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT & START SERVER
// ══════════════════════════════════════════════════════════════════════════════

async function startServer() {
  await db.init();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ SA Comunicação - RAG + PGVector + Redis rodando em http://0.0.0.0:${PORT}`);
    console.log(`   🤖 Gemini AI: ${process.env.GEMINI_MODEL || 'gemini-2.0-flash'}`);
    console.log(`   📱 Z-API: ${process.env.ZAPI_INSTANCE_ID ? 'configurada' : 'não configurada'}\n`);
  });
}

startServer().catch(err => {
  console.error('Falha fatal ao iniciar servidor:', err);
  process.exit(1);
});
