'use strict';

const db = require('./db');
const cache = require('./cache'); // Usaremos para locks

const ZAPI_BASE = () =>
  `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`;

// ─── Formata número BR para padrão Z-API (5583999999999) ─────────────────────
function formatarNumero(telefone) {
  if (!telefone) return null;
  const digits = telefone.replace(/\\D/g, '');
  if (!digits) return null;
  const comDDI = digits.startsWith('55') ? digits : `55${digits}`;
  // Celular: 13 dígitos | Fixo: 12 dígitos
  if (comDDI.length < 12 || comDDI.length > 13) return null;
  return comDDI;
}

// ─── Verifica horário comercial (Seg–Sex, 8h–18h) ────────────────────────────
function isHorarioComercial() {
  const hora     = new Date().getHours();
  // Timezone adjustment se necessário (assumindo servidor em local time ou ajustado)
  const diaSemana = new Date().getDay(); // 0=Dom … 6=Sáb
  const inicio   = parseInt(process.env.PROSPECCAO_HORA_INICIO || '8', 10);
  const fim      = parseInt(process.env.PROSPECCAO_HORA_FIM    || '18', 10);
  return hora >= inicio && hora < fim && diaSemana >= 1 && diaSemana <= 5;
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
async function dispararLote(leads, { limite = 10, gerarMensagemFn } = {}) {
  if (!isHorarioComercial()) {
    return { ignorado: true, motivo: 'Fora do horário comercial (Seg–Sex 8h–18h)' };
  }

  const limiteDiario = parseInt(process.env.PROSPECCAO_LIMITE_DIARIO || '40', 10);
  const enviosHoje = await db.getLeadsProspectadosHoje();

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

    // Verifica cooldown no DB
    if (await db.emCooldownDB(lead.cnpj)) {
      resultados.push({ cnpj: lead.cnpj, status: 'ignorado', motivo: 'Em cooldown' });
      continue;
    }

    // Lock no Redis para evitar envio duplicado em requisições paralelas
    const gotLock = await cache.acquireLock(`prosp:${lead.cnpj}`, 30);
    if (!gotLock) {
      resultados.push({ cnpj: lead.cnpj, status: 'ignorado', motivo: 'Lock de disparo ativo' });
      continue;
    }

    let mensagem;
    try {
      mensagem = gerarMensagemFn
        ? await gerarMensagemFn(lead)
        : templatePadrao(lead);
    } catch (err) {
      console.warn(`Erro ao gerar mensagem para ${lead.cnpj}:`, err.message);
      mensagem = templatePadrao(lead);
    }

    // Pega os dados anteriores de prospecção do DB pra atualizar tentativas
    const prospData = await db.getProspeccao(lead.cnpj) || { tentativas: 0 };

    try {
      const resposta = await enviarMensagem(numero, mensagem);
      
      await db.saveProspeccaoDB(lead.cnpj, {
        status: 'enviado',
        enviadoEm: new Date().toISOString(),
        zaapId: resposta.zaapId,
        messageId: resposta.messageId,
        mensagem,
        numero,
        tentativas: prospData.tentativas + 1,
      });

      // Se for a primeira vez que entra em contato, já jogamos o bot no contexto (simula que o bot mandou pra começar a conversa)
      await db.saveConversa(lead.cnpj, 'model', mensagem);
      await cache.appendMensagemConversa(lead.cnpj, 'model', mensagem);

      resultados.push({ cnpj: lead.cnpj, status: 'enviado', messageId: resposta.messageId });
      contador++;

      // Delay anti-ban antes do próximo envio
      if (contador < maxEnvios) await delayAleatorio();
    } catch (err) {
      await db.saveProspeccaoDB(lead.cnpj, {
        status: 'erro',
        enviadoEm: new Date().toISOString(),
        mensagem,
        numero,
        tentativas: prospData.tentativas + 1,
      });
      resultados.push({ cnpj: lead.cnpj, status: 'erro', motivo: err.message });
    }
  }

  return { disparados: contador, resultados };
}

// ─── Template padrão (fallback quando Gemini falha) ──────────────────────────
function templatePadrao(lead) {
  const agente  = process.env.BDR_AGENTE_NOME || 'Lourdes';
  const empresa = lead.fantasia || lead.razao || 'sua empresa';
  return `Olá! 👋 Aqui é o/a *${agente}*, da *SA Comunicação* de Cajazeiras.

Vi que a *${empresa}* atua em ${lead.cidade || 'nossa região'} — ${lead.discurso_consultivo || lead.discursoConsultivo || 'e temos uma solução de mídia local que pode ajudar muito o seu negócio'}.

Posso te apresentar uma proposta rápida? 🚀`;
}

// ─── Processa webhook Z-API (resposta recebida) ───────────────────────────────
async function encontrarCnpjPorNumero(numero) {
  return await db.encontrarCnpjPorNumeroDB(numero);
}

module.exports = {
  enviarMensagem,
  dispararLote,
  formatarNumero,
  encontrarCnpjPorNumero,
  isHorarioComercial,
  templatePadrao,
};
