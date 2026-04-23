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

(async function init() {
  await renderTabs();
  wireTabSwitcher();
  wireEvents();
  drawClaudeTicks();
  await populateAccounts();
  await render();
  setInterval(async () => {
    await populateAccounts();
    await render();
  }, 5000);
})();

// -------- Tab switcher --------

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
  select.innerHTML = '';
  select.disabled = false;

  const entries = Object.values(accounts);
  if (entries.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = activeProvider === 'claude'
      ? 'nenhuma org detectada — abra claude.ai'
      : 'nenhum workspace — abra lovable.dev';
    opt.disabled = true;
    select.appendChild(opt);
    select.disabled = true;
    currentAccountId = null;
    return;
  }

  const labelCount = new Map();
  for (const acc of entries) {
    const key = acc.label || acc.providerId;
    labelCount.set(key, (labelCount.get(key) || 0) + 1);
  }

  for (const acc of entries) {
    const opt = document.createElement('option');
    opt.value = acc.providerId;
    const baseLabel = acc.label || acc.providerId;
    const shouldDisambiguate = (labelCount.get(baseLabel) || 0) > 1;
    const suffix = shouldDisambiguate ? ` · ${shortProviderSuffix(acc.providerId)}` : '';
    opt.textContent = baseLabel + suffix + (acc.plan && acc.plan !== 'unknown' ? ` [${acc.plan}]` : '');
    if (acc.providerId === active) opt.selected = true;
    select.appendChild(opt);
  }
  currentAccountId = active || entries[0].providerId;
}

function shortProviderSuffix(providerId) {
  if (typeof providerId !== 'string') return 'id';
  const idx = providerId.indexOf(':');
  const raw = idx >= 0 ? providerId.slice(idx + 1) : providerId;
  return raw.slice(0, 8);
}

// -------- Render dispatcher --------

async function render() {
  if (!currentAccountId) currentAccountId = await getActiveProviderId(activeProvider);
  if (!currentAccountId) {
    setStatusMsg(activeProvider === 'claude'
      ? 'Abra claude.ai para inicializar'
      : 'Abra lovable.dev para inicializar');
    return;
  }

  const snapshots = await getSnapshots(currentAccountId);

  if (activeProvider === 'claude') {
    const analysis = analyze(snapshots);
    if (!analysis.ready) { setStatusMsg('Aguardando primeiro snapshot...'); return; }
    renderClaudeSpeedo(analysis);
    renderClaudeStats(analysis);
    renderHeatmap(snapshots);
    renderFooter(analysis);
  } else {
    const analysis = analyzeLovable(snapshots);
    if (!analysis.ready) { setStatusMsg('Aguardando dados do Lovable...'); return; }
    renderLovablePanel(analysis);
    renderFooter(analysis);
  }
}

function setStatusMsg(msg) {
  document.getElementById('speedo-legend').textContent = msg;
}

function legendToneFromUiState(uiState) {
  if (uiState === 'locked_monthly' || uiState === 'locked_5h' || uiState === 'critical') return 'warn';
  if (uiState === 'idle' || uiState === 'healthy') return 'ok';
  return '';
}

function barColorFromUiState(uiState) {
  if (uiState === 'locked_monthly' || uiState === 'locked_5h' || uiState === 'critical') return '#ef4444';
  if (uiState === 'attention') return '#eab308';
  return '#22c55e';
}

// -------- Claude panel --------

function renderClaudeSpeedo(a) {
  const needle = document.getElementById('speedo-needle');
  const value  = document.getElementById('speedo-value');
  const legend = document.getElementById('speedo-legend');
  const pace   = a.rpmBlend;
  const uiState = a.uiState || 'loading';
  const u5h = Number.isFinite(a?.latest?.u5h) ? a.latest.u5h : null;

  if (uiState === 'loading') { value.textContent = '—'; legend.textContent = 'Aguardando dados de pace'; return; }
  if (pace === null) { value.textContent = '—'; legend.textContent = 'Aguardando dados de pace'; return; }

  const angle = -90 + (Math.min(Math.max(pace, 0), 200) / 200) * 180;
  needle.style.transform = `rotate(${angle}deg)`;
  value.textContent = Math.round(pace);

  legend.className = 'speedo-legend';
  const tone = legendToneFromUiState(uiState);
  if (tone) legend.classList.add(tone);
  if (uiState === 'locked_monthly') {
    legend.textContent = `Limite mensal esgotado · reset ${formatETA(a.minutesToReset7d)}`;
  } else if (uiState === 'locked_5h' || (u5h !== null && u5h >= 100)) {
    legend.textContent = `Janela 5h esgotada · reset ${formatETA(a.minutesToReset5h)}`;
  } else if (uiState === 'critical' || pace > 130) {
    legend.textContent = `Redline · zera ${formatETA(a.etaBlend)} · reset ${formatETA(a.minutesToReset5h)}`;
  } else if (uiState === 'attention' || pace > 105) {
    legend.textContent = `Acima do pace · ETA ${formatETA(a.etaBlend)}`;
  } else if (uiState === 'idle' || pace < 50) {
    legend.textContent = `Throttle folgado · reset ${formatETA(a.minutesToReset5h)}`;
  } else {
    legend.textContent = `Pace saudável · reset ${formatETA(a.minutesToReset5h)}`;
  }
}

function renderClaudeStats(a) {
  const l = a.latest;
  const uiState = a.uiState || 'loading';

  if (l.u5h !== null) {
    const fill5h = document.getElementById('stat-5h-fill');
    fill5h.style.width  = `${Math.min(l.u5h, 100)}%`;
    fill5h.style.background = barColorFromUiState(uiState);
    document.getElementById('stat-5h-pct').textContent   = `${l.u5h.toFixed(1)}%`;
    document.getElementById('stat-5h-reset').textContent = `reset ${formatETA(a.minutesToReset5h)}`;
    document.getElementById('stat-5h-eta15').textContent = formatETA(a.eta15);
    document.getElementById('stat-5h-eta60').textContent = formatETA(a.eta60);
  }

  if (l.u7d !== null) {
    const mask7d = document.getElementById('stat-7d-mask');
    const pct7d = Math.max(0, Math.min(l.u7d, 100));
    if (mask7d) {
      mask7d.style.left = `${pct7d}%`;
    }
    document.getElementById('stat-7d-pct').textContent   = `${l.u7d.toFixed(1)}%`;
    document.getElementById('stat-7d-reset').textContent = `reset ${formatETA(a.minutesToReset7d)}`;
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

  if (uiState !== 'loading' && a.todayPace !== null) {
    const angle = -90 + (Math.min(Math.max(a.todayPace, 0), 200) / 200) * 180;
    todayNeedle.style.transform = `rotate(${angle}deg)`;
    todayVal.textContent = Math.round(a.todayPace);

    todayLegend.className = 'speedo-legend';
    const tone = legendToneFromUiState(uiState);
    if (tone) todayLegend.classList.add(tone);

    if (uiState === 'locked_monthly') {
      todayLegend.textContent = `Limite mensal esgotado · reset ${formatETA(a.minutesToMonthlyReset)}`;
    } else if (uiState === 'critical') {
      todayLegend.textContent = `Redline · esgota ${formatETA(a.etaDailyExhaust)} · reset ${formatETA(a.minutesToDailyReset)}`;
    } else if (uiState === 'attention') {
      todayLegend.textContent = `Atenção · esgota ${formatETA(a.etaDailyExhaust)}`;
    } else if (uiState === 'idle') {
      todayLegend.textContent = `Créditos sobrando · reset ${formatETA(a.minutesToDailyReset)}`;
    } else {
      todayLegend.textContent = `Pace diário saudável · reset ${formatETA(a.minutesToDailyReset)}`;
    }
  } else {
    todayVal.textContent = '—';
    todayLegend.textContent = 'Aguardando dados de TODAY PACE';
  }

  // Dots de créditos diários
  const dotsEl = document.getElementById('lv-daily-dots');
  dotsEl.innerHTML = '';
  const total = a.dailyTotal || 5;
  const used  = total - (a.dailyRemaining ?? 0);
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'lv-dot ' + (i < used ? 'used' : 'avail');
    dotsEl.appendChild(dot);
  }
  document.getElementById('lv-daily-text').textContent =
    `${a.dailyRemaining ?? '—'} de ${total} restantes · reset ${formatETA(a.minutesToDailyReset)}`;

  // MONTHLY BURN
  const monthFill  = document.getElementById('lv-monthly-fill');
  const monthPct   = document.getElementById('lv-monthly-pct');
  const monthSub   = document.getElementById('lv-monthly-sub');
  const monthBurn  = document.getElementById('lv-monthly-burn');

  if (a.monthlyPct !== null) {
    monthFill.style.width = `${Math.min(a.monthlyPct, 100)}%`;
    monthFill.style.background = barColorFromUiState(uiState);
    monthPct.textContent  = `${a.monthlyPct.toFixed(1)}%`;
    monthSub.textContent  = `reset ${formatETA(a.minutesToMonthlyReset)}`;
    monthBurn.textContent = a.monthlyBurn !== null
      ? `BURN ${Math.round(a.monthlyBurn)}${a.monthlyProjectedDays !== null ? ` · ${Math.round(a.monthlyProjectedDays)}d de saldo` : ''}`
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

// -------- Heatmap (Claude only) --------

function renderHeatmap(snapshots) {
  const heatmap = document.getElementById('heatmap');
  if (!heatmap) return;
  heatmap.innerHTML = '';

  const now = new Date();
  const byHour = new Map();
  for (const s of snapshots) {
    if (s.u5h === null) continue;
    const d = new Date(s.t);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    if (!byHour.has(key)) byHour.set(key, []);
    byHour.get(key).push(s);
  }

  const buckets = new Map();
  for (const [key, snaps] of byHour) {
    snaps.sort((a, b) => a.t - b.t);
    let delta = 0;
    for (let i = 1; i < snaps.length; i++) {
      const d = snaps[i].u5h - snaps[i-1].u5h;
      if (d > 0) delta += d;
    }
    buckets.set(key, delta);
  }

  const maxDelta = Math.max(1, ...buckets.values());

  for (let hoursAgo = 167; hoursAgo >= 0; hoursAgo--) {
    const t = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
    const key = `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}-${t.getHours()}`;
    const delta = buckets.get(key) || 0;
    const el = document.createElement('div');
    el.className = 'cell';
    const ratio = delta / maxDelta;
    let tier = 0;
    if (ratio > 0.75) tier = 4;
    else if (ratio > 0.5) tier = 3;
    else if (ratio > 0.25) tier = 2;
    else if (ratio > 0) tier = 1;
    el.classList.add(`scale-${tier}`);
    const hh = String(t.getHours()).padStart(2, '0');
    const dd = t.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    el.title = `${dd} ${hh}h — +${delta.toFixed(1)}%`;
    heatmap.appendChild(el);
  }

  if (snapshots.length > 0) {
    const from = new Date(snapshots[0].t);
    document.getElementById('heatmap-range').textContent =
      `desde ${from.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`;
  }
}

// -------- Footer --------

function renderFooter(a) {
  const last = new Date(a.latest.t);
  document.getElementById('last-update').textContent =
    `last ${last.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  document.getElementById('snap-count').textContent = `${a.snapshotCount} snapshots`;
}

// -------- Ticks Claude speedo --------

function drawClaudeTicks() {
  const group  = document.getElementById('speedo-ticks');
  const labels = document.getElementById('speedo-tick-labels');
  if (!group || !labels) return;
  const cx = 120, cy = 140, rOuter = 100, rInner = 90, rLabel = 78;
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

  document.getElementById('export-csv-btn')?.addEventListener('click', exportCSV);

  document.getElementById('settings-btn')?.addEventListener('click', async () => {
    const panel = document.getElementById('settings-panel');
    if (panel.hidden) { await loadSettingsIntoForm(); panel.hidden = false; }
    else panel.hidden = true;
  });

  document.getElementById('settings-save')?.addEventListener('click', saveSettings);
  document.getElementById('settings-cancel')?.addEventListener('click', () => {
    document.getElementById('settings-panel').hidden = true;
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
  document.getElementById('settings-panel').hidden = true;
  await render();
}

// -------- CSV export --------

async function exportCSV() {
  const snapshots = await getSnapshots(currentAccountId);
  if (!snapshots.length) { alert('Sem snapshots para exportar.'); return; }

  let rows, headers;
  if (activeProvider === 'claude') {
    headers = ['timestamp_iso','timestamp_ms','u5h_pct','u7d_pct','reset_5h_iso','reset_7d_iso','extra_used','extra_limit','extra_util_pct','extra_currency'];
    rows = snapshots.map(s => [
      new Date(s.t).toISOString(), s.t,
      fmt(s.u5h), fmt(s.u7d), s.reset5h||'', s.reset7d||'',
      fmt(s.extra_used), fmt(s.extra_limit), fmt(s.extra_util), s.extra_currency||''
    ]);
  } else {
    headers = ['timestamp_iso','timestamp_ms','daily_used','daily_total','daily_reset_at','monthly_used','monthly_total','monthly_reset_at','cloud_used','cloud_total','ai_used','ai_total','ws_name'];
    rows = snapshots.map(s => [
      new Date(s.t).toISOString(), s.t,
      fmt(s.daily_used), fmt(s.daily_total), s.daily_reset_at||'',
      fmt(s.monthly_used), fmt(s.monthly_total), s.monthly_reset_at||'',
      fmt(s.cloud_used), fmt(s.cloud_total), fmt(s.ai_used), fmt(s.ai_total),
      s.ws_name||''
    ]);
  }

  const csv = [headers, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `throttle_${activeProvider}_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v.toFixed(2);
  return String(v);
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
