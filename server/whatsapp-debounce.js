'use strict';

/**
 * Agrupa várias mensagens do mesmo contato antes de chamar a IA (evita 1 resposta por tecla).
 * Usa timer deslizante após a última mensagem recebida.
 */

const DEBOUNCE_MS = parseInt(process.env.WHATSAPP_DEBOUNCE_MS || '2200', 10);
const MAX_ITENS = parseInt(process.env.WHATSAPP_DEBOUNCE_MAX_ITENS || '15', 10);

/** @type {Map<string, Promise<void>>} */
const chains = new Map();

/** @type {Map<string, { items: object[], timer: ReturnType<typeof setTimeout> | null, lead: object, cnpj: string }>} */
const buffers = new Map();

function enqueue(phone, fn) {
  const prev = chains.get(phone) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error('[Debounce]', phone, e.message));
  chains.set(phone, next);
  return next;
}

function mergeUserContents(items) {
  const texts = [];
  const parts = [];
  for (const uc of items) {
    if (!uc) continue;
    if (typeof uc === 'string') {
      if (uc.trim()) texts.push(uc.trim());
      continue;
    }
    if (uc.text && String(uc.text).trim()) texts.push(String(uc.text).trim());
    if (uc.parts && uc.parts.length) parts.push(...uc.parts);
  }
  const text = texts.join('\n\n').trim();
  return { text: text || '(mídia recebida)', parts };
}

/**
 * Agenda processamento após silêncio (debounce). Serializa por número para evitar corrida.
 * @param {string} phone dígitos
 * @param {{ userContent: object, lead: object, cnpj: string }} ctx
 * @param {(args: { merged: { text: string, parts: object[] }, lead: object, cnpj: string, phone: string }) => Promise<void>} handler
 */
function scheduleBatchedReply(phone, ctx, handler) {
  if (DEBOUNCE_MS <= 0) {
    enqueue(phone, async () => {
      const merged = mergeUserContents([ctx.userContent]);
      await handler({ merged, lead: ctx.lead, cnpj: ctx.cnpj, phone });
    });
    return;
  }

  enqueue(phone, async () => {
    let buf = buffers.get(phone);
    if (!buf) {
      buf = { items: [], timer: null, lead: ctx.lead, cnpj: ctx.cnpj };
    }
    buf.items.push(ctx.userContent);
    buf.lead = ctx.lead;
    buf.cnpj = ctx.cnpj;
    if (buf.items.length > MAX_ITENS) buf.items = buf.items.slice(-MAX_ITENS);

    if (buf.timer) clearTimeout(buf.timer);

    buf.timer = setTimeout(async () => {
      const items = [...buf.items];
      const lead = buf.lead;
      const cnpj = buf.cnpj;
      buffers.delete(phone);
      const merged = mergeUserContents(items);
      try {
        await handler({ merged, lead, cnpj, phone });
      } catch (e) {
        console.error('[Debounce] Falha no handler:', e.message);
      }
    }, DEBOUNCE_MS);

    buffers.set(phone, buf);
  });
}

module.exports = {
  scheduleBatchedReply,
  mergeUserContents,
  DEBOUNCE_MS,
};
