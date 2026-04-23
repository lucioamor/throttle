// lib/predictor.js — Throttle v2

// -------- Shared helpers --------

export function snapshotAt(snapshots, minutesAgo) {
  if (!snapshots.length) return null;
  const target = Date.now() - minutesAgo * 60 * 1000;
  let best = null;
  for (const s of snapshots) {
    if (s.t <= target) {
      if (!best || s.t > best.t) best = s;
    }
  }
  return best || snapshots[0];
}

export function computeRate(snapshots, field, windowMinutes) {
  const now = snapshots[snapshots.length - 1];
  if (!now) return null;
  const past = snapshotAt(snapshots, windowMinutes);
  if (!past || past.t === now.t) return null;

  const nowValue = now[field];
  const pastValue = past[field];
  if (!Number.isFinite(nowValue) || !Number.isFinite(pastValue)) return null;

  const deltaUtil = nowValue - pastValue;
  const deltaMin = (now.t - past.t) / 60000;
  if (deltaMin < 0.5) return null;
  if (deltaUtil < -1) return null;
  if (deltaUtil > 100) return null;
  return { rate: Math.max(0, deltaUtil / deltaMin), windowActualMin: deltaMin, from: past[field], to: now[field] };
}

function computeETA(currentUtil, rate) {
  if (rate === null || rate === undefined) return null;
  if (!Number.isFinite(currentUtil)) return null;
  const remaining = 100 - currentUtil;
  if (remaining <= 0) return 0;
  if (rate <= 0.001) return Infinity;
  return remaining / rate;
}

function idealRate(windowTotalHours) { return 100 / (windowTotalHours * 60); }

function computeRPM(currentRate, idealRateValue) {
  if (!idealRateValue || idealRateValue <= 0 || currentRate === null) return null;
  return (currentRate / idealRateValue) * 100;
}

function computeTrend(rate15, rate60) {
  if (rate15 === null || rate60 === null) return null;
  if (rate60 <= 0.001) return rate15 > 0.001 ? 'up' : 'stable';
  const ratio = rate15 / rate60;
  if (ratio > 1.15) return 'up';
  if (ratio < 0.85) return 'down';
  return 'stable';
}

export function resolveUiState(ctx) {
  const monthlyRemaining = Number.isFinite(ctx?.monthlyCreditsRemaining)
    ? ctx.monthlyCreditsRemaining
    : null;
  const monthlyExhausted = (ctx?.monthlyExhausted ?? false) || (monthlyRemaining !== null && monthlyRemaining <= 0);
  const locked5h = ctx?.window5hExhausted ?? false;

  if (monthlyExhausted) return 'locked_monthly';
  if (locked5h) return 'locked_5h';
  if (!ctx?.hasPaceData || !Number.isFinite(ctx?.recentUsagePct)) return 'loading';

  const pace = ctx.recentUsagePct;
  if (pace < 2) return 'idle';
  if (pace < 40) return 'healthy';
  if (pace < 75) return 'attention';
  return 'critical';
}

// -------- Claude: analyze() --------

export function analyze(snapshots) {
  if (!snapshots || snapshots.length === 0) return { ready: false, reason: 'no_data' };

  const latest = snapshots[snapshots.length - 1];
  const u5h = Number.isFinite(latest.u5h) ? latest.u5h : null;
  const minutesToReset5h = latest.reset5h ? (new Date(latest.reset5h).getTime() - Date.now()) / 60000 : null;
  const minutesToReset7d = latest.reset7d ? (new Date(latest.reset7d).getTime() - Date.now()) / 60000 : null;

  const rate15 = computeRate(snapshots, 'u5h', 15);
  const rate60 = computeRate(snapshots, 'u5h', 60);
  const rate7d_360 = computeRate(snapshots, 'u7d', 360);

  let blendedRate = null;
  if (rate15 && rate60) blendedRate = rate15.rate * 0.7 + rate60.rate * 0.3;
  else if (rate15) blendedRate = rate15.rate;
  else if (rate60) blendedRate = rate60.rate;

  const eta15    = rate15      ? computeETA(u5h, rate15.rate) : null;
  const eta60    = rate60      ? computeETA(u5h, rate60.rate) : null;
  const etaBlend = blendedRate !== null ? computeETA(u5h, blendedRate) : null;

  const ideal5h  = idealRate(5);
  let rpmBlend = blendedRate !== null ? computeRPM(blendedRate, ideal5h) : null;
  // When the 5h window is already exhausted, a near-zero live burn rate should
  // not render as "0 pace" in UI.
  if (u5h !== null && u5h >= 99.5 && (rpmBlend === null || rpmBlend < 1)) {
    rpmBlend = 100;
  }
  const trend    = computeTrend(rate15?.rate ?? null, rate60?.rate ?? null);

  let status = 'green', statusReason = 'Pace saudável', operationalMsg = 'ritmo sustentável';

  if (u5h !== null && u5h >= 100) {
    status = 'red'; statusReason = 'Janela de 5h esgotada';
  } else if (u5h !== null && u5h >= 95) {
    status = 'red'; statusReason = 'Janela de 5h quase no limite';
  } else if (eta15 !== null && eta15 !== Infinity && minutesToReset5h !== null && eta15 < minutesToReset5h) {
    status = 'red'; statusReason = `Ritmo atual esgota em ${Math.round(eta15)}min`;
  } else if (eta60 !== null && eta60 !== Infinity && minutesToReset5h !== null && eta60 < minutesToReset5h) {
    status = 'yellow'; statusReason = 'Média da última hora preocupa';
  } else if (rpmBlend !== null && rpmBlend > 130) {
    status = 'red'; statusReason = 'Redline — segura o throttle';
  } else if (rpmBlend !== null && rpmBlend > 105) {
    status = 'yellow'; statusReason = 'Acima do pace ideal';
  } else if (rpmBlend !== null && rpmBlend < 50 && u5h !== null && u5h < 80) {
    status = 'blue'; statusReason = 'Sobrando cota';
  }

  if (u5h !== null && u5h >= 100) {
    operationalMsg = 'janela esgotada - aguarde reset';
  } else if (status === 'red' && etaBlend !== null && etaBlend !== Infinity && etaBlend < (minutesToReset5h ?? Infinity)) {
    operationalMsg = 'vai secar antes do reset';
  } else if (status === 'blue') {
    operationalMsg = 'pode acelerar';
  } else if (status === 'yellow') {
    operationalMsg = 'atenção ao ritmo';
  }

  const monthlyCreditsRemaining = Number.isFinite(latest.extra_limit) && Number.isFinite(latest.extra_used)
    ? Math.max(0, latest.extra_limit - latest.extra_used)
    : null;
  const uiState = resolveUiState({
    provider: 'claude',
    // Stub for future reliable monthly lock detection in Claude.
    monthlyExhausted: latest.monthlyExhausted ?? false,
    monthlyCreditsRemaining,
    window5hExhausted: u5h !== null && u5h >= 100,
    hasPaceData: rpmBlend !== null,
    recentUsagePct: rpmBlend
  });

  return {
    ready: true, provider: 'claude', latest,
    minutesToReset5h, minutesToReset7d,
    rate15: rate15?.rate ?? null, rate60: rate60?.rate ?? null,
    rate7d: rate7d_360?.rate ?? null, blendedRate, eta15, eta60, etaBlend,
    ideal5h, rpmBlend, trend, operationalMsg, status, statusReason,
    monthlyCreditsRemaining, uiState,
    snapshotCount: snapshots.length, firstSnapshotAt: snapshots[0].t
  };
}

// -------- Lovable: analyzeLovable() --------
//
// Snap shape:
// { t, daily_used, daily_total, daily_reset_at,
//   monthly_used, monthly_total, monthly_reset_at,
//   cloud_used, cloud_total, ai_used, ai_total,
//   ws_name, ws_id }

export function analyzeLovable(snapshots) {
  if (!snapshots || snapshots.length === 0) return { ready: false, reason: 'no_data' };

  const latest = snapshots[snapshots.length - 1];
  const now = Date.now();

  const minutesToDailyReset   = latest.daily_reset_at   ? (new Date(latest.daily_reset_at).getTime()   - now) / 60000 : null;
  const minutesToMonthlyReset = latest.monthly_reset_at ? (new Date(latest.monthly_reset_at).getTime() - now) / 60000 : null;

  // --- Diário ---
  const dailyTotal     = latest.daily_total ?? 5;
  const dailyUsed      = latest.daily_used  ?? 0;
  const dailyRemaining = Math.max(0, dailyTotal - dailyUsed);
  const dailyPct       = dailyTotal > 0 ? (dailyUsed / dailyTotal) * 100 : null;

  // Filtra snapshots do ciclo diário atual
  const dailyCycleStart = minutesToDailyReset !== null && minutesToDailyReset > 0
    ? now - (1440 - minutesToDailyReset) * 60000 : now - 1440 * 60000;
  const todaySnaps = snapshots.filter(s => s.t >= dailyCycleStart);

  let todayPace = null, todayPaceStatus = 'green', todayTrend = null, etaDailyExhaust = null;

  if (todaySnaps.length >= 2 && minutesToDailyReset !== null && minutesToDailyReset > 1) {
    const first = todaySnaps[0];
    const last  = todaySnaps[todaySnaps.length - 1];
    const deltaUsed = Math.max(0, (last.daily_used ?? 0) - (first.daily_used ?? 0));
    const deltaMins = (last.t - first.t) / 60000;

    if (deltaMins > 0.5) {
      const currentRate = deltaUsed / deltaMins; // créditos/min

      // Ritmo ideal: usar o que resta até 00:00 UTC — ativos perecíveis devem ser usados
      const idealTodayRate = dailyRemaining > 0 ? dailyRemaining / minutesToDailyReset : 0;

      // TODAY PACE: taxa atual / taxa ideal × 100
      // 100 = vai esgotar exatamente no reset (uso perfeito)
      // >130 = redline, esgota antes
      // <50  = vai desperdiçar créditos diários
      todayPace = idealTodayRate > 0 ? (currentRate / idealTodayRate) * 100 : null;

      if (todayPace !== null) {
        if      (todayPace > 130)                        todayPaceStatus = 'red';
        else if (todayPace > 105)                        todayPaceStatus = 'yellow';
        else if (todayPace < 50 && dailyRemaining > 0)   todayPaceStatus = 'blue';
      }

      etaDailyExhaust = currentRate > 0.001 && dailyRemaining > 0
        ? dailyRemaining / currentRate
        : dailyRemaining <= 0 ? 0 : Infinity;

      // Trend: últimos 3 snaps vs baseline
      const recentSnaps = todaySnaps.slice(-3);
      if (recentSnaps.length >= 2) {
        const rFirst = recentSnaps[0], rLast = recentSnaps[recentSnaps.length - 1];
        const recentDelta = Math.max(0, (rLast.daily_used ?? 0) - (rFirst.daily_used ?? 0));
        const recentMins  = (rLast.t - rFirst.t) / 60000;
        if (recentMins > 0.5 && currentRate > 0.001) {
          const recentRate = recentDelta / recentMins;
          const ratio = recentRate / currentRate;
          todayTrend = ratio > 1.15 ? 'up' : ratio < 0.85 ? 'down' : 'stable';
        }
      }
    }
  }

  // --- Mensal ---
  const monthlyTotal     = latest.monthly_total ?? 0;
  const monthlyUsed      = latest.monthly_used  ?? 0;
  const monthlyRemaining = Math.max(0, monthlyTotal - monthlyUsed);
  const monthlyPct       = monthlyTotal > 0 ? (monthlyUsed / monthlyTotal) * 100 : null;

  let monthlyBurn = null, monthlyBurnStatus = 'green', monthlyProjectedDays = null;

  const sevenDaysAgo   = now - 7 * 24 * 60 * 60 * 1000;
  const monthlySnaps7d = snapshots.filter(s => s.t >= sevenDaysAgo);

  if (monthlySnaps7d.length >= 2) {
    const f = monthlySnaps7d[0], l = monthlySnaps7d[monthlySnaps7d.length - 1];
    const deltaMonthly = Math.max(0, (l.monthly_used ?? 0) - (f.monthly_used ?? 0));
    const deltaDays    = (l.t - f.t) / (24 * 60 * 60 * 1000);

    if (deltaDays > 0.1) {
      const creditsPerDay = deltaMonthly / deltaDays;

      if (creditsPerDay > 0.001 && monthlyRemaining > 0) {
        monthlyProjectedDays = monthlyRemaining / creditsPerDay;

        const daysToReset = minutesToMonthlyReset !== null ? minutesToMonthlyReset / (24 * 60) : null;
        if (daysToReset !== null && daysToReset > 0) {
          const idealMonthlyRate = monthlyRemaining / daysToReset;
          monthlyBurn = idealMonthlyRate > 0 ? (creditsPerDay / idealMonthlyRate) * 100 : null;

          if (monthlyBurn !== null) {
            if      (monthlyBurn > 130) monthlyBurnStatus = 'red';
            else if (monthlyBurn > 105) monthlyBurnStatus = 'yellow';
            else if (monthlyBurn < 50)  monthlyBurnStatus = 'blue';
          }
        }
      }
    }
  }

  // --- Passivos: Cloud / AI ---
  const cloudPct    = latest.cloud_total  > 0 ? ((latest.cloud_used ?? 0)  / latest.cloud_total)  * 100 : null;
  const aiPct       = latest.ai_total     > 0 ? ((latest.ai_used    ?? 0)  / latest.ai_total)     * 100 : null;
  const cloudStatus = cloudPct === null ? 'unknown' : cloudPct >= 85 ? 'red' : cloudPct >= 70 ? 'yellow' : 'green';
  const aiStatus    = aiPct    === null ? 'unknown' : aiPct    >= 85 ? 'red' : aiPct    >= 70 ? 'yellow' : 'green';

  // Status geral
  const allStatuses = [todayPaceStatus, monthlyBurnStatus, cloudStatus, aiStatus];
  let overallStatus = 'green';
  if      (allStatuses.includes('red'))    overallStatus = 'red';
  else if (allStatuses.includes('yellow')) overallStatus = 'yellow';
  else if (todayPaceStatus === 'blue')     overallStatus = 'blue';

  const uiState = resolveUiState({
    provider: 'lovable',
    monthlyCreditsRemaining: monthlyRemaining,
    window5hExhausted: false,
    hasPaceData: todayPace !== null,
    recentUsagePct: todayPace
  });

  return {
    ready: true, provider: 'lovable',
    latest, wsName: latest.ws_name || 'workspace',

    dailyUsed, dailyTotal, dailyRemaining, dailyPct,
    minutesToDailyReset, todayPace, todayPaceStatus, todayTrend, etaDailyExhaust,

    monthlyUsed, monthlyTotal, monthlyRemaining, monthlyPct,
    minutesToMonthlyReset, monthlyBurn, monthlyBurnStatus, monthlyProjectedDays,

    cloudPct, cloudStatus, cloudUsed: latest.cloud_used ?? null, cloudTotal: latest.cloud_total ?? null,
    aiPct,    aiStatus,    aiUsed:    latest.ai_used    ?? null, aiTotal:    latest.ai_total    ?? null,

    overallStatus, uiState, snapshotCount: snapshots.length, firstSnapshotAt: snapshots[0].t
  };
}

// -------- Formatters --------

export function formatETA(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes === Infinity) return 'sem queima';
  if (minutes < 1) return '<1min';
  if (minutes < 60) return `${Math.round(minutes)}min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return m > 0 ? `${h}h${m}min` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d${(h % 24) > 0 ? (h % 24) + 'h' : ''}`;
}

export function formatMinutes(minutes) { return formatETA(minutes); }
