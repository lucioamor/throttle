import test from 'node:test';
import assert from 'node:assert/strict';

import { areSnapshotsEquivalent } from '../lib/storage.js';

test('areSnapshotsEquivalent ignores timestamp', () => {
  const a = { t: 1, u5h: 20, u7d: 10 };
  const b = { t: 2, u5h: 20, u7d: 10 };
  assert.equal(areSnapshotsEquivalent(a, b), true);
});

test('areSnapshotsEquivalent detects payload differences', () => {
  const a = { t: 1, u5h: 20, u7d: 10 };
  const b = { t: 1, u5h: 25, u7d: 10 };
  assert.equal(areSnapshotsEquivalent(a, b), false);
});
