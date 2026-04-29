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

export function computeWeightedRate(snapshots, field, lookbackMinutes = 120, halfLifeMinutes = 45) {
  if (!snapshots || snapshots.length < 2) return null;

  const latest = snapshots[snapshots.length - 1];
  const endTs = Number.isFinite(latest?.t) ? latest.t : Date.now();
  const cutoffTs = endTs - lookbackMinutes * 60 * 1000;

  const inside = snapshots.filter((s) => Number.isFinite(s?.t) && s.t >= cutoffTs && Number.isFinite(s?.[field]));
  if (inside.length === 0) return null;

  const firstInside = snapshots.findIndex((s) => Number.isFinite(s?.t) && s.t >= cutoffTs && Number.isFinite(s?.[field]));
  const series = firstInside > 0
    ? [snapshots[firstInside - 1], ...inside]
    : inside;
  if (series.length < 2) return null;

  let weightedSum = 0;
  let weightTotal = 0;

  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    const prevValue = prev?.[field];
    const curValue = cur?.[field];
    if (!Number.isFinite(prev?.t) || !Number.isFinite(cur?.t)) continue;
    if (!Number.isFinite(prevValue) || !Number.isFinite(curValue)) continue;

    const deltaMin = (cur.t - prev.t) / 60000;
    if (deltaMin < 0.5) continue;

    const deltaUtil = curValue - prevValue;
    if (deltaUtil < -1 || deltaUtil > 100) continue;

    const rate = Math.max(0, deltaUtil / deltaMin);
    const midpointAge = (endTs - ((prev.t + cur.t) / 2)) / 60000;
    const decay = Math.exp(-Math.max(0, midpointAge) / Math.max(1, halfLifeMinutes));
    const weight = deltaMin * decay;
    weightedSum += rate * weight;
    weightTotal += weight;
  }

  if (weightTotal <= 0) return null;
  return {
    rate: weightedSum / weightTotal,
    windowActualMin: lookbackMinutes,
    samples: series.length - 1
  };
}

function computeETA(currentUtil, rate) {
  if (rate === null || rate === undefined) return null;
  if (!Number.isFinite(currentUtil)) return null;
  const remaining = 100 - currentUtil;
  if (remaining <= 0) return 0;
  if (rate <= 0.001) return Infinity;
  return remaining / rate;
}

function chooseDisplayETA(...values) {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finite.length) return Math.min(...finite);
  return values.includes(Infinity) ? Infinity : null;
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

function formatResetDate(isoValue) {
  if (typeof isoValue !== 'string' || !isoValue) return '—';
  const ts = new Date(isoValue).getTime();
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatHoursToReset(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  const totalMinutes = Math.max(0, Math.ceil(minutes));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours <= 0) return `${mins}m`;
  return `${hours}h${String(mins).padStart(2, '0')}m`;
}

function smoothValues(values) {
  if (!Array.isArray(values) || values.length < 3) return values.slice();
  return values.map((value, index) => {
    const prev = values[index - 1] ?? value;
    const next = values[index + 1] ?? value;
    return (prev + value * 2 + next) / 4;
  });
}

function catmullRomPath(points) {
  if (!Array.isArray(points) || points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function interpolateSeriesValue(series, targetTs, field) {
  if (!Array.isArray(series) || series.length === 0) return null;
  if (targetTs <= series[0].t) return series[0][field];
  if (targetTs >= series[series.length - 1].t) return series[series.length - 1][field];

  let left = series[0];
  for (let i = 1; i < series.length; i++) {
    const right = series[i];
    if (right.t < targetTs) {
      left = right;
      continue;
    }

    const leftValue = left?.[field];
    const rightValue = right?.[field];
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return rightValue ?? leftValue ?? null;

    const span = right.t - left.t;
    if (span <= 0) return rightValue;

    const ratio = (targetTs - left.t) / span;
    return leftValue + ((rightValue - leftValue) * ratio);
  }

  return series[series.length - 1][field];
}

export function buildSparkline(snapshots, field, lookbackMinutes = 120, width = 64, height = 18, sampleCount = 24) {
  if (!snapshots || snapshots.length < 2) return null;

  const latest = snapshots[snapshots.length - 1];
  const endTs = Number.isFinite(latest?.t) ? latest.t : Date.now();
  const startTs = endTs - lookbackMinutes * 60 * 1000;

  const inside = snapshots.filter((s) => Number.isFinite(s?.t) && s.t >= startTs && Number.isFinite(s?.[field]));
  if (inside.length === 0) return null;

  const firstInside = snapshots.findIndex((s) => Number.isFinite(s?.t) && s.t >= startTs && Number.isFinite(s?.[field]));
  const series = firstInside > 0
    ? [snapshots[firstInside - 1], ...inside]
    : inside;
  if (series.length < 2) return null;

  const samples = [];
  const steps = Math.max(2, sampleCount);
  for (let i = 0; i < steps; i++) {
    const ts = startTs + ((endTs - startTs) * i) / (steps - 1);
    const value = interpolateSeriesValue(series, ts, field);
    if (Number.isFinite(value)) samples.push(value);
  }

  if (samples.length < 2) return null;

  const smoothed = smoothValues(samples).map((value) => Math.min(100, Math.max(0, value)));
  let min = Math.min(...smoothed);
  let max = Math.max(...smoothed);
  const spread = max - min;
  const padding = Math.max(2, spread * 0.18);
  min = Math.max(0, min - padding);
  max = Math.min(100, max + padding);
  if (max - min < 1) {
    min = Math.max(0, min - 1);
    max = Math.min(100, max + 1);
  }

  const points = smoothed.map((value, index) => {
    const x = (index / (smoothed.length - 1)) * width;
    const y = height - ((value - min) / Math.max(1e-6, max - min)) * height;
    return { x, y, value };
  });

  return {
    path: catmullRomPath(points),
    points,
    min,
    max,
    latestValue: smoothed[smoothed.length - 1],
    width,
    height
  };
}

function dynamicTargetRate(currentUtil, minutesToReset) {
  if (!Number.isFinite(currentUtil) || !Number.isFinite(minutesToReset) || minutesToReset <= 0) return null;
  const remaining = Math.max(0, 100 - currentUtil);
  if (remaining <= 0) return 0;
  return remaining / minutesToReset;
}

export function resolveUiState(ctx) {
  const monthlyRemaining = Number.isFinite(ctx?.monthlyCreditsRemaining)
    ? ctx.monthlyCreditsRemaining
    : null;
  const dailyRemaining = Number.isFinite(ctx?.dailyCreditsRemaining)
    ? ctx.dailyCreditsRemaining
    : null;
  const hasMonthlyQuota = typeof ctx?.hasMonthlyQuota === 'boolean'
    ? ctx.hasMonthlyQuota
    : monthlyRemaining !== null;
  const monthlyExhausted = (ctx?.monthlyExhausted ?? false)
    || (hasMonthlyQuota && monthlyRemaining !== null && monthlyRemaining <= 0);
  const hasDailyQuota = typeof ctx?.hasDailyQuota === 'boolean'
    ? ctx.hasDailyQuota
    : dailyRemaining !== null;
  const hasAnyDailyCredits = hasDailyQuota && dailyRemaining !== null && dailyRemaining > 0;
  const locked5h = ctx?.window5hExhausted ?? false;

  if (monthlyExhausted && !hasAnyDailyCredits) return 'locked_monthly';
  if (locked5h) return 'locked_5h';
  if (!ctx?.hasPaceData || !Number.isFinite(ctx?.recentUsagePct)) return 'loading';

  const pace = ctx.recentUsagePct;
  if (pace < 2) return 'idle';
  if (pace < 40) return 'healthy';
  if (pace < 75) return 'attention';
  return 'critical';
}

function buildLockOverlay(provider, uiState, timing = {}) {
  if (uiState !== 'locked_monthly' && uiState !== 'locked_5h') {
    return {
      active: false,
      kind: null,
      icon: '',
      title: '',
      detail: ''
    };
  }

  if (uiState === 'locked_monthly') {
    const resetAt = provider === 'lovable'
      ? timing.monthlyResetAt
      : timing.reset7dAt;
    return {
      active: true,
      kind: 'monthly',
      icon: '🔒',
      title: 'Limite mensal esgotado',
      detail: `reset ${formatResetDate(resetAt)}`
    };
  }

  const resetMinutes = provider === 'lovable'
    ? timing.minutesToDailyReset
    : timing.minutesToReset5h;
  return {
    active: true,
    kind: 'window',
    icon: '⏳',
    title: provider === 'lovable' ? 'Janela diária esgotada' : 'Janela 5h esgotada',
    detail: `reset ${formatHoursToReset(resetMinutes)}`
  };
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
  const weightedRate = computeWeightedRate(snapshots, 'u5h', 120, 45);

  let blendedRate = null;
  if (weightedRate) blendedRate = weightedRate.rate;
  else if (rate15 && rate60) blendedRate = rate15.rate * 0.7 + rate60.rate * 0.3;
  else if (rate15) blendedRate = rate15.rate;
  else if (rate60) blendedRate = rate60.rate;

  const eta15    = rate15      ? computeETA(u5h, rate15.rate) : null;
  const eta60    = rate60      ? computeETA(u5h, rate60.rate) : null;
  const etaBlend = blendedRate !== null ? computeETA(u5h, blendedRate) : null;
  const etaToLimit5h = chooseDisplayETA(eta15, etaBlend, eta60);

  const ideal5h  = idealRate(5);
  const dynamicIdealRate = dynamicTargetRate(u5h, minutesToReset5h);
  const paceReferenceRate = dynamicIdealRate ?? ideal5h;
  let rpmBlend = blendedRate !== null && paceReferenceRate !== null
    ? computeRPM(blendedRate, paceReferenceRate)
    : null;
  // When the 5h window is already exhausted, a near-zero live burn rate should
  // not render as "0 pace" in UI.
  if (u5h !== null && u5h >= 99.5 && (rpmBlend === null || rpmBlend < 1)) {
    rpmBlend = 100;
  }
  const trend    = computeTrend(rate15?.rate ?? null, rate60?.rate ?? null);

  let status = 'green', statusReason = 'Pace saudável', operationalMsg = 'ritmo sustentável';

  if (u5h !== null && u5h >= 100) {
    status = 'red'; statusReason = 'Janela de 5h esgotada';
  } else if (etaToLimit5h !== null && etaToLimit5h !== Infinity && minutesToReset5h !== null && etaToLimit5h < minutesToReset5h) {
    status = 'red'; statusReason = `Ritmo atual esgota em ${Math.round(etaToLimit5h)}min`;
  } else if (u5h !== null && u5h >= 95) {
    status = 'red'; statusReason = 'Janela de 5h quase no limite';
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

  const uiState = resolveUiState({
    provider: 'claude',
    hasMonthlyQuota: false,
    monthlyExhausted: false,
    monthlyCreditsRemaining: null,
    window5hExhausted: u5h !== null && u5h >= 100,
    hasPaceData: rpmBlend !== null,
    recentUsagePct: rpmBlend
  });
  const lockOverlay = buildLockOverlay('claude', uiState, {
    minutesToReset5h,
    minutesToReset7d,
    reset7dAt: latest.reset7d
  });
  const sparkline = buildSparkline(snapshots, 'u5h', 120, 64, 18, 24);
  if (uiState === 'loading') {
    operationalMsg = '...';
  } else if (uiState === 'idle') {
    operationalMsg = '0% · tranquilo';
  }

  return {
    ready: true, provider: 'claude', latest,
    minutesToReset5h, minutesToReset7d,
    rate15: rate15?.rate ?? null, rate60: rate60?.rate ?? null,
    rate7d: rate7d_360?.rate ?? null, weightedRate: weightedRate?.rate ?? null, blendedRate, eta15, eta60, etaBlend, etaToLimit5h,
    ideal5h, dynamicIdealRate, paceReferenceRate, rpmBlend, trend, operationalMsg, status, statusReason,
    monthlyCreditsRemaining: null, uiState, lockOverlay, sparkline,
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
  const monthlyTotalRaw = Number.isFinite(latest.monthly_total) ? Math.max(0, latest.monthly_total) : null;
  const monthlyUsedRaw = Number.isFinite(latest.monthly_used) ? Math.max(0, latest.monthly_used) : null;
  const hasMonthlyQuota = monthlyTotalRaw !== null && monthlyUsedRaw !== null;
  const monthlyTotal = hasMonthlyQuota ? monthlyTotalRaw : null;
  const monthlyUsed = hasMonthlyQuota ? monthlyUsedRaw : null;
  const monthlyRemaining = hasMonthlyQuota ? Math.max(0, monthlyTotal - monthlyUsed) : null;
  const monthlyPct = hasMonthlyQuota && monthlyTotal > 0 ? (monthlyUsed / monthlyTotal) * 100 : null;
  const monthlyExhausted = hasMonthlyQuota && monthlyRemaining <= 0;

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
    hasDailyQuota: dailyTotal > 0,
    dailyCreditsRemaining: dailyRemaining,
    hasMonthlyQuota,
    monthlyExhausted,
    monthlyCreditsRemaining: monthlyRemaining,
    window5hExhausted: false,
    hasPaceData: todayPace !== null,
    recentUsagePct: todayPace
  });
  const lockOverlay = buildLockOverlay('lovable', uiState, {
    minutesToDailyReset,
    minutesToMonthlyReset,
    monthlyResetAt: latest.monthly_reset_at
  });
  let operationalMsg = '';
  if (uiState === 'loading') {
    operationalMsg = '...';
  } else if (uiState === 'idle') {
    operationalMsg = '0% · tranquilo';
  } else {
    if (minutesToDailyReset !== null) {
      operationalMsg = `reset diário ${formatHoursToReset(minutesToDailyReset)}`;
    }
    if (monthlyBurn !== null && monthlyBurnStatus !== 'green') {
      operationalMsg += operationalMsg ? ' · ' : '';
      operationalMsg += monthlyBurnStatus === 'red' ? 'ciclo em risco' : 'burn elevado';
    }
  }

  return {
    ready: true, provider: 'lovable',
    latest, wsName: latest.ws_name || 'workspace',

    dailyUsed, dailyTotal, dailyRemaining, dailyPct,
    minutesToDailyReset, todayPace, todayPaceStatus, todayTrend, etaDailyExhaust,

    monthlyUsed, monthlyTotal, monthlyRemaining, monthlyPct,
    minutesToMonthlyReset, monthlyBurn, monthlyBurnStatus, monthlyProjectedDays,

    cloudPct, cloudStatus, cloudUsed: latest.cloud_used ?? null, cloudTotal: latest.cloud_total ?? null,
    aiPct,    aiStatus,    aiUsed:    latest.ai_used    ?? null, aiTotal:    latest.ai_total    ?? null,

    overallStatus, uiState, lockOverlay, operationalMsg, snapshotCount: snapshots.length, firstSnapshotAt: snapshots[0].t
  };
}

// -------- Formatters --------

function formatMinutesOnly(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes === Infinity) return 'sem queima';

  const totalMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  if (hours <= 0) return `${mins}m`;
  return `${hours}h${String(mins).padStart(2, '0')}m`;
}

export function formatETA(minutes) {
  return formatMinutesOnly(minutes);
}

export function formatMinutes(minutes) { return formatMinutesOnly(minutes); }
