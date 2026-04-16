'use strict';

/**
 * Driver Evolution API (MVP).
 *
 * Como existem várias "Evolution API" no mercado com rotas diferentes,
 * este driver é um esqueleto seguro: habilita a seleção via configuração
 * e falha com erro claro até as variáveis/endpoints estarem corretos.
 *
 * Variáveis sugeridas:
 * - EVOLUTION_BASE_URL (ex: https://seu-servidor-evolution.com)
 * - EVOLUTION_API_KEY  (se aplicável)
 * - EVOLUTION_INSTANCE (se aplicável)
 */

function assertConfigured() {
  const base = (process.env.EVOLUTION_BASE_URL || '').trim();
  if (!base) {
    throw new Error('Evolution API não configurada. Defina EVOLUTION_BASE_URL no .env');
  }
}

function baseUrl() {
  return (process.env.EVOLUTION_BASE_URL || '').trim().replace(/\/$/, '');
}

function headersJson() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.EVOLUTION_API_KEY) h.Authorization = `Bearer ${process.env.EVOLUTION_API_KEY}`;
  return h;
}

async function sendText({ phone, message }) {
  assertConfigured();
  throw new Error('Evolution API: sendText ainda não implementado (preciso do endpoint oficial da sua Evolution).');
}

async function sendMedia({ phone, type, url, caption, fileName }) {
  assertConfigured();
  throw new Error('Evolution API: sendMedia ainda não implementado (preciso do endpoint oficial da sua Evolution).');
}

module.exports = {
  id: 'evolution',
  baseUrl,
  headersJson,
  sendText,
  sendMedia,
};

