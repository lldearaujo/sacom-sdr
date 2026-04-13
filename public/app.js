/* ─── State ─────────────────────────────────────────────────── */
let stats = null;
let currentPage = 1;
let currentFilters = {
  classificacao: '',
  segmento: '',
  search: '',
  consciencia: '',
  viabilidade: '',
  canal: '',
  dor: '',
  objetivo: '',
  segmento_prioritario: '',
  recorrencia: '',
  oferta: '',
  pacote: '',
  prioridade: '',
  etapa_funil: '',
  gatilho: '',
  order_by: 'score_comercial',
};
let charts = {};
let segmentList = [];
let leadsViewInitialized = false;
let leadsIndexByCnpj = new Map();

function showApiError(message) {
  const main = document.querySelector('.main');
  if (!main) return;

  let banner = document.getElementById('api-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'api-error-banner';
    banner.className = 'api-error-banner';
    main.prepend(banner);
  }

  banner.textContent = message;
}

function clearApiError() {
  const banner = document.getElementById('api-error-banner');
  if (banner) banner.remove();
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Erro HTTP ${res.status} ao carregar ${url}`);
  }
  return res.json();
}

/* ─── Init ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('update-date').textContent = new Date().toLocaleDateString('pt-BR');

  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      const view = el.dataset.view;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('view-' + view).classList.add('active');
      if (view === 'leads' && !leadsViewInitialized) initLeadsView();
      if (view === 'segmentos') initSegmentosView();
      if (view === 'prospeccao') initProspeccaoView();
      if (view === 'config') initConfigView();
    });
  });

  loadStats().catch(err => {
    console.error(err);
    showApiError('Nao foi possivel carregar os dados. Verifique se o servidor esta em execucao.');
  });
});

/* ─── Stats ─────────────────────────────────────────────────── */
async function loadStats() {
  stats = await fetchJson('/api/stats');
  clearApiError();

  segmentList = Object.keys(stats.porSegmento);

  renderKPIs();
  renderChartClassificacao();
  renderChartPorte();
  renderChartCidades();
  renderChartContatos();
  renderTop5();
}

function preencherSelect(id, values) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const existing = new Set(Array.from(sel.options).map(o => o.value));
  values.forEach(v => {
    if (!v || existing.has(v)) return;
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  });
}

function renderKPIs() {
  const pc = stats.porClassificacao;
  document.getElementById('kpi-total').textContent  = stats.total.toLocaleString('pt-BR');
  document.getElementById('kpi-hot').textContent    = (pc['🔴 HOT']    || 0).toLocaleString('pt-BR');
  document.getElementById('kpi-warm').textContent   = (pc['🟠 WARM']   || 0).toLocaleString('pt-BR');
  document.getElementById('kpi-medium').textContent = (pc['🟡 MEDIUM'] || 0).toLocaleString('pt-BR');
  document.getElementById('kpi-score').textContent  = stats.scoreMedio;
  document.getElementById('kpi-score-comercial').textContent  = (stats.scoreComercialMedio || 0).toLocaleString('pt-BR');
  document.getElementById('kpi-email').textContent  = stats.comEmail.toLocaleString('pt-BR');
}

/* ─── Charts ────────────────────────────────────────────────── */
const COLORS = {
  '🔴 HOT':    '#ef4444',
  '🟠 WARM':   '#f97316',
  '🟡 MEDIUM': '#eab308',
  '🔵 COOL':   '#3b82f6',
  '⚪ COLD':   '#475569',
};

const chartDefaults = {
  plugins: { legend: { labels: { color: '#64748b', font: { family: 'Inter', size: 12 } } } },
  scales: {
    x: { ticks: { color: '#475569', font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(31,45,69,.4)' } },
    y: { ticks: { color: '#475569', font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(31,45,69,.4)' } },
  },
};

function renderChartClassificacao() {
  const pc = stats.porClassificacao;
  const labels = ['🔴 HOT', '🟠 WARM', '🟡 MEDIUM', '🔵 COOL', '⚪ COLD'];
  const data   = labels.map(l => pc[l] || 0);

  charts.class = new Chart(document.getElementById('chart-classificacao'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: labels.map(l => COLORS[l] + 'bb'),
        borderColor:     labels.map(l => COLORS[l]),
        borderWidth: 1.5,
        borderRadius: 8,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toLocaleString('pt-BR')} leads` } },
      },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(31,45,69,.4)' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(31,45,69,.4)' } },
      },
    },
  });
}

function renderChartPorte() {
  const pp = stats.porPorte;
  const entries = Object.entries(pp).sort((a, b) => b[1] - a[1]);
  const labels  = entries.map(([k]) => k || 'Não informado');
  const data    = entries.map(([,v]) => v);
  const palette = ['#3b82f6','#6366f1','#8b5cf6','#a855f7','#64748b','#0ea5e9'];

  charts.porte = new Chart(document.getElementById('chart-porte'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: palette, borderWidth: 0 }],
    },
    options: {
      responsive: true,
      cutout: '60%',
      plugins: {
        legend: { position: 'bottom', labels: { color: '#64748b', font: { size: 11, family: 'Inter' }, boxWidth: 12 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw.toLocaleString('pt-BR')}` } },
      },
    },
  });
}

function renderChartCidades() {
  const { topCidades } = stats;
  const labels = topCidades.map(c => c.cidade);
  const data   = topCidades.map(c => c.count);

  charts.cidades = new Chart(document.getElementById('chart-cidades'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Leads',
        data,
        backgroundColor: 'rgba(99,102,241,.6)',
        borderColor: '#6366f1',
        borderWidth: 1.5,
        borderRadius: 8,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(31,45,69,.4)' } },
        y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(31,45,69,.4)' } },
      },
    },
  });
}

function renderChartContatos() {
  const total = stats.total;
  const labels = ['Com E-mail', 'Com Site', 'Com Telefone'];
  const data   = [stats.comEmail, stats.comSite, stats.comTelefone];
  const cols   = ['#10b981','#3b82f6','#a855f7'];

  charts.contatos = new Chart(document.getElementById('chart-contatos'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Leads',
        data,
        backgroundColor: cols.map(c => c + '99'),
        borderColor: cols,
        borderWidth: 1.5,
        borderRadius: 8,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.raw.toLocaleString('pt-BR')} (${Math.round(ctx.raw/total*100)}%)` } },
      },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(31,45,69,.4)' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(31,45,69,.4)' } },
      },
    },
  });
}

function renderTop5() {
  const container = document.getElementById('top5-grid');
  container.innerHTML = '';
  stats.top5.forEach((lead, i) => {
    const nome = lead.fantasia || lead.razao || lead.cnpj;
    const div  = document.createElement('div');
    div.className = 'top5-card';
    div.innerHTML = `
      <div class="top5-rank">#${i+1} ${lead.classificacao}</div>
      <div class="top5-name">${nome}</div>
      <div class="top5-seg">${lead.segmento}</div>
      <div class="top5-score">${lead.score} pts</div>
      ${lead.email    ? `<div style="font-size:11px;color:#64748b;overflow:hidden;text-overflow:ellipsis">✉ ${lead.email}</div>` : ''}
      ${lead.telefone1 ? `<div style="font-size:11px;color:#64748b">📞 ${lead.telefone1}</div>` : ''}
    `;
    container.appendChild(div);
  });
}

/* ─── Leads View ────────────────────────────────────────────── */
function initLeadsView() {
  leadsViewInitialized = true;

  // Preencher select de segmentos
  preencherSelect('filter-seg', segmentList);
  preencherSelect('filter-consciencia', Object.keys(stats?.porConsciencia || {}));
  preencherSelect('filter-viabilidade', Object.keys(stats?.porViabilidade || {}));
  preencherSelect('filter-canal', Object.keys(stats?.porCanal || {}));
  preencherSelect('filter-dor', Object.keys(stats?.porDor || {}));
  preencherSelect('filter-objetivo', Object.keys(stats?.porObjetivo || {}));
  preencherSelect('filter-seg-prio', Object.keys(stats?.porSegmentoPrioritario || {}));
  preencherSelect('filter-recorrencia', Object.keys(stats?.porRecorrencia || {}));
  preencherSelect('filter-oferta', Object.keys(stats?.porOferta || {}));
  preencherSelect('filter-pacote', Object.keys(stats?.porPacote || {}));
  preencherSelect('filter-prioridade', Object.keys(stats?.porPrioridade || {}));
  preencherSelect('filter-etapa', Object.keys(stats?.porEtapaFunil || {}));
  preencherSelect('filter-gatilho', Object.keys(stats?.porGatilho || {}));

  document.getElementById('btn-filter').addEventListener('click', () => {
    currentFilters.search = document.getElementById('filter-search').value;
    currentFilters.classificacao = document.getElementById('filter-class').value;
    currentFilters.segmento = document.getElementById('filter-seg').value;
    currentFilters.consciencia = document.getElementById('filter-consciencia').value;
    currentFilters.viabilidade = document.getElementById('filter-viabilidade').value;
    currentFilters.canal = document.getElementById('filter-canal').value;
    currentFilters.dor = document.getElementById('filter-dor').value;
    currentFilters.objetivo = document.getElementById('filter-objetivo').value;
    currentFilters.segmento_prioritario = document.getElementById('filter-seg-prio').value;
    currentFilters.recorrencia = document.getElementById('filter-recorrencia').value;
    currentFilters.oferta = document.getElementById('filter-oferta').value;
    currentFilters.pacote = document.getElementById('filter-pacote').value;
    currentFilters.prioridade = document.getElementById('filter-prioridade').value;
    currentFilters.etapa_funil = document.getElementById('filter-etapa').value;
    currentFilters.gatilho = document.getElementById('filter-gatilho').value;
    currentFilters.order_by = document.getElementById('filter-order').value || 'score_comercial';
    currentPage = 1;
    loadLeads();
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-class').value  = '';
    document.getElementById('filter-seg').value    = '';
    document.getElementById('filter-consciencia').value = '';
    document.getElementById('filter-viabilidade').value = '';
    document.getElementById('filter-canal').value = '';
    document.getElementById('filter-dor').value = '';
    document.getElementById('filter-objetivo').value = '';
    document.getElementById('filter-seg-prio').value = '';
    document.getElementById('filter-recorrencia').value = '';
    document.getElementById('filter-oferta').value = '';
    document.getElementById('filter-pacote').value = '';
    document.getElementById('filter-prioridade').value = '';
    document.getElementById('filter-etapa').value = '';
    document.getElementById('filter-gatilho').value = '';
    document.getElementById('filter-order').value = 'score_comercial';
    currentFilters = {
      classificacao: '',
      segmento: '',
      search: '',
      consciencia: '',
      viabilidade: '',
      canal: '',
      dor: '',
      objetivo: '',
      segmento_prioritario: '',
      recorrencia: '',
      oferta: '',
      pacote: '',
      prioridade: '',
      etapa_funil: '',
      gatilho: '',
      order_by: 'score_comercial',
    };
    currentPage = 1;
    loadLeads();
  });

  document.getElementById('filter-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-filter').click();
  });

  loadLeads();
}

async function loadLeads() {
  const tbody = document.getElementById('leads-tbody');
  tbody.innerHTML = `<tr><td colspan="11"><div class="loader"><div class="spinner"></div> Carregando...</div></td></tr>`;

  const params = new URLSearchParams({
    page:  currentPage,
    limit: 50,
    include_enrichment: 'true',
    enrich_limit: 8,
    ...(currentFilters.classificacao && { classificacao: currentFilters.classificacao }),
    ...(currentFilters.segmento      && { segmento:      currentFilters.segmento }),
    ...(currentFilters.search        && { search:        currentFilters.search }),
    ...(currentFilters.consciencia   && { consciencia:   currentFilters.consciencia }),
    ...(currentFilters.viabilidade   && { viabilidade:   currentFilters.viabilidade }),
    ...(currentFilters.canal         && { canal:         currentFilters.canal }),
    ...(currentFilters.dor           && { dor:           currentFilters.dor }),
    ...(currentFilters.objetivo      && { objetivo:      currentFilters.objetivo }),
    ...(currentFilters.segmento_prioritario && { segmento_prioritario: currentFilters.segmento_prioritario }),
    ...(currentFilters.recorrencia   && { recorrencia:   currentFilters.recorrencia }),
    ...(currentFilters.oferta        && { oferta:        currentFilters.oferta }),
    ...(currentFilters.pacote        && { pacote:        currentFilters.pacote }),
    ...(currentFilters.prioridade    && { prioridade:    currentFilters.prioridade }),
    ...(currentFilters.etapa_funil   && { etapa_funil:   currentFilters.etapa_funil }),
    ...(currentFilters.gatilho       && { gatilho:       currentFilters.gatilho }),
    ...(currentFilters.order_by      && { order_by:      currentFilters.order_by }),
  });

  try {
    const json = await fetchJson('/api/leads?' + params);
    clearApiError();

    document.getElementById('leads-subtitle').textContent =
      `${json.total.toLocaleString('pt-BR')} leads encontrados`;

    renderLeadsTable(json.data);
    renderPagination(json.total, json.page, json.limit);
    if (json.data.length) renderLeadInsight(json.data[0]);
    else renderLeadInsight(null);
  } catch (err) {
    console.error(err);
    showApiError('Falha ao carregar leads. Confira a conexao com a API.');
    document.getElementById('leads-subtitle').textContent = 'Erro ao carregar leads';
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:30px;color:#fca5a5">Nao foi possivel buscar os leads.</td></tr>`;
    document.getElementById('pagination').innerHTML = '';
    renderLeadInsight(null);
  }
}

function tagClass(c) {
  if (c.includes('HOT'))    return 'tag-hot';
  if (c.includes('WARM'))   return 'tag-warm';
  if (c.includes('MEDIUM')) return 'tag-medium';
  if (c.includes('COOL'))   return 'tag-cool';
  return 'tag-cold';
}

function renderLeadsTable(leads) {
  const tbody = document.getElementById('leads-tbody');
  tbody.innerHTML = '';
  leadsIndexByCnpj = new Map(leads.map(lead => [lead.cnpj, lead]));
  if (!leads.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:30px;color:#64748b">Nenhum lead encontrado</td></tr>`;
    return;
  }
  for (const lead of leads) {
    const nome = lead.fantasia || lead.razao || lead.cnpj;
    const tr = document.createElement('tr');
    tr.dataset.cnpj = lead.cnpj;
    tr.innerHTML = `
      <td><span class="${tagClass(lead.classificacao)}">${lead.classificacao}</span></td>
      <td><span class="score-pill">${lead.scoreComercial || lead.score}</span></td>
      <td title="${lead.razao}">${nome}</td>
      <td>${lead.segmento}</td>
      <td>${lead.segmentoPrioritario || 'Outros'}</td>
      <td>${lead.cidade}${lead.uf ? ' / ' + lead.uf : ''}</td>
      <td>${lead.telefone1 || '—'}</td>
      <td title="${lead.email}">${lead.email ? `<span style="font-size:11px">${lead.email}</span>` : '—'}</td>
      <td>${lead.site ? `<a href="${lead.site.startsWith('http') ? lead.site : 'http://'+lead.site}" target="_blank" class="link-site">🔗</a>` : '—'}</td>
      <td>${lead.pacoteSugerido || 'Plano Presenca'}</td>
      <td>${lead.prioridadeComercial || 'Baixa Prioridade'}</td>
    `;
    tr.addEventListener('click', () => {
      const target = leadsIndexByCnpj.get(tr.dataset.cnpj);
      if (target) renderLeadInsight(target);
    });
    tbody.appendChild(tr);
  }
}

async function renderLeadInsight(lead) {
  const container = document.getElementById('lead-insight');
  if (!container) return;
  if (!lead) {
    container.innerHTML = `<div class="insight-empty">Selecione um lead para ver recomendacoes comerciais.</div>`;
    return;
  }

  container.innerHTML = `<div class="insight-loading">Carregando insight de ${lead.fantasia || lead.razao || lead.cnpj}...</div>`;

  let enrichment = null;
  try {
    const info = await fetchJson(`/api/leads/${encodeURIComponent(lead.cnpj)}/enrichment`);
    enrichment = info.enrichment;
  } catch (err) {
    console.error(err);
  }

  const gatilhos = (lead.gatilhosDetectados || []).join(' | ');
  const maturidade = enrichment?.maturidadeDigital || 'Nao identificado';
  const statusEnrichment = enrichment?.status || 'nao executado';

  container.innerHTML = `
    <div class="insight-grid">
      <div class="insight-card">
        <div class="insight-title">Oferta e pacote sugerido</div>
        <div class="insight-main">${lead.ofertaPrincipal || 'Presenca Basica OOH'}</div>
        <div class="insight-sub">${lead.pacoteSugerido || 'Plano Presenca'} · ${lead.prioridadeComercial || 'Baixa Prioridade'}</div>
      </div>
      <div class="insight-card">
        <div class="insight-title">Abordagem comercial</div>
        <div class="insight-main">${lead.discursoConsultivo || ''}</div>
        <div class="insight-sub">Etapa: ${lead.etapaFunil || ''} · Proximo passo: ${lead.proximoPasso || ''}</div>
      </div>
      <div class="insight-card">
        <div class="insight-title">Dores e gatilhos</div>
        <div class="insight-main">${lead.dorPrincipal || ''}</div>
        <div class="insight-sub">Gatilhos: ${gatilhos || 'Nao identificado'}</div>
      </div>
      <div class="insight-card">
        <div class="insight-title">Enriquecimento digital</div>
        <div class="insight-main">Maturidade: ${maturidade}</div>
        <div class="insight-sub">Status: ${statusEnrichment}</div>
      </div>
    </div>
  `;
}

function renderPagination(total, page, limit) {
  const pages = Math.ceil(total / limit);
  const pag   = document.getElementById('pagination');
  pag.innerHTML = '';

  const range = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) range.push(i);
  if (range[0] > 1) range.unshift('...');
  if (range[range.length - 1] < pages) range.push('...');

  if (page > 1) {
    const btn = document.createElement('button');
    btn.className = 'page-btn'; btn.textContent = '← Anterior';
    btn.addEventListener('click', () => { currentPage--; loadLeads(); });
    pag.appendChild(btn);
  }

  range.forEach(r => {
    const btn = document.createElement('button');
    if (r === '...') { btn.className = 'page-btn'; btn.textContent = '...'; btn.disabled = true; }
    else {
      btn.className = 'page-btn' + (r === page ? ' active' : '');
      btn.textContent = r;
      btn.addEventListener('click', () => { currentPage = r; loadLeads(); });
    }
    pag.appendChild(btn);
  });

  if (page < pages) {
    const btn = document.createElement('button');
    btn.className = 'page-btn'; btn.textContent = 'Próximo →';
    btn.addEventListener('click', () => { currentPage++; loadLeads(); });
    pag.appendChild(btn);
  }
}

/* ─── Segmentos View ────────────────────────────────────────── */
function initSegmentosView() {
  if (charts.segmentos) return;

  const entries = Object.entries(stats.porSegmento).sort((a, b) => b[1] - a[1]);
  const labels  = entries.map(([k]) => k);
  const data    = entries.map(([,v]) => v);

  const palette = [
    '#ef4444','#f97316','#eab308','#22c55e','#14b8a6',
    '#3b82f6','#6366f1','#a855f7','#ec4899','#64748b',
    '#0ea5e9','#84cc16','#f59e0b','#10b981','#8b5cf6',
  ];

  charts.segmentos = new Chart(document.getElementById('chart-segmentos'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Leads',
        data,
        backgroundColor: palette.map(c => c + 'bb'),
        borderColor: palette,
        borderWidth: 1.5,
        borderRadius: 8,
      }],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: 'rgba(31,45,69,.4)' } },
        y: { ticks: { color: '#94a3b8', font: { size: 11 } }, grid: { color: 'rgba(31,45,69,.4)' } },
      },
    },
  });

  const container = document.getElementById('segmentos-cards');
  container.innerHTML = '';
  entries.forEach(([seg, count], i) => {
    const div = document.createElement('div');
    div.className = 'seg-card';
    div.innerHTML = `
      <div class="seg-name">${seg}</div>
      <div class="seg-count">${count.toLocaleString('pt-BR')}</div>
      <div class="seg-label">leads neste segmento</div>
    `
    container.appendChild(div);
  });
}


/* ─── Prospecção View & Kanban ────────────────────────────────── */
let prospeccaoViewInitialized = false;

function initProspeccaoView() {
  if (prospeccaoViewInitialized) {
    loadProspeccaoKanban();
    return;
  }
  prospeccaoViewInitialized = true;

  document.getElementById('btn-disparar-ia').addEventListener('click', async () => {
    if (!confirm('Deseja iniciar um disparo em lote usando o Gemini (IA)? O processo respeita os limites anti-ban.')) return;
    try {
      showApiError('Iniciando disparo com IA... acompanhe no painel de Enviados.', false);
      const res = await fetch('/api/prospeccao/disparar', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limite: 10, usarIA: true }) 
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro desconhecido');
      alert(`Disparo concluído: ${data.disparados} mensagens enviadas!`);
      clearApiError();
      loadProspeccaoKanban();
    } catch (err) {
      console.error(err);
      showApiError('Erro no disparo: ' + err.message);
    }
  });

  loadIaInsights();
  loadProspeccaoKanban();
}

async function loadIaInsights() {
  const container = document.getElementById('ia-insights-content');
  try {
    const res = await fetchJson('/api/ai/insights');
    if (res.error) throw new Error(res.error);
    container.innerHTML = `
      <p style="margin-bottom:8px"><strong>Estratégia sugerida:</strong> ${res.recomendacao_estrategica || 'Nenhuma recomendação técnica no momento'}</p>
      ${res.alerta ? `<p style="color:#ef4444;margin-bottom:8px"><strong>⚡ Alerta:</strong> ${res.alerta}</p>` : ''}
      <ul>
         <li>🎯 Foco Atual: <strong>${res.cidade_prioridade || '-'}</strong></li>
         <li>📌 Nicho Sugerido: <strong>${res.melhores_segmentos ? res.melhores_segmentos[0] : '-'}</strong></li>
         <li>⏰ Sazonalidade: <strong>${res.gatilho_sazonal || 'Sem tendência mapeada'}</strong></li>
      </ul>
    `;
  } catch (err) {
    container.innerHTML = '<p class="ia-loading">Não foi possível carregar os insights. O Gemini pode estar indisponível.</p>';
  }
}

async function loadProspeccaoKanban() {
  ['enviado','respondido','oportunidade','erro'].forEach(s => {
    const el = document.getElementById('cards-' + s);
    if(el) el.innerHTML = '';
    const countEl = document.getElementById('count-' + s);
    if(countEl) countEl.textContent = '0';
  });

  try {
    const data = await fetchJson('/api/prospeccao/status');
    if (!data.entries) return;

    data.entries.forEach(lead => {
      const status = lead.status === 'ignorando' ? 'erro' : lead.status;
      const targetCol = document.getElementById('cards-' + status);
      if (!targetCol) return;

      const countSpan = document.getElementById('count-' + status);
      countSpan.textContent = parseInt(countSpan.textContent) + 1;

      const card = document.createElement('div');
      card.className = 'kb-card';
      let titleParams = '';
      if(lead.intentDetectado) {
         titleParams = `<div class="kb-intent">🎯 ${lead.intentDetectado.tipo.toUpperCase()} (Urgência: ${lead.intentDetectado.urgencia})</div>`;
      }
      if(lead.erro) {
         titleParams = `<div class="kb-error">🚨 ${lead.erro}</div>`;
      }

      card.innerHTML = `
        <div class="kb-card-header">
           <span class="kb-cnpj">${lead.cnpj}</span>
           <span class="kb-time">${new Date(lead.respondidoEm || lead.enviadoEm || Date.now()).toLocaleDateString()}</span>
        </div>
        <div class="kb-title" title="${lead.razao || 'Empresa desconhecida'}">${lead.fantasia || lead.razao || 'Lead ' + lead.cnpj}</div>
        <div class="kb-city">📍 ${lead.cidade || 'Local não informado'} | ${lead.segmentoPrioritario || 'Varejo'}</div>
        <div class="kb-status-tag" style="${lead.status === 'oportunidade' ? 'background:rgba(245,158,11,0.2);color:#f59e0b;' : ''}">${lead.classificacao}</div>
        ${titleParams}
      `;

      card.addEventListener('click', () => openHistoricoModal(lead.cnpj, lead.fantasia || lead.razao, lead.status));
      targetCol.appendChild(card);
    });

  } catch (err) {
    console.error('Erro ao carregar kanban:', err);
  }
}

async function openHistoricoModal(cnpj, nome, status) {
  let modal = document.getElementById('hist-modal');
  if(!modal) {
     modal = document.createElement('div');
     modal.id = 'hist-modal';
     modal.className = 'modal-overlay';
     modal.innerHTML = `
       <div class="modal-content">
         <div class="modal-header">
            <h2 id="hist-title">Histórico: Empresa</h2>
            <button class="btn-close" id="btn-close-hist">×</button>
         </div>
         <div class="modal-body" id="hist-body">Carregando...</div>
       </div>
     `;
     document.body.appendChild(modal);
     document.getElementById('btn-close-hist').addEventListener('click', () => modal.classList.remove('active'));
  }

  document.getElementById('hist-title').textContent = 'Conversa: ' + nome;
  document.getElementById('hist-body').innerHTML = '<div class="loader"><div class="spinner"></div> Carregando...</div>';
  modal.classList.add('active');

  try {
     const hist = await fetchJson('/api/prospeccao/'+cnpj+'/historico');
     if(!hist || !hist.messages || hist.messages.length === 0) {
        document.getElementById('hist-body').innerHTML = '<p style="color:var(--text-muted)">Nenhuma mensagem registrada na IA ainda. Talvez o lead não tenha respondido.</p>';
        return;
     }

     document.getElementById('hist-body').innerHTML = hist.messages.map(m => `
       <div class="chat-bubble ${m.role}">
         <div class="chat-role">${m.role === 'model' ? '🤖 Gemini IA (Lourdes)' : '👤 Lead (${nome})'}</div>
         <div>${m.text.replace(/\n/g, '<br/>')}</div>
       </div>
     `).join('');

     // Scroll to bottom
     const body = document.getElementById('hist-body');
     body.scrollTop = body.scrollHeight;

  } catch (e) {
     document.getElementById('hist-body').innerHTML = '<p style="color:var(--text-muted)">Falha ao carregar histórico... Talvez não haja interações com o bot.</p>';
  }
}

/* ── Configurações IA View ────────────────────────────────────── */
let configViewInitialized = false;

async function initConfigView() {
  if (configViewInitialized) return;
  configViewInitialized = true;

  const btnSalvar = document.getElementById('btn-salvar-config');
  const msg = document.getElementById('config-status-msg');

  try {
    const config = await fetchJson('/api/config');
    document.getElementById('cfg-agente-nome').value = config.BDR_AGENTE_NOME || '';
    document.getElementById('cfg-agente-cargo').value = config.BDR_AGENTE_CARGO || '';
    document.getElementById('cfg-system-prompt').value = config.BDR_SYSTEM_PROMPT || '';
    document.getElementById('cfg-gemini-model').value = config.GEMINI_MODEL || '';
    document.getElementById('cfg-gemini-temp').value = config.GEMINI_TEMPERATURA || '';
    document.getElementById('cfg-hora-inicio').value = config.PROSPECCAO_HORA_INICIO || '';
    document.getElementById('cfg-hora-fim').value = config.PROSPECCAO_HORA_FIM || '';
    document.getElementById('cfg-cooldown').value = config.PROSPECCAO_COOLDOWN_DIAS || '';
    document.getElementById('cfg-limite').value = config.PROSPECCAO_LIMITE_DIARIO || '';
    document.getElementById('cfg-numeros-teste').value = config.NUMEROS_TESTE || '';
  } catch (err) {
    showMsg('Erro ao carregar configurações: ' + err.message, 'error');
  }

  function showMsg(text, type) {
    msg.textContent = text;
    msg.style.display = 'block';
    msg.style.backgroundColor = type === 'success' ? '#065f46' : '#7f1d1d';
    msg.style.color = type === 'success' ? '#a7f3d0' : '#fecaca';
    msg.style.border = `1px solid ${type === 'success' ? '#059669' : '#b91c1c'}`;
    setTimeout(() => msg.style.display = 'none', 5000);
  }

  btnSalvar.addEventListener('click', async () => {
    const updates = {
      BDR_AGENTE_NOME: document.getElementById('cfg-agente-nome').value,
      BDR_AGENTE_CARGO: document.getElementById('cfg-agente-cargo').value,
      BDR_SYSTEM_PROMPT: document.getElementById('cfg-system-prompt').value,
      GEMINI_MODEL: document.getElementById('cfg-gemini-model').value,
      GEMINI_TEMPERATURA: document.getElementById('cfg-gemini-temp').value,
      PROSPECCAO_HORA_INICIO: document.getElementById('cfg-hora-inicio').value,
      PROSPECCAO_HORA_FIM: document.getElementById('cfg-hora-fim').value,
      PROSPECCAO_COOLDOWN_DIAS: document.getElementById('cfg-cooldown').value,
      PROSPECCAO_LIMITE_DIARIO: document.getElementById('cfg-limite').value,
      NUMEROS_TESTE: document.getElementById('cfg-numeros-teste').value
    };

    btnSalvar.disabled = true;
    btnSalvar.textContent = 'Salvando...';

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao salvar');
      showMsg('Configurações da IA atualizadas com sucesso!', 'success');
    } catch (err) {
      showMsg('Erro: ' + err.message, 'error');
    } finally {
      btnSalvar.disabled = false;
      btnSalvar.textContent = '💾 Salvar Configurações';
    }
  });

  // Base de Conhecimento
  const uploadInput = document.getElementById('knowledge-file');
  const uploadStatus = document.getElementById('upload-status');
  
  uploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    
    uploadStatus.style.color = 'var(--text-light)';
    uploadStatus.textContent = '⏱️ Carregando e processando semântica do arquivo. Pode levar alguns minutos...';

    try {
      const res = await fetch('/api/knowledge/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro no upload');
      
      uploadStatus.style.color = '#34d399';
      uploadStatus.textContent = `✅ Sucesso! O bot memorizou ${data.inseridos} blocos lógicos desse arquivo.`;
      loadKnowledgeBase();
    } catch(err) {
      uploadStatus.style.color = '#f87171';
      uploadStatus.textContent = `❌ Falha: ${err.message}`;
    } finally {
      uploadInput.value = '';
    }
  });

  loadKnowledgeBase();
}

async function loadKnowledgeBase() {
  const container = document.getElementById('knowledge-list');
  try {
    const res = await fetchJson('/api/knowledge');
    if (!res || res.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">Nenhum documento treinado.</p>';
      return;
    }
    
    container.innerHTML = res.map(doc => `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-color); padding: 12px 0;">
        <div>
          <div style="font-weight:600; color:var(--text-light); font-size:14px;">${doc.fonte_arquivo || doc.titulo}</div>
          <div style="font-size:12px; color:var(--text-muted); line-height:1.4; margin-top:4px;">${doc.resumo}</div>
        </div>
        <button class="btn btn-close" style="color:#ef4444;" onclick="deleteKnowledge(${doc.id})">🗑️</button>
      </div>
    `).join('');
  } catch(err) {
    container.innerHTML = '<p style="color:#ef4444; font-size: 13px;">Erro ao carregar lista.</p>';
  }
}

async function deleteKnowledge(id) {
  if (!confirm('Deseja realmente remover este bloco da memória da IA?')) return;
  try {
    const res = await fetch('/api/knowledge/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error('Erro ao deletar');
    loadKnowledgeBase();
  } catch(err) {
    alert(err.message);
  }
}
