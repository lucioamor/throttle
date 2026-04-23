import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidClaudeOrgId,
  normalizeClaudeOrgId,
  providerIdFromOrgId,
  orgIdFromProviderId,
  normalizeClaudeSnapshot,
  normalizeClaudeAppStartMetadata,
  buildClaudeAccountLabel
} from '../lib/providers/claude.js';
import {
  isValidLovableWorkspaceId,
  providerIdFromWorkspaceId,
  workspaceIdFromProviderId,
  normalizeLovableSnapshot
} from '../lib/providers/lovable.js';

test('Claude provider id helpers validate and map values', () => {
  const orgId = '123e4567-e89b-12d3-a456-426614174000';
  assert.equal(isValidClaudeOrgId(orgId), true);
  assert.equal(providerIdFromOrgId(orgId), `claude:${orgId}`);
  assert.equal(orgIdFromProviderId(`claude:${orgId}`), orgId);
  assert.equal(providerIdFromOrgId('bad id'), null);
  assert.equal(normalizeClaudeOrgId('123E4567-E89B-12D3-A456-426614174000'), orgId);
  assert.equal(providerIdFromOrgId('123E4567-E89B-12D3-A456-426614174000'), `claude:${orgId}`);
});

test('normalizeClaudeSnapshot sanitizes values', () => {
  const snap = normalizeClaudeSnapshot({
    five_hour: { utilization: 120.5, resets_at: '2026-04-22T20:00:00Z' },
    seven_day: { utilization: -5, resets_at: 'not-a-date' },
    extra_usage: { used_credits: '10', monthly_limit: 20, utilization: 200, currency: 'BRL' }
  }, 10);

  assert.equal(snap.t, 10);
  assert.equal(snap.u5h, 100);
  assert.equal(snap.u7d, 0);
  assert.equal(snap.reset5h, '2026-04-22T20:00:00.000Z');
  assert.equal(snap.reset7d, null);
  assert.equal(snap.extra_used, 10);
  assert.equal(snap.extra_limit, 20);
  assert.equal(snap.extra_util, 100);
  assert.equal(snap.monthly_exhausted, false);
});

test('normalizeClaudeSnapshot marks monthly_exhausted from used vs limit', () => {
  const snap = normalizeClaudeSnapshot({
    five_hour: { utilization: 0, resets_at: '2026-04-22T20:00:00Z' },
    seven_day: { utilization: 0, resets_at: '2026-04-30T20:00:00Z' },
    extra_usage: { used_credits: 25, monthly_limit: 25, utilization: 99 }
  }, 11);

  assert.equal(snap.monthly_exhausted, true);
});

test('normalizeClaudeSnapshot does not treat utilization=1 as exhausted without corroborating amounts', () => {
  const snap = normalizeClaudeSnapshot({
    five_hour: { utilization: 10, resets_at: '2026-04-22T20:00:00Z' },
    seven_day: { utilization: 5, resets_at: '2026-04-30T20:00:00Z' },
    extra_usage: { utilization: 1 }
  }, 12);

  assert.equal(snap.extra_util, 1);
  assert.equal(snap.monthly_exhausted, false);
});

test('normalizeClaudeAppStartMetadata keeps safe account/org metadata', () => {
  const metadata = normalizeClaudeAppStartMetadata({
    accountName: 'Test User',
    accountEmail: 'user@example.com',
    primaryOrgId: '00000000-0000-4000-8000-000000000002',
    organizations: [
      { orgId: '00000000-0000-4000-8000-000000000002', orgName: "Test Organization" },
      { orgId: '00000000-0000-4000-8000-000000000002', orgName: null },
      { orgId: '00000000-0000-4000-8000-000000000001', orgName: 'Individual Org' }
    ]
  });

  assert.ok(metadata);
  assert.equal(metadata.accountName, 'Test User');
  assert.equal(metadata.accountEmail, 'user@example.com');
  assert.equal(metadata.primaryOrgId, '00000000-0000-4000-8000-000000000002');
  assert.equal(metadata.organizations.length, 2);
});

test('buildClaudeAccountLabel prioritizes name and email', () => {
  assert.equal(buildClaudeAccountLabel({
    accountName: 'Test User',
    accountEmail: 'user@example.com',
    organizationName: 'Org'
  }), 'Lucio <user@example.com>');

  assert.equal(buildClaudeAccountLabel({
    accountName: null,
    accountEmail: 'user@example.com',
    organizationName: 'Org'
  }), 'user@example.com');
});

test('Lovable provider id helpers validate and map values', () => {
  const wsId = 'ws_alpha-123';
  assert.equal(isValidLovableWorkspaceId(wsId), true);
  assert.equal(providerIdFromWorkspaceId(wsId), `lovable:${wsId}`);
  assert.equal(workspaceIdFromProviderId(`lovable:${wsId}`), wsId);
  assert.equal(providerIdFromWorkspaceId(''), null);
});

test('normalizeLovableSnapshot resolves workspace fallback', () => {
  const snap = normalizeLovableSnapshot({
    ws_name: 'Workspace',
    daily_used: '2',
    daily_total: '5',
    daily_reset_at: '2026-04-23T00:00:00Z'
  }, 'lovable:ws_fallback', 15);

  assert.equal(snap.t, 15);
  assert.equal(snap.ws_id, 'ws_fallback');
  assert.equal(snap.daily_used, 2);
  assert.equal(snap.daily_total, 5);
  assert.equal(snap.daily_reset_at, '2026-04-23T00:00:00.000Z');
});
