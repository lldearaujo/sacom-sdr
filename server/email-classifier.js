'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const aiObs = require('./ai-observability');

const CLASSIFICATION_PROMPT = `Você classifica e-mails comerciais de uma empresa de mídia exterior.
Retorne somente JSON válido (sem markdown) com este formato:
{
  "category": "opec|oportunidade|spam",
  "confidence": 0.0,
  "summary": "texto curto",
  "fields": {
    "company": "string|null",
    "contactName": "string|null",
    "contactEmail": "string|null",
    "requestType": "string|null",
    "requestedDeadline": "string|null"
  }
}

Regras:
- "opec" = solicitação operacional/comercial formal (registro comercial, pedido de proposta, negociação com dados de operação).
- "oportunidade" = potencial negócio sem solicitação formal de OPEC.
- "spam" = propaganda irrelevante, phishing, ruído.
- confidence deve estar entre 0 e 1.
- summary deve ter no máximo 220 caracteres.
`;

function getModel() {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada para classificar e-mails.');
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: Number.parseInt(process.env.GEMINI_EMAIL_CLASSIFIER_MAX_TOKENS || '450', 10),
    },
  });
}

function safeParseJson(rawText) {
  try {
    return JSON.parse(rawText);
  } catch (_) {
    const match = String(rawText || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeCategory(category) {
  const raw = String(category || '').toLowerCase().trim();
  if (raw === 'opec' || raw === 'oportunidade' || raw === 'spam') return raw;
  return 'oportunidade';
}

function clampConfidence(value) {
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function toOutput(payload) {
  const fields = payload && typeof payload.fields === 'object' && payload.fields ? payload.fields : {};
  return {
    category: normalizeCategory(payload && payload.category),
    confidence: clampConfidence(payload && payload.confidence),
    summary: String((payload && payload.summary) || 'Classificação gerada automaticamente.').slice(0, 220),
    fields: {
      company: fields.company || null,
      contactName: fields.contactName || null,
      contactEmail: fields.contactEmail || null,
      requestType: fields.requestType || null,
      requestedDeadline: fields.requestedDeadline || null,
    },
  };
}

async function classifyInboundEmail({ fromEmail, subject, bodyText }) {
  const traceId = aiObs.startTrace({
    flow: 'email_classifier',
    channel: 'email',
    inputPreview: `${String(subject || '').slice(0, 120)} | ${String(fromEmail || '').slice(0, 80)}`,
  });
  const model = getModel();
  const prompt = `${CLASSIFICATION_PROMPT}

E-mail:
- from: ${String(fromEmail || '').slice(0, 200)}
- subject: ${String(subject || '').slice(0, 500)}
- body:
${String(bodyText || '').slice(0, 5000)}
`;

  try {
    aiObs.addStep(traceId, { stage: 'gemini_classifier', status: 'running', message: 'Classificando e-mail com Gemini.' });
    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    const parsed = safeParseJson(raw);
    if (!parsed) throw new Error('Resposta do classificador IA sem JSON válido.');
    const output = {
      ...toOutput(parsed),
      source: 'gemini',
      needsReview: false,
    };
    aiObs.finishTrace(traceId, {
      status: 'ok',
      outputPreview: JSON.stringify({ category: output.category, confidence: output.confidence, summary: output.summary }),
    });
    return output;
  } catch (err) {
    const fallback = {
      category: 'oportunidade',
      confidence: 0,
      summary: 'Fallback por falha no classificador IA.',
      fields: {
        company: null,
        contactName: null,
        contactEmail: null,
        requestType: null,
        requestedDeadline: null,
      },
      source: 'fallback',
      needsReview: true,
      error: err.message,
    };
    aiObs.finishTrace(traceId, {
      status: 'fallback',
      error: err && err.message,
      outputPreview: JSON.stringify({ category: fallback.category, summary: fallback.summary }),
      fallbackUsed: true,
    });
    return fallback;
  }
}

module.exports = {
  classifyInboundEmail,
};
