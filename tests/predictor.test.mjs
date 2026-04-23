import test from 'node:test';
import assert from 'node:assert/strict';

import { computeRate, analyze, analyzeLovable, resolveUiState } from '../lib/predictor.js';

test('computeRate returns null when values are not finite', () => {
  const now = Date.now();
  const snaps = [
    { t: now - 60 * 60 * 1000, u5h: null },
    { t: now, u5h: 20 }
  ];
  assert.equal(computeRate(snaps, 'u5h', 60), null);
});

test('computeRate calculates positive rates', () => {
  const now = Date.now();
  const snaps = [
    { t: now - 60 * 1000, u5h: 10 },
    { t: now, u5h: 20 }
  ];
  const rate = computeRate(snaps, 'u5h', 60);
  assert.ok(rate);
  assert.ok(rate.rate > 0);
});

test('analyze handles finite utilization and produces ready state', () => {
  const now = Date.now();
  const snaps = [
    {
      t: now - 60 * 60 * 1000,
      u5h: 20,
      u7d: 10,
      reset5h: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
      reset7d: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    },
    {
      t: now,
      u5h: 35,
      u7d: 14,
      reset5h: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
      reset7d: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const result = analyze(snaps);
  assert.equal(result.ready, true);
  assert.equal(result.provider, 'claude');
  assert.ok(Number.isFinite(result.rate60));
});

test('analyze exposes loading uiState message for mini-badge', () => {
  const now = Date.now();
  const snaps = [
    {
      t: now,
      u5h: 10,
      u7d: 13,
      reset5h: new Date(now + 4 * 60 * 60 * 1000).toISOString(),
      reset7d: new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString()
    }
  ];

  const result = analyze(snaps);
  assert.equal(result.ready, true);
  assert.equal(result.uiState, 'loading');
  assert.equal(result.operationalMsg, '...');
});

test('analyze maps idle uiState to neutral mini-badge copy', () => {
  const now = Date.now();
  const reset5h = new Date(now + 4 * 60 * 60 * 1000).toISOString();
  const reset7d = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
  const snaps = [
    { t: now - 60 * 60 * 1000, u5h: 0.0, u7d: 12.8, reset5h, reset7d },
    { t: now, u5h: 0.3, u7d: 13.0, reset5h, reset7d }
  ];

  const result = analyze(snaps);
  assert.equal(result.ready, true);
  assert.equal(result.uiState, 'idle');
  assert.equal(result.operationalMsg, '0% · tranquilo');
});

test('analyze does not report zero pace when 5h window is exhausted', () => {
  const now = Date.now();
  const reset5h = new Date(now + 2 * 60 * 60 * 1000).toISOString();
  const reset7d = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
  const snaps = [
    { t: now - 60 * 60 * 1000, u5h: 100, u7d: 10, reset5h, reset7d },
    { t: now, u5h: 100, u7d: 11, reset5h, reset7d }
  ];

  const result = analyze(snaps);
  assert.equal(result.ready, true);
  assert.equal(result.status, 'red');
  assert.equal(result.rpmBlend, 100);
  assert.equal(result.eta15, 0);
  assert.equal(result.lockOverlay.active, true);
  assert.equal(result.lockOverlay.kind, 'window');
  assert.equal(result.lockOverlay.icon, '⏳');
  assert.ok(result.lockOverlay.detail.includes('h') || result.lockOverlay.detail.includes('min'));
});

test('analyze ignores stale monthly_exhausted flag when extra utilization is low', () => {
  const now = Date.now();
  const reset5h = new Date(now + 2 * 60 * 60 * 1000).toISOString();
  const reset7d = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
  const snaps = [
    {
      t: now - 60 * 60 * 1000,
      u5h: 8,
      u7d: 1,
      reset5h,
      reset7d,
      extra_util: 1,
      monthly_exhausted: true
    },
    {
      t: now,
      u5h: 10,
      u7d: 1.5,
      reset5h,
      reset7d,
      extra_util: 1,
      monthly_exhausted: true
    }
  ];

  const result = analyze(snaps);
  assert.equal(result.ready, true);
  assert.notEqual(result.uiState, 'locked_monthly');
  assert.equal(result.lockOverlay.active, false);
});

test('analyze does not lock monthly when extra limit is zero', () => {
  const now = Date.now();
  const reset5h = new Date(now + 2 * 60 * 60 * 1000).toISOString();
  const reset7d = new Date(now + 6 * 24 * 60 * 60 * 1000).toISOString();
  const snaps = [
    {
      t: now - 60 * 1000,
      u5h: 40,
      u7d: 12,
      reset5h,
      reset7d,
      extra_used: 0,
      extra_limit: 0,
      extra_util: null,
      monthly_exhausted: false
    },
    {
      t: now,
      u5h: 42,
      u7d: 13,
      reset5h,
      reset7d,
      extra_used: 0,
      extra_limit: 0,
      extra_util: null,
      monthly_exhausted: false
    }
  ];

  const result = analyze(snaps);
  assert.equal(result.ready, true);
  assert.notEqual(result.uiState, 'locked_monthly');
  assert.equal(result.lockOverlay.active, false);
});

test('analyzeLovable exposes monthly lock overlay when cycle is exhausted', () => {
  const now = Date.now();
  const snaps = [
    {
      t: now - 60 * 60 * 1000,
      daily_used: 1,
      daily_total: 5,
      daily_reset_at: new Date(now + 10 * 60 * 60 * 1000).toISOString(),
      monthly_used: 100,
      monthly_total: 100,
      monthly_reset_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      cloud_used: 1,
      cloud_total: 10,
      ai_used: 1,
      ai_total: 10,
      ws_name: 'ws',
      ws_id: 'ws1'
    },
    {
      t: now,
      daily_used: 2,
      daily_total: 5,
      daily_reset_at: new Date(now + 10 * 60 * 60 * 1000).toISOString(),
      monthly_used: 100,
      monthly_total: 100,
      monthly_reset_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      cloud_used: 2,
      cloud_total: 10,
      ai_used: 2,
      ai_total: 10,
      ws_name: 'ws',
      ws_id: 'ws1'
    }
  ];

  const result = analyzeLovable(snaps);
  assert.equal(result.ready, true);
  assert.equal(result.uiState, 'locked_monthly');
  assert.equal(result.lockOverlay.active, true);
  assert.equal(result.lockOverlay.kind, 'monthly');
  assert.equal(result.lockOverlay.icon, '🔒');
  assert.ok(result.lockOverlay.detail.includes('/'));
});

test('analyzeLovable exposes loading message for mini-badge', () => {
  const now = Date.now();
  const snaps = [
    {
      t: now,
      daily_used: 1,
      daily_total: 5,
      daily_reset_at: new Date(now + 10 * 60 * 60 * 1000).toISOString(),
      monthly_used: 10,
      monthly_total: 100,
      monthly_reset_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      cloud_used: 1,
      cloud_total: 10,
      ai_used: 1,
      ai_total: 10,
      ws_name: 'ws',
      ws_id: 'ws1'
    }
  ];

  const result = analyzeLovable(snaps);
  assert.equal(result.ready, true);
  assert.equal(result.uiState, 'loading');
  assert.equal(result.operationalMsg, '...');
});

test('analyzeLovable maps idle uiState to neutral mini-badge copy', () => {
  const now = Date.now();
  const dailyResetAt = new Date(now + 10 * 60 * 60 * 1000).toISOString();
  const monthlyResetAt = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
  const snaps = [
    {
      t: now - 6 * 60 * 60 * 1000,
      daily_used: 1.0,
      daily_total: 5,
      daily_reset_at: dailyResetAt,
      monthly_used: 10,
      monthly_total: 100,
      monthly_reset_at: monthlyResetAt,
      cloud_used: 1,
      cloud_total: 10,
      ai_used: 1,
      ai_total: 10,
      ws_name: 'ws',
      ws_id: 'ws1'
    },
    {
      t: now,
      daily_used: 1.01,
      daily_total: 5,
      daily_reset_at: dailyResetAt,
      monthly_used: 10.1,
      monthly_total: 100,
      monthly_reset_at: monthlyResetAt,
      cloud_used: 1.5,
      cloud_total: 10,
      ai_used: 1.5,
      ai_total: 10,
      ws_name: 'ws',
      ws_id: 'ws1'
    }
  ];

  const result = analyzeLovable(snaps);
  assert.equal(result.ready, true);
  assert.equal(result.uiState, 'idle');
  assert.equal(result.operationalMsg, '0% · tranquilo');
});

test('resolveUiState returns locked_monthly when monthly credits are exhausted', () => {
  const uiState = resolveUiState({
    monthlyCreditsRemaining: 0,
    window5hExhausted: false,
    hasPaceData: true,
    recentUsagePct: 50
  });
  assert.equal(uiState, 'locked_monthly');
});

test('resolveUiState returns locked_5h when 5h window is exhausted', () => {
  const uiState = resolveUiState({
    monthlyCreditsRemaining: 10,
    window5hExhausted: true,
    hasPaceData: true,
    recentUsagePct: 50
  });
  assert.equal(uiState, 'locked_5h');
});

test('resolveUiState returns loading when pace data is unavailable', () => {
  const uiState = resolveUiState({
    monthlyCreditsRemaining: 10,
    window5hExhausted: false,
    hasPaceData: false,
    recentUsagePct: null
  });
  assert.equal(uiState, 'loading');
});

test('resolveUiState classifies idle pace', () => {
  const uiState = resolveUiState({
    monthlyCreditsRemaining: 10,
    window5hExhausted: false,
    hasPaceData: true,
    recentUsagePct: 1.5
  });
  assert.equal(uiState, 'idle');
});

test('resolveUiState classifies healthy pace', () => {
  const uiState = resolveUiState({
    monthlyCreditsRemaining: 10,
    window5hExhausted: false,
    hasPaceData: true,
    recentUsagePct: 20
  });
  assert.equal(uiState, 'healthy');
});

test('resolveUiState classifies attention pace', () => {
  const uiState = resolveUiState({
    monthlyCreditsRemaining: 10,
    window5hExhausted: false,
    hasPaceData: true,
    recentUsagePct: 60
  });
  assert.equal(uiState, 'attention');
});

test('resolveUiState classifies critical pace', () => {
  const uiState = resolveUiState({
    monthlyCreditsRemaining: 10,
    window5hExhausted: false,
    hasPaceData: true,
    recentUsagePct: 90
  });
  assert.equal(uiState, 'critical');
});
