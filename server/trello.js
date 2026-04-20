'use strict';

const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.TRELLO_TIMEOUT_MS || '15000', 10);
const DEFAULT_RETRIES = Number.parseInt(process.env.TRELLO_RETRY_ATTEMPTS || '3', 10);
const TRELLO_BASE_URL = 'https://api.trello.com/1';

function getConfig() {
  return {
    key: String(process.env.TRELLO_KEY || '').trim(),
    token: String(process.env.TRELLO_TOKEN || '').trim(),
    listIdOpec: String(process.env.TRELLO_LIST_ID_OPEC || '').trim(),
  };
}

function assertConfigured() {
  const cfg = getConfig();
  if (!cfg.key || !cfg.token || !cfg.listIdOpec) {
    throw new Error('Integração Trello incompleta: defina TRELLO_KEY, TRELLO_TOKEN e TRELLO_LIST_ID_OPEC.');
  }
  return cfg;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, { retries = DEFAULT_RETRIES } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429) {
        lastError = new Error(`Trello HTTP ${res.status}`);
      } else {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Trello HTTP ${res.status}: ${bodyText}`.trim());
      }
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await wait(500 * attempt);
  }
  throw lastError || new Error('Falha inesperada ao chamar Trello.');
}

function withAuthQuery(url) {
  const cfg = assertConfigured();
  const next = new URL(url);
  next.searchParams.set('key', cfg.key);
  next.searchParams.set('token', cfg.token);
  return next.toString();
}

async function createOpecCard({ title, description }) {
  const cfg = assertConfigured();
  const url = new URL(`${TRELLO_BASE_URL}/cards`);
  url.searchParams.set('idList', cfg.listIdOpec);
  url.searchParams.set('name', String(title || 'Solicitação OPEC sem título').slice(0, 160));
  url.searchParams.set('desc', String(description || '').slice(0, 16000));
  const res = await fetchWithRetry(withAuthQuery(url.toString()), {
    method: 'POST',
  });
  const payload = await res.json();
  return {
    id: payload.id,
    url: payload.url,
    name: payload.name,
  };
}

async function attachFileToCard({ cardId, fileName, mimeType, buffer }) {
  if (!cardId) throw new Error('cardId é obrigatório para anexar arquivo no Trello.');
  const safeName = String(fileName || 'anexo').slice(0, 180);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), safeName);
  form.append('name', safeName);

  const url = withAuthQuery(`${TRELLO_BASE_URL}/cards/${encodeURIComponent(cardId)}/attachments`);
  const res = await fetchWithRetry(url, {
    method: 'POST',
    body: form,
  });
  const payload = await res.json();
  return {
    id: payload.id,
    url: payload.url,
    name: payload.name,
  };
}

async function createCardWithAttachments({ title, description, attachments = [] }) {
  const card = await createOpecCard({ title, description });
  const uploaded = [];
  const failed = [];

  for (const attachment of attachments) {
    try {
      const result = await attachFileToCard({
        cardId: card.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        buffer: attachment.buffer,
      });
      uploaded.push(result);
    } catch (err) {
      failed.push({
        fileName: attachment.fileName,
        reason: err.message,
      });
    }
  }

  return {
    card,
    uploaded,
    failed,
  };
}

module.exports = {
  createOpecCard,
  attachFileToCard,
  createCardWithAttachments,
  assertConfigured,
};
