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
 * Salva ou atualiza uma mídia no catálogo.
 */
function saveMedia(key, entry) {
  if (!key || typeof key !== 'string') throw new Error('Chave inválida');
  const m = loadManifest();
  m[key] = {
    file: entry.file,
    type: entry.type,
    fileName: entry.fileName || entry.file,
    caption: entry.caption || '',
    descricao: entry.descricao || '',
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf8');
  return m[key];
}

/**
 * Remove uma mídia do catálogo e opcionalmente apaga o arquivo físico.
 */
function deleteMedia(key, deleteFile = true) {
  const m = loadManifest();
  const entry = m[key];
  if (!entry) return false;

  if (deleteFile && entry.file) {
    const full = path.join(PUBLIC_MEDIA_DIR, entry.file);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); } catch (e) { console.warn('Falha ao deletar arquivo físico:', e.message); }
    }
  }

  delete m[key];
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2), 'utf8');
  return true;
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
    const desc = e && e.descricao ? ` ${String(e.descricao).slice(0, 60)}` : '';
    return `- [[MEDIA:${k}]] ${tipo} ${arq}${desc}`;
  });

  return `

## Mídia (opcional)
No fim da resposta, uma linha por arquivo: [[MEDIA:chave]]
${lines.join('\n')}
(só chaves listadas; senão omita.)`;
}

/**
 * Remove marcações [[MEDIA:...]] e devolve lista de chaves na ordem.
 */
function extrairMidiasDaResposta(texto) {
  if (!texto) return { texto: '', mediaKeys: [] };
  
  const tagRegex = /\[\[MEDIA:([a-zA-Z0-9_-]+)\]\]/g;
  const mediaKeys = [];
  let processado = texto;

  // Encontra todas as ocorrências
  let match;
  while ((match = tagRegex.exec(texto)) !== null) {
    const key = match[1];
    mediaKeys.push(key);
    
    // Tenta resolver o link para colocar no texto
    const resolved = resolveMediaUrl(key);
    let substituto = '';
    
    if (resolved && resolved.url) {
      substituto = `\n\n🔗 *Link do material:* ${resolved.url}\n`;
    } else {
      // Fallback caso a PUBLIC_BASE_URL não esteja configurada
      substituto = `\n\n📁 [Arquivo: ${key} disponíveis para envio]\n`;
    }
    
    // Substitui a tag específica no texto processado
    processado = processado.replace(`[[MEDIA:${key}]]`, substituto);
  }

  // Limpeza final de espaços redundantes
  const textoFinal = processado
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { texto: textoFinal, mediaKeys };
}

module.exports = {
  loadManifest,
  resolveMediaUrl,
  blocoPromptMidia,
  extrairMidiasDaResposta,
  fileExistsInPublicMedia,
  saveMedia,
  deleteMedia,
};
