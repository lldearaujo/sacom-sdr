'use strict';

const db = require('./db');
const cache = require('./cache'); // Usaremos para locks
const mediaCatalog = require('./media');

const ZAPI_BASE = () =>
  `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;

// ─── Formata número BR para padrão Z-API (5583999999999) ─────────────────────
function formatarNumero(telefone) {
  if (!telefone) return null;
  const digits = telefone.replace(/\\D/g, '');
  if (!digits) return null;
  const comDDI = digits.startsWith('55') ? digits : `55${digits}`;
  // Celular: 13 dígitos | Fixo: 12 dígitos
  if (comDDI.length < 12 || comDDI.length > 13) return null;
  return comDDI;
}

// ─── Verifica horário comercial (Seg–Sex, 8h–18h) ────────────────────────────
function isHorarioComercial() {
  const hora     = new Date().getHours();
  // Timezone adjustment se necessário (assumindo servidor em local time ou ajustado)
  const diaSemana = new Date().getDay(); // 0=Dom … 6=Sáb
  const inicio   = parseInt(process.env.PROSPECCAO_HORA_INICIO || '8', 10);
  const fim      = parseInt(process.env.PROSPECCAO_HORA_FIM    || '18', 10);
  return hora >= inicio && hora < fim && diaSemana >= 1 && diaSemana <= 5;
}

// ─── Delay aleatório (anti-ban) ───────────────────────────────────────────────
function delayAleatorio() {
  const min = parseInt(process.env.PROSPECCAO_DELAY_MIN_MS || '8000', 10);
  const max = parseInt(process.env.PROSPECCAO_DELAY_MAX_MS || '15000', 10);
  const ms  = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Envia mensagem de texto via Z-API ───────────────────────────────────────
async function enviarMensagem(numero, mensagem) {
  if (!process.env.ZAPI_INSTANCE_ID || !process.env.ZAPI_TOKEN) {
    throw new Error('Z-API não configurada. Preencha ZAPI_INSTANCE_ID e ZAPI_TOKEN no .env');
  }

  const res = await fetch(`${ZAPI_BASE()}/send-text`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': process.env.ZAPI_CLIENT_TOKEN || '',
    },
    body: JSON.stringify({ phone: numero, message: mensagem }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Z-API ${res.status}: ${err}`);
  }
  return res.json(); // { zaapId, messageId, id }
}

const MAX_CHUNK = parseInt(process.env.WHATSAPP_RESPOSTA_MAX_CHUNK || '380', 10);
const DELAY_CHUNK_MIN = parseInt(process.env.WHATSAPP_RESPOSTA_DELAY_MIN_MS || '550', 10);
const DELAY_CHUNK_MAX = parseInt(process.env.WHATSAPP_RESPOSTA_DELAY_MAX_MS || '1300', 10);

/**
 * Quebra texto em blocos curtos (parágrafos → frases) para parecer várias mensagens humanas.
 */
function quebrarTextoEmChunks(texto) {
  const t = String(texto || '').trim();
  if (!t) return [];

  let blocos = t.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  if (blocos.length === 0) blocos = [t];

  const out = [];
  for (const bloco of blocos) {
    if (bloco.length <= MAX_CHUNK) {
      out.push(bloco);
      continue;
    }
    let resto = bloco;
    while (resto.length > 0) {
      if (resto.length <= MAX_CHUNK) {
        out.push(resto.trim());
        break;
      }
      let corte = resto.lastIndexOf('. ', MAX_CHUNK);
      if (corte < Math.floor(MAX_CHUNK * 0.45)) corte = resto.lastIndexOf('! ', MAX_CHUNK);
      if (corte < Math.floor(MAX_CHUNK * 0.45)) corte = resto.lastIndexOf('? ', MAX_CHUNK);
      if (corte < Math.floor(MAX_CHUNK * 0.45)) corte = resto.lastIndexOf('\n', MAX_CHUNK);
      if (corte < Math.floor(MAX_CHUNK * 0.45)) corte = resto.lastIndexOf(' ', MAX_CHUNK);
      if (corte < 20) corte = MAX_CHUNK;
      const pedaco = resto.slice(0, corte + 1).trim();
      out.push(pedaco);
      resto = resto.slice(corte + 1).trim();
    }
  }

  const merged = [];
  for (const c of out) {
    if (!c) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.length + c.length + 2 <= MAX_CHUNK && prev.length < 90) {
      merged[merged.length - 1] = `${prev}\n\n${c}`;
    } else {
      merged.push(c);
    }
  }
  return merged.length ? merged : [t];
}

async function delayEntreChunks() {
  const ms = DELAY_CHUNK_MIN + Math.random() * (DELAY_CHUNK_MAX - DELAY_CHUNK_MIN);
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Envia resposta em várias bolhas de chat com pausas aleatórias.
 */
async function enviarTextoFracionado(numero, texto) {
  const chunks = quebrarTextoEmChunks(texto);
  if (chunks.length === 0) return;
  for (let i = 0; i < chunks.length; i++) {
    await enviarMensagem(numero, chunks[i]);
    if (i < chunks.length - 1) await delayEntreChunks();
  }
}

async function zapiPost(suffixPath, body) {
  if (!process.env.ZAPI_INSTANCE_ID || !process.env.ZAPI_TOKEN) {
    throw new Error('Z-API não configurada. Preencha ZAPI_INSTANCE_ID e ZAPI_TOKEN no .env');
  }
  const res = await fetch(`${ZAPI_BASE()}${suffixPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': process.env.ZAPI_CLIENT_TOKEN || '',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Z-API ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * Envia um arquivo de mídia (URL pública HTTPS) via Z-API.
 * type: image | video | document | audio
 */
async function enviarMidia(numero, { type, url, caption, fileName }) {
  const phone = numero;
  switch (type) {
    case 'image':
      return zapiPost('/send-image', { phone, image: url, caption: caption || '', viewOnce: false });
    case 'video':
      return zapiPost('/send-video', { phone, video: url, caption: caption || '', viewOnce: false });
    case 'document':
      return zapiPost('/send-document', {
        phone,
        document: url,
        fileName: fileName || 'documento.pdf',
      });
    case 'audio':
      return zapiPost('/send-audio', { phone, audio: url, viewOnce: false });
    default:
      throw new Error(`Tipo de mídia não suportado: ${type}`);
  }
}

const DELAY_ENTRE_MIDIAS_MS = 800;

/**
 * Envia múltiplas mídias do catálogo (server/media-manifest.json + public/media).
 */
async function enviarMidiasCatalogo(numero, mediaKeys) {
  if (!mediaKeys || !mediaKeys.length) return { enviados: 0 };

  const base = (process.env.PUBLIC_BASE_URL || '').trim();
  if (!base) {
    console.warn('[WhatsApp] PUBLIC_BASE_URL não definido; não é possível enviar mídias por URL.');
    return { skipped: true, motivo: 'PUBLIC_BASE_URL ausente' };
  }

  let enviados = 0;
  for (let i = 0; i < mediaKeys.length; i++) {
    const key = mediaKeys[i];
    const resolved = mediaCatalog.resolveMediaUrl(key);
    if (!resolved) {
      console.warn(`[WhatsApp] Mídia ignorada (chave inválida ou arquivo ausente): ${key}`);
      continue;
    }
    try {
      await enviarMidia(numero, { type: resolved.type, url: resolved.url, fileName: resolved.fileName, caption: resolved.caption });
      enviados++;
      if (i < mediaKeys.length - 1) await new Promise((r) => setTimeout(r, DELAY_ENTRE_MIDIAS_MS));
    } catch (err) {
      console.error(`[WhatsApp] Falha ao enviar mídia "${key}":`, err.message);
    }
  }
  return { enviados };
}

// ─── Disparo de lote de leads ─────────────────────────────────────────────────
async function dispararLote(leads, { limite = 10, gerarMensagemFn } = {}) {
  if (!isHorarioComercial()) {
    return { ignorado: true, motivo: 'Fora do horário comercial (Seg–Sex 8h–18h)' };
  }

  const limiteDiario = parseInt(process.env.PROSPECCAO_LIMITE_DIARIO || '40', 10);
  const enviosHoje = await db.getLeadsProspectadosHoje();

  if (enviosHoje >= limiteDiario) {
    return { ignorado: true, motivo: `Limite diário de ${limiteDiario} mensagens atingido` };
  }

  const maxEnvios  = Math.min(limite, limiteDiario - enviosHoje);
  const resultados = [];
  let contador = 0;

  for (const lead of leads) {
    if (contador >= maxEnvios) break;

    const numero = formatarNumero(lead.telefone1 || lead.telefone2);
    if (!numero) {
      resultados.push({ cnpj: lead.cnpj, status: 'ignorado', motivo: 'Número inválido' });
      continue;
    }

    // Verifica cooldown no DB
    if (await db.emCooldownDB(lead.cnpj)) {
      resultados.push({ cnpj: lead.cnpj, status: 'ignorado', motivo: 'Em cooldown' });
      continue;
    }

    // Lock no Redis para evitar envio duplicado em requisições paralelas
    const gotLock = await cache.acquireLock(`prosp:${lead.cnpj}`, 30);
    if (!gotLock) {
      resultados.push({ cnpj: lead.cnpj, status: 'ignorado', motivo: 'Lock de disparo ativo' });
      continue;
    }

    let mensagem;
    try {
      mensagem = gerarMensagemFn
        ? await gerarMensagemFn(lead)
        : templatePadrao(lead);
    } catch (err) {
      console.warn(`Erro ao gerar mensagem para ${lead.cnpj}:`, err.message);
      mensagem = templatePadrao(lead);
    }

    // Pega os dados anteriores de prospecção do DB pra atualizar tentativas
    const prospData = await db.getProspeccao(lead.cnpj) || { tentativas: 0 };

    try {
      const resposta = await enviarMensagem(numero, mensagem);
      
      await db.saveProspeccaoDB(lead.cnpj, {
        status: 'enviado',
        enviadoEm: new Date().toISOString(),
        zaapId: resposta.zaapId,
        messageId: resposta.messageId,
        mensagem,
        numero,
        tentativas: prospData.tentativas + 1,
      });

      // Se for a primeira vez que entra em contato, já jogamos o bot no contexto (simula que o bot mandou pra começar a conversa)
      await db.saveConversa(lead.cnpj, 'model', mensagem);
      await cache.appendMensagemConversa(lead.cnpj, 'model', mensagem);

      resultados.push({ cnpj: lead.cnpj, status: 'enviado', messageId: resposta.messageId });
      contador++;

      // Delay anti-ban antes do próximo envio
      if (contador < maxEnvios) await delayAleatorio();
    } catch (err) {
      await db.saveProspeccaoDB(lead.cnpj, {
        status: 'erro',
        enviadoEm: new Date().toISOString(),
        mensagem,
        numero,
        tentativas: prospData.tentativas + 1,
      });
      resultados.push({ cnpj: lead.cnpj, status: 'erro', motivo: err.message });
    }
  }

  return { disparados: contador, resultados };
}

// ─── Template padrão (fallback quando Gemini falha) ──────────────────────────
function templatePadrao(lead) {
  const agente  = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const empresa = lead.fantasia || lead.razao || 'sua empresa';
  return `Olá! 👋 Aqui é o/a *${agente}*, da *SA Comunicação* de Cajazeiras.

Vi que a *${empresa}* atua em ${lead.cidade || 'nossa região'} — ${lead.discurso_consultivo || lead.discursoConsultivo || 'e temos uma solução de mídia local que pode ajudar muito o seu negócio'}.

Posso te apresentar uma proposta rápida? 🚀`;
}

// ─── Processa webhook Z-API (resposta recebida) ───────────────────────────────
async function encontrarCnpjPorNumero(numero) {
  return await db.encontrarCnpjPorNumeroDB(numero);
}

module.exports = {
  enviarMensagem,
  enviarTextoFracionado,
  quebrarTextoEmChunks,
  enviarMidia,
  enviarMidiasCatalogo,
  dispararLote,
  formatarNumero,
  encontrarCnpjPorNumero,
  isHorarioComercial,
  templatePadrao,
};
