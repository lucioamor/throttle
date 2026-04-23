import test from 'node:test';
import assert from 'node:assert/strict';

import { computeRate, analyze } from '../lib/predictor.js';

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
});
