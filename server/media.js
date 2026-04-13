'use strict';

/**
 * Catálogo de mídia para WhatsApp (Z-API): arquivos em public/media/ + manifest.
 * URLs públicas: PUBLIC_BASE_URL + /media/<arquivo>
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join(__dirname, 'media-manifest.json');
const PUBLIC_MEDIA_DIR = path.join(__dirname, '..', 'public', 'media');

const ALLOWED_TYPES = new Set(['image', 'video', 'document', 'audio']);

function loadManifest() {
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getManifestEntry(key) {
  if (!key || typeof key !== 'string' || key.startsWith('_')) return null;
  const m = loadManifest();
  return m[key] || null;
}

function validateBasename(file) {
  if (!file || typeof file !== 'string') return false;
  const base = path.basename(file);
  if (base !== file) return false;
  if (base.includes('..') || base.includes('/') || base.includes('\\')) return false;
  return true;
}

function fileExistsInPublicMedia(file) {
  if (!validateBasename(file)) return false;
  const full = path.join(PUBLIC_MEDIA_DIR, file);
  if (!full.startsWith(PUBLIC_MEDIA_DIR)) return false;
  return fs.existsSync(full);
}

/**
 * Resolve URL + metadados para envio Z-API. Retorna null se inválido.
 */
function resolveMediaUrl(key) {
  const base = (process.env.PUBLIC_BASE_URL || '').trim();
  if (!base) return null;

  const entry = getManifestEntry(key);
  if (!entry || !entry.file || !entry.type) return null;
  if (!ALLOWED_TYPES.has(String(entry.type))) return null;
  if (!fileExistsInPublicMedia(entry.file)) return null;

  const url = `${base.replace(/\/$/, '')}/media/${encodeURIComponent(entry.file)}`;
  return {
    url,
    type: String(entry.type),
    fileName: entry.fileName || entry.file || 'arquivo',
    caption: typeof entry.caption === 'string' ? entry.caption : '',
  };
}

/**
 * Texto para injetar no system prompt (lista de chaves).
 */
function blocoPromptMidia() {
  const m = loadManifest();
  const keys = Object.keys(m).filter((k) => !k.startsWith('_'));
  if (keys.length === 0) return '';

  const lines = keys.map((k) => {
    const e = m[k];
    const tipo = e && e.type ? e.type : '?';
    const arq = e && e.file ? e.file : '';
    const desc = e && e.descricao ? ` — ${e.descricao}` : '';
    return `- [[MEDIA:${k}]] → ${tipo}: ${arq}${desc}`;
  });

  return `

## MÍDIA DO CATÁLOGO (WhatsApp)
Quando fizer sentido (ex.: lead pediu tabela, portfólio, áudio institucional), você pode anexar arquivos **já cadastrados** no servidor.
Inclua **no final** da sua resposta, uma linha por arquivo, usando exatamente esta marcação (chaves válidas abaixo):
[[MEDIA:chave]]

Chaves disponíveis:
${lines.join('\n')}

Não invente chaves. Se nenhuma mídia for adequada, não use [[MEDIA:...]].`;
}

/**
 * Remove marcações [[MEDIA:...]] e devolve lista de chaves na ordem.
 */
function extrairMidiasDaResposta(texto) {
  if (!texto) return { texto: '', mediaKeys: [] };
  const tag = /\[\[MEDIA:([a-zA-Z0-9_-]+)\]\]/g;
  const mediaKeys = [];
  let m;
  while ((m = tag.exec(texto)) !== null) mediaKeys.push(m[1]);

  const textoSem = texto
    .replace(/\[\[MEDIA:[a-zA-Z0-9_-]+\]\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { texto: textoSem, mediaKeys };
}

module.exports = {
  loadManifest,
  resolveMediaUrl,
  blocoPromptMidia,
  extrairMidiasDaResposta,
  fileExistsInPublicMedia,
};
