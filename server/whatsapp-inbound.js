'use strict';

/**
 * Webhook Z-API — mensagens recebidas (texto + mídia).
 * @see https://developer.z-api.io/en/webhooks/on-message-received-examples
 */

const MAX_BYTES = parseInt(process.env.INBOUND_MEDIA_MAX_BYTES || String(15 * 1024 * 1024), 10);

function normalizeMime(m) {
  if (!m) return 'application/octet-stream';
  let s = String(m).split(';')[0].trim().toLowerCase();
  if (s === 'audio/ogg') return 'audio/ogg';
  if (s.startsWith('audio/')) return s.split(' ')[0];
  return s;
}

async function fetchMediaBuffer(url) {
  if (!url || typeof url !== 'string') throw new Error('URL de mídia ausente');
  const headers = { Accept: '*/*' };
  if (process.env.ZAPI_CLIENT_TOKEN) headers['Client-Token'] = process.env.ZAPI_CLIENT_TOKEN;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`Arquivo maior que ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);
  }
  return buf;
}

/** @returns {Promise<{ text: string, parts: object[] } | null>} */
async function buildUserContentFromPayload(payload) {
  if (!payload || payload.fromMe) return null;

  if (payload.text?.message && !payload.image && !payload.audio && !payload.video && !payload.document) {
    return { text: payload.text.message, parts: [] };
  }

  try {
    if (payload.image?.imageUrl) {
      const buf = await fetchMediaBuffer(payload.image.imageUrl);
      const mime = normalizeMime(payload.image.mimeType || 'image/jpeg');
      const caption = (payload.image.caption || '').trim();
      const text =
        caption ||
        'O cliente enviou uma imagem. Analise o conteúdo visual e responda como consultora BDR (SA Comunicação), de forma natural no WhatsApp.';
      return {
        text,
        parts: [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }],
      };
    }

    if (payload.document?.documentUrl) {
      const buf = await fetchMediaBuffer(payload.document.documentUrl);
      let mime = normalizeMime(payload.document.mimeType || 'application/pdf');
      if (mime === 'application/octet-stream') mime = 'application/pdf';
      const name = payload.document.fileName || payload.document.title || 'documento';
      const text = `O cliente enviou o documento "${name}". Leia o conteúdo e responda ao que for relevante para a conversa comercial (mídia OOH/DOOH).`;
      return {
        text,
        parts: [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }],
      };
    }

    if (payload.audio?.audioUrl) {
      const buf = await fetchMediaBuffer(payload.audio.audioUrl);
      const mime = normalizeMime(payload.audio.mimeType || 'audio/ogg');
      const text =
        'O cliente enviou um áudio. Compreenda o que foi dito e responda de forma natural, como consultora BDR.';
      return {
        text,
        parts: [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }],
      };
    }

    if (payload.video?.videoUrl) {
      const buf = await fetchMediaBuffer(payload.video.videoUrl);
      const mime = normalizeMime(payload.video.mimeType || 'video/mp4');
      const cap = (payload.video.caption || '').trim();
      const text =
        cap ||
        'O cliente enviou um vídeo. Analise o que for relevante para a conversa comercial e responda.';
      return {
        text,
        parts: [{ inlineData: { mimeType: mime, data: buf.toString('base64') } }],
      };
    }
  } catch (e) {
    console.error('[Inbound] Erro ao baixar/processar mídia:', e.message);
    return {
      text: `Não consegui acessar o arquivo enviado (${e.message}). Peça ao cliente para reenviar em formato menor ou descrever em texto.`,
      parts: [],
    };
  }

  if (payload.text?.message) {
    return { text: payload.text.message, parts: [] };
  }

  return null;
}

function textoParaHistorico(userInput) {
  if (typeof userInput === 'string') return userInput;
  const t = userInput?.text || '';
  const extra = userInput?.parts?.length ? '\n[📎 mídia recebida: imagem, vídeo, PDF ou áudio]' : '';
  return (t + extra).trim();
}

module.exports = {
  buildUserContentFromPayload,
  textoParaHistorico,
  MAX_BYTES,
};
