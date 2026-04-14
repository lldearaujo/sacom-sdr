'use strict';

/**
 * server/cache.js — Redis Cache com Fallback para PostgreSQL
 * Otimiza acessos frequentes (sessões de chat ativas, rate limits).
 */

const Redis = require('ioredis');
const db = require('./db');

const redisUrl = (process.env.REDIS_URL && process.env.REDIS_URL.includes('outdoora_sacom-redis') && process.env.REDIS_URL_EXTERNAL)
  ? process.env.REDIS_URL_EXTERNAL
  : process.env.REDIS_URL;

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  retryStrategy(times) {
    if (times > 3) return null; // Para de tentar após 3 vezes (usa fallback)
    return Math.min(times * 100, 3000);
  },
});

if (redisUrl === process.env.REDIS_URL_EXTERNAL) {
  console.log('📡 Usando REDIS_URL_EXTERNAL para cache.');
}

redis.on('error', (err) => {
  console.warn('⚠️ Erro no Redis (usando fallback PostgreSQL):', err.message);
});

async function isRedisHealthy() {
  return redis.status === 'ready';
}

// ─── CACHE DE LEADS ──────────────────────────────────────────────────────────

async function getLead(cnpj) {
  if (await isRedisHealthy()) {
    try {
      const cached = await redis.get(`lead:${cnpj}`);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      console.warn('Erro ao ler lead do Redis:', e.message);
    }
  }

  // Fallback PostgreSQL
  const lead = await db.getLeadByCnpj(cnpj);
  if (lead && await isRedisHealthy()) {
    // Salva no cache por 1 hora
    redis.set(`lead:${cnpj}`, JSON.stringify(lead), 'EX', 3600).catch(() => {});
  }
  return lead;
}

// ─── CACHE DE CONVERSAS (ÚLTIMAS MENSAGENS) ──────────────────────────────────

async function getConversaContexto(cnpj, limite = 5) {
  if (await isRedisHealthy()) {
    try {
      const cached = await redis.lrange(`conv:${cnpj}`, 0, limite - 1);
      if (cached && cached.length > 0) {
        return cached.map(c => JSON.parse(c)).reverse(); // Retorna cronológico
      }
    } catch (e) {
      console.warn('Erro ao ler conversa do Redis:', e.message);
    }
  }

  // Fallback PostgreSQL
  const fallback = await db.getHistoricoConversa(cnpj, { limit: limite });
  
  // Reidrata o cache se Redis estiver saudável
  if (fallback.length > 0 && await isRedisHealthy()) {
    try {
      const pipeline = redis.pipeline();
      pipeline.del(`conv:${cnpj}`);
      // LPush inverte a ordem cronológica, então LRange 0 N pegará as mais recentes
      for (const msg of fallback) {
        pipeline.lpush(`conv:${cnpj}`, JSON.stringify({ role: msg.role, text: msg.conteudo }));
      }
      pipeline.expire(`conv:${cnpj}`, 86400); // 24h
      await pipeline.exec();
    } catch (e) {
      console.warn('Erro ao reidratar cache de conversa:', e.message);
    }
  }

  return fallback.map(msg => ({ role: msg.role, text: msg.conteudo }));
}

async function appendMensagemConversa(cnpj, role, texto) {
  // Salva no PostgreSQL (persistência)
  await db.saveConversa(cnpj, role, texto);

  // Salva no Redis (cache rápido)
  if (await isRedisHealthy()) {
    try {
      const msgStr = JSON.stringify({ role, text: texto });
      const pipeline = redis.pipeline();
      pipeline.lpush(`conv:${cnpj}`, msgStr);
      pipeline.ltrim(`conv:${cnpj}`, 0, 19); // Mantém só as últimas 20 mensagens em memória
      pipeline.expire(`conv:${cnpj}`, 86400); // Reseta TTL para 24h
      await pipeline.exec();
    } catch (e) {
      console.warn('Erro ao salvar mensagem no Redis:', e.message);
    }
  }
}

// ─── CACHE DE PROSPECÇÃO (LOCKS E LIMITES) ───────────────────────────────────

// Lock para evitar disparos simultâneos para o mesmo domínio/cnpj
async function acquireLock(key, ttlSeconds = 60) {
  if (!await isRedisHealthy()) return true; // Se não tem redis, assume lock adquirido (arriscado, mas é fallback)
  try {
    const result = await redis.set(`lock:${key}`, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (e) {
    return true; // Falha aberta no cache
  }
}

async function releaseLock(key) {
  if (await isRedisHealthy()) {
    redis.del(`lock:${key}`).catch(() => {});
  }
}

module.exports = {
  redis,
  isRedisHealthy,
  getLead,
  getConversaContexto,
  appendMensagemConversa,
  acquireLock,
  releaseLock,
};
