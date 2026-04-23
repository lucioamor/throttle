// content-lovable.js — Throttle v2
// Overlay no domínio lovable.dev. Mesma arquitetura do content.js do Claude:
// Shadow DOM, sem margin-top no body, tabContext por aba, showBar reativo.

(() => {
  if (window.__THROTTLE_LOVABLE_UI__) return;
  window.__THROTTLE_LOVABLE_UI__ = true;

  let host   = null;
  let shadow = null;
  let tabAccountId = null; // "lovable:wsId" desta aba

  const LOVABLE_TOKEN_ATTR = 'data-throttle-lovable-token';
  const WS_ID_RE = /^[a-zA-Z0-9_-]{2,128}$/;

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

  // -------- Injeta interceptor no MAIN world --------

  function injectInterceptor() {
    try {
      ensureToken();
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('interceptor-lovable.js');
      script.onload  = () => script.remove();
      script.onerror = () => script.remove();
      document.documentElement.appendChild(script);
    } catch (e) {
      console.warn('[Throttle] Lovable interceptor injection failed:', e.message);
    }
  }

  function ensureToken() {
    const root = document.documentElement;
    if (!root) return null;
    const existing = root.getAttribute(LOVABLE_TOKEN_ATTR);
    if (existing) return existing;

    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    root.setAttribute(LOVABLE_TOKEN_ATTR, token);
    return token;
  }

  // -------- Bridge: MAIN world → background --------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.source !== 'THROTTLE_LOVABLE' || msg?.type !== 'LOVABLE_USAGE') return;
    if (msg.token !== document.documentElement.getAttribute(LOVABLE_TOKEN_ATTR)) return;

    const snap = msg.payload;
    if (!snap?.ws_id || !WS_ID_RE.test(snap.ws_id)) return;

    // Atualiza o contexto da aba caso o workspace mude
    tabAccountId = `lovable:${snap.ws_id}`;

    safeSendMessage({
      type:    'LOVABLE_USAGE_INTERCEPTED',
      wsId:    snap.ws_id,
      wsName:  snap.ws_name,
      data:    snap
    });
  });

  // -------- Shadow DOM --------

  function mountBar() {
    if (host) return;

    host = document.createElement('div');
    host.id = 'throttle-lovable-host';
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
        .capsule {
          position: relative;
          display: flex;
          align-items: center;
          height: 34px;
          background: rgba(10, 10, 12, 0.88);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border: 1px solid rgba(255, 255, 255, 0.10);
          border-radius: 999px;
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          font-size: 11px;
          color: #e5e7eb;
          user-select: none;
          white-space: nowrap;
          overflow: hidden;
          box-shadow: 0 4px 16px rgba(0,0,0,0.35);
          transition: box-shadow 0.3s ease, border-color 0.3s ease, max-width 0.4s cubic-bezier(0.4,0,0.2,1);
          max-width: 380px;
          cursor: default;
        }
        .capsule[data-locked="true"] {
          border-color: rgba(239,68,68,0.45);
          box-shadow: 0 4px 18px rgba(220,38,38,0.22);
        }
        .capsule[data-status="red"]    { border-color: rgba(239,68,68,0.45);  box-shadow: 0 4px 16px rgba(220,38,38,0.22); }
        .capsule[data-status="yellow"] { border-color: rgba(234,179,8,0.35); }
        .capsule:hover { max-width: 520px; border-color: rgba(255,255,255,0.18); }
        .capsule:hover .extra { max-width: 180px; opacity: 1; }

        .provider-tag {
          padding: 0 8px;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.12em;
          color: #f59e0b;
          background: rgba(245,158,11,0.10);
          border-right: 1px solid rgba(255,255,255,0.08);
          height: 100%;
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }

        .seg {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 10px;
          height: 100%;
          flex-shrink: 0;
        }
        .divider { width: 1px; height: 16px; background: rgba(255,255,255,0.12); flex-shrink: 0; }

        .tag { font-size: 9px; font-weight: 700; letter-spacing: 0.1em; color: rgba(255,255,255,0.40); flex-shrink: 0; }

        /* TODAY PACE — velocímetro */
        .speedo-wrap {
          display: flex; align-items: center; padding: 0 10px;
          height: 100%; gap: 5px; flex-shrink: 0;
          background: rgba(255,255,255,0.04);
        }
        .pace-val {
          font-size: 13px; font-weight: 700; color: #f59e0b;
          min-width: 28px; text-align: center; transition: color 0.3s ease;
        }
        .pace-val[data-status="red"]    { color: #f87171; }
        .pace-val[data-status="yellow"] { color: #fbbf24; }
        .pace-val[data-status="blue"]   { color: #60a5fa; }
        .trend { font-size: 10px; flex-shrink: 0; transition: color 0.3s ease; }
        .trend[data-dir="up"]     { color: #f87171; }
        .trend[data-dir="down"]   { color: #86efac; }
        .trend[data-dir="stable"] { color: rgba(255,255,255,0.3); }

        /* Créditos diários: dots */
        .dots { display: flex; gap: 3px; align-items: center; }
        .dot  { width: 6px; height: 6px; border-radius: 50%; transition: background 0.3s ease; flex-shrink: 0; }
        .dot.used { background: rgba(255,255,255,0.15); }
        .dot.avail { background: #22c55e; }
        .dot.avail[data-warn="true"] { background: #eab308; }

        /* MONTHLY BURN bar */
        .bar-wrap { width: 44px; height: 3px; background: rgba(255,255,255,0.12); border-radius: 2px; overflow: hidden; flex-shrink: 0; }
        .bar-fill { height: 100%; border-radius: 2px; transition: width 0.9s cubic-bezier(0.4,0,0.2,1), background 0.3s ease; }
        .pct { font-weight: 600; font-size: 12px; color: #fafafa; min-width: 30px; text-align: right; }

        /* Cloud/AI badges — só quando em risco */
        .passive-badges { display: flex; gap: 4px; padding: 0 8px; flex-shrink: 0; }
        .badge {
          font-size: 9px; font-weight: 700; padding: 2px 5px;
          border-radius: 999px; flex-shrink: 0;
          transition: background 0.3s ease, opacity 0.3s ease;
        }
        .badge.hidden { display: none; }
        .badge[data-risk="yellow"] { background: rgba(234,179,8,0.18);  color: #fbbf24; }
        .badge[data-risk="red"]    { background: rgba(239,68,68,0.22);  color: #f87171; animation: pulse 2s ease-in-out infinite; }

        /* Hover expand */
        .extra {
          max-width: 0; opacity: 0; overflow: hidden;
          transition: max-width 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease;
          font-size: 10px; color: rgba(255,255,255,0.5); padding-right: 4px; flex-shrink: 0;
        }

        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.65} }
        @media (max-width: 500px) { .bar-wrap { width: 32px; } .passive-badges { display: none; } }

        .lock-overlay {
          position: absolute;
          inset: 0;
          border-radius: 999px;
          background: rgba(10, 10, 12, 0.78);
          backdrop-filter: blur(2px);
          -webkit-backdrop-filter: blur(2px);
          display: none;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 0 12px;
          pointer-events: none;
          z-index: 2;
        }
        .capsule[data-locked="true"] .lock-overlay { display: flex; }
        .lock-title {
          font-size: 10px;
          font-weight: 700;
          color: #fca5a5;
          letter-spacing: 0.04em;
        }
        .lock-sub {
          font-size: 10px;
          color: #d4d4d8;
        }
      </style>

      <div class="capsule" id="capsule" title="Throttle Lovable — clique para detalhes">

        <div class="provider-tag">LVB</div>

        <!-- TODAY PACE: velocímetro mini -->
        <div class="speedo-wrap" id="speedo-wrap">
          <svg width="28" height="18" viewBox="0 0 28 18">
            <path d="M 2 16 A 12 12 0 0 1 26 16" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2.8" stroke-linecap="round"/>
            <path d="M 2 16 A 12 12 0 0 1 8 5"   fill="none" stroke="#1e40af" stroke-width="2.8" stroke-linecap="round" opacity="0.7"/>
            <path d="M 8 5 A 12 12 0 0 1 20 5"   fill="none" stroke="#16a34a" stroke-width="2.8" stroke-linecap="round" opacity="0.7"/>
            <path d="M 20 5 A 12 12 0 0 1 26 16" fill="none" stroke="#dc2626" stroke-width="2.8" stroke-linecap="round" opacity="0.7"/>
            <line id="needle" x1="14" y1="16" x2="14" y2="5" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"
              style="transform-origin:14px 16px; transform:rotate(-90deg); transition:transform 0.9s cubic-bezier(0.34,1.56,0.64,1);"/>
            <circle cx="14" cy="16" r="2.2" fill="#f59e0b"/>
          </svg>
          <span class="pace-val" id="today-pace-val">—</span>
          <span class="trend"    id="today-trend" data-dir="stable">→</span>
        </div>

        <div class="divider"></div>

        <!-- Créditos diários: dots (5 dots = 5 créditos) -->
        <div class="seg">
          <span class="tag">TODAY</span>
          <div class="dots" id="daily-dots"></div>
          <span class="pct" id="daily-remaining">—</span>
        </div>

        <div class="divider"></div>

        <!-- MONTHLY BURN -->
        <div class="seg">
          <span class="tag">MO</span>
          <div class="bar-wrap"><div class="bar-fill" id="monthly-fill"></div></div>
          <span class="pct" id="monthly-pct">—</span>
        </div>

        <!-- Cloud/AI passivos (só aparecem em risco) -->
        <div class="passive-badges">
          <span class="badge hidden" id="badge-cloud">☁</span>
          <span class="badge hidden" id="badge-ai">AI</span>
        </div>

        <!-- Hover expand: reset diário + msg mensal -->
        <span class="extra" id="extra-msg">—</span>

        <div class="lock-overlay" id="lock-overlay">
          <span class="lock-title" id="lock-title">Limite esgotado</span>
          <span class="lock-sub" id="lock-sub">reset —</span>
        </div>

      </div>
    `;

    document.documentElement.appendChild(host);

    // Click abre popup ou força refresh
    shadow.getElementById('capsule').addEventListener('click', () => {
      safeSendMessage({ type: 'FORCE_POLL', provider: 'lovable', accountId: tabAccountId });
    });
  }

  function unmountBar() {
    if (host) { host.remove(); host = null; shadow = null; }
  }

  function isHighRiskUiState(uiState, isLocked) {
    return isLocked || uiState === 'critical';
  }

  // -------- Render --------

  function render(analysis) {
    if (!shadow || !analysis || !analysis.ready) return;

    const {
      dailyRemaining, dailyTotal, dailyPct,
      minutesToDailyReset, minutesToMonthlyReset,
      todayPace, todayPaceStatus, todayTrend, etaDailyExhaust,
      monthlyPct, monthlyBurn, monthlyBurnStatus,
      cloudPct, cloudStatus, aiPct, aiStatus,
      overallStatus, operationalMsg
    } = analysis;

    const uiState = analysis.uiState || 'loading';
    const lockOverlay = analysis.lockOverlay || { active: false };
    const isLocked = !!lockOverlay.active;

    const capsule = shadow.getElementById('capsule');
    const highRisk = isHighRiskUiState(uiState, isLocked);
    capsule.dataset.status = highRisk ? 'red' : (uiState === 'attention' ? 'yellow' : 'green');
    capsule.dataset.locked = isLocked ? 'true' : 'false';

    // TODAY PACE
    const needle   = shadow.getElementById('needle');
    const paceEl   = shadow.getElementById('today-pace-val');
    const trendEl  = shadow.getElementById('today-trend');

    if (uiState !== 'loading' && todayPace !== null) {
      const angle = -90 + (Math.min(Math.max(todayPace, 0), 200) / 200) * 180;
      needle.style.transform = `rotate(${angle}deg)`;
      paceEl.textContent = Math.round(todayPace);
      paceEl.dataset.status = highRisk ? 'red' : (uiState === 'attention' ? 'yellow' : (uiState === 'idle' ? 'blue' : 'green'));
    } else {
      paceEl.textContent = '—';
      paceEl.dataset.status = 'green';
    }

    if (todayTrend === 'up')       { trendEl.textContent = '↑'; trendEl.dataset.dir = 'up'; }
    else if (todayTrend === 'down'){ trendEl.textContent = '↓'; trendEl.dataset.dir = 'down'; }
    else                           { trendEl.textContent = '→'; trendEl.dataset.dir = 'stable'; }

    // Daily dots
    const dotsEl = shadow.getElementById('daily-dots');
    dotsEl.innerHTML = '';
    const total = dailyTotal || 5;
    const used  = total - (dailyRemaining ?? 0);
    const warn  = highRisk;
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('div');
      dot.className = i < used ? 'dot used' : 'dot avail';
      if (i >= used) dot.dataset.warn = warn ? 'true' : 'false';
      dotsEl.appendChild(dot);
    }

    const remainEl = shadow.getElementById('daily-remaining');
    remainEl.textContent = dailyRemaining !== null ? `${dailyRemaining}cr` : '—';

    // Monthly
    const monthFill = shadow.getElementById('monthly-fill');
    const monthPctEl = shadow.getElementById('monthly-pct');
    if (monthlyPct !== null) {
      let color = '#22c55e';
      if (highRisk) color = '#ef4444';
      else if (uiState === 'attention') color = '#eab308';
      monthFill.style.width = `${Math.min(monthlyPct, 100)}%`;
      monthFill.style.background = color;
      monthPctEl.textContent = `${monthlyPct.toFixed(0)}%`;
    } else {
      monthFill.style.width = '0%';
      monthPctEl.textContent = '—';
    }

    // Cloud/AI badges (só em risco)
    const badgeCloud = shadow.getElementById('badge-cloud');
    const badgeAi    = shadow.getElementById('badge-ai');

    const uiRisk = highRisk ? 'red' : (uiState === 'attention' ? 'yellow' : null);

    if (uiRisk && cloudPct !== null) {
      badgeCloud.classList.remove('hidden');
      badgeCloud.dataset.risk = uiRisk;
      badgeCloud.title = `Cloud: ${cloudPct?.toFixed(0)}%`;
    } else {
      badgeCloud.classList.add('hidden');
    }

    if (uiRisk && aiPct !== null) {
      badgeAi.classList.remove('hidden');
      badgeAi.dataset.risk = uiRisk;
      badgeAi.title = `AI: ${aiPct?.toFixed(0)}%`;
    } else {
      badgeAi.classList.add('hidden');
    }

    // Hover expand: mensagem contextual centralizada no analysis
    const extraEl = shadow.getElementById('extra-msg');
    extraEl.textContent = operationalMsg || '';

    const lockTitle = shadow.getElementById('lock-title');
    const lockSub = shadow.getElementById('lock-sub');
    if (lockTitle) lockTitle.textContent = lockOverlay.title || 'Limite esgotado';
    if (lockSub) lockSub.textContent = lockOverlay.detail || 'reset —';
  }

  function fmtMin(min) {
    if (min === null || !isFinite(min) || min < 0) return '—';
    if (min < 1) return 'agora';
    if (min < 60) return `em ${Math.round(min)}min`;
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return m > 0 ? `em ${h}h${m}m` : `em ${h}h`;
  }

  // -------- State subscription --------

  function requestState() {
    safeSendMessage({
      type: 'GET_STATE', provider: 'lovable', accountId: tabAccountId
    }, (resp) => {
      if (resp?.ok && resp.analysis) render(resp.analysis);
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE' && msg.provider === 'lovable') {
      if (tabAccountId && msg.accountId && msg.accountId !== tabAccountId) return;
      render(msg.analysis);
      return;
    }

    if (msg.type === 'LOVABLE_FORCE_REFRESH') {
      if (tabAccountId && msg.accountId && msg.accountId !== tabAccountId) return;
      const token = ensureToken();
      window.postMessage({
        source: 'THROTTLE_LOVABLE',
        type: 'FORCE_REFRESH',
        token
      }, '*');
      requestState();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const s = changes.settings.newValue;
    if (!s) return;
    if (s.showBar === false) unmountBar();
    else if (s.showBar === true && !host) { mountBar(); requestState(); }
  });

  // -------- Init --------

  injectInterceptor();

  chrome.storage.local.get('settings', ({ settings }) => {
    if (settings?.showBar === false) return;
    mountBar();
    requestState();
  });

})();
