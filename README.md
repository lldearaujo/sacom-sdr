# SACom - BDR Dashboard

Dashboard local para priorizacao de leads BDR da SA Comunicacao (DOOH/OOH).

## Requisitos

- Node.js 18+ (recomendado)
- npm

## Instalacao

```bash
npm install
```

## Configuracao

1. Copie `.env.example` para `.env`
2. Ajuste as variaveis se necessario

Exemplo:

```env
PORT=3000
ENRICHMENT_TTL_HOURS=168
MAX_ENRICHMENTS_PER_REQUEST=20
MAX_ENRICHMENT_CONCURRENCY=4
ENRICHMENT_DOMAIN_COOLDOWN_MS=600
ENRICHMENT_FETCH_TIMEOUT_MS=4000
```

## Execucao

```bash
npm run start
```

Abra no navegador:

- [http://localhost:3000](http://localhost:3000)

## Smoke test rapido

Com servidor ja rodando:

```bash
npm run smoke
```

Subindo e encerrando servidor automaticamente:

```bash
npm run smoke:spawn
```

## Estrutura principal

- `server.js`: API e processamento dos CSVs
- `public/index.html`: layout do dashboard
- `public/app.js`: logica da interface e chamadas da API
- `public/style.css`: estilos
- `Fontes/*.csv`: bases de leads

## Endpoints

- `GET /api/stats`: indicadores gerais para a visao geral
- `GET /api/leads`: lista paginada com filtros (`classificacao`, `segmento`, `cidade`, `search`, `consciencia`, `viabilidade`, `segmento_prioritario`, `recorrencia`, `oferta`, `pacote`, `prioridade`, `gatilho`, `order_by`, `page`, `limit`) e enrichment em lote opcional com `include_enrichment=true`, `enrich_limit`, `enrich_concurrency` e `force_refresh=true`
- `GET /api/health`: healthcheck simples para monitoramento
- `GET /api/leads/:cnpj/enrichment`: enrichment individual com cache local, TTL e fallback seguro (`force_refresh=true`)
- `GET /api/enrichment/warmup`: aquece cache de enrichment para os top leads (`limit`, `concurrency`, `force_refresh=true`)

## Comportamento de dados

- Leitura de CSV com `;` e encoding `iso-8859-1`
- Deduplicacao por CNPJ (mantem maior score)
- Classificacao final em `HOT`, `WARM`, `MEDIUM`, `COOL`, `COLD`
- Score comercial composto por `score base + fit SA + fit territorial`
- Recomendacao comercial por lead: `ofertaPrincipal`, `pacoteSugerido`, `prioridadeComercial`, `etapaFunil`, `proximoPasso`
- Cache de enrichment com TTL configuravel (`ENRICHMENT_TTL_HOURS`) e limite por requisicao (`MAX_ENRICHMENTS_PER_REQUEST`)
- Controle de concorrencia de enrichment (`MAX_ENRICHMENT_CONCURRENCY`) e cooldown por dominio (`ENRICHMENT_DOMAIN_COOLDOWN_MS`)

## Troubleshooting rapido

- Se a tela mostrar erro de API, confirme que o servidor esta rodando (`npm run start`)
- Se faltar dados, verifique se existem CSVs na pasta `Fontes`
