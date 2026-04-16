'use strict';

const zapi = require('./zapi');
const evolution = require('./evolution');

const PROVIDERS = {
  zapi,
  evolution,
};

function getProviderId() {
  const raw = String(process.env.WHATSAPP_PROVIDER || 'zapi').trim().toLowerCase();
  return raw === 'evolution' ? 'evolution' : 'zapi';
}

function getProvider() {
  const id = getProviderId();
  return PROVIDERS[id] || zapi;
}

module.exports = {
  getProviderId,
  getProvider,
  PROVIDERS,
};

