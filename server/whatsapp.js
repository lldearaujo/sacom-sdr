'use strict';

const fs   = require('fs');
const path = require('path');

const CACHE_DIR        = path.join(__dirname, '..', '.cache');
const PROSPECCAO_FILE  = path.join(CACHE_DIR, 'prospeccao.json');

const ZAPI_BASE = () =>
  `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;

// ─── Cache de prospecção ──────────────────────────────────────────────────────
function loadProspeccao() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(PROSPECCAO_FILE)) return {};
    return JSON.parse(fs.readFileSync(PROSPECCAO_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveProspeccao(data) {
  try {
    fs.writeFileSync(PROSPECCAO_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Falha ao salvar cache de prospecção:', err.message);
  }
}

// ─── Formata número BR para padrão Z-API (5583999999999) ─────────────────────
function formatarNumero(telefone) {
  if (!telefone) return null;
  const digits = telefone.replace(/\D/g, '');
  if (!digits) return null;
  const comDDI = digits.startsWith('55') ? digits : `55${digits}`;
  // Celular: 13 dígitos | Fixo: 12 dígitos
  if (comDDI.length < 12 || comDDI.length > 13) return null;
  return comDDI;
}

// ─── Verifica horário comercial (Seg–Sex, 8h–18h) ────────────────────────────
function isHorarioComercial() {
  const hora     = new Date().getHours();
  const diaSemana = new Date().getDay(); // 0=Dom … 6=Sáb
  const inicio   = parseInt(process.env.PROSPECCAO_HORA_INICIO || '8', 10);
  const fim      = parseInt(process.env.PROSPECCAO_HORA_FIM    || '18', 10);
  return hora >= inicio && hora < fim && diaSemana >= 1 && diaSemana <= 5;
}

// ─── Verifica cooldown de um lead ────────────────────────────────────────────
function emCooldown(cnpj, cache) {
  const entry = cache[cnpj];
  if (!entry?.enviadoEm) return false;
  const diasPassados = (Date.now() - Date.parse(entry.enviadoEm)) / (1000 * 60 * 60 * 24);
  const cooldown = parseInt(process.env.PROSPECCAO_COOLDOWN_DIAS || '30', 10);
  return diasPassados < cooldown;
}

// ─── Delay aleatório (anti-ban) ───────────────────────────────────────────────
function delayAleatorio() {
  const min = parseInt(process.env.PROSPECCAO_DELAY_MIN_MS || '8000', 10);
  const max = parseInt(process.env.PROSPECCAO_DELAY_MAX_MS || '15000', 10);
  const ms  = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Envia mensagem de texto via Z-API ───────────────────────────────────────
async function enviarMensagem(numero, mensagem) {
  if (!process.env.ZAPI_INSTANCE_ID || !process.env.ZAPI_TOKEN) {
    throw new Error('Z-API não configurada. Preencha ZAPI_INSTANCE_ID e ZAPI_TOKEN no .env');
  }

  const res = await fetch(`${ZAPI_BASE()}/send-text`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Client-Token': process.env.ZAPI_CLIENT_TOKEN || '',
    },
    body: JSON.stringify({ phone: numero, message: mensagem }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Z-API ${res.status}: ${err}`);
  }
  return res.json(); // { zaapId, messageId, id }
}

// ─── Disparo de lote de leads ─────────────────────────────────────────────────
// gerarMensagemFn: função async (lead) => string — pode ser Gemini ou template fixo
async function dispararLote(leads, { limite = 10, gerarMensagemFn } = {}) {
  if (!isHorarioComercial()) {
    return { ignorado: true, motivo: 'Fora do horário comercial (Seg–Sex 8h–18h)' };
  }

  const cache = loadProspeccao();
  const limiteDiario = parseInt(process.env.PROSPECCAO_LIMITE_DIARIO || '40', 10);

  const hoje = new Date().toISOString().slice(0, 10);
  const enviosHoje = Object.values(cache).filter(e => e.enviadoEm?.startsWith(hoje)).length;

  if (enviosHoje >= limiteDiario) {
    return { ignorado: true, motivo: `Limite diário de ${limiteDiario} mensagens atingido` };
  }

  const maxEnvios  = Math.min(limite, limiteDiario - enviosHoje);
  const resultados = [];
  let contador = 0;

  for (const lead of leads) {
    if (contador >= maxEnvios) break;

    const numero = formatarNumero(lead.telefone1 || lead.telefone2);
    if (!numero) {
      resultados.push({ cnpj: lead.cnpj, status: 'ignorado', motivo: 'Número inválido' });
      continue;
    }

    if (emCooldown(lead.cnpj, cache)) {
      resultados.push({ cnpj: lead.cnpj, status: 'ignorado', motivo: 'Em cooldown' });
      continue;
    }

    let mensagem;
    try {
      mensagem = gerarMensagemFn
        ? await gerarMensagemFn(lead)
        : templatePadrão(lead);
    } catch (err) {
      console.warn(`Erro ao gerar mensagem para ${lead.cnpj}:`, err.message);
      mensagem = templatePadrão(lead);
    }

    try {
      const resposta = await enviarMensagem(numero, mensagem);
      cache[lead.cnpj] = {
        status:     'enviado',
        enviadoEm:  new Date().toISOString(),
        zaapId:     resposta.zaapId,
        messageId:  resposta.messageId,
        mensagem,
        numero,
        respondidoEm: null,
        notas:      '',
        tentativas: (cache[lead.cnpj]?.tentativas || 0) + 1,
      };
      saveProspeccao(cache);
      resultados.push({ cnpj: lead.cnpj, status: 'enviado', messageId: resposta.messageId });
      contador++;

      // Delay anti-ban antes do próximo envio
      if (contador < maxEnvios) await delayAleatorio();
    } catch (err) {
      cache[lead.cnpj] = {
        ...(cache[lead.cnpj] || {}),
        status:    'erro',
        erro:      err.message,
        enviadoEm: new Date().toISOString(),
      };
      saveProspeccao(cache);
      resultados.push({ cnpj: lead.cnpj, status: 'erro', motivo: err.message });
    }
  }

  return { disparados: contador, resultados };
}

// ─── Template padrão (fallback quando Gemini falha) ──────────────────────────
function templatePadrão(lead) {
  const agente  = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const empresa = lead.fantasia || lead.razao || 'sua empresa';
  return `Olá! 👋 Aqui é o/a *${agente}*, da *SA Comunicação* de Cajazeiras.

Vi que a *${empresa}* atua em ${lead.cidade} — ${lead.discursoConsultivo || 'e temos uma solução de mídia local que pode ajudar muito o seu negócio'}.

Posso te apresentar uma proposta rápida? 🚀`;
}

// ─── Processa webhook Z-API (resposta recebida) ───────────────────────────────
function encontrarCnpjPorNumero(numero, cache) {
  const numLimpo = numero.replace(/\D/g, '');
  return Object.keys(cache).find(cnpj => {
    const numCache = (cache[cnpj].numero || '').replace(/\D/g, '');
    return numCache === numLimpo;
  });
}

module.exports = {
  loadProspeccao,
  saveProspeccao,
  enviarMensagem,
  dispararLote,
  formatarNumero,
  encontrarCnpjPorNumero,
  isHorarioComercial,
  templatePadrão,
};
