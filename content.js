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
          position: relative;
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
        .capsule[data-locked="true"] {
          border-color: rgba(239, 68, 68, 0.45);
          box-shadow: 0 4px 18px rgba(220,38,38,0.25);
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
        .usage-seg {
          padding-left: 10px;
          padding-right: 10px;
        }

        .divider {
          width: 1px;
          height: 16px;
          background: rgba(255,255,255,0.12);
          flex-shrink: 0;
        }
        .weekly-divider {
          width: 0;
          opacity: 0;
          transition: width 0.25s ease, opacity 0.2s ease;
        }
        .capsule:hover .weekly-divider {
          width: 1px;
          opacity: 1;
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
        #sparkline-svg {
          width: 64px;
          height: 18px;
          flex-shrink: 0;
          display: block;
          overflow: visible;
          max-width: 0;
          opacity: 0;
          transform: translateX(-2px);
          transition: max-width 0.28s ease, opacity 0.2s ease, transform 0.2s ease;
          pointer-events: none;
        }
        .capsule:hover #sparkline-svg {
          max-width: 64px;
          opacity: 1;
          transform: translateX(0);
        }
        .sparkline-track {
          opacity: 0.35;
        }
        .sparkline-divider {
          opacity: 0;
          transition: opacity 0.2s ease;
        }
        .capsule:hover .sparkline-divider {
          opacity: 0.8;
        }
        .speedo-arc {
          opacity: 0.24;
          transition: opacity 0.25s ease, stroke-width 0.25s ease, filter 0.25s ease;
        }
        .speedo-arc[data-speedo-band="low"] { --speedo-glow: rgba(59, 130, 246, 0.85); }
        .speedo-arc[data-speedo-band="healthy"] { --speedo-glow: rgba(34, 197, 94, 0.85); }
        .speedo-arc[data-speedo-band="attention"] { --speedo-glow: rgba(234, 179, 8, 0.85); }
        .speedo-arc[data-speedo-band="critical"] { --speedo-glow: rgba(239, 68, 68, 0.85); }
        .speedo-arc.speedo-arc-active {
          opacity: 1;
          stroke-width: 3.2;
          filter: drop-shadow(0 0 3px var(--speedo-glow));
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
        .bar-wrap[data-status="red"] {
          box-shadow: 0 0 10px rgba(239,68,68,0.55);
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
          text-align: left;
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
        .weekly-seg {
          max-width: 0;
          opacity: 0;
          overflow: hidden;
          padding-left: 0 !important;
          padding-right: 0 !important;
          transition: max-width 0.25s ease, opacity 0.2s ease, padding 0.25s ease;
        }
        .capsule:hover .weekly-seg {
          max-width: 74px;
          opacity: 1;
          padding-left: 8px !important;
          padding-right: 8px !important;
        }

        /* PACE + trend */
        .pace-val {
          font-size: 13px;
          font-weight: 700;
          color: #f59e0b;
          min-width: 28px;
          text-align: center;
          transition: color 0.3s ease;
        }
        .pace-val[data-status="red"]    { color: #f87171; text-shadow: 0 0 10px rgba(239,68,68,0.8); animation: pulse 2s ease-in-out infinite; }
        .pace-val[data-status="yellow"] { color: #fbbf24; }
        .pace-val[data-status="blue"]   { color: #60a5fa; }
        .pace-val[data-status="green"]  { color: #86efac; }

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
          padding-right: 0;
          flex-shrink: 0;
        }
        .capsule:hover .extra {
          padding-right: 4px;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.65; }
        }

        @media (max-width: 500px) {
          .aux { display: none; }
          .bar-wrap { width: 36px; }
        }

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
          opacity: 1;
          transform: scale(1);
          transition: opacity 0.24s ease, transform 0.28s ease, background 0.28s ease, backdrop-filter 0.28s ease;
          will-change: opacity, transform, backdrop-filter;
        }
        .capsule[data-locked="true"] .lock-overlay {
          display: flex;
        }
        .capsule[data-locked="true"]:hover .lock-overlay {
          opacity: 0;
          transform: scale(1.02);
          background: rgba(10, 10, 12, 0.02);
          backdrop-filter: blur(0px);
          -webkit-backdrop-filter: blur(0px);
        }
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

      <div class="capsule" id="capsule" title="Throttle — clique para atualizar">

        <!-- Velocímetro mini -->
        <div class="speedo-wrap" id="speedo-wrap">
          <svg width="28" height="18" viewBox="0 0 28 18" id="speedo-svg">
            <path d="M 2 16 A 12 12 0 0 1 26 16" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2.8" stroke-linecap="round"/>
            <path class="speedo-arc" data-speedo-band="low" d="M 2 16 A 12 12 0 0 1 8 6"    fill="none" stroke="#1e40af" stroke-width="2.8" stroke-linecap="round"/>
            <path class="speedo-arc" data-speedo-band="healthy" d="M 8 6 A 12 12 0 0 1 14 4.5"   fill="none" stroke="#16a34a" stroke-width="2.8" stroke-linecap="round"/>
            <path class="speedo-arc" data-speedo-band="attention" d="M 14 4.5 A 12 12 0 0 1 20 6"  fill="none" stroke="#ca8a04" stroke-width="2.8" stroke-linecap="round"/>
            <path class="speedo-arc" data-speedo-band="critical" d="M 20 6 A 12 12 0 0 1 26 16"   fill="none" stroke="#dc2626" stroke-width="2.8" stroke-linecap="round"/>
            <line id="needle"
              x1="14" y1="16" x2="14" y2="5"
              stroke="#f59e0b" stroke-width="2" stroke-linecap="round"
              style="transform-origin: 14px 16px; transform: rotate(-90deg); transition: transform 0.9s cubic-bezier(0.34,1.56,0.64,1);"/>
            <circle cx="14" cy="16" r="2.2" fill="#f59e0b"/>
          </svg>
          <span class="pace-val" id="pace-val">—</span>
          <svg id="sparkline-svg" viewBox="0 0 64 18" aria-label="Curva de consumo">
            <path id="sparkline-track" class="sparkline-track" d="M 1 15 H 63" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.2" stroke-linecap="round"/>
            <g id="sparkline-dividers"></g>
            <path id="sparkline-path" d="" fill="none" stroke="#22c55e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <circle id="sparkline-dot" cx="63" cy="15" r="1.6" fill="#22c55e"/>
          </svg>
          <span class="trend" id="trend-arrow" data-dir="stable">—</span>
        </div>

        <div class="divider"></div>

        <!-- Uso -->
        <div class="seg usage-seg">
          <div class="bar-wrap" id="bar-5h"><div class="bar-fill" id="fill-5h"></div></div>
          <span class="pct" id="pct-5h">—</span>
          <span class="aux" id="aux-5h">—</span>
        </div>

        <div class="divider weekly-divider"></div>

        <!-- Badge 7D (sempre visível, tamanho mínimo) -->
        <div class="seg weekly-seg">
          <span class="badge-7d" id="badge-7d" data-risk="low">7D —</span>
        </div>

        <!-- Expansão no hover: msg operacional + detalhe 7D -->
        <span class="extra" id="extra-msg">—</span>

        <div class="lock-overlay" id="lock-overlay">
          <span class="lock-title" id="lock-title">Limit reached</span>
          <span class="lock-sub" id="lock-sub">reset —</span>
        </div>

      </div>
    `;

    document.documentElement.appendChild(host);

    shadow.getElementById('capsule').addEventListener('click', () => {
      const accountId = getAccountId();
      if (!accountId) return;
      safeSendMessage({
        type: 'FORCE_POLL',
        provider: 'claude',
        accountId
      });
    });
  }

  function unmountBar() {
    if (host) { host.remove(); host = null; shadow = null; }
  }

  function isHighRiskUiState(uiState, isLocked) {
    return isLocked || uiState === 'critical';
  }

  function speedoBandForPace(pace) {
    if (!Number.isFinite(pace)) return null;
    if (pace < 66) return 'low';
    if (pace < 100) return 'healthy';
    if (pace < 134) return 'attention';
    return 'critical';
  }

  function setSpeedoArcForPace(pace) {
    const activeBand = speedoBandForPace(pace);
    shadow?.querySelectorAll('.speedo-arc').forEach((arc) => {
      arc.classList.toggle('speedo-arc-active', arc.dataset.speedoBand === activeBand);
    });
  }

  function paceStatusForSpeedoBand(pace) {
    const band = speedoBandForPace(pace);
    if (band === 'low') return 'blue';
    if (band === 'healthy') return 'green';
    if (band === 'attention') return 'yellow';
    if (band === 'critical') return 'red';
    return 'green';
  }

  function sparklineColorFromUiState(uiState, lockOverlay) {
    if (lockOverlay?.kind === 'monthly') return '#52525b';
    if (lockOverlay?.kind === 'window' || lockOverlay?.active || uiState === 'critical') return '#ef4444';
    if (uiState === 'attention') return '#ca8a04';
    if (uiState === 'idle') return '#3b82f6';
    return '#22c55e';
  }

  function renderSparkline(analysis, uiState, lockOverlay) {
    const sparkline = shadow.getElementById('sparkline-svg');
    const path = shadow.getElementById('sparkline-path');
    const dot = shadow.getElementById('sparkline-dot');
    const track = shadow.getElementById('sparkline-track');
    const dividers = shadow.getElementById('sparkline-dividers');
    if (!sparkline || !path || !dot || !track || !dividers) return;

    const series = analysis?.sparkline;
    if (!series?.path || !Array.isArray(series.points) || series.points.length < 2) {
      sparkline.hidden = true;
      dividers.innerHTML = '';
      return;
    }

    const color = sparklineColorFromUiState(uiState, lockOverlay);
    const points = series.points;
    const isFlat = points.every((point) => Math.abs(point.y - points[0].y) < 0.01);
    const isZeroFlat = isFlat && points.every((point) => Number.isFinite(point.value) && point.value <= 0.01);
    const displayPath = isZeroFlat
      ? `M ${points[0].x.toFixed(2)} 15 H ${points[points.length - 1].x.toFixed(2)}`
      : series.path;
    const displayDotY = isZeroFlat ? 15 : points[points.length - 1].y;

    sparkline.hidden = false;
    path.setAttribute('d', displayPath);
    path.style.stroke = color;
    dot.setAttribute('cx', points[points.length - 1].x.toFixed(2));
    dot.setAttribute('cy', displayDotY.toFixed(2));
    dot.style.fill = color;
    track.style.opacity = lockOverlay?.active ? '0.2' : '0.35';
    dividers.innerHTML = '';
    for (const divider of series.dividers || []) {
      if (!Number.isFinite(divider?.x)) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const x = divider.x.toFixed(2);
      line.setAttribute('class', 'sparkline-divider');
      line.setAttribute('x1', x);
      line.setAttribute('x2', x);
      line.setAttribute('y1', '2');
      line.setAttribute('y2', '16');
      line.setAttribute('stroke', 'rgba(255,255,255,0.55)');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('stroke-dasharray', '2 2');
      line.setAttribute('stroke-linecap', 'round');
      dividers.appendChild(line);
    }
  }

  // -------- Render --------

  function render(analysis) {
    if (!shadow || !analysis || !analysis.ready) return;

    const { latest, minutesToReset5h, minutesToReset7d, rpmBlend, trend, operationalMsg, eta15, etaBlend, eta60 } = analysis;
    const uiState = analysis.uiState || 'loading';
    const lockOverlay = analysis.lockOverlay || { active: false };
    const isLocked = !!lockOverlay.active;
    const locked5h = uiState === 'locked_5h' || lockOverlay.kind === 'window';

    const capsule = shadow.getElementById('capsule');
    const highRisk = isHighRiskUiState(uiState, isLocked);
    capsule.dataset.status = highRisk ? 'red' : (uiState === 'attention' ? 'yellow' : 'green');
    capsule.dataset.locked = isLocked ? 'true' : 'false';

    // --- Velocímetro ---
    const needle = shadow.getElementById('needle');
    const paceEl = shadow.getElementById('pace-val');
    const trendEl = shadow.getElementById('trend-arrow');

    if (uiState !== 'loading' && rpmBlend !== null) {
      const clamped = Math.max(0, Math.min(200, rpmBlend));
      // Meia-circunferência: -90deg (esquerda) a +90deg (direita)
      const angle = -90 + (clamped / 200) * 180;
      setSpeedoArcForPace(rpmBlend);
      needle.style.transform = `rotate(${angle}deg)`;
      paceEl.textContent = String(Math.min(299, Math.round(rpmBlend)));
      paceEl.dataset.status = paceStatusForSpeedoBand(rpmBlend);
    } else {
      setSpeedoArcForPace(null);
      paceEl.textContent = '—';
      paceEl.dataset.status = 'green';
    }

    // Trend arrow
    if (trend === 'up') {
      trendEl.textContent = '↑';
      trendEl.dataset.dir = 'up';
      trendEl.title = 'accelerating';
    } else if (trend === 'down') {
      trendEl.textContent = '↓';
      trendEl.dataset.dir = 'down';
      trendEl.title = 'decelerating';
    } else {
      trendEl.textContent = '→';
      trendEl.dataset.dir = 'stable';
      trendEl.title = 'stable pace';
    }

    renderSparkline(analysis, uiState, lockOverlay);

    // --- 5H ---
    if (latest.u5h !== null) {
      const fill5h = shadow.getElementById('fill-5h');
      const bar5h = shadow.getElementById('bar-5h');
      const pct5h = shadow.getElementById('pct-5h');
      const aux5h = shadow.getElementById('aux-5h');

      const barStatus = highRisk ? 'red' : (uiState === 'attention' ? 'yellow' : 'green');
      const color5h = barStatus === 'red' ? '#ef4444' : (barStatus === 'yellow' ? '#eab308' : '#22c55e');

      fill5h.style.width = `${Math.min(latest.u5h, 100)}%`;
      fill5h.style.background = color5h;
      if (bar5h) bar5h.dataset.status = barStatus;
      pct5h.textContent = `${latest.u5h.toFixed(0)}%`;

      // Aux: mostra ETA de esgotamento se em risco, senao mostra reset
      const etaToLimit = Number.isFinite(analysis.etaToLimit5h)
        ? analysis.etaToLimit5h
        : bestFiniteEta(eta15, etaBlend, eta60);
      const inRisk = !locked5h
        && Number.isFinite(etaToLimit)
        && minutesToReset5h !== null
        && etaToLimit < minutesToReset5h;
      if (locked5h) {
        aux5h.textContent = `reset ${fmtMin(minutesToReset5h)}`;
        aux5h.dataset.warn = 'true';
      } else if (inRisk) {
        aux5h.textContent = `zeroes in ${fmtMin(etaToLimit)}`;
        aux5h.dataset.warn = 'true';
      } else {
        aux5h.textContent = `reset ${fmtMin(minutesToReset5h)}`;
        aux5h.dataset.warn = 'false';
      }
    }

    // --- Badge 7D ---
    const badge7d = shadow.getElementById('badge-7d');
    if (latest.u7d !== null) {
      badge7d.dataset.risk = highRisk ? 'high' : (uiState === 'attention' ? 'medium' : 'low');
      badge7d.textContent = `7D ${latest.u7d.toFixed(0)}%`;
      badge7d.title = `Weekly window: ${latest.u7d.toFixed(1)}% — reset ${fmtMin(minutesToReset7d)}`;
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

    const lockTitle = shadow.getElementById('lock-title');
    const lockSub = shadow.getElementById('lock-sub');
    if (lockTitle) lockTitle.textContent = lockOverlay.title || 'Limit reached';
    if (lockSub) lockSub.textContent = lockOverlay.detail || 'reset —';
  }

  function fmtMin(min) {
    if (min === null || min === undefined || !isFinite(min) || min < 0) return '—';
    const totalMinutes = Math.max(0, Math.ceil(min));
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h <= 0) return `${m}m`;
    return `${h}h${String(m).padStart(2, '0')}m`;
  }

  function bestFiniteEta(...values) {
    const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
    return finite.length ? Math.min(...finite) : null;
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
        const accountId = getAccountId();
        if (!accountId) return;
        safeSendMessage({
          type: 'FORCE_POLL',
          provider: 'claude',
          accountId
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
    const accountId = getAccountId();
    if (!accountId) return;
    safeSendMessage({
      type: 'GET_STATE',
      provider: 'claude',
      accountId
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
    if (!accountId) return;
    if (msg.accountId && msg.accountId !== accountId) return;
    currentAnalysis = msg.analysis;
    render(msg.analysis);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const accountId = getAccountId();
      if (!accountId) return;
      safeSendMessage({
        type: 'FORCE_POLL',
        provider: 'claude',
        accountId
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
      const changed = tabOrgId !== msg.orgId;
      tabOrgId = msg.orgId;
      if (changed) requestState();
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
