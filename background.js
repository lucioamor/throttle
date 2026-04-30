// background.js - Throttle v2

import {
  getAccount,
  getAccountsByProvider,
  upsertAccount,
  pushSnapshot,
  removeAccount,
  setActiveProviderId,
  getActiveProviderId,
  getSettings,
  getSnapshots,
  wasAlertFired,
  markAlertFired
} from './lib/storage.js';

import { analyze, analyzeLovable } from './lib/predictor.js';
import {
  isValidClaudeOrgId,
  providerIdFromOrgId,
  orgIdFromProviderId,
  normalizeClaudeSnapshot,
  normalizeClaudeAppStartMetadata,
  buildClaudeAccountLabel
} from './lib/providers/claude.js';
import {
  isValidLovableWorkspaceId,
  providerIdFromWorkspaceId,
  workspaceIdFromProviderId,
  normalizeLovableSnapshot,
  normalizeLovableApiPayload
} from './lib/providers/lovable.js';

const ALARM_NAME = 'throttle-fallback-poll';
const ACTION_ICON_ALARM_NAME = 'throttle-action-icon-refresh';
const STALE_MS = 4 * 60 * 60 * 1000;
const KNOWN_PROVIDERS = new Set(['claude', 'lovable']);
const ACTION_ICON_SIZES = [16, 32];
const ACTION_ICON_MAX_PACE = 200;
const ACTION_ICON_GLYPHS = Object.freeze({
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000']
});
const ACTION_ICON_BADGE_GLYPHS = Object.freeze({
  '0': ['1111', '1001', '1001', '1001', '1001', '1111'],
  '1': ['0110', '1110', '0110', '0110', '0110', '1111'],
  '2': ['1111', '0001', '1111', '1000', '1000', '1111'],
  '3': ['1111', '0001', '1111', '0001', '0001', '1111'],
  '4': ['1001', '1001', '1111', '0001', '0001', '0001'],
  '5': ['1111', '1000', '1111', '0001', '0001', '1111'],
  '6': ['1111', '1000', '1111', '1001', '1001', '1111'],
  '7': ['1111', '0001', '0010', '0010', '0100', '0100'],
  '8': ['1111', '1001', '1111', '1001', '1001', '1111'],
  '9': ['1111', '1001', '1001', '1111', '0001', '1111'],
  'm': ['0000', '0000', '1110', '1111', '1011', '1011']
});
let lastActionIconKey = '';
let lastLovableAuthToken = null;
let lastLovableTokenPollAt = 0;
const LOVABLE_TOKEN_POLL_COOLDOWN_MS = 60 * 1000;

function isClaude5hLockedModel(model) {
  return model?.provider === 'claude'
    && (model?.uiState === 'locked_5h' || model?.lockedKind === 'window');
}

function isClaude5hLockedAnalysis(analysis) {
  return analysis?.provider === 'claude'
    && (analysis?.uiState === 'locked_5h' || analysis?.lockOverlay?.kind === 'window');
}

function formatToolbarMinutes(minutes) {
  if (!Number.isFinite(minutes)) return '';
  const clamped = Math.max(1, Math.min(300 * 60, Math.ceil(minutes)));
  if (clamped >= 60) return `${Math.floor(clamped / 60)}h`;
  return `${clamped}m`;
}

function formatResetCountdown(minutes) {
  if (!Number.isFinite(minutes)) return '—';
  const totalMinutes = Math.max(0, Math.ceil(minutes));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours <= 0) return `${mins}m`;
  return `${hours}h${String(mins).padStart(2, '0')}m`;
}

// -------- Lifecycle --------

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await setupAlarm(s.activePollSeconds);
  await setupActionIconAlarm();
  await refreshActionIcon();
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  await setupAlarm(s.activePollSeconds);
  await setupActionIconAlarm();
  await refreshActionIcon();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.active_claude && !changes.active_lovable) return;
  refreshActionIcon().catch(() => {});
});

void refreshActionIcon();

async function setupAlarm(intervalSec) {
  const safeSeconds = Number.isFinite(intervalSec) ? intervalSec : 120;
  const minutes = Math.max(1, Math.round(safeSeconds / 60));
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: 0.1 });
}

async function setupActionIconAlarm() {
  await chrome.alarms.clear(ACTION_ICON_ALARM_NAME);
  await chrome.alarms.create(ACTION_ICON_ALARM_NAME, { periodInMinutes: 1, delayInMinutes: 1 });
}

// -------- Alarm: fallback poll --------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ACTION_ICON_ALARM_NAME) {
    await refreshActionIcon();
    return;
  }

  if (alarm.name !== ALARM_NAME) return;

  const settings = await getSettings();
  let polled = false;

  const claudeId = await getActiveProviderId('claude');
  if (claudeId) {
    const snaps = await getSnapshots(claudeId);
    const lastAge = snaps.length ? Date.now() - snaps[snaps.length - 1].t : Infinity;
    if (lastAge > settings.activePollSeconds * 1000 * 0.9) {
      await pollClaude(claudeId, { origin: 'alarm' });
      polled = true;
    }
    await checkStale(claudeId, snaps, 'Claude');
  }

  const lovableId = await getActiveProviderId('lovable');
  if (lovableId) {
    let snaps = await getSnapshots(lovableId);
    const lastAge = snaps.length ? Date.now() - snaps[snaps.length - 1].t : Infinity;
    if (lastAge > settings.activePollSeconds * 1000 * 0.9) {
      await pollLovable(lovableId, { origin: 'alarm' });
      snaps = await getSnapshots(lovableId);
      polled = true;
    }
    await checkStale(lovableId, snaps, 'Lovable');
  }

  // Only refresh icon directly when no poll ran; polls call updateActionIconFromAnalysis
  // internally via handleClaudeUsage/handleLovableUsage, so a second call here would
  // race against the in-flight icon render and could revert the hourglass to speedometer.
  if (!polled) await refreshActionIcon();
});

async function checkStale(providerId, snaps, providerLabel) {
  if (!snaps.length) return;
  const lastAge = Date.now() - snaps[snaps.length - 1].t;
  if (lastAge <= STALE_MS) return;

  const key = `stale:${providerId}`;
  if (await wasAlertFired(key, 6 * 60 * 60 * 1000)) return;
  await markAlertFired(key);
  notify(`Throttle - ${providerLabel} stale`, 'No telemetry in 4h+. Open the platform to refresh data.');
}

// -------- WebRequest: auto-discover Claude orgId --------

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const match = details.url.match(/\/api\/organizations\/([0-9a-f-]+)\//i);
    if (!match) return;

    const providerId = providerIdFromOrgId(match[1]);
    if (!providerId) return;

    await ensureClaudeAccountDiscovered(providerId);
    const active = await getActiveProviderId('claude');
    if (!active) await setActiveProviderId('claude', providerId);
  },
  { urls: ['https://claude.ai/api/organizations/*/*'] }
);

// -------- Runtime messages --------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const safeMsg = msg && typeof msg === 'object' ? msg : null;
      if (!safeMsg || typeof safeMsg.type !== 'string') {
        sendResponse({ ok: false, reason: 'invalid_message' });
        return;
      }

      switch (safeMsg.type) {
        case 'USAGE_INTERCEPTED': {
          const orgId = typeof safeMsg.orgId === 'string' ? safeMsg.orgId : '';
          if (!isValidClaudeOrgId(orgId) || !isObject(safeMsg.data)) {
            sendResponse({ ok: false, reason: 'invalid_usage_payload' });
            return;
          }

          const providerId = providerIdFromOrgId(orgId);
          await ensureClaudeAccountDiscovered(providerId);
          const promoteSender = await shouldPromoteSenderAsActive(sender);
          const active = await getActiveProviderId('claude');
          if (!active || promoteSender) await setActiveProviderId('claude', providerId);
          await handleClaudeUsage(providerId, safeMsg.data);
          sendResponse({ ok: true, accountId: providerId });
          return;
        }

        case 'ORG_SEEN': {
          const orgId = typeof safeMsg.orgId === 'string' ? safeMsg.orgId : '';
          const providerId = providerIdFromOrgId(orgId);
          if (!providerId) {
            sendResponse({ ok: false, reason: 'invalid_org_id' });
            return;
          }

          await ensureClaudeAccountDiscovered(providerId);
          const promoteSender = await shouldPromoteSenderAsActive(sender);
          const active = await getActiveProviderId('claude');
          if (!active || promoteSender) await setActiveProviderId('claude', providerId);
          sendResponse({ ok: true, accountId: providerId });
          return;
        }

        case 'CLAUDE_APP_START_METADATA': {
          const metadata = normalizeClaudeAppStartMetadata(safeMsg.data);
          if (!metadata) {
            sendResponse({ ok: false, reason: 'invalid_app_start_metadata' });
            return;
          }

          for (const org of metadata.organizations) {
            const providerId = providerIdFromOrgId(org.orgId);
            if (!providerId) continue;
            const existing = await getAccount(providerId);
            const isPrimary = org.orgId === metadata.primaryOrgId;
            // Do not create extra org entries just because they appear in memberships.
            // Only ensure the primary org or already-known orgs.
            if (!isPrimary && !existing) continue;

            const label = buildClaudeAccountLabel({
              accountName: metadata.accountName,
              accountEmail: metadata.accountEmail,
              organizationName: org.orgName
            }) || fallbackClaudeOrgLabel(providerId);

            await ensureClaudeAccountDiscovered(providerId);
            await maybeSetClaudeLabel(providerId, label);
          }

          const active = await getActiveProviderId('claude');
          if (!active && metadata.primaryOrgId) {
            const primaryProviderId = providerIdFromOrgId(metadata.primaryOrgId);
            if (primaryProviderId) await setActiveProviderId('claude', primaryProviderId);
          }

          const activeAfter = await getActiveProviderId('claude');
          await pruneStaleClaudeAccounts(metadata, activeAfter);

          sendResponse({ ok: true });
          return;
        }

        case 'LOVABLE_USAGE_INTERCEPTED': {
          const wsId = typeof safeMsg.wsId === 'string' ? safeMsg.wsId : '';
          if (!isValidLovableWorkspaceId(wsId) || !isObject(safeMsg.data)) {
            sendResponse({ ok: false, reason: 'invalid_lovable_payload' });
            return;
          }

          const providerId = providerIdFromWorkspaceId(wsId);
          await upsertLovableAccount(providerId, wsId, safeMsg.wsName);
          const promoteSender = await shouldPromoteSenderAsActive(sender);
          const active = await getActiveProviderId('lovable');
          if (!active || promoteSender) await setActiveProviderId('lovable', providerId);
          await handleLovableUsage(providerId, safeMsg.data);
          sendResponse({ ok: true, accountId: providerId });
          return;
        }

        case 'LOVABLE_API_DATA': {
          if (!isObject(safeMsg.data)) {
            sendResponse({ ok: false, reason: 'invalid_lovable_api_payload' });
            return;
          }
          const result = await handleLovableApiData(safeMsg.data, sender);
          sendResponse(result);
          return;
        }

        case 'LOVABLE_AUTH_TOKEN': {
          const result = await handleLovableAuthToken(safeMsg.authToken, safeMsg.url);
          sendResponse(result);
          return;
        }

        case 'FORCE_POLL': {
          const provider = normalizeProvider(safeMsg.provider || inferProviderFromAccountId(safeMsg.accountId));
          if (!provider) {
            sendResponse({ ok: false, reason: 'invalid_provider' });
            return;
          }

          if (provider === 'claude') {
            const accountId = await resolveAccountId('claude', safeMsg.accountId);
            if (!accountId) {
              sendResponse({ ok: false, reason: 'no_active_account' });
              return;
            }
            const result = await pollClaude(accountId, { origin: 'manual' });
            sendResponse({ ok: result.ok, accountId, reason: result.reason || null });
            return;
          }

          const result = await requestLovableRefresh(safeMsg.accountId);
          sendResponse(result);
          return;
        }

        case 'GET_STATE': {
          const provider = normalizeProvider(safeMsg.provider) || 'claude';
          const resolvedId = await resolveAccountId(provider, safeMsg.accountId);
          if (!resolvedId) {
            sendResponse({ ok: false, reason: 'no_active_account' });
            return;
          }

          const snapshots = await getSnapshots(resolvedId);
          const analysis = provider === 'lovable' ? analyzeLovable(snapshots) : analyze(snapshots);
          sendResponse({ ok: true, provider, accountId: resolvedId, analysis });
          return;
        }

        case 'SETTINGS_UPDATED': {
          const s = await getSettings();
          await setupAlarm(s.activePollSeconds);
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, reason: 'unknown_message_type' });
      }
    } catch (err) {
      console.error('[Throttle] handler:', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true;
});

function normalizeProvider(provider) {
  if (typeof provider !== 'string') return null;
  return KNOWN_PROVIDERS.has(provider) ? provider : null;
}

function inferProviderFromAccountId(accountId) {
  if (typeof accountId !== 'string') return null;
  if (accountId.startsWith('claude:')) return 'claude';
  if (accountId.startsWith('lovable:')) return 'lovable';
  return null;
}

async function resolveAccountId(provider, requestedAccountId) {
  if (typeof requestedAccountId === 'string' && requestedAccountId.startsWith(`${provider}:`)) return requestedAccountId;
  return getActiveProviderId(provider);
}

async function upsertLovableAccount(providerId, wsId, wsName) {
  const cleanName = typeof wsName === 'string' && wsName.trim()
    ? wsName.trim()
    : null;
  const existing = await getAccount(providerId);
  const meta = {};

  if (cleanName) {
    if (existing?.label === cleanName) return existing;
    meta.label = cleanName;
  } else if (!existing) {
    meta.label = `WS ${wsId.slice(0, 8)}`;
  } else {
    return existing;
  }

  return upsertAccount(providerId, meta);
}

async function ensureClaudeAccountDiscovered(providerId) {
  const existing = await getAccount(providerId);
  if (existing) return existing;
  await upsertAccount(providerId, { label: fallbackClaudeOrgLabel(providerId) });
  return getAccount(providerId);
}

function fallbackClaudeOrgLabel(providerId) {
  const orgId = orgIdFromProviderId(providerId);
  if (!orgId) return 'Claude Org';
  return `Org ${orgId.slice(0, 8)}`;
}

function isGenericClaudeLabel(label) {
  return typeof label === 'string' && /^Org [0-9a-f]{8}$/i.test(label.trim());
}

async function maybeSetClaudeLabel(providerId, nextLabel) {
  if (!nextLabel) return;
  const account = await getAccount(providerId);
  if (!account) {
    await upsertAccount(providerId, { label: nextLabel });
    return;
  }
  if (!account.label || isGenericClaudeLabel(account.label)) {
    await upsertAccount(providerId, { label: nextLabel });
  }
}

async function pruneStaleClaudeAccounts(metadata, activeProviderId) {
  const orgsInMetadata = new Set(metadata.organizations.map((org) => org.orgId));
  const accounts = await getAccountsByProvider('claude');

  for (const [providerId, account] of Object.entries(accounts)) {
    if (providerId === activeProviderId) continue;

    const orgId = orgIdFromProviderId(providerId);
    if (!orgId) continue;
    if (orgsInMetadata.has(orgId)) continue;

    const snapshots = Array.isArray(account?.snapshots) ? account.snapshots : [];
    const hasSnapshots = snapshots.length > 0;
    // Only auto-remove clearly stale placeholders.
    if (hasSnapshots) continue;
    if (!isGenericClaudeLabel(account?.label || '')) continue;

    await removeAccount(providerId);
  }
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function shouldPromoteSenderAsActive(sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return false;
  if (sender?.tab?.active === true) return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab?.active;
  } catch (_err) {
    return false;
  }
}

// -------- Claude poll --------

async function pollClaude(providerId, meta = {}) {
  const orgId = orgIdFromProviderId(providerId);
  if (!orgId) return { ok: false, reason: 'invalid_account_id' };

  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: '*/*',
        'content-type': 'application/json'
      }
    });

    if (res.status === 401 || res.status === 403) {
      const key = `auth:${providerId}`;
      if (!(await wasAlertFired(key, 6 * 60 * 60 * 1000))) {
        await markAlertFired(key);
        notify('Throttle - Claude auth required', 'Claude usage poll was denied. Reopen claude.ai and sign in.');
      }
      return { ok: false, reason: `auth_${res.status}` };
    }

    if (!res.ok) {
      return { ok: false, reason: `status_${res.status}` };
    }

    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, reason: 'invalid_json' };

    await handleClaudeUsage(providerId, data);
    return { ok: true };
  } catch (err) {
    console.warn('[Throttle] Claude poll failed:', err?.message || err);
    return { ok: false, reason: 'network_error', detail: String(err?.message || err), origin: meta.origin || 'unknown' };
  }
}

function normalizeAuthHeader(token) {
  if (!token || typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().startsWith('bearer ') ? trimmed : `Bearer ${trimmed}`;
}

async function getLovableAuthHeader() {
  if (lastLovableAuthToken) return normalizeAuthHeader(lastLovableAuthToken);
  const { lovableAuthToken = null } = await chrome.storage.local.get('lovableAuthToken');
  lastLovableAuthToken = typeof lovableAuthToken === 'string' ? lovableAuthToken : null;
  return normalizeAuthHeader(lastLovableAuthToken);
}

async function handleLovableAuthToken(authToken, url = null) {
  const header = normalizeAuthHeader(authToken);
  if (!header) return { ok: false, reason: 'invalid_lovable_auth_token' };

  const previous = lastLovableAuthToken;
  lastLovableAuthToken = header;
  await chrome.storage.local.set({ lovableAuthToken: header });

  const now = Date.now();
  const shouldPoll = header !== previous || (now - lastLovableTokenPollAt) > LOVABLE_TOKEN_POLL_COOLDOWN_MS;
  if (shouldPoll) {
    lastLovableTokenPollAt = now;
    pollLovable(null, { origin: 'auth_capture', url }).catch((err) => {
      console.warn('[Throttle] Lovable auth poll failed:', err?.message || err);
    });
  }

  return { ok: true };
}

async function handleLovableApiData(apiData, sender = null) {
  const payloads = normalizeLovableApiPayload(apiData);
  if (!payloads.length) return { ok: false, reason: 'no_lovable_usage_payloads' };

  const promoteSender = await shouldPromoteSenderAsActive(sender);
  const shouldPromotePayload = promoteSender && payloads.length === 1;
  const touched = [];

  for (const data of payloads) {
    const wsId = data.ws_id;
    if (!isValidLovableWorkspaceId(wsId)) continue;

    const providerId = providerIdFromWorkspaceId(wsId);
    await upsertLovableAccount(providerId, wsId, data.ws_name);

    const active = await getActiveProviderId('lovable');
    if (!active || shouldPromotePayload) await setActiveProviderId('lovable', providerId);

    const stored = await handleLovableUsage(providerId, data);
    if (stored) touched.push(providerId);
  }

  return touched.length
    ? { ok: true, accountIds: [...new Set(touched)] }
    : { ok: false, reason: 'no_lovable_snapshots_stored' };
}

async function pollLovable(requestedAccountId = null, meta = {}) {
  const authHeader = await getLovableAuthHeader();
  if (!authHeader) return { ok: false, reason: 'no_auth_token' };

  const requestedProviderId = requestedAccountId
    ? await resolveAccountId('lovable', requestedAccountId)
    : null;
  const requestedWsId = workspaceIdFromProviderId(requestedProviderId);

  try {
    const wsUrl = 'https://api.lovable.dev/user/workspaces';
    const wsRes = await fetch(wsUrl, {
      headers: { Authorization: authHeader, accept: 'application/json' }
    });

    if (wsRes.status === 401 || wsRes.status === 403) {
      lastLovableAuthToken = null;
      await chrome.storage.local.remove('lovableAuthToken');
      return { ok: false, reason: `auth_${wsRes.status}` };
    }

    if (!wsRes.ok) return { ok: false, reason: `status_${wsRes.status}` };

    const wsBody = await wsRes.json().catch(() => null);
    if (!wsBody) return { ok: false, reason: 'invalid_json' };

    const wsResult = await handleLovableApiData({ url: wsUrl, method: 'GET', body: wsBody });
    const accountIds = new Set(wsResult.accountIds || []);

    const usageTargets = requestedWsId
      ? [requestedWsId]
      : [...accountIds]
          .map((providerId) => workspaceIdFromProviderId(providerId))
          .filter(Boolean);

    for (const wsId of usageTargets) {
      const usageUrl = `https://api.lovable.dev/workspaces/${encodeURIComponent(wsId)}/lovable-cloud-monthly-usage`;
      try {
        const usageRes = await fetch(usageUrl, {
          headers: { Authorization: authHeader, accept: 'application/json' }
        });
        if (!usageRes.ok) continue;
        const usageBody = await usageRes.json().catch(() => null);
        if (!usageBody) continue;
        const usageResult = await handleLovableApiData({
          url: usageUrl,
          method: 'GET',
          workspaceId: wsId,
          body: usageBody
        });
        for (const accountId of usageResult.accountIds || []) accountIds.add(accountId);
      } catch (_err) {}
    }

    if (requestedProviderId && !accountIds.has(requestedProviderId)) {
      return { ok: false, reason: 'workspace_not_found', accountId: requestedProviderId, origin: meta.origin || null };
    }

    return { ok: accountIds.size > 0, accountIds: [...accountIds], origin: meta.origin || null };
  } catch (err) {
    console.warn('[Throttle] Lovable poll failed:', err?.message || err);
    return { ok: false, reason: 'network_error', detail: String(err?.message || err), origin: meta.origin || 'unknown' };
  }
}

async function requestLovableRefresh(requestedAccountId) {
  const accountId = await resolveAccountId('lovable', requestedAccountId);
  if (!accountId) return { ok: false, reason: 'no_active_account' };

  const pollResult = await pollLovable(accountId, { origin: 'manual' });
  if (pollResult.ok) return { ...pollResult, accountId, mode: 'active_poll' };

  broadcastToTabs('https://lovable.dev/*', { type: 'LOVABLE_FORCE_REFRESH', accountId });
  broadcastToTabs('https://*.lovable.dev/*', { type: 'LOVABLE_FORCE_REFRESH', accountId });

  return { ok: true, accountId, mode: 'passive_triggered', reason: pollResult.reason || null };
}

// -------- Handlers --------

async function handleClaudeUsage(providerId, data) {
  const snap = normalizeClaudeSnapshot(data);
  if (!snap) return;

  await pushSnapshot(providerId, snap);
  const snapshots = await getSnapshots(providerId);
  const analysis = analyze(snapshots);
  await updateActionIconFromAnalysis(analysis);

  broadcastToTabs('https://claude.ai/*', {
    type: 'STATE_UPDATE',
    provider: 'claude',
    accountId: providerId,
    analysis
  });

  if (analysis.ready) await checkClaudeAlerts(providerId, snap, analysis);
}

function mergeLovableUsageWithLatest(latest, data) {
  if (!latest || !data || typeof data !== 'object') return data;
  const fields = [
    'ws_id', 'ws_name',
    'daily_used', 'daily_total', 'daily_reset_at',
    'monthly_used', 'monthly_total', 'monthly_reset_at',
    'cloud_used', 'cloud_total',
    'ai_used', 'ai_total'
  ];
  const merged = { ...data };
  for (const field of fields) {
    if (merged[field] === null || merged[field] === undefined) {
      merged[field] = latest[field] ?? null;
    }
  }
  return merged;
}

async function handleLovableUsage(providerId, data) {
  const existingSnapshots = await getSnapshots(providerId);
  const latest = existingSnapshots[existingSnapshots.length - 1] || null;
  const snap = normalizeLovableSnapshot(mergeLovableUsageWithLatest(latest, data), providerId);
  if (!snap) return false;

  await pushSnapshot(providerId, snap);
  const snapshots = await getSnapshots(providerId);
  const analysis = analyzeLovable(snapshots);
  await updateActionIconFromAnalysis(analysis);

  const payload = {
    type: 'STATE_UPDATE',
    provider: 'lovable',
    accountId: providerId,
    analysis
  };
  broadcastToTabs('https://lovable.dev/*', payload);
  broadcastToTabs('https://*.lovable.dev/*', payload);

  if (analysis.ready) await checkLovableAlerts(providerId, analysis);
  return true;
}

// -------- Broadcast helper --------

function broadcastToTabs(urlPattern, message) {
  chrome.tabs.query({ url: urlPattern }, (tabs) => {
    for (const tab of tabs) {
      if (!tab?.id) continue;
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

// -------- Action icon (dynamic speedometer) --------

async function refreshActionIcon() {
  try {
    const [claudeId, lovableId] = await Promise.all([
      getActiveProviderId('claude'),
      getActiveProviderId('lovable')
    ]);

    const candidates = [];

    if (claudeId) {
      const claudeSnaps = await getSnapshots(claudeId);
      if (claudeSnaps.length) {
        const claudeAnalysis = analyze(claudeSnaps);
        if (claudeAnalysis?.ready) candidates.push(claudeAnalysis);
      } else {
        candidates.push({ ready: false, provider: 'claude' });
      }
    }

    if (lovableId) {
      const lovableSnaps = await getSnapshots(lovableId);
      if (lovableSnaps.length) {
        const lovableAnalysis = analyzeLovable(lovableSnaps);
        if (lovableAnalysis?.ready) candidates.push(lovableAnalysis);
      } else {
        candidates.push({ ready: false, provider: 'lovable' });
      }
    }

    if (!candidates.length) {
      await updateActionIconFromAnalysis(null);
      return;
    }

    const readyCandidates = candidates.filter((candidate) => candidate?.ready);
    if (!readyCandidates.length) {
      await updateActionIconFromAnalysis(candidates[0]);
      return;
    }

    const lockedClaude = readyCandidates.find(isClaude5hLockedAnalysis);
    if (lockedClaude) {
      await updateActionIconFromAnalysis(lockedClaude);
    } else {
      readyCandidates.sort((a, b) => {
        const aTs = Number.isFinite(a?.latest?.t) ? a.latest.t : 0;
        const bTs = Number.isFinite(b?.latest?.t) ? b.latest.t : 0;
        return bTs - aTs;
      });
      await updateActionIconFromAnalysis(readyCandidates[0]);
    }
  } catch (err) {
    console.warn('[Throttle] icon refresh failed:', err?.message || err);
    await setDefaultActionIcon();
  }
}

async function updateActionIconFromAnalysis(analysis) {
  if (typeof OffscreenCanvas === 'undefined') {
    await setDefaultActionIcon();
    return;
  }

  const model = buildActionIconModel(analysis);
  const key = actionIconModelKey(model);
  if (key === lastActionIconKey) {
    await updateActionBadgeFromModel(model);
    return;
  }

  const imageData = buildActionIconImageData(model);
  if (!imageData) {
    await setDefaultActionIcon();
    return;
  }

  await chrome.action.setIcon({ imageData });
  await updateActionBadgeFromModel(model);
  lastActionIconKey = key;
}

function buildActionIconModel(analysis) {
  const provider = analysis?.provider === 'lovable'
    ? 'lovable'
    : analysis?.provider === 'claude'
      ? 'claude'
      : 'unknown';

  if (!analysis || analysis.ready !== true) {
    return {
      provider,
      uiState: 'loading',
      pace: null,
      locked: false,
      lockedKind: null,
      minutesToReset5h: null
    };
  }

  const rawPace = provider === 'lovable' ? analysis.todayPace : analysis.rpmBlend;
  return {
    provider,
    uiState: typeof analysis.uiState === 'string' ? analysis.uiState : 'loading',
    pace: Number.isFinite(rawPace) ? rawPace : null,
    locked: !!analysis.lockOverlay?.active,
    lockedKind: analysis.lockOverlay?.kind || null,
    minutesToReset5h: Number.isFinite(analysis.minutesToReset5h) ? analysis.minutesToReset5h : null
  };
}

function actionIconModelKey(model) {
  const roundedPace = model.pace === null ? 'na' : String(Math.round(model.pace));
  const resetMinute = Number.isFinite(model.minutesToReset5h) ? Math.ceil(model.minutesToReset5h) : 'na';
  return `${model.provider}|${model.uiState}|${model.locked ? '1' : '0'}|${model.lockedKind || 'none'}|${roundedPace}|${resetMinute}`;
}

async function updateActionBadgeFromModel(model) {
  if (isClaude5hLockedModel(model)) {
    const badgeText = formatToolbarMinutes(model.minutesToReset5h);
    await chrome.action.setBadgeText({ text: badgeText });
    await chrome.action.setBadgeBackgroundColor({ color: [0, 0, 0, 127] });
    await chrome.action.setBadgeTextColor({ color: '#ef4444' });
    await chrome.action.setTitle({
      title: `Throttle - Claude 5h esgotada. Reset em ${formatResetCountdown(model.minutesToReset5h)}`
    });
    return;
  }

  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Throttle - Pace control for AI limits' });
}

function buildActionIconImageData(model) {
  const iconMap = {};
  for (const size of ACTION_ICON_SIZES) {
    const frame = renderSpeedometerIcon(size, model);
    if (!frame) return null;
    iconMap[size] = frame;
  }
  return iconMap;
}

function renderSpeedometerIcon(size, model) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, size, size);
  ctx.lineCap = 'round';

  const uiState = model.uiState || 'loading';
  const highRisk = isHighRiskIconState(uiState, model.locked);
  const locked5h = isClaude5hLockedModel(model);
  const paceLabel = formatActionIconLabel(model, uiState);
  if (locked5h) {
    const shift = Math.round(size * 0.125);
    ctx.save();
    ctx.translate(-shift, 0);
    const result = renderHourglassIcon(ctx, size);
    ctx.restore();
    return result;
  }

  // Split icon into two zones:
  // top => speedometer; bottom => numeric digits.
  // Shift 2px left to give clearance from the badge in the bottom-right corner.
  const shift = Math.round(size * 0.125); // ~2px at 16px, scales up
  const digitsBandHeight = Math.max(5, Math.round(size * 0.38));
  const digitsBandTop = size - digitsBandHeight;
  const gaugeBottom = digitsBandTop - 1;
  const cx = size / 2 - shift;
  const cy = gaugeBottom;
  const radius = Math.max(2.6, Math.min(size * 0.34, gaugeBottom - 1.6));
  const arcWidth = Math.max(1.1, size * 0.1);

  // Track — dark groove, more defined than before
  ctx.lineWidth = arcWidth;
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI, Math.PI * 2, false);
  ctx.stroke();

  // Inner shadow on track for depth
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = arcWidth * 0.45;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI, Math.PI * 2, false);
  ctx.stroke();

  const segmentAlpha = uiState === 'loading' ? 0.45 : 1.0;
  ctx.globalAlpha = segmentAlpha;
  drawIconArc(ctx, cx, cy, radius, 0, 66, '#60a5fa');
  drawIconArc(ctx, cx, cy, radius, 66, 100, '#4ade80');
  drawIconArc(ctx, cx, cy, radius, 100, 134, '#fbbf24');
  drawIconArc(ctx, cx, cy, radius, 134, 200, '#f87171');
  ctx.globalAlpha = 1;

  const drawPace = Number.isFinite(model.pace) && uiState !== 'loading' && uiState !== 'idle'
    ? clamp(model.pace, 0, ACTION_ICON_MAX_PACE)
    : 0;
  const angleDeg = -90 + (drawPace / ACTION_ICON_MAX_PACE) * 180;
  const angle = (angleDeg * Math.PI) / 180;
  const needleLen = Math.max(1, radius - arcWidth * 0.45);
  const x2 = cx + Math.sin(angle) * needleLen;
  const y2 = cy - Math.cos(angle) * needleLen;

  const needleColor = '#fbbf24';
  // Needle shadow for crispness on dark bg
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(1.8, size * 0.13);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = needleColor;
  ctx.lineWidth = Math.max(1.1, size * 0.09);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  // Pivot dot
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.4, size * 0.1), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = needleColor;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.0, size * 0.075), 0, Math.PI * 2);
  ctx.fill();

  // Separator — slightly more visible
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, digitsBandTop + 0.5);
  ctx.lineTo(size, digitsBandTop + 0.5);
  ctx.stroke();

  let labelColor = '#f1f5f9';
  if (uiState === 'loading') labelColor = 'rgba(203,213,225,0.7)';
  else if (highRisk) labelColor = '#fca5a5';
  else if (uiState === 'attention') labelColor = '#fde68a';

  drawActionIconDigits(ctx, {
    text: paceLabel,
    x: -shift,
    y: digitsBandTop,
    width: size,
    height: digitsBandHeight,
    color: labelColor
  });

  return ctx.getImageData(0, 0, size, size);
}

function renderHourglassIcon(ctx, size) {
  const scale = size / 16;
  const top = Math.max(1.5, size * 0.10);
  const bottom = size - top;
  const left = Math.max(2, size * 0.18);
  const right = size - left;
  const cx = size / 2;
  const midY = size / 2;
  const neckHalf = Math.max(1.5, size * 0.15);
  const stroke = Math.max(1.0, size * 0.075);
  const rimStroke = Math.max(0.7, size * 0.055);

  // Control point pull for the curved sides (quadratic bezier).
  // Positive = bulges outward away from center.
  const bulge = size * 0.18;

  function drawHourglassBody() {
    // Top bar
    ctx.moveTo(left, top);
    ctx.lineTo(right, top);
    // Bottom bar
    ctx.moveTo(left, bottom);
    ctx.lineTo(right, bottom);
    // Left side — upper bulge curving inward to neck
    ctx.moveTo(left + stroke * 0.25, top + stroke * 0.55);
    ctx.quadraticCurveTo(left - bulge, midY, cx - neckHalf, midY);
    // Left side — neck continuing down, curving out to bottom
    ctx.quadraticCurveTo(left - bulge, midY, left + stroke * 0.25, bottom - stroke * 0.55);
    // Right side — upper bulge curving inward to neck
    ctx.moveTo(right - stroke * 0.25, top + stroke * 0.55);
    ctx.quadraticCurveTo(right + bulge, midY, cx + neckHalf, midY);
    // Right side — neck continuing down, curving out to bottom
    ctx.quadraticCurveTo(right + bulge, midY, right - stroke * 0.25, bottom - stroke * 0.55);
  }

  // Shadow pass
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = rimStroke + Math.max(0.3, 0.4 * scale);
  ctx.beginPath();
  drawHourglassBody();
  ctx.stroke();

  // Glass body stroke — subtle, dim, seamless on dark bg
  ctx.strokeStyle = 'rgba(148,163,184,0.65)';
  ctx.lineWidth = rimStroke;
  ctx.globalAlpha = 1.0;
  ctx.beginPath();
  drawHourglassBody();
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Glass fill — upper bulb (curved trapezoid approximation with straight lines inside)
  const glass = ctx.createLinearGradient(0, top, 0, bottom);
  glass.addColorStop(0, 'rgba(96,165,250,0.46)');
  glass.addColorStop(0.5, 'rgba(219,234,254,0.16)');
  glass.addColorStop(1, 'rgba(96,165,250,0.42)');
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.moveTo(left + stroke * 0.85, top + stroke * 1.05);
  ctx.lineTo(right - stroke * 0.85, top + stroke * 1.05);
  ctx.lineTo(cx + neckHalf * 1.0, midY - stroke * 0.15);
  ctx.lineTo(cx - neckHalf * 1.0, midY - stroke * 0.15);
  ctx.closePath();
  ctx.fill();

  // Glass fill — lower bulb
  ctx.beginPath();
  ctx.moveTo(cx - neckHalf * 1.0, midY + stroke * 0.15);
  ctx.lineTo(cx + neckHalf * 1.0, midY + stroke * 0.15);
  ctx.lineTo(right - stroke * 0.85, bottom - stroke * 1.05);
  ctx.lineTo(left + stroke * 0.85, bottom - stroke * 1.05);
  ctx.closePath();
  ctx.fill();

  // Sand — upper half (draining)
  const sand = '#fbbf24';
  const sandDark = '#d97706';
  ctx.fillStyle = sand;
  ctx.beginPath();
  ctx.moveTo(left + stroke * 1.2, top + stroke * 1.45);
  ctx.lineTo(right - stroke * 1.2, top + stroke * 1.45);
  ctx.lineTo(cx + neckHalf * 0.85, midY - stroke * 0.45);
  ctx.lineTo(cx - neckHalf * 0.85, midY - stroke * 0.45);
  ctx.closePath();
  ctx.fill();

  // Sand — lower half (accumulating)
  ctx.fillStyle = sandDark;
  ctx.beginPath();
  ctx.moveTo(left + stroke * 1.25, bottom - stroke * 1.35);
  ctx.lineTo(right - stroke * 1.25, bottom - stroke * 1.35);
  ctx.lineTo(cx + neckHalf * 0.85, midY + stroke * 1.15);
  ctx.lineTo(cx - neckHalf * 0.85, midY + stroke * 1.15);
  ctx.closePath();
  ctx.fill();

  // Sand trickle through neck
  ctx.strokeStyle = sand;
  ctx.lineWidth = Math.max(0.8, size * 0.055);
  ctx.beginPath();
  ctx.moveTo(cx, midY - stroke * 0.15);
  ctx.lineTo(cx, midY + stroke * 0.9);
  ctx.stroke();

  // Highlight on upper-left glass edge
  ctx.strokeStyle = 'rgba(255,255,255,0.82)';
  ctx.lineWidth = Math.max(0.65, size * 0.04);
  ctx.beginPath();
  ctx.moveTo(left + stroke * 0.95, top + stroke * 1.2);
  ctx.quadraticCurveTo(left - bulge * 0.5, midY * 0.7, cx - neckHalf * 1.3, midY - stroke * 0.55);
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}


function drawIconArc(ctx, cx, cy, radius, fromPace, toPace, color) {
  const from = paceToTopArcRad(fromPace);
  const to = paceToTopArcRad(toPace);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, from, to, false);
  ctx.stroke();
}

function paceToTopArcRad(pace) {
  const clamped = clamp(pace, 0, ACTION_ICON_MAX_PACE);
  return Math.PI + (clamped / ACTION_ICON_MAX_PACE) * Math.PI;
}

function isHighRiskIconState(uiState, locked) {
  if (locked) return true;
  return uiState === 'critical' || uiState === 'locked_5h' || uiState === 'locked_monthly';
}

function formatActionIconLabel(model, uiState) {
  if (uiState === 'loading') return '--';
  if (!Number.isFinite(model?.pace)) return '0';
  return String(Math.round(clamp(model.pace, 0, 999)));
}

function drawActionIconDigits(ctx, opts) {
  const text = typeof opts?.text === 'string' && opts.text ? opts.text : '0';
  const color = opts?.color || '#f8fafc';
  const bounds = {
    x: Number.isFinite(opts?.x) ? opts.x : 0,
    y: Number.isFinite(opts?.y) ? opts.y : 0,
    width: Number.isFinite(opts?.width) ? opts.width : 16,
    height: Number.isFinite(opts?.height) ? opts.height : 6
  };

  const glyphs = [...text].map((ch) => ACTION_ICON_GLYPHS[ch] || ACTION_ICON_GLYPHS['-']);
  const maxGlyphHeight = glyphs.reduce((acc, g) => Math.max(acc, g.length), 5);
  const basePixel = Math.floor(bounds.height / maxGlyphHeight);
  const pixel = Math.max(1, basePixel);
  const glyphWidth = 3 * pixel;
  const glyphHeight = 5 * pixel;
  const gap = Math.max(1, Math.floor(pixel * 0.9));
  const totalWidth = glyphs.length * glyphWidth + Math.max(0, glyphs.length - 1) * gap;
  const startX = Math.round(bounds.x + (bounds.width - totalWidth) / 2);
  const startY = Math.round(bounds.y + (bounds.height - glyphHeight) / 2);

  for (let i = 0; i < glyphs.length; i++) {
    const glyph = glyphs[i];
    const gx = startX + i * (glyphWidth + gap);
    drawActionIconGlyph(ctx, glyph, gx, startY, pixel, color);
  }
}

function drawActionIconGlyph(ctx, glyph, x, y, pixel, color, includeBuiltInShadow = true) {
  if (!Array.isArray(glyph)) return;
  for (let row = 0; row < glyph.length; row++) {
    const rowBits = glyph[row];
    if (typeof rowBits !== 'string') continue;
    for (let col = 0; col < rowBits.length; col++) {
      if (rowBits[col] !== '1') continue;
      const px = x + col * pixel;
      const py = y + row * pixel;
      if (includeBuiltInShadow) {
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(px, py + 1, pixel, pixel);
      }
      ctx.fillStyle = color;
      ctx.fillRect(px, py, pixel, pixel);
    }
  }
}

async function setDefaultActionIcon() {
  await chrome.action.setIcon({
    path: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png'
    }
  });
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Throttle - Pace control for AI limits' });
  lastActionIconKey = 'default';
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

// -------- Alerts --------

async function checkClaudeAlerts(providerId, snap, analysis) {
  const s = await getSettings();

  if (snap.u5h !== null && snap.u5h >= s.alertThreshold5h) {
    const key = `${providerId}:5h:${Math.floor(snap.u5h / 5) * 5}`;
    if (!(await wasAlertFired(key, 30 * 60 * 1000))) {
      await markAlertFired(key);
      notify('Throttle - Claude 5h', `5h window at ${snap.u5h.toFixed(0)}%. Reset ${fmtMin(analysis.minutesToReset5h)}.`);
    }
  }

  if (snap.u7d !== null && snap.u7d >= s.alertThreshold7d) {
    const key = `${providerId}:7d:${Math.floor(snap.u7d / 5) * 5}`;
    if (!(await wasAlertFired(key, 6 * 60 * 60 * 1000))) {
      await markAlertFired(key);
      notify('Throttle - Claude 7d', `7d window at ${snap.u7d.toFixed(0)}%. Reset ${fmtMin(analysis.minutesToReset7d)}.`);
    }
  }

  if (s.alertOnRedline && analysis.rpmBlend !== null && analysis.rpmBlend > 130) {
    const key = `${providerId}:redline`;
    if (!(await wasAlertFired(key, 15 * 60 * 1000))) {
      await markAlertFired(key);
      notify('Throttle - Claude redline', `PACE ${Math.round(analysis.rpmBlend)}. ETA ${fmtMin(analysis.etaBlend)}.`);
    }
  }
}

async function checkLovableAlerts(providerId, analysis) {
  const s = await getSettings();

  if (analysis.todayPace !== null && analysis.todayPace > s.alertLovableDailyPace) {
    const key = `${providerId}:daily_redline`;
    if (!(await wasAlertFired(key, 15 * 60 * 1000))) {
      await markAlertFired(key);
      notify('Throttle - Lovable today', `TODAY PACE ${Math.round(analysis.todayPace)}. Daily credits may end before reset.`);
    }
  }

  if (analysis.monthlyPct !== null && analysis.monthlyPct >= s.alertLovableMonthlyBurn) {
    const key = `${providerId}:monthly:${Math.floor(analysis.monthlyPct / 5) * 5}`;
    if (!(await wasAlertFired(key, 6 * 60 * 60 * 1000))) {
      await markAlertFired(key);
      notify('Throttle - Lovable monthly', `${analysis.monthlyPct.toFixed(0)}% of monthly cycle used. Reset ${fmtMin(analysis.minutesToMonthlyReset)}.`);
    }
  }

  if (analysis.cloudStatus === 'red') {
    const key = `${providerId}:cloud_red`;
    if (!(await wasAlertFired(key, 6 * 60 * 60 * 1000))) {
      await markAlertFired(key);
      notify('Throttle - Lovable cloud', `Cloud at ${analysis.cloudPct?.toFixed(0) ?? '-'}% of monthly limit.`);
    }
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 1
  });
}

function fmtMin(min) {
  if (min === null || min === undefined || !Number.isFinite(min) || min < 0) return '-';
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}
