'use strict';

const zapi = require('./zapi');

const PROVIDERS = {
  zapi,
};

function getProviderId() {
  return 'zapi';
}

function getProvider() {
  return zapi;
}

module.exports = {
  getProviderId,
  getProvider,
  PROVIDERS,
};

