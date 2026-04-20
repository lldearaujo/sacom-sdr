'use strict';

const crypto = require('crypto');

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmailContent({ subject, bodyText }) {
  return {
    subject: normalizeWhitespace(subject),
    bodyText: normalizeWhitespace(bodyText),
  };
}

function sanitizeAttachmentName(fileName) {
  return String(fileName || 'anexo_sem_nome')
    .replace(/[^\w.\-]/g, '_')
    .slice(0, 180);
}

function isAttachmentAllowed({ mimeType, sizeBytes, maxMb = 15 }) {
  const safeBytes = Number.isFinite(sizeBytes) ? sizeBytes : 0;
  const maxBytes = Math.max(1, Number(maxMb) || 15) * 1024 * 1024;
  if (safeBytes <= 0 || safeBytes > maxBytes) return false;

  const safeMime = String(mimeType || '').toLowerCase();
  if (!safeMime) return true;
  if (safeMime.startsWith('application/x-dosexec')) return false;
  return true;
}

function computeContentHash({ subject, bodyText, attachmentsMeta = [] }) {
  const normalized = normalizeEmailContent({ subject, bodyText });
  const safeMeta = Array.isArray(attachmentsMeta) ? attachmentsMeta : [];
  const digestSource = JSON.stringify({
    subject: normalized.subject.toLowerCase(),
    bodyText: normalized.bodyText.toLowerCase(),
    attachments: safeMeta
      .map((item) => ({
        fileName: String(item.fileName || '').toLowerCase(),
        size: Number(item.size || 0),
        mimeType: String(item.mimeType || '').toLowerCase(),
      }))
      .sort((a, b) => (a.fileName > b.fileName ? 1 : -1)),
  });
  return crypto.createHash('sha256').update(digestSource).digest('hex');
}

module.exports = {
  normalizeEmailContent,
  sanitizeAttachmentName,
  isAttachmentAllowed,
  computeContentHash,
};
