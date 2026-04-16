'use strict';

const db = require('./db');
const fs = require('fs');
const path = require('path');

const PUBLIC_MEDIA_DIR = path.join(__dirname, '..', 'public', 'media');
const ALLOWED_TYPES = new Set(['image', 'video', 'document', 'audio']);

/**
 * Carrega o catálogo de mídias do Banco de Dados.
 * Mantemos o nome 'loadManifest' para compatibilidade, mas agora busca no PG.
 */
async function loadManifest() {
  try {
    const rows = await db.getMediaCatalog();
    const manifest = {};
    rows.forEach(r => {
      manifest[r.key] = {
        file: r.filename,
        type: r.type,
        fileName: r.filename,
        caption: (r.metadata && r.metadata.caption) || '',
        descricao: (r.metadata && r.metadata.descricao) || '',
      };
    });
    return manifest;
  } catch (err) {
    console.error('Erro ao carregar catálogo do banco:', err.message);
    return {};
  }
}

async function getManifestEntry(key) {
  if (!key || typeof key !== 'string' || key.startsWith('_')) return null;
  const m = await loadManifest();
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
  return fs.existsSync(full);
}

/**
 * Resolve URL + metadados para envio Z-API.
 */
async function resolveMediaUrl(key) {
  const base = (process.env.PUBLIC_BASE_URL || '').trim();
  if (!base) return null;

  const entry = await getManifestEntry(key);
  if (!entry || !entry.file || !entry.type) return null;
  if (!ALLOWED_TYPES.has(String(entry.type))) return null;
  
  // No fluxo de bootstrap, garantimos que o arquivo existe fisicamente.
  // Se não existir, tentamos restaurar agora (on-demand fallback)
  if (!fileExistsInPublicMedia(entry.file)) {
      const fileRow = await db.getMediaFile(key);
      if (fileRow) fs.writeFileSync(path.join(PUBLIC_MEDIA_DIR, entry.file), fileRow.file_data);
  }

  const url = `${base.replace(/\/$/, '')}/media/${encodeURIComponent(entry.file)}`;
  return {
    url,
    type: String(entry.type),
    fileName: entry.fileName || entry.file || 'arquivo',
    caption: typeof entry.caption === 'string' ? entry.caption : '',
  };
}

/**
 * Salva ou atualiza uma mídia no banco de dados.
 */
async function saveMedia(key, entry, fileBuffer = null) {
  if (!key || typeof key !== 'string') throw new Error('Chave inválida');
  
  const metadata = {
      caption: entry.caption || '',
      descricao: entry.descricao || ''
  };

  // Se recebemos um buffer, salvamos no Postgres (persistência absoluta)
  if (fileBuffer) {
      await db.saveMediaEntry(key, entry.file, entry.type, fileBuffer, metadata);
  }
  
  return entry;
}

/**
 * Remove uma mídia do banco e da pasta física.
 */
async function deleteMedia(key) {
  const entry = await getManifestEntry(key);
  if (entry && entry.file) {
    const full = path.join(PUBLIC_MEDIA_DIR, entry.file);
    if (fs.existsSync(full)) {
      try { fs.unlinkSync(full); } catch (e) { /* ignore */ }
    }
  }
  await db.deleteMediaEntry(key);
  return true;
}

/**
 * Texto para injetar no system prompt.
 */
async function blocoPromptMidia() {
  const m = await loadManifest();
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
## Mídia Disponível
Mande arquivos usando a tag [[MEDIA:chave]] no fim da resposta.
${lines.join('\n')}
`;
}

/**
 * Substitui tags por links reais. Pequeno delay para garantir que resolveMediaUrl seja await.
 */
async function extrairMidiasDaResposta(texto) {
  if (!texto) return { texto: '', mediaKeys: [] };
  
  const tagRegex = /\[\[MEDIA:([a-zA-Z0-9_-]+)\]\]/g;
  const mediaKeys = [];
  let processado = texto;

  const matches = [...texto.matchAll(tagRegex)];
  for (const match of matches) {
    const key = match[1];
    mediaKeys.push(key);
    
    const resolved = await resolveMediaUrl(key);
    let substituto = '';
    
    if (resolved && resolved.url) {
      substituto = `\n\n🔗 *Link do material:* ${resolved.url}\n`;
    } else {
      substituto = `\n\n📁 [Arquivo: ${key}]\n`;
    }
    processado = processado.replace(`[[MEDIA:${key}]]`, substituto);
  }

  const textoFinal = processado.replace(/\n{3,}/g, '\n\n').trim();
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
