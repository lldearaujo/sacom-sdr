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
ENRICHMENT_WARMUP_ENABLED=true
ENRICHMENT_WARMUP_HOUR=7
ENRICHMENT_WARMUP_MINUTE=0
ENRICHMENT_WARMUP_LIMIT=30
ENRICHMENT_WARMUP_SEGMENTS=Varejo,Saude,Automotivo,Educacao,Construcao e Imoveis
# ENRICHMENT_WARMUP_ON_START=false
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
- `GET /api/enrichment/warmup`: aquece cache de enrichment priorizando segmentos estratégicos (`limit`, `concurrency`, `segmentos`, `force_refresh=true`)
- `GET /api/oportunidades/recorrencia`: projeção de campanhas anuais e janelas por segmento prioritário
- `POST /api/prospeccao/preview`: gera prévia das mensagens antes do disparo (`classificacoes`, `limite`, `limite_preview`, `templateModo=ia|padrao|custom`, `templateCustom`)
- `POST /api/prospeccao/disparar`: executa disparo em lote respeitando horário e limites (`classificacoes`, `limite`, `templateModo`, `templateCustom`)
- `GET/PUT /api/prospeccao/template-config`: consulta/salva configuração padrão do disparo (modo, limites, classificações e template base)
- `POST /api/prospeccao/template-historico`: salva uma nova versão de template customizado
- `POST /api/prospeccao/template-historico/:id/aprovar`: marca versão como aprovada para envio
- `GET /api/email/status`: status operacional do worker de e-mail IMAP/Trello (conexão, última checagem, contadores)
- `GET /api/email/inbound`: lista de e-mails processados para gestão operacional (filtros: `status`, `classification`, `needs_review`, `page`, `limit`)
- `PATCH /api/email/inbound/:id/review`: marca item como pendente/revisado manualmente
- `POST /api/email/poll`: força varredura imediata da caixa IMAP

## Comportamento de dados

- Leitura de CSV com `;` e encoding `iso-8859-1`
- Deduplicacao por CNPJ (mantem maior score)
- Classificacao final em `HOT`, `WARM`, `MEDIUM`, `COOL`, `COLD`
- Score comercial composto por `score base + fit SA + fit territorial`
- Recomendacao comercial por lead: `ofertaPrincipal`, `pacoteSugerido`, `prioridadeComercial`, `etapaFunil`, `proximoPasso`
- Cache de enrichment com TTL configuravel (`ENRICHMENT_TTL_HOURS`) e limite por requisicao (`MAX_ENRICHMENTS_PER_REQUEST`)
- Controle de concorrencia de enrichment (`MAX_ENRICHMENT_CONCURRENCY`) e cooldown por dominio (`ENRICHMENT_DOMAIN_COOLDOWN_MS`)
- Warmup diário automático configurável por horário e segmentos prioritários (status disponível em `stats.warmup`)
- Projeção de recorrência anual por segmento disponível em `stats.recorrenciaAnual`
- Fluxo de disparo com confirmação: usuário configura o padrão da mensagem, gera prévia e só então confirma o envio
- Persistência da configuração do modal de disparo e histórico de versões para template customizado com etapa de aprovação
- Worker de e-mail (IMAP) com deduplicação por `message-id` e hash de conteúdo, classificação IA (`opec|oportunidade|spam`) e criação direta de card Trello para OPEC com anexos

## Troubleshooting rapido

- Se a tela mostrar erro de API, confirme que o servidor esta rodando (`npm run start`)
- Se faltar dados, verifique se existem CSVs na pasta `Fontes`
- Se o `EmailWorker` falhar com erro TLS/certificado (`SELF_SIGNED_CERT_IN_CHAIN`), ajuste `EMAIL_IMAP_TLS_REJECT_UNAUTHORIZED=false` no `.env`
- Se aparecer `AUTHENTICATIONFAILED`, corrija `EMAIL_IMAP_USER/EMAIL_IMAP_PASS`; por padrão o worker entra em modo suspenso para evitar loop de logs (`EMAIL_IMAP_STOP_ON_AUTH_FAILURE=true`)
- Se o ambiente já exporta variáveis, `dotenv` pode carregar `0` itens (`injecting env (0) from .env`); nesse caso ajuste credenciais IMAP no ambiente de execução (container/painel), não apenas no arquivo `.env`
