// content.js — Throttle v1.1
// Overlay redesenhado: cápsula compacta centralizada, sem margin-top no body.
// Corrige: filtro de orgId, showBar reativo via storage.onChanged.

(() => {
  if (window.__THROTTLE_UI__) return;
  window.__THROTTLE_UI__ = true;

  let host = null;
  let shadow = null;
  let currentAnalysis = null;
  let tabOrgId = null; // orgId desta aba específica
  let submitObserverBound = false;

  const BRIDGE_TOKEN_ATTR = 'data-throttle-token';

  function getAccountId() {
    return tabOrgId ? `claude:${tabOrgId}` : null;
  }

  function isExtensionContextAlive() {
    try {
      return typeof chrome !== 'undefined'
        && !!chrome.runtime
        && typeof chrome.runtime.sendMessage === 'function'
        && !!chrome.runtime.id;
    } catch (_err) {
      return false;
    }
  }

  function safeSendMessage(message, onResponse = null) {
    if (!isExtensionContextAlive()) return;

    try {
      if (typeof onResponse === 'function') {
        chrome.runtime.sendMessage(message, (resp) => {
          try {
            if (!isExtensionContextAlive()) return;
            if (chrome.runtime.lastError) return;
            onResponse(resp);
          } catch (_err) {}
        });
        return;
      }

      const maybePromise = chrome.runtime.sendMessage(message);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (!msg.includes('Extension context invalidated')) {
        console.debug('[Throttle] sendMessage failed:', msg);
      }
    }
  }

  // -------- Shadow DOM --------

  function mountBar() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'throttle-host';
    // Overlay puro: não empurra o layout da página
    host.style.cssText = `
      position: fixed;
      top: 10px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      pointer-events: auto;
    `;
    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }

        /* Cápsula principal */
        .capsule {
          display: flex;
          align-items: center;
          height: 34px;
          background: rgba(10, 10, 12, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.10);
          border-radius: 999px;
          font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
          font-size: 11px;
          color: #e5e7eb;
          user-select: none;
          white-space: nowrap;
          overflow: hidden;
          box-shadow: 0 4px 16px rgba(0,0,0,0.35);
          transition: box-shadow 0.3s ease, border-color 0.3s ease, max-width 0.4s cubic-bezier(0.4,0,0.2,1);
          max-width: 340px;
          cursor: default;
        }

        /* Estado de risco: borda fica mais visível */
        .capsule[data-status="red"] {
          border-color: rgba(239, 68, 68, 0.45);
          box-shadow: 0 4px 16px rgba(220,38,38,0.25);
        }
        .capsule[data-status="yellow"] {
          border-color: rgba(234, 179, 8, 0.35);
        }

        /* Estado expandido por hover */
        .capsule:hover {
          max-width: 480px;
          border-color: rgba(255,255,255,0.18);
        }
        .capsule:hover .extra { max-width: 160px; opacity: 1; }

        /* Seções internas */
        .seg {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 12px;
          height: 100%;
          flex-shrink: 0;
        }

        .divider {
          width: 1px;
          height: 16px;
          background: rgba(255,255,255,0.12);
          flex-shrink: 0;
        }

        /* Mini velocímetro SVG */
        .speedo-wrap {
          display: flex;
          align-items: center;
          padding: 0 10px;
          height: 100%;
          background: rgba(255,255,255,0.04);
          flex-shrink: 0;
          gap: 5px;
        }

        /* Tag (5H, 7D) */
        .tag {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.1em;
          color: rgba(255,255,255,0.45);
          flex-shrink: 0;
        }

        /* Barra de progresso inline */
        .bar-wrap {
          width: 52px;
          height: 3px;
          background: rgba(255,255,255,0.12);
          border-radius: 2px;
          overflow: hidden;
          flex-shrink: 0;
        }
        .bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width 0.9s cubic-bezier(0.4,0,0.2,1), background 0.3s ease;
        }

        /* Percentual */
        .pct {
          font-weight: 600;
          font-size: 12px;
          color: #fafafa;
          min-width: 30px;
          text-align: right;
        }

        /* Texto auxiliar (reset/eta) */
        .aux {
          font-size: 10px;
          color: rgba(255,255,255,0.5);
        }
        .aux[data-warn="true"] {
          color: #fca5a5;
          font-weight: 600;
        }

        /* Badge 7D — pequeno, sempre visível se em risco */
        .badge-7d {
          font-size: 9px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 999px;
          flex-shrink: 0;
          transition: background 0.3s ease, color 0.3s ease;
        }
        .badge-7d[data-risk="low"]    { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.35); }
        .badge-7d[data-risk="medium"] { background: rgba(234,179,8,0.18);  color: #fbbf24; }
        .badge-7d[data-risk="high"]   { background: rgba(239,68,68,0.22);  color: #f87171; animation: pulse 2s ease-in-out infinite; }

        /* PACE + trend */
        .pace-val {
          font-size: 13px;
          font-weight: 700;
          color: #f59e0b;
          min-width: 28px;
          text-align: center;
          transition: color 0.3s ease;
        }
        .pace-val[data-status="red"]    { color: #f87171; }
        .pace-val[data-status="yellow"] { color: #fbbf24; }
        .pace-val[data-status="blue"]   { color: #60a5fa; }

        /* Seta de trend */
        .trend {
          font-size: 10px;
          line-height: 1;
          flex-shrink: 0;
          transition: color 0.3s ease;
        }
        .trend[data-dir="up"]     { color: #f87171; }
        .trend[data-dir="down"]   { color: #86efac; }
        .trend[data-dir="stable"] { color: rgba(255,255,255,0.3); }

        /* Mensagem operacional — aparece no hover */
        .extra {
          max-width: 0;
          opacity: 0;
          overflow: hidden;
          transition: max-width 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease;
          font-size: 10px;
          color: rgba(255,255,255,0.55);
          padding-right: 4px;
          flex-shrink: 0;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.65; }
        }

        @media (max-width: 500px) {
          .aux { display: none; }
          .bar-wrap { width: 36px; }
        }
      </style>

      <div class="capsule" id="capsule" title="Throttle — clique para atualizar">

        <!-- Velocímetro mini -->
        <div class="speedo-wrap" id="speedo-wrap">
          <svg width="28" height="18" viewBox="0 0 28 18" id="speedo-svg">
            <path d="M 2 16 A 12 12 0 0 1 26 16" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2.8" stroke-linecap="round"/>
            <path d="M 2 16 A 12 12 0 0 1 8 5"   fill="none" stroke="#1e40af" stroke-width="2.8" stroke-linecap="round" opacity="0.7"/>
            <path d="M 8 5 A 12 12 0 0 1 20 5"   fill="none" stroke="#16a34a" stroke-width="2.8" stroke-linecap="round" opacity="0.7"/>
            <path d="M 20 5 A 12 12 0 0 1 26 16" fill="none" stroke="#dc2626" stroke-width="2.8" stroke-linecap="round" opacity="0.7"/>
            <line id="needle"
              x1="14" y1="16" x2="14" y2="5"
              stroke="#f59e0b" stroke-width="2" stroke-linecap="round"
              style="transform-origin: 14px 16px; transform: rotate(-90deg); transition: transform 0.9s cubic-bezier(0.34,1.56,0.64,1);"/>
            <circle cx="14" cy="16" r="2.2" fill="#f59e0b"/>
          </svg>
          <span class="pace-val" id="pace-val">—</span>
          <span class="trend" id="trend-arrow" data-dir="stable">—</span>
        </div>

        <div class="divider"></div>

        <!-- 5H -->
        <div class="seg">
          <span class="tag">5H</span>
          <div class="bar-wrap"><div class="bar-fill" id="fill-5h"></div></div>
          <span class="pct" id="pct-5h">—</span>
          <span class="aux" id="aux-5h">—</span>
        </div>

        <div class="divider"></div>

        <!-- Badge 7D (sempre visível, tamanho mínimo) -->
        <div class="seg" style="padding: 0 8px;">
          <span class="badge-7d" id="badge-7d" data-risk="low">7D —</span>
        </div>

        <!-- Expansão no hover: msg operacional + detalhe 7D -->
        <span class="extra" id="extra-msg">—</span>

      </div>
    `;

    document.documentElement.appendChild(host);

    shadow.getElementById('capsule').addEventListener('click', () => {
      safeSendMessage({
        type: 'FORCE_POLL',
        provider: 'claude',
        accountId: getAccountId()
      });
    });
  }

  function unmountBar() {
    if (host) { host.remove(); host = null; shadow = null; }
  }

  // -------- Render --------

  function render(analysis) {
    if (!shadow || !analysis || !analysis.ready) return;

    const { latest, minutesToReset5h, minutesToReset7d, rpmBlend, trend, status, operationalMsg, etaBlend, eta15 } = analysis;

    const capsule = shadow.getElementById('capsule');
    capsule.dataset.status = status;

    // --- Velocímetro ---
    const needle = shadow.getElementById('needle');
    const paceEl = shadow.getElementById('pace-val');
    const trendEl = shadow.getElementById('trend-arrow');

    if (rpmBlend !== null) {
      const clamped = Math.max(0, Math.min(200, rpmBlend));
      // Meia-circunferência: -90deg (esquerda) a +90deg (direita)
      const angle = -90 + (clamped / 200) * 180;
      needle.style.transform = `rotate(${angle}deg)`;
      paceEl.textContent = Math.round(rpmBlend);
      let paceStatus = 'green';
      if (rpmBlend > 130) paceStatus = 'red';
      else if (rpmBlend > 105) paceStatus = 'yellow';
      else if (rpmBlend < 50) paceStatus = 'blue';
      paceEl.dataset.status = paceStatus;
    } else {
      paceEl.textContent = '—';
      paceEl.dataset.status = 'green';
    }

    // Trend arrow
    if (trend === 'up') {
      trendEl.textContent = '↑';
      trendEl.dataset.dir = 'up';
      trendEl.title = 'acelerando';
    } else if (trend === 'down') {
      trendEl.textContent = '↓';
      trendEl.dataset.dir = 'down';
      trendEl.title = 'desacelerando';
    } else {
      trendEl.textContent = '→';
      trendEl.dataset.dir = 'stable';
      trendEl.title = 'ritmo estável';
    }

    // --- 5H ---
    if (latest.u5h !== null) {
      const fill5h = shadow.getElementById('fill-5h');
      const pct5h = shadow.getElementById('pct-5h');
      const aux5h = shadow.getElementById('aux-5h');

      const color5h = latest.u5h >= 100 ? '#ef4444' : '#22c55e';

      fill5h.style.width = `${Math.min(latest.u5h, 100)}%`;
      fill5h.style.background = color5h;
      pct5h.textContent = `${latest.u5h.toFixed(0)}%`;

      // Aux: mostra ETA de esgotamento se em risco, senão mostra reset
      const inRisk = eta15 !== null && eta15 !== Infinity && minutesToReset5h !== null && eta15 < minutesToReset5h;
      if (inRisk) {
        aux5h.textContent = `zera ${fmtMin(eta15)}`;
        aux5h.dataset.warn = 'true';
      } else {
        aux5h.textContent = `reset ${fmtMin(minutesToReset5h)}`;
        aux5h.dataset.warn = 'false';
      }
    }

    // --- Badge 7D ---
    const badge7d = shadow.getElementById('badge-7d');
    if (latest.u7d !== null) {
      let risk7d = 'low';
      if (latest.u7d >= 85) risk7d = 'high';
      else if (latest.u7d >= 70) risk7d = 'medium';
      badge7d.dataset.risk = risk7d;
      badge7d.textContent = `7D ${latest.u7d.toFixed(0)}%`;
      badge7d.title = `Janela semanal: ${latest.u7d.toFixed(1)}% — reset ${fmtMin(minutesToReset7d)}`;
    } else {
      badge7d.dataset.risk = 'low';
      badge7d.textContent = '7D —';
    }

    // --- Mensagem operacional (hover expand) ---
    const extraEl = shadow.getElementById('extra-msg');
    if (operationalMsg) {
      extraEl.textContent = operationalMsg;
    } else {
      extraEl.textContent = '';
    }
  }

  function fmtMin(min) {
    if (min === null || min === undefined || !isFinite(min) || min < 0) return '—';
    if (min < 1) return 'agora';
    if (min < 60) return `em ${Math.round(min)}min`;
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return m > 0 ? `em ${h}h${m}m` : `em ${h}h`;
  }

  // -------- Submit observer --------

  function setupSubmitObserver() {
    if (submitObserverBound) return;
    submitObserverBound = true;

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        const t = e.target;
        if (t && (t.tagName === 'TEXTAREA' || t.getAttribute?.('contenteditable') === 'true')) {
          schedulePoll();
        }
      }
    }, true);

    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('button');
      if (!btn) return;
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('send') || label.includes('enviar')) {
        schedulePoll();
      }
    }, true);
  }

  let pollTimer = null;
  function schedulePoll() {
    if (!isExtensionContextAlive()) return;

    try {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        if (!isExtensionContextAlive()) return;
        safeSendMessage({
          type: 'FORCE_POLL',
          provider: 'claude',
          accountId: getAccountId()
        });
      }, 3500);
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (!msg.includes('Extension context invalidated')) {
        console.debug('[Throttle] schedulePoll failed:', msg);
      }
    }
  }

  // -------- State subscription --------

  function requestState() {
    safeSendMessage({
      type: 'GET_STATE',
      provider: 'claude',
      accountId: getAccountId()
    }, (resp) => {
      if (resp && resp.ok && resp.analysis) {
        currentAnalysis = resp.analysis;
        render(resp.analysis);
      }
    });
  }

  // v1.1: filtra STATE_UPDATE pelo orgId desta aba
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'STATE_UPDATE' || msg.provider !== 'claude') return;
    const accountId = getAccountId();
    if (accountId && msg.accountId && msg.accountId !== accountId) return;
    currentAnalysis = msg.analysis;
    render(msg.analysis);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      safeSendMessage({
        type: 'FORCE_POLL',
        provider: 'claude',
        accountId: getAccountId()
      });
    }
  });

  // v1.1: reatividade de showBar via storage.onChanged
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const newSettings = changes.settings.newValue;
      if (newSettings) {
        if (newSettings.showBar === false) {
          unmountBar();
        } else if (newSettings.showBar === true && !host) {
          mountBar();
          setupSubmitObserver();
          requestState();
        }
      }
    }
  });

  // -------- Init --------

  // Tenta descobrir o orgId desta aba a partir da URL ou aguarda ORG_SEEN
  function tryExtractOrgFromUrl() {
    const m = location.href.match(/\/organizations\/([0-9a-f-]+)/);
    if (m) tabOrgId = m[1];
  }

  // Escuta ORG_SEEN vindo do bridge para saber o orgId desta aba
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    const token = document.documentElement.getAttribute(BRIDGE_TOKEN_ATTR);
    if (
      msg?.source === 'THROTTLE_CORE' &&
      msg.type === 'ORG_SEEN' &&
      typeof msg.orgId === 'string' &&
      msg.token === token
    ) {
      tabOrgId = msg.orgId;
    }
  });

  tryExtractOrgFromUrl();

  chrome.storage.local.get('settings', ({ settings }) => {
    if (settings && settings.showBar === false) return;
    mountBar();
    setupSubmitObserver();
    requestState();
  });

})();
