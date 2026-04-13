const fs = require('fs');
let code = fs.readFileSync('public/app.js', 'utf8');

// fix the botched line
code = code.replace(/\\`\s*;\s*container.appendChild/g, '`\n    container.appendChild');

const appendCode = `
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
      alert(\`Disparo concluído: \${data.disparados} mensagens enviadas!\`);
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
    container.innerHTML = \`
      <p style="margin-bottom:8px"><strong>Estratégia sugerida:</strong> \${res.recomendacao_estrategica || 'Nenhuma recomendação técnica no momento'}</p>
      \${res.alerta ? \\\`<p style="color:#ef4444;margin-bottom:8px"><strong>⚡ Alerta:</strong> \${res.alerta}</p>\\\` : ''}
      <ul>
         <li>🎯 Foco Atual: <strong>\${res.cidade_prioridade || '-'}</strong></li>
         <li>📌 Nicho Sugerido: <strong>\${res.melhores_segmentos ? res.melhores_segmentos[0] : '-'}</strong></li>
         <li>⏰ Sazonalidade: <strong>\${res.gatilho_sazonal || 'Sem tendência mapeada'}</strong></li>
      </ul>
    \`;
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
         titleParams = \`<div class="kb-intent">🎯 \${lead.intentDetectado.tipo.toUpperCase()} (Urgência: \${lead.intentDetectado.urgencia})</div>\`;
      }
      if(lead.erro) {
         titleParams = \`<div class="kb-error">🚨 \${lead.erro}</div>\`;
      }

      card.innerHTML = \`
        <div class="kb-card-header">
           <span class="kb-cnpj">\${lead.cnpj}</span>
           <span class="kb-time">\${new Date(lead.respondidoEm || lead.enviadoEm || Date.now()).toLocaleDateString()}</span>
        </div>
        <div class="kb-title" title="\${lead.razao || 'Empresa desconhecida'}">\${lead.fantasia || lead.razao || 'Lead ' + lead.cnpj}</div>
        <div class="kb-city">📍 \${lead.cidade || 'Local não informado'} | \${lead.segmentoPrioritario || 'Varejo'}</div>
        <div class="kb-status-tag" style="\${lead.status === 'oportunidade' ? 'background:rgba(245,158,11,0.2);color:#f59e0b;' : ''}">\${lead.classificacao}</div>
        \${titleParams}
      \`;

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
     modal.innerHTML = \`
       <div class="modal-content">
         <div class="modal-header">
            <h2 id="hist-title">Histórico: Empresa</h2>
            <button class="btn-close" id="btn-close-hist">×</button>
         </div>
         <div class="modal-body" id="hist-body">Carregando...</div>
       </div>
     \`;
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

     document.getElementById('hist-body').innerHTML = hist.messages.map(m => \`
       <div class="chat-bubble \${m.role}">
         <div class="chat-role">\${m.role === 'model' ? '🤖 Gemini IA (Lourdes)' : '👤 Lead (\${nome})'}</div>
         <div>\${m.text.replace(/\\n/g, '<br/>')}</div>
       </div>
     \`).join('');

     // Scroll to bottom
     const body = document.getElementById('hist-body');
     body.scrollTop = body.scrollHeight;

  } catch (e) {
     document.getElementById('hist-body').innerHTML = '<p style="color:var(--text-muted)">Falha ao carregar histórico... Talvez não haja interações com o bot.</p>';
  }
}
`;

fs.writeFileSync('public/app.js', code + appendCode);
console.log('Fixed app.js fully!');
