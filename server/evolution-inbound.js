'use strict';

/**
 * Parser tolerante para webhooks "Evolution API".
 *
 * Existem várias distribuições da Evolution no mercado com payloads diferentes.
 * Este módulo tenta extrair, de forma defensiva:
 * - número do remetente (somente dígitos, ex: 5583999999999)
 * - texto (conversation / extendedTextMessage / message.text etc.)
 * - ignore mensagens enviadas por nós (fromMe)
 *
 * Quando não conseguir extrair com segurança, retorna null para o caller logar e ignorar.
 */

function asObj(x) {
  return x && typeof x === 'object' ? x : null;
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

function pick(obj, path) {
  let cur = obj;
  for (const k of path) {
    cur = asObj(cur)?.[k];
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

function extractRemoteJid(payload) {
  // Padrões comuns: data.key.remoteJid, key.remoteJid, message.key.remoteJid...
  return (
    pick(payload, ['data', 'key', 'remoteJid']) ||
    pick(payload, ['key', 'remoteJid']) ||
    pick(payload, ['message', 'key', 'remoteJid']) ||
    pick(payload, ['data', 'messages', 0, 'key', 'remoteJid']) ||
    pick(payload, ['messages', 0, 'key', 'remoteJid'])
  );
}

function extractFromMe(payload) {
  const v =
    pick(payload, ['data', 'key', 'fromMe']) ??
    pick(payload, ['key', 'fromMe']) ??
    pick(payload, ['message', 'key', 'fromMe']) ??
    pick(payload, ['data', 'messages', 0, 'key', 'fromMe']) ??
    pick(payload, ['messages', 0, 'key', 'fromMe']);
  return Boolean(v);
}

function extractMessageNode(payload) {
  return (
    pick(payload, ['data', 'message']) ||
    pick(payload, ['message']) ||
    pick(payload, ['data', 'messages', 0, 'message']) ||
    pick(payload, ['messages', 0, 'message']) ||
    null
  );
}

function extractTextFromMessage(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;

  // Baileys-style
  const conversation = msg.conversation;
  if (typeof conversation === 'string') return conversation;

  const ext = msg.extendedTextMessage;
  if (ext && typeof ext.text === 'string') return ext.text;

  // Outros formatos
  if (typeof msg.text === 'string') return msg.text;
  if (typeof msg.message === 'string') return msg.message;

  // Template / buttons
  const template =
    msg.templateButtonReplyMessage?.selectedDisplayText ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title;
  if (typeof template === 'string') return template;

  return '';
}

function extractPhoneDigits(payload) {
  const remoteJid = extractRemoteJid(payload);
  if (typeof remoteJid === 'string' && remoteJid.includes('@')) {
    const raw = remoteJid.split('@')[0];
    return digitsOnly(raw);
  }

  // fallback: alguns payloads mandam "from"/"sender"/"phone"
  const alt =
    payload?.from ||
    payload?.sender ||
    payload?.phone ||
    pick(payload, ['data', 'from']) ||
    pick(payload, ['data', 'sender']) ||
    pick(payload, ['data', 'phone']);
  return digitsOnly(alt);
}

/**
 * @returns {null | { phone: string, userContent: { text: string, parts: object[] } }}
 */
function buildInboundFromEvolutionPayload(payload) {
  if (!payload) return null;
  if (extractFromMe(payload)) return null;

  const msg = extractMessageNode(payload);
  const text = extractTextFromMessage(msg).trim();
  const phone = extractPhoneDigits(payload);

  // Por enquanto, só texto (sem mídia). Dá pra evoluir depois com download de media se precisar.
  if (!phone || phone.length < 10) return null;
  if (!text) return null;

  return { phone, userContent: { text, parts: [] } };
}

module.exports = {
  buildInboundFromEvolutionPayload,
};

