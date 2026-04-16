'use strict';

function zapiBase() {
  return `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;
}

function assertConfigured() {
  if (!process.env.ZAPI_INSTANCE_ID || !process.env.ZAPI_TOKEN) {
    throw new Error('Z-API não configurada. Preencha ZAPI_INSTANCE_ID e ZAPI_TOKEN no .env');
  }
}

async function sendText({ phone, message }) {
  assertConfigured();
  const res = await fetch(`${zapiBase()}/send-text`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': process.env.ZAPI_CLIENT_TOKEN || '',
    },
    body: JSON.stringify({ phone, message }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Z-API ${res.status}: ${err}`);
  }
  return res.json();
}

async function post(pathSuffix, body) {
  assertConfigured();
  const res = await fetch(`${zapiBase()}${pathSuffix}`, {
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

async function sendMedia({ phone, type, url, caption, fileName }) {
  console.log(`[Z-API] Tentando enviar mídia: tipo=${type}, url=${url}`);
  switch (type) {
    case 'image':
      return post('/send-image', { phone, image: url, caption: caption || '', viewOnce: false });
    case 'video':
      return post('/send-video', { phone, video: url, caption: caption || '', viewOnce: false });
    case 'document':
      return post('/send-document', { phone, document: url, fileName: fileName || 'documento.pdf' });
    case 'audio':
      return post('/send-audio', { phone, audio: url, viewOnce: false });
    default:
      throw new Error(`Tipo de mídia não suportado: ${type}`);
  }
}

module.exports = {
  id: 'zapi',
  sendText,
  sendMedia,
};

