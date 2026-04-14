'use strict';

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const systemLogger = require('./server/logger');

// ─── Módulos de Banco, IA e WhatsApp ──────────────────────────────────────────
const db = require('./server/db');
const cache = require('./server/cache');
const gemini = require('./server/gemini');
const whatsapp = require('./server/whatsapp');
const whatsappInbound = require('./server/whatsapp-inbound');
const whatsappDebounce = require('./server/whatsapp-debounce');

const app = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

systemLogger.installConsoleCapture();

let dbReady = false;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Constantes antigas de enrichment (mantidas para compatibilidade com a UI)
const ENRICHMENT_TTL_HOURS = Number.parseInt(process.env.ENRICHMENT_TTL_HOURS || '168', 10);
const MAX_ENRICHMENTS_PER_REQUEST = Number.parseInt(process.env.MAX_ENRICHMENTS_PER_REQUEST || '20', 10);
const MAX_ENRICHMENT_CONCURRENCY = Number.parseInt(process.env.MAX_ENRICHMENT_CONCURRENCY || '4', 10);
const ENRICHMENT_DOMAIN_COOLDOWN_MS = Number.parseInt(process.env.ENRICHMENT_DOMAIN_COOLDOWN_MS || '600', 10);
const ENRICHMENT_FETCH_TIMEOUT_MS = Number.parseInt(process.env.ENRICHMENT_FETCH_TIMEOUT_MS || '4000', 10);

// ─── APIs Core ────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const status = res.statusCode;
    if (req.path.startsWith('/api/')) {
      console.log(`[API] ${req.method} ${req.path} -> ${status} (${ms}ms)`);
    }
  });
  next();
});

app.get('/api/health', async (req, res) => {
  const isRedisOk = await cache.isRedisHealthy();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    dbConectado: dbReady,
    redisConectado: isRedisOk,
  });
});

app.get('/api/system/logs', (req, res) => {
  const limit = req.query.limit || '200';
  const level = req.query.level || '';
  const logs = systemLogger.getLogs({ limit, level: level ? String(level) : undefined });
  res.json({ logs });
});

const mediaMod = require('./server/media');
app.get('/api/media/catalog', async (req, res) => {
  try {
    const m = await mediaMod.loadManifest();
    const entries = Object.entries(m)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => ({
        key: k,
        type: v && v.type,
        file: v && v.file,
        fileName: (v && v.fileName) || (v && v.file),
        descricao: (v && v.descricao) || '',
      }));
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const { cnpj } = req.params;
    const { status, notas } = req.body || {};
    
    await db.saveProspeccaoDB(cnpj, { status, notas });
    res.json({ ok: true, cnpj, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prospeccao/:cnpj/aprovar-sugestao', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const { cnpj } = req.params;
    const { score, etapa_funil, status } = req.body || {};
    
    const lead = await db.getLeadByCnpj(cnpj);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    // Atualiza o lead com os novos valores aprovados
    const leadUpdate = { ...lead };
    if (score !== undefined) leadUpdate.score = score;
    if (etapa_funil) leadUpdate.etapaFunil = etapa_funil;
    
    await db.upsertLead(leadUpdate);

    // Se houver mudança de status na prospecção/kanban
    if (status) {
      await db.saveProspeccaoDB(cnpj, { status });
    }

    res.json({ ok: true, cnpj, score, etapa_funil, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prospeccao/:cnpj/historico', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
    if (!dbReady) {
      console.warn('[Webhook] Banco indisponível: ignorando processamento.');
      return;
    }
    const payload = req.body;
    console.log('\n[Webhook Z-API Recebido]', JSON.stringify({
      phone: payload?.phone,
      fromMe: payload?.fromMe,
      type: payload?.type,
      text: payload?.text?.message,
      hasImage: !!payload?.image,
      hasAudio: !!payload?.audio,
      hasVideo: !!payload?.video,
      hasDocument: !!payload?.document,
    }));

    if (payload.fromMe) return;

    const userContent = await whatsappInbound.buildUserContentFromPayload(payload);
    if (!userContent) {
      console.log('[Webhook] Nenhum texto ou mídia suportada para processar.');
      return;
    }

    const numero = (payload.phone || '').replace(/\\D/g, '');

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

    console.log(`[Webhook] Mensagem recebida — debounce ${whatsappDebounce.DEBOUNCE_MS}ms: ${lead.razao} (${cnpj})`);

    whatsappDebounce.scheduleBatchedReply(
      numero,
      { userContent, lead, cnpj },
      async ({ merged, lead: leadCtx, cnpj: cnpjCtx, phone }) => {
        const userInput =
          merged.parts && merged.parts.length > 0 ? merged : merged.text;

        console.log(`[Webhook] Processando lote agregado para: ${leadCtx.razao} (${cnpjCtx})`);

        const { resposta, intent, mediaKeys = [] } = await gemini.processarRespostaLead(leadCtx, userInput);

        if (intent?.interesse) {
          console.log(`🔥 OPORTUNIDADE: ${leadCtx.razao} (${leadCtx.cidade}) — ${intent.tipo}`);
          await db.saveProspeccaoDB(cnpjCtx, { status: intent.urgencia === 'alta' ? 'oportunidade' : 'respondido' });
        }

        await new Promise((r) => setTimeout(r, 800 + Math.random() * 1400));

        if (resposta && resposta.trim()) {
          await whatsapp.enviarTextoFracionado(phone, resposta);
        }
        if (mediaKeys.length) {
          const rMidia = await whatsapp.enviarMidiasCatalogo(phone, mediaKeys);
          if (rMidia.enviados) console.log(`[Webhook] Mídias enviadas: ${rMidia.enviados} (${mediaKeys.join(', ')})`);
        }
      }
    );

  } catch (err) {
    console.error('Erro no webhook Gemini/Z-API:', err.message);
  }
});

// ─── APIs AI & Insights ────────────────────────────────────────────────────────

app.get('/api/ai/insights', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
  try {
    const leadsRaw = await db.queryLeads({ limit: 100 }); 
    const insights = await gemini.analisarLeadsComIA(leadsRaw.data);
    res.json(insights);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai/mensagem-preview/:cnpj', async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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

const MULTILINE_CONFIG_KEYS = new Set(['BDR_SYSTEM_PROMPT', 'BDR_OBJETIVO_CONVERSA', 'BDR_INTENT_DETECCAO']);

app.get('/api/config', (req, res) => {
  const keys = ['BDR_AGENTE_NOME', 'BDR_AGENTE_CARGO', 'BDR_SYSTEM_PROMPT', 'BDR_OBJETIVO_CONVERSA', 'BDR_INTENT_DETECCAO', 'GEMINI_MODEL', 'GEMINI_TEMPERATURA', 'PROSPECCAO_HORA_INICIO', 'PROSPECCAO_HORA_FIM', 'PROSPECCAO_COOLDOWN_DIAS', 'PROSPECCAO_LIMITE_DIARIO', 'NUMEROS_TESTE', 'PUBLIC_BASE_URL'];
  const responseConfig = {};
  keys.forEach(k => {
    let val = process.env[k] || '';
    if (MULTILINE_CONFIG_KEYS.has(k)) val = val.replace(/\\n/g, '\n');
    responseConfig[k] = val;
  });
  res.json(responseConfig);
});

app.post('/api/config', async (req, res) => {
  try {
    const envPath = path.join(__dirname, '.env');
    let lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').split('\n') : [];
    
    const payload = req.body || {};
    const updates = payload.updates && typeof payload.updates === 'object' ? payload.updates : payload;

    for (const [key, rawValue] of Object.entries(updates || {})) {
      let value = rawValue;
      if (MULTILINE_CONFIG_KEYS.has(key)) {
        value = String(value).replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
      }
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        value = String(value);
      }
      
      // Salva no process.env (runtime)
      process.env[key] = value;
      
      // Salva no PostgreSQL (persistência definitiva)
      if (dbReady) {
        await db.saveSetting(key, value).catch(e => console.error(`Erro ao salvar ${key} no PG:`, e.message));
      }

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
  if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
    if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
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
    if (!dbReady) return res.status(503).json({ error: 'Banco de dados indisponível (DATABASE_URL). O servidor está em modo degradado.' });
    await db.deleteKnowledge(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Media Catalog Management API ─────────────────────────────────────────────

const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'media'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, '_');
    cb(null, `${Date.now()}_${name}${ext}`);
  }
});
const uploadMedia = multer({ storage: mediaStorage });

app.post('/api/media/upload', uploadMedia.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  try {
    const { key, type, caption, descricao } = req.body;
    if (!key) return res.status(400).json({ error: 'A chave da mídia é obrigatória.' });

    const entry = {
      file: req.file.filename,
      type: type || 'document',
      fileName: req.file.originalname,
      caption: caption || '',
      descricao: descricao || ''
    };

    const result = await mediaMod.saveMedia(key, entry, req.file.buffer);
    res.json({ ok: true, key, entry: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/media/:key', async (req, res) => {
  try {
    const success = await mediaMod.deleteMedia(req.params.key, true);
    if (!success) return res.status(404).json({ error: 'Mídia não encontrada no catálogo.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INIT & START SERVER
// ══════════════════════════════════════════════════════════════════════════════

async function startServer() {
  try {
    await db.init();
    dbReady = true;
    
    // Bootstrap: Recupera tudo que está no Banco (Configs e Arquivos)
    // Isso evita perda de dados em ambientes efêmeros (Easypanel/Docker)
    await db.bootstrapSystem().catch(err => {
      console.error('⚠️ Falha no bootstrap de dados:', err.message);
    });

  } catch (err) {
    dbReady = false;
    console.error('⚠️ Banco indisponível. Subindo API em modo degradado.', err.message);
    console.error('   Verifique DATABASE_URL no .env (host/porta/credenciais).');
  }
  
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
