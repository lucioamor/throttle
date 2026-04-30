// popup.js — Throttle v2

import {
  getAccountsByProvider,
  getActiveProviderId, setActiveProviderId,
  getSettings, updateSettings,
  getSnapshots
} from './lib/storage.js';
import { analyze, analyzeLovable, formatETA } from './lib/predictor.js';

let activeProvider = 'claude'; // 'claude' | 'lovable'
let currentAccountId = null;
const initialPollRequested = new Set();
const FOOTER_TICK_MS = 1000;
let renderInFlight = false;
let renderAgain = false;
let footerTimer = null;
let footerState = null;
let accountsSignature = '';

function isClaude5hLocked(analysis) {
  if (analysis?.provider !== 'claude') return false;
  if (analysis?.uiState === 'locked_5h' || analysis?.lockOverlay?.kind === 'window') return true;
  const u5h = Number.isFinite(analysis?.latest?.u5h) ? analysis.latest.u5h : null;
  return u5h !== null && u5h >= 99.5;
}

function formatResetCountdown(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return '—';
  const totalMinutes = Math.max(0, Math.ceil(minutes));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, '0')}m`;
}

function formatReset5h(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return 'resets in —';
  return `resets in ${formatResetCountdown(minutes)}`;
}

function formatReset7d(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return 'resets in —';
  const totalMinutes = Math.max(0, Math.ceil(minutes));
  if (totalMinutes >= 1440) {
    const d = Math.floor(totalMinutes / 1440);
    const h = Math.floor((totalMinutes % 1440) / 60);
    return `resets in ${d}d${String(h).padStart(2, '0')}h`;
  }
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `resets in ${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m`;
}

(async function init() {
  activeProvider = await inferProviderFromActiveTab();
  await renderTabs();
  wireTabSwitcher();
  wireEvents();
  bindStorageRefresh();
  drawClaudeTicks();
  await populateAccounts();
  await requestRender();
  startFooterClock();
})();

// -------- Tab switcher --------

async function inferProviderFromActiveTab() {
  try {
    if (!chrome?.tabs?.query) return activeProvider;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = typeof tab?.url === 'string' ? tab.url : '';
    if (url.startsWith('https://lovable.dev/') || /^https:\/\/[^/]+\.lovable\.dev\//.test(url)) return 'lovable';
    if (url.startsWith('https://claude.ai/')) return 'claude';
  } catch (_err) {}
  return activeProvider;
}

async function renderTabs() {
  document.querySelectorAll('.provider-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.provider === activeProvider);
  });
  document.getElementById('panel-claude').hidden  = activeProvider !== 'claude';
  document.getElementById('panel-lovable').hidden = activeProvider !== 'lovable';
}

function wireTabSwitcher() {
  document.querySelectorAll('.provider-tab').forEach(tab => {
    tab.addEventListener('click', async () => {
      activeProvider = tab.dataset.provider;
      currentAccountId = null;
      accountsSignature = '';
      await renderTabs();
      await populateAccounts();
      await render();
    });
  });
}

// -------- Account selector --------

async function populateAccounts() {
  const accounts = await getAccountsByProvider(activeProvider);
  const active   = await getActiveProviderId(activeProvider);
  const select   = document.getElementById('account-select');

  const entries = Object.values(accounts);
  const signature = entries
    .map((acc) => acc.providerId)
    .sort()
    .join(';;') + `::${activeProvider}::${active || ''}::${currentAccountId || ''}`;
  if (signature === accountsSignature) {
    if (entries.length === 0) {
      currentAccountId = null;
    } else if (!entries.some((acc) => acc.providerId === currentAccountId)) {
      currentAccountId = entries.some((acc) => acc.providerId === active) ? active : entries[0].providerId;
    }
    updateAccountOptionLabels(select, entries);
    return false;
  }
  accountsSignature = signature;

  select.innerHTML = '';
  select.disabled = false;

  if (entries.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = activeProvider === 'claude'
      ? 'nenhuma org detectada — abra claude.ai'
      : 'nenhum workspace — abra lovable.dev';
    opt.disabled = true;
    select.appendChild(opt);
    select.disabled = true;
    currentAccountId = null;
    return true;
  }

  const labelCount = buildLabelCount(entries);

  for (const acc of entries) {
    const opt = document.createElement('option');
    opt.value = acc.providerId;
    const baseLabel = acc.label || acc.providerId;
    const shouldDisambiguate = (labelCount.get(baseLabel) || 0) > 1;
    const suffix = shouldDisambiguate ? ` · ${shortProviderSuffix(acc.providerId)}` : '';
    opt.textContent = baseLabel + suffix + (acc.plan && acc.plan !== 'unknown' ? ` [${acc.plan}]` : '');
    select.appendChild(opt);
  }

  const hasCurrentSelection = entries.some((acc) => acc.providerId === currentAccountId);
  if (hasCurrentSelection) {
    select.value = currentAccountId;
  } else {
    currentAccountId = entries.some((acc) => acc.providerId === active) ? active : entries[0].providerId;
    select.value = currentAccountId;
  }

  return true;
}

function buildLabelCount(entries) {
  const labelCount = new Map();
  for (const acc of entries) {
    const key = acc.label || acc.providerId;
    labelCount.set(key, (labelCount.get(key) || 0) + 1);
  }
  return labelCount;
}

function formatAccountOptionLabel(acc, labelCount) {
  const baseLabel = acc.label || acc.providerId;
  const shouldDisambiguate = (labelCount.get(baseLabel) || 0) > 1;
  const suffix = shouldDisambiguate ? ` · ${shortProviderSuffix(acc.providerId)}` : '';
  return baseLabel + suffix + (acc.plan && acc.plan !== 'unknown' ? ` [${acc.plan}]` : '');
}

function updateAccountOptionLabels(select, entries) {
  const labelCount = buildLabelCount(entries);
  for (const acc of entries) {
    const option = [...select.options].find((opt) => opt.value === acc.providerId);
    if (option) option.textContent = formatAccountOptionLabel(acc, labelCount);
  }
}

function shortProviderSuffix(providerId) {
  if (typeof providerId !== 'string') return 'id';
  const idx = providerId.indexOf(':');
  const raw = idx >= 0 ? providerId.slice(idx + 1) : providerId;
  return raw.slice(0, 8);
}

function getPopupCreditsRemaining(analysis) {
  if (!analysis || typeof analysis !== 'object') return null;

  if (analysis.provider === 'claude') {
    const u5h = Number.isFinite(analysis?.latest?.u5h) ? analysis.latest.u5h : null;
    if (u5h === null) return null;
    return 100 - u5h;
  }

  if (analysis.provider === 'lovable') {
    const dailyRemaining = Number.isFinite(analysis?.dailyRemaining) ? analysis.dailyRemaining : null;
    const monthlyRemaining = Number.isFinite(analysis?.monthlyRemaining) ? analysis.monthlyRemaining : null;
    if (dailyRemaining !== null && dailyRemaining > 0) return dailyRemaining;
    if (monthlyRemaining !== null && monthlyRemaining > 0) return monthlyRemaining;
    if (dailyRemaining !== null || monthlyRemaining !== null) {
      return (dailyRemaining ?? 0) + (monthlyRemaining ?? 0);
    }
    return null;
  }

  return null;
}

function resolvePopupLockOverlay(analysis) {
  const creditsRemaining = getPopupCreditsRemaining(analysis);
  if (analysis?.provider === 'claude' && isClaude5hLocked(analysis)) {
    const base = analysis?.lockOverlay && typeof analysis.lockOverlay === 'object'
      ? analysis.lockOverlay
      : {};
    return {
      active: true,
      kind: 'window',
      icon: base.icon || '⏳',
      title: base.title || '5h window exhausted',
      detail: base.detail || `resets in ${formatResetCountdown(analysis.minutesToReset5h)}`
    };
  }

  if (creditsRemaining === null || creditsRemaining > 0) {
    return { active: false, kind: null, icon: '', title: '', detail: '' };
  }

  const base = analysis?.lockOverlay && typeof analysis.lockOverlay === 'object'
    ? analysis.lockOverlay
    : {};

  return {
    active: true,
    kind: base.kind || 'monthly',
    icon: base.icon || '🔒',
    title: base.title || 'Credits exhausted',
    detail: base.detail || 'balance <= 0'
  };
}

// -------- Render dispatcher --------

async function render() {
  if (!currentAccountId) currentAccountId = await getActiveProviderId(activeProvider);
  if (!currentAccountId) {
    renderPanelLockOverlay('claude', null);
    renderPanelLockOverlay('lovable', null);
    setStatusMsg(activeProvider === 'claude'
      ? 'Open claude.ai to initialize'
      : 'Open lovable.dev to initialize');
    setFooterState(null);
    return;
  }

  requestInitialPoll(activeProvider, currentAccountId);
  const snapshots = await getSnapshots(currentAccountId);

  if (activeProvider === 'claude') {
    const analysis = analyze(snapshots);
    if (!analysis.ready) {
      renderPanelLockOverlay('claude', null);
      setStatusMsg('Waiting for first snapshot...');
      setFooterState(null);
      return;
    }
    const popupAnalysis = { ...analysis, lockOverlay: resolvePopupLockOverlay(analysis) };
    renderClaudeSpeedo(popupAnalysis);
    renderClaudeStats(popupAnalysis);
    renderWeekBlocks(popupAnalysis);
    renderSparkline(snapshots);
    renderFooter(popupAnalysis);
    renderPanelLockOverlay('claude', popupAnalysis.lockOverlay);
    renderPanelLockOverlay('lovable', null);
  } else {
    const analysis = analyzeLovable(snapshots);
    if (!analysis.ready) {
      renderPanelLockOverlay('lovable', null);
      setStatusMsg('Waiting for Lovable data...');
      setFooterState(null);
      return;
    }
    const popupAnalysis = { ...analysis, lockOverlay: resolvePopupLockOverlay(analysis) };
    renderLovablePanel(popupAnalysis);
    renderFooter(popupAnalysis);
    renderPanelLockOverlay('lovable', popupAnalysis.lockOverlay);
    renderPanelLockOverlay('claude', null);
  }
}

async function requestRender() {
  if (renderInFlight) {
    renderAgain = true;
    return;
  }

  renderInFlight = true;
  try {
    do {
      renderAgain = false;
      await render();
    } while (renderAgain);
  } finally {
    renderInFlight = false;
  }
}

function bindStorageRefresh() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.accounts) return;
    void populateAccounts().then(() => requestRender()).catch(() => {});
  });
}
function requestInitialPoll(provider, accountId) {
  if (!provider || !accountId) return;
  const key = `${provider}:${accountId}`;
  if (initialPollRequested.has(key)) return;
  initialPollRequested.add(key);
  chrome.runtime.sendMessage({
    type: 'FORCE_POLL',
    provider,
    accountId
  });
}

function setStatusMsg(msg) {
  document.getElementById('speedo-legend').textContent = msg;
}

function setFooterState(analysis) {
  const lastUpdate = document.getElementById('last-update');
  const snapCount = document.getElementById('snap-count');

  if (!analysis?.latest?.t) {
    footerState = null;
    if (lastUpdate) lastUpdate.textContent = '—';
    if (snapCount) snapCount.textContent = '— snapshots';
    return;
  }

  footerState = {
    latestTs: analysis.latest.t,
    latestLabel: new Date(analysis.latest.t).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }),
    snapshotCount: analysis.snapshotCount
  };

  updateFooterClock();
}

function updateFooterClock() {
  const lastUpdate = document.getElementById('last-update');
  const snapCount = document.getElementById('snap-count');
  if (!footerState) return;

  const ageMs = Date.now() - footerState.latestTs;
  const ageLabel = formatRelativeAge(ageMs);
  if (lastUpdate) lastUpdate.textContent = `last ${footerState.latestLabel} · ${ageLabel}`;
  if (snapCount) snapCount.textContent = `${footerState.snapshotCount} snapshots`;
}

function startFooterClock() {
  if (footerTimer) clearInterval(footerTimer);
  footerTimer = setInterval(updateFooterClock, FOOTER_TICK_MS);
  updateFooterClock();
}

function formatRelativeAge(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return '0s ago';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
function isUiStateCritical(uiState) {
  return uiState === 'critical';
}

function legendToneFromUiState(uiState, lockActive) {
  if (lockActive || isUiStateCritical(uiState)) return 'warn';
  if (uiState === 'healthy') return 'ok';
  return '';
}

function barColorFromUiState(uiState, lockActive) {
  if (lockActive || isUiStateCritical(uiState)) return '#ef4444';
  if (uiState === 'attention') return '#eab308';
  return '#22c55e';
}

function colorForClaude5h(u5h, uiState, lockOverlay) {
  if (lockOverlay?.kind === 'monthly') return '#52525b';
  if (lockOverlay?.kind === 'window' || lockOverlay?.active) return '#ef4444';
  if (Number.isFinite(u5h)) {
    if (u5h >= 90) return '#ef4444';
    if (u5h >= 70) return '#eab308';
  }
  return '#22c55e';
}

function setNeedleToZero(needle) {
  if (!needle) return;
  needle.classList.remove('speedo-needle-redline');
  needle.style.transform = 'rotate(-90deg)';
}

function speedoBandForPace(pace) {
  if (!Number.isFinite(pace)) return null;
  if (pace < 73) return 'low';
  if (pace < 113) return 'healthy';
  if (pace < 144) return 'attention';
  return 'critical';
}

function setSpeedoArcForPace(needle, pace) {
  const speedo = needle?.closest('.speedo');
  if (!speedo) return;

  const activeBand = speedoBandForPace(pace);
  speedo.querySelectorAll('.speedo-arc').forEach((arc) => {
    arc.classList.toggle('speedo-arc-active', arc.dataset.speedoBand === activeBand);
  });
}

function setSpeedoNeedleForPace(needle, pace) {
  if (!needle || !Number.isFinite(pace)) return;
  setSpeedoArcForPace(needle, pace);

  if (pace <= 200) {
    needle.classList.remove('speedo-needle-redline');
    const angle = -90 + (Math.min(Math.max(pace, 0), 200) / 200) * 180;
    needle.style.transform = `rotate(${angle}deg)`;
    return;
  }

  const excess = Math.min(Math.max(pace - 200, 0), 120);
  const overshoot = 5 + (excess / 120) * 7;
  needle.style.setProperty('--rev-rest-angle', '90deg');
  needle.style.setProperty('--rev-pull-angle', `${90 + overshoot}deg`);
  needle.style.transform = 'rotate(90deg)';
  needle.classList.add('speedo-needle-redline');
}

function applySpeedoUiState(needle, uiState) {
  const speedo = needle?.closest('.speedo');
  if (speedo) {
    speedo.classList.toggle('speedo-idle', uiState === 'idle');
    if (uiState === 'loading' || uiState === 'idle') {
      speedo.querySelectorAll('.speedo-arc-active').forEach((arc) => {
        arc.classList.remove('speedo-arc-active');
      });
    }
  }
  if (!needle) return;
  if (uiState === 'loading') {
    setNeedleToZero(needle);
    needle.style.opacity = '0';
    return;
  }
  needle.style.opacity = '1';
  if (uiState === 'idle') {
    setNeedleToZero(needle);
  }
}

function renderPanelLockOverlay(panel, lockOverlay) {
  const root = document.getElementById(`panel-${panel}-lock`);
  if (!root) return;

  const active = !!lockOverlay?.active;
  root.hidden = !active;
  root.style.display = active ? 'flex' : 'none';
  if (!active) return;

  const title = document.getElementById(`panel-${panel}-lock-title`);
  const sub = document.getElementById(`panel-${panel}-lock-sub`);
  const icon = document.getElementById(`panel-${panel}-lock-icon`);
  if (icon) icon.textContent = lockOverlay.icon || '🔒';
  if (title) title.textContent = lockOverlay.title || 'Limit reached';
  if (sub) sub.textContent = lockOverlay.detail || 'reset —';
}

// -------- Claude panel --------

function renderClaudeSpeedo(a) {
  const needle = document.getElementById('speedo-needle');
  const value  = document.getElementById('speedo-value');
  const legend = document.getElementById('speedo-legend');
  const pace   = a.rpmBlend;
  const uiState = a.uiState || 'loading';
  const lockOverlay = a.lockOverlay || { active: false };

  applySpeedoUiState(needle, uiState);

  if (uiState === 'loading') {
    value.textContent = '—';
    legend.className = 'speedo-legend';
    legend.textContent = 'Collecting data';
    return;
  }

  if (uiState === 'idle') {
    value.textContent = '0';
    legend.className = 'speedo-legend';
    legend.textContent = 'No recent consumption';
    return;
  }

  if (pace === null) {
    needle.classList.remove('speedo-needle-redline');
    setSpeedoArcForPace(needle, null);
    value.textContent = '—';
    legend.className = 'speedo-legend';
    legend.textContent = 'Collecting data';
    return;
  }

  setSpeedoNeedleForPace(needle, pace);
  value.textContent = Math.round(pace);

  legend.className = 'speedo-legend';
  const tone = legendToneFromUiState(uiState, lockOverlay.active);
  if (tone) legend.classList.add(tone);
  if (lockOverlay.active) {
    legend.textContent = `${lockOverlay.title} · ${lockOverlay.detail}`;
  } else if (uiState === 'critical' || pace > 130) {
    legend.textContent = `Redlining · ${formatETA(a.etaBlend)} to zero · resets in ${formatETA(a.minutesToReset5h)}`;
  } else if (uiState === 'attention' || pace > 105) {
    legend.textContent = `Above pace · ETA ${formatETA(a.etaBlend)}`;
  } else if (pace < 50) {
    legend.textContent = `Low pace · resets in ${formatETA(a.minutesToReset5h)}`;
  } else {
    legend.textContent = `Healthy pace · resets in ${formatETA(a.minutesToReset5h)}`;
  }
}

function renderClaudeStats(a) {
  const l = a.latest;
  const uiState = a.uiState || 'loading';
  const lockOverlay = a.lockOverlay || { active: false };
  const fill5h = document.getElementById('stat-5h-fill');
  const pct5h = document.getElementById('stat-5h-pct');
  const reset5h = document.getElementById('stat-5h-reset');
  const eta60  = document.getElementById('stat-5h-eta15');
  const eta300 = document.getElementById('stat-5h-eta60');
  const etaRow = document.getElementById('stat-5h-eta-row');
  const stat5hWrap = document.getElementById('stat-5h-wrap');
  if (stat5hWrap) stat5hWrap.classList.toggle('stat-disabled', lockOverlay.kind === 'monthly');
  const locked5h = isClaude5hLocked(a);
  if (etaRow) {
    etaRow.hidden = locked5h;
    etaRow.style.display = locked5h ? 'none' : '';
  }

  if (uiState === 'loading') {
    fill5h.style.width = '100%';
    fill5h.style.background = '#52525b';
    pct5h.textContent = '—';
    reset5h.textContent = 'collecting...';
    eta60.textContent  = '—';
    eta300.textContent = '—';
  } else if (uiState === 'idle') {
    fill5h.style.width = '0%';
    fill5h.style.background = colorForClaude5h(0, uiState, lockOverlay);
    pct5h.textContent = '0%';
    reset5h.textContent = formatReset5h(a.minutesToReset5h);
    eta60.textContent  = '—';
    eta300.textContent = '—';
  } else if (l.u5h !== null) {
    fill5h.style.width  = `${Math.min(l.u5h, 100)}%`;
    fill5h.style.background = colorForClaude5h(l.u5h, uiState, lockOverlay);
    pct5h.textContent = `${l.u5h.toFixed(1)}%`;
    reset5h.textContent = locked5h
      ? `back in ${formatResetCountdown(a.minutesToReset5h)}`
      : formatReset5h(a.minutesToReset5h);
    eta60.textContent  = locked5h ? '—' : formatETA(a.eta60);
    eta300.textContent = locked5h ? '—' : formatETA(a.eta300);
  } else {
    fill5h.style.width = '0%';
    fill5h.style.background = '#52525b';
    pct5h.textContent = '—';
    reset5h.textContent = 'resets in —';
    eta60.textContent  = '—';
    eta300.textContent = '—';
  }

  if (l.u7d !== null) {
    const mask7d = document.getElementById('stat-7d-mask');
    const pct7d = Math.max(0, Math.min(l.u7d, 100));
    if (mask7d) {
      mask7d.style.left = `${pct7d}%`;
    }
    document.getElementById('stat-7d-pct').textContent   = `${l.u7d.toFixed(1)}%`;
    document.getElementById('stat-7d-reset').textContent = formatReset7d(a.minutesToReset7d);
  }

  if (l.extra_used !== null && l.extra_limit) {
    document.getElementById('stat-extra-wrap').style.display = '';
    const pct = l.extra_util || 0;
    const cur = l.extra_currency || 'BRL';
    document.getElementById('stat-extra-fill').style.width = `${pct}%`;
    document.getElementById('stat-extra-pct').textContent  = `${pct.toFixed(1)}%`;
    document.getElementById('stat-extra-sub').textContent  =
      `${cur} ${l.extra_used.toFixed(2)} / ${l.extra_limit.toFixed(2)}`;
  } else {
    document.getElementById('stat-extra-wrap').style.display = 'none';
  }
}

// -------- Lovable panel --------

function renderLovablePanel(a) {
  // TODAY PACE
  const todayLegend  = document.getElementById('lv-today-legend');
  const todayNeedle  = document.getElementById('lv-speedo-needle');
  const todayVal     = document.getElementById('lv-speedo-value');
  const uiState = a.uiState || 'loading';
  const lockOverlay = a.lockOverlay || { active: false };

  applySpeedoUiState(todayNeedle, uiState);
  if (a.todayPace === null) {
    todayNeedle.classList.remove('speedo-needle-redline');
    setSpeedoArcForPace(todayNeedle, null);
  }

  if (uiState === 'loading') {
    todayVal.textContent = '—';
    todayNeedle.classList.remove('speedo-needle-redline');
    todayLegend.className = 'speedo-legend';
    todayLegend.textContent = 'Collecting data';
  } else if (uiState === 'idle') {
    todayVal.textContent = '0';
    todayLegend.className = 'speedo-legend';
    todayLegend.textContent = 'No recent consumption';
  } else if (a.todayPace !== null) {
    setSpeedoNeedleForPace(todayNeedle, a.todayPace);
    todayVal.textContent = Math.round(a.todayPace);

    todayLegend.className = 'speedo-legend';
    const tone = legendToneFromUiState(uiState, lockOverlay.active);
    if (tone) todayLegend.classList.add(tone);

    if (lockOverlay.active) {
      todayLegend.textContent = `${lockOverlay.title} · ${lockOverlay.detail}`;
    } else if (uiState === 'critical') {
      todayLegend.textContent = `Redlining · ${formatETA(a.etaDailyExhaust)} to zero · reset ${formatETA(a.minutesToDailyReset)}`;
    } else if (uiState === 'attention') {
      todayLegend.textContent = `Attention · exhausts in ${formatETA(a.etaDailyExhaust)}`;
    } else {
      todayLegend.textContent = `Healthy daily pace · reset ${formatETA(a.minutesToDailyReset)}`;
    }
  } else {
    todayVal.textContent = '—';
    todayLegend.className = 'speedo-legend';
    todayLegend.textContent = 'Collecting data';
  }

  // Dots de créditos diários
  const dotsEl = document.getElementById('lv-daily-dots');
  dotsEl.innerHTML = '';
  const total = a.dailyTotal || 5;
  const remaining = Number.isFinite(a.dailyRemaining) ? a.dailyRemaining : null;
  const used  = remaining === null ? total : Math.ceil(Math.max(0, total - remaining));
  const dailyLevel = lovableDailyLevel(remaining);
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'lv-dot ' + (i < used ? 'used' : 'avail');
    if (i >= used) dot.dataset.level = dailyLevel;
    dotsEl.appendChild(dot);
  }
  document.getElementById('lv-daily-text').innerHTML =
    `<span class="lv-daily-remaining" data-level="${dailyLevel}">${formatLovableCredits(remaining)}</span> of ${formatLovableCredits(total)} remaining · reset ${formatETA(a.minutesToDailyReset)}`;

  // MONTHLY BURN
  const monthFill  = document.getElementById('lv-monthly-fill');
  const monthPct   = document.getElementById('lv-monthly-pct');
  const monthSub   = document.getElementById('lv-monthly-sub');
  const monthBurn  = document.getElementById('lv-monthly-burn');

  if (a.monthlyPct !== null) {
    monthFill.style.width = `${Math.min(a.monthlyPct, 100)}%`;
    monthFill.style.background = barColorFromUiState(uiState, lockOverlay.active);
    monthPct.textContent  = `${a.monthlyPct.toFixed(1)}%`;
    monthSub.textContent  = `reset ${formatETA(a.minutesToMonthlyReset)}`;
    monthBurn.textContent = a.monthlyBurn !== null
      ? `BURN ${Math.round(a.monthlyBurn)}${a.monthlyProjectedDays !== null ? ` · ${Math.round(a.monthlyProjectedDays)}d remaining` : ''}`
      : '—';
  }

  // Cloud / AI (passivos)
  const cloudWrap = document.getElementById('lv-cloud-wrap');
  const aiWrap    = document.getElementById('lv-ai-wrap');

  if (a.cloudPct !== null) {
    cloudWrap.style.display = '';
    document.getElementById('lv-cloud-fill').style.width = `${Math.min(a.cloudPct, 100)}%`;
    document.getElementById('lv-cloud-pct').textContent  = `${a.cloudPct.toFixed(1)}%`;
    if (a.cloudUsed !== null && a.cloudTotal !== null) {
      document.getElementById('lv-cloud-sub').textContent = `${a.cloudUsed.toFixed(2)} / ${a.cloudTotal.toFixed(2)}`;
    }
  } else { cloudWrap.style.display = 'none'; }

  if (a.aiPct !== null) {
    aiWrap.style.display = '';
    document.getElementById('lv-ai-fill').style.width = `${Math.min(a.aiPct, 100)}%`;
    document.getElementById('lv-ai-pct').textContent  = `${a.aiPct.toFixed(1)}%`;
    if (a.aiUsed !== null && a.aiTotal !== null) {
      document.getElementById('lv-ai-sub').textContent = `${a.aiUsed.toFixed(2)} / ${a.aiTotal.toFixed(2)}`;
    }
  } else { aiWrap.style.display = 'none'; }
}

function lovableDailyLevel(remaining) {
  if (!Number.isFinite(remaining)) return 'red';
  if (remaining >= 4) return 'blue';
  if (remaining >= 3) return 'green';
  if (remaining >= 2) return 'yellow';
  return 'red';
}

function formatLovableCredits(value) {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

// -------- Week blocks (Claude only) --------

function renderWeekBlocks(a) {
  const mins = a.minutesToReset7d;
  // days elapsed = 7 - days remaining; partial current day counts as elapsed
  const daysRemaining = mins !== null ? Math.max(0, Math.min(7, mins / 1440)) : null;
  const daysElapsed   = daysRemaining !== null ? Math.ceil(7 - daysRemaining) : 0;

  for (let i = 0; i < 7; i++) {
    const block = document.getElementById(`wblock-${i}`);
    if (!block) continue;
    // blocks 0..6 left→right = day1..day7; elapsed blocks get filled
    block.classList.toggle('week-block-elapsed', i < daysElapsed);
  }
}

// -------- Sparkline rolling-avg 7d (Claude only) --------

const SVG_NS = 'http://www.w3.org/2000/svg';

function rollingAvg(arr, radius) {
  return arr.map((_, i) => {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(arr.length - 1, i + radius);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += arr[j];
    return sum / (hi - lo + 1);
  });
}

function renderSparkline(snapshots) {
  const svg = document.getElementById('sparkline');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const W = 280, H = 60, PAD_L = 4, PAD_R = 4, PAD_T = 4, PAD_B = 10;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const now = Date.now();
  const start = now - 7 * 24 * 60 * 60 * 1000;

  const byHour = new Map();
  for (const s of snapshots) {
    if (s.u5h === null || s.t < start) continue;
    const d = new Date(s.t);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    if (!byHour.has(key)) byHour.set(key, []);
    byHour.get(key).push(s);
  }

  const hours = [];
  for (let hoursAgo = 167; hoursAgo >= 0; hoursAgo--) {
    const t = new Date(now - hoursAgo * 60 * 60 * 1000);
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}-${t.getHours()}`;
    const snaps = byHour.get(key);
    let delta = 0;
    if (snaps) {
      snaps.sort((a, b) => a.t - b.t);
      for (let i = 1; i < snaps.length; i++) {
        const d = snaps[i].u5h - snaps[i - 1].u5h;
        if (d > 0) delta += d;
      }
    }
    hours.push({ t: t.getTime(), delta });
  }

  const smoothed = rollingAvg(hours.map(h => h.delta), 2);
  const maxVal = Math.max(0.001, ...smoothed);
  const totalDelta = hours.reduce((s, h) => s + h.delta, 0);

  const points = hours.map((h, i) => ({
    t: h.t,
    x: PAD_L + (i / (hours.length - 1)) * plotW,
    y: PAD_T + plotH - (smoothed[i] / maxVal) * plotH,
  }));

  // day separators at 00:00
  for (let i = 0; i < points.length; i++) {
    const t = new Date(points[i].t);
    if (t.getHours() !== 0) continue;
    const x = points[i].x;

    const sep = document.createElementNS(SVG_NS, 'line');
    sep.setAttribute('x1', x); sep.setAttribute('x2', x);
    sep.setAttribute('y1', PAD_T); sep.setAttribute('y2', PAD_T + plotH);
    sep.setAttribute('stroke', '#27272a');
    sep.setAttribute('stroke-width', '1');
    sep.setAttribute('stroke-dasharray', '2 2');
    svg.appendChild(sep);

    const tick = document.createElementNS(SVG_NS, 'line');
    tick.setAttribute('x1', x); tick.setAttribute('x2', x);
    tick.setAttribute('y1', PAD_T + plotH); tick.setAttribute('y2', PAD_T + plotH + 3);
    tick.setAttribute('stroke', '#52525b');
    tick.setAttribute('stroke-width', '1');
    svg.appendChild(tick);

    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('x', x); lbl.setAttribute('y', H - 1);
    lbl.setAttribute('text-anchor', 'middle');
    lbl.setAttribute('fill', '#52525b');
    lbl.setAttribute('font-size', '7');
    lbl.setAttribute('font-family', 'ui-monospace, monospace');
    lbl.textContent = String(t.getDate()).padStart(2, '0') + '/' + String(t.getMonth() + 1).padStart(2, '0');
    svg.appendChild(lbl);
  }

  const baseY = PAD_T + plotH;
  const areaD = `M ${points[0].x} ${baseY} ` +
    points.map(p => `L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') +
    ` L ${points[points.length - 1].x} ${baseY} Z`;
  const area = document.createElementNS(SVG_NS, 'path');
  area.setAttribute('d', areaD);
  area.setAttribute('fill', 'rgba(245, 158, 11, 0.12)');
  svg.appendChild(area);

  const lineD = 'M ' + points.map(p => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('d', lineD);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#f59e0b');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);

  const last = points[points.length - 1];
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', last.x); dot.setAttribute('cy', last.y);
  dot.setAttribute('r', '2');
  dot.setAttribute('fill', '#f59e0b');
  svg.appendChild(dot);

  const rangeEl = document.getElementById('sparkline-range');
  if (rangeEl) rangeEl.textContent = `+${totalDelta.toFixed(1)}% / 7d`;
}

// -------- Footer --------

function renderFooter(a) {
  setFooterState(a);
}

// -------- Ticks Claude speedo --------

function drawClaudeTicks() {
  const group  = document.getElementById('speedo-ticks');
  const labels = document.getElementById('speedo-tick-labels');
  if (!group || !labels) return;
  const cx = 120, cy = 120, rOuter = 100, rInner = 90, rLabel = 78;
  for (let pace = 0; pace <= 200; pace += 25) {
    const angleDeg = -180 + (pace / 200) * 180;
    const rad = (angleDeg * Math.PI) / 180;
    const x1 = cx + Math.cos(rad) * rOuter, y1 = cy + Math.sin(rad) * rOuter;
    const x2 = cx + Math.cos(rad) * rInner, y2 = cy + Math.sin(rad) * rInner;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', pace === 100 ? '#f59e0b' : '#4b5563');
    line.setAttribute('stroke-width', pace === 100 ? '2.5' : '1.5');
    group.appendChild(line);

    if (pace % 50 === 0) {
      const lx = cx + Math.cos(rad) * rLabel, ly = cy + Math.sin(rad) * rLabel + 3;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', lx); text.setAttribute('y', ly);
      text.textContent = pace;
      labels.appendChild(text);
    }
  }
}

// -------- Events --------

function wireEvents() {
  document.getElementById('account-select').addEventListener('change', async (e) => {
    currentAccountId = e.target.value;
    await setActiveProviderId(activeProvider, currentAccountId);
    await render();
  });

  document.getElementById('refresh-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({
      type: 'FORCE_POLL', provider: activeProvider, accountId: currentAccountId
    }, () => setTimeout(render, 600));
  });

  document.getElementById('settings-btn')?.addEventListener('click', async () => {
    const modal = document.getElementById('settings-modal');
    await loadSettingsIntoForm();
    modal.classList.add('open');
  });

  document.getElementById('settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
  });

  document.getElementById('settings-save')?.addEventListener('click', saveSettings);
  document.getElementById('settings-cancel')?.addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('open');
  });
}

async function loadSettingsIntoForm() {
  const s = await getSettings();
  document.getElementById('set-poll').value             = s.activePollSeconds;
  document.getElementById('set-threshold-5h').value     = s.alertThreshold5h;
  document.getElementById('set-threshold-7d').value     = s.alertThreshold7d;
  document.getElementById('set-alert-redline').checked  = s.alertOnRedline;
  document.getElementById('set-show-bar').checked       = s.showBar;
}

async function saveSettings() {
  const clamp = (n, min, max) => isNaN(n) ? min : Math.max(min, Math.min(max, n));
  const patch = {
    activePollSeconds:  clamp(parseInt(document.getElementById('set-poll').value, 10), 60, 600),
    alertThreshold5h:   clamp(parseInt(document.getElementById('set-threshold-5h').value, 10), 0, 100),
    alertThreshold7d:   clamp(parseInt(document.getElementById('set-threshold-7d').value, 10), 0, 100),
    alertOnRedline:     document.getElementById('set-alert-redline').checked,
    showBar:            document.getElementById('set-show-bar').checked
  };
  await updateSettings(patch);
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
  document.getElementById('settings-modal').classList.remove('open');
  await render();
}

