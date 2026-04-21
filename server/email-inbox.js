'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const classifier = require('./email-classifier');
const trello = require('./trello');
const {
  normalizeEmailContent,
  sanitizeAttachmentName,
  isAttachmentAllowed,
  computeContentHash,
} = require('./email-utils');

const state = {
  running: false,
  connected: false,
  suspended: false,
  suspendedReason: null,
  lastCheckAt: null,
  lastProcessedAt: null,
  processedCount: 0,
  duplicateCount: 0,
  lastError: null,
  lastErrorAt: null,
};

let client = null;
let pollTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let consecutiveConnectFailures = 0;
let isPolling = false;
let shouldRun = false;
let dbRef = null;

function parseBooleanEnv(rawValue, defaultValue = false) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return defaultValue;
  const normalized = String(rawValue).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getConfig() {
  return {
    host: String(process.env.EMAIL_IMAP_HOST || '').trim(),
    port: Number.parseInt(process.env.EMAIL_IMAP_PORT || '993', 10),
    secure: parseBooleanEnv(process.env.EMAIL_IMAP_SECURE, true),
    user: String(process.env.EMAIL_IMAP_USER || '').trim(),
    pass: String(process.env.EMAIL_IMAP_PASS || '').trim(),
    mailbox: String(process.env.EMAIL_IMAP_MAILBOX || 'INBOX').trim(),
    pollIntervalMs: Math.max(10_000, Number.parseInt(process.env.EMAIL_POLL_INTERVAL_MS || '120000', 10)),
    maxAttachmentMb: Math.max(1, Number.parseInt(process.env.EMAIL_MAX_ATTACHMENT_MB || '15', 10)),
    markSeenAfterProcess: parseBooleanEnv(process.env.EMAIL_MARK_SEEN_AFTER_PROCESS, true),
    tlsRejectUnauthorized: parseBooleanEnv(process.env.EMAIL_IMAP_TLS_REJECT_UNAUTHORIZED, true),
    stopOnAuthFailure: parseBooleanEnv(process.env.EMAIL_IMAP_STOP_ON_AUTH_FAILURE, true),
    maxConsecutiveFailuresBeforeSuspend: Math.max(1, Number.parseInt(process.env.EMAIL_IMAP_MAX_CONSECUTIVE_FAILURES || '3', 10)),
  };
}

function isAuthFailureError(err) {
  if (!err) return false;
  const serverCode = String(err.serverResponseCode || '').toUpperCase();
  const imapStatus = String(err.responseStatus || '').toUpperCase();
  const authFlag = Boolean(err.authenticationFailed);
  const text = `${String(err.message || '')} ${String(err.responseText || '')} ${String(err.response || '')}`.toLowerCase();
  if (authFlag) return true;
  if (serverCode.includes('AUTHENTICATIONFAILED')) return true;
  if (imapStatus === 'NO' && text.includes('authentication failed')) return true;
  return text.includes('auth') && text.includes('failed');
}

function suspendWorker(reason) {
  shouldRun = false;
  clearTimers();
  state.running = false;
  state.connected = false;
  state.suspended = true;
  state.suspendedReason = reason || 'Suspenso por erro de autenticação IMAP.';
  console.error('[EmailWorker] Worker suspenso:', state.suspendedReason);
}

function hasAuthFailureInState() {
  const text = String(state.lastError || '').toLowerCase();
  return text.includes('authentication failed')
    || text.includes('authenticationfailed')
    || text.includes('server_code=authenticationfailed');
}

function handleConnectionFailure(err, source = 'connect') {
  const cfg = getConfig();
  consecutiveConnectFailures += 1;
  if (cfg.stopOnAuthFailure && (isAuthFailureError(err) || hasAuthFailureInState())) {
    suspendWorker(`Falha de autenticação IMAP detectada (${source}). Verifique EMAIL_IMAP_USER/EMAIL_IMAP_PASS e reinicie o servidor.`);
    return true;
  }
  if (consecutiveConnectFailures >= cfg.maxConsecutiveFailuresBeforeSuspend) {
    suspendWorker(
      `Conexão IMAP falhou ${consecutiveConnectFailures} vezes seguidas (${source}). Worker pausado para evitar loop de erros.`,
    );
    return true;
  }
  return false;
}

function updateError(err) {
  const baseMessage = err && err.message ? err.message : String(err);
  const extraDetails = [];
  if (err && err.code) extraDetails.push(`code=${err.code}`);
  if (err && err.responseStatus) extraDetails.push(`imap_status=${err.responseStatus}`);
  if (err && err.responseText) extraDetails.push(`imap_response=${String(err.responseText).slice(0, 300)}`);
  if (err && err.serverResponseCode) extraDetails.push(`server_code=${err.serverResponseCode}`);
  state.lastError = extraDetails.length ? `${baseMessage} (${extraDetails.join(', ')})` : baseMessage;
  state.lastErrorAt = new Date().toISOString();
  console.error('[EmailWorker] Erro:', state.lastError);
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
  });
}

function buildCardDescription({ inbound, classification }) {
  const fields = classification.fields || {};
  const lines = [
    '## Solicitação OPEC detectada automaticamente',
    '',
    `**Resumo IA:** ${classification.summary || 'Sem resumo'}`,
    `**Confianca:** ${classification.confidence}`,
    `**Remetente:** ${inbound.fromEmail || '-'}`,
    `**Assunto:** ${inbound.subject || '-'}`,
    `**Message-ID:** ${inbound.messageId || '-'}`,
    '',
    '### Campos extraidos',
    `- Empresa: ${fields.company || '-'}`,
    `- Contato: ${fields.contactName || '-'}`,
    `- Email contato: ${fields.contactEmail || '-'}`,
    `- Tipo de solicitacao: ${fields.requestType || '-'}`,
    `- Prazo: ${fields.requestedDeadline || '-'}`,
    '',
    '### Corpo (trecho)',
    String(inbound.bodyText || '').slice(0, 4500) || 'Sem corpo textual.',
  ];
  return lines.join('\n');
}

async function processParsedEmail({ uid, parsed, internalDate }) {
  const fromEmail = parsed.from?.value?.[0]?.address || null;
  const subject = parsed.subject || '(Sem assunto)';
  const bodyText = parsed.text || parsed.html || '';
  const normalized = normalizeEmailContent({ subject, bodyText });
  const attachments = (parsed.attachments || []).map((item) => ({
    fileName: sanitizeAttachmentName(item.filename || 'anexo'),
    mimeType: item.contentType || 'application/octet-stream',
    size: Number(item.size || 0),
    buffer: item.content,
  }));
  const contentHash = computeContentHash({
    subject: normalized.subject,
    bodyText: normalized.bodyText,
    attachmentsMeta: attachments.map((item) => ({
      fileName: item.fileName,
      size: item.size,
      mimeType: item.mimeType,
    })),
  });
  const messageIdRaw = String(parsed.messageId || '').trim();
  const messageId = messageIdRaw || null;

  if (messageId) {
    const existingByMessage = await dbRef.findInboundByMessageId(messageId);
    if (existingByMessage) {
      state.duplicateCount += 1;
      console.log(`[EmailWorker] Duplicado por message-id: ${messageId}`);
      return;
    }
  }

  const existingByHash = await dbRef.findInboundByContentHash(contentHash);
  if (existingByHash) {
    state.duplicateCount += 1;
    console.log(`[EmailWorker] Duplicado por hash de conteúdo: ${contentHash}`);
    return;
  }

  const inbound = await dbRef.saveInboundEmail({
    messageId,
    contentHash,
    fromEmail,
    subject: normalized.subject,
    bodyText: normalized.bodyText,
    receivedAt: internalDate ? new Date(internalDate).toISOString() : new Date().toISOString(),
  });

  for (const attachment of attachments) {
    await dbRef.saveInboundAttachment(inbound.id, {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.size,
      storagePath: null,
    });
  }

  const classification = await classifier.classifyInboundEmail({
    fromEmail,
    subject: normalized.subject,
    bodyText: normalized.bodyText,
  });
  await dbRef.updateInboundClassification(inbound.id, classification);

  if (classification.category !== 'opec') {
    await dbRef.markInboundStatus(inbound.id, 'done');
    state.processedCount += 1;
    state.lastProcessedAt = new Date().toISOString();
    return;
  }

  const allowedAttachments = attachments.filter((item) => isAttachmentAllowed({
    mimeType: item.mimeType,
    sizeBytes: item.size,
    maxMb: getConfig().maxAttachmentMb,
  }));
  const cardTitle = `[OPEC] ${normalized.subject}`.slice(0, 160);
  const cardDescription = buildCardDescription({ inbound, classification });
  const trelloResult = await trello.createCardWithAttachments({
    title: cardTitle,
    description: cardDescription,
    attachments: allowedAttachments,
  });

  await dbRef.saveOpecRequest({
    inboundEmailId: inbound.id,
    summary: classification.summary,
    company: classification.fields.company,
    contactName: classification.fields.contactName,
    contactEmail: classification.fields.contactEmail || fromEmail,
    requestType: classification.fields.requestType,
    requestedDeadline: classification.fields.requestedDeadline,
    trelloCardId: trelloResult.card.id,
    trelloCardUrl: trelloResult.card.url,
  });

  await dbRef.markInboundStatus(
    inbound.id,
    trelloResult.failed.length ? 'done_with_attachment_errors' : 'done',
  );
  state.processedCount += 1;
  state.lastProcessedAt = new Date().toISOString();
}

async function processMessage(uid) {
  const messages = client.fetch(String(uid), { uid: true, source: true, internalDate: true });
  for await (const message of messages) {
    try {
      const sourceBuffer = await streamToBuffer(message.source);
      const parsed = await simpleParser(sourceBuffer);
      await processParsedEmail({
        uid: message.uid || uid,
        parsed,
        internalDate: message.internalDate,
      });
      if (getConfig().markSeenAfterProcess) {
        await client.messageFlagsAdd(String(message.uid || uid), ['\\Seen'], { uid: true });
      }
    } catch (err) {
      updateError(err);
    }
  }
}

async function pollInbox() {
  if (!client || !state.connected || isPolling) return;
  isPolling = true;
  state.lastCheckAt = new Date().toISOString();
  try {
    const unseen = await client.search({ seen: false }, { uid: true });
    if (!unseen || unseen.length === 0) return;
    for (const uid of unseen) {
      if (!shouldRun) break;
      // eslint-disable-next-line no-await-in-loop
      await processMessage(uid);
    }
  } catch (err) {
    updateError(err);
  } finally {
    isPolling = false;
  }
}

function clearTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  pollTimer = null;
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (!shouldRun || reconnectTimer) return;
  reconnectAttempt += 1;
  const delay = Math.min(60_000, 2000 * reconnectAttempt);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connect();
    } catch (err) {
      updateError(err);
      scheduleReconnect();
    }
  }, delay);
}

async function connect() {
  const cfg = getConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    throw new Error('Configuração IMAP incompleta. Verifique EMAIL_IMAP_HOST, EMAIL_IMAP_USER e EMAIL_IMAP_PASS.');
  }

  if (client) {
    try {
      await client.logout();
    } catch (_) {
      // noop
    }
  }

  client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    tls: {
      rejectUnauthorized: cfg.tlsRejectUnauthorized,
    },
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    logger: false,
  });

  client.on('error', (err) => {
    state.connected = false;
    updateError(err);
    if (handleConnectionFailure(err, 'event:error')) return;
    scheduleReconnect();
  });
  client.on('close', () => {
    const wasConnected = state.connected;
    state.connected = false;
    if (!shouldRun) return;
    if (!wasConnected) return;
    console.warn('[EmailWorker] Conexão IMAP encerrada.');
    scheduleReconnect();
  });
  client.on('exists', () => {
    pollInbox().catch((err) => updateError(err));
  });

  await client.connect();
  await client.mailboxOpen(cfg.mailbox);
  state.connected = true;
  consecutiveConnectFailures = 0;
  reconnectAttempt = 0;
  console.log(`[EmailWorker] Conectado ao IMAP (${cfg.mailbox}).`);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    pollInbox().catch((err) => updateError(err));
  }, cfg.pollIntervalMs);

  await pollInbox();
}

async function startEmailWorker({ db }) {
  if (state.running) return;
  shouldRun = true;
  dbRef = db;
  state.running = true;
  state.suspended = false;
  state.suspendedReason = null;
  try {
    trello.assertConfigured();
  } catch (err) {
    state.running = false;
    shouldRun = false;
    throw err;
  }
  try {
    await connect();
  } catch (err) {
    if (!handleConnectionFailure(err, 'startup')) {
      state.running = false;
      shouldRun = false;
    }
    throw err;
  }
}

async function stopEmailWorker() {
  shouldRun = false;
  clearTimers();
  if (client) {
    try {
      await client.logout();
    } catch (_) {
      // noop
    }
  }
  client = null;
  state.running = false;
  state.connected = false;
  consecutiveConnectFailures = 0;
  reconnectAttempt = 0;
  state.suspended = false;
  state.suspendedReason = null;
}

function getEmailWorkerStatus() {
  return {
    ...state,
    pollIntervalMs: getConfig().pollIntervalMs,
  };
}

async function triggerManualPoll() {
  await pollInbox();
  return getEmailWorkerStatus();
}

module.exports = {
  startEmailWorker,
  stopEmailWorker,
  getEmailWorkerStatus,
  triggerManualPoll,
};
