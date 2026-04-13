'use strict';

/**
 * Limita tamanho de strings para prompts (economia de tokens no Gemini / embeddings).
 */
function trunc(texto, maxChars) {
  if (texto == null || texto === '') return '';
  const s = String(texto).replace(/\s+/g, ' ').trim();
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)) + '…';
}

module.exports = { trunc };
