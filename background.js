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
  normalizeLovableSnapshot
} from './lib/providers/lovable.js';

const ALARM_NAME = 'throttle-fallback-poll';
const STALE_MS = 4 * 60 * 60 * 1000;
const KNOWN_PROVIDERS = new Set(['claude', 'lovable']);

// -------- Lifecycle --------

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await setupAlarm(s.activePollSeconds);
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  await setupAlarm(s.activePollSeconds);
});

async function setupAlarm(intervalSec) {
  const safeSeconds = Number.isFinite(intervalSec) ? intervalSec : 120;
  const minutes = Math.max(1, Math.round(safeSeconds / 60));
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes, delayInMinutes: 0.1 });
}

// -------- Alarm: fallback poll --------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const settings = await getSettings();

  const claudeId = await getActiveProviderId('claude');
  if (claudeId) {
    const snaps = await getSnapshots(claudeId);
    const lastAge = snaps.length ? Date.now() - snaps[snaps.length - 1].t : Infinity;
    if (lastAge > settings.activePollSeconds * 1000 * 0.9) {
      await pollClaude(claudeId, { origin: 'alarm' });
    }
    await checkStale(claudeId, snaps, 'Claude');
  }

  const lovableId = await getActiveProviderId('lovable');
  if (lovableId) {
    const snaps = await getSnapshots(lovableId);
    await checkStale(lovableId, snaps, 'Lovable');
  }
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
          const active = await getActiveProviderId('claude');
          if (!active) await setActiveProviderId('claude', providerId);
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
          const active = await getActiveProviderId('claude');
          if (!active) await setActiveProviderId('claude', providerId);
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
          await upsertAccount(providerId, {
            label: typeof safeMsg.wsName === 'string' && safeMsg.wsName.trim() ? safeMsg.wsName.trim() : `WS ${wsId.slice(0, 8)}`
          });
          const active = await getActiveProviderId('lovable');
          if (!active) await setActiveProviderId('lovable', providerId);
          await handleLovableUsage(providerId, safeMsg.data);
          sendResponse({ ok: true, accountId: providerId });
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

async function requestLovableRefresh(requestedAccountId) {
  const accountId = await resolveAccountId('lovable', requestedAccountId);
  if (!accountId) return { ok: false, reason: 'no_active_account' };

  broadcastToTabs('https://lovable.dev/*', { type: 'LOVABLE_FORCE_REFRESH', accountId });
  broadcastToTabs('https://*.lovable.dev/*', { type: 'LOVABLE_FORCE_REFRESH', accountId });

  return { ok: true, accountId, mode: 'passive_triggered' };
}

// -------- Handlers --------

async function handleClaudeUsage(providerId, data) {
  const snap = normalizeClaudeSnapshot(data);
  if (!snap) return;

  await pushSnapshot(providerId, snap);
  const snapshots = await getSnapshots(providerId);
  const analysis = analyze(snapshots);

  broadcastToTabs('https://claude.ai/*', {
    type: 'STATE_UPDATE',
    provider: 'claude',
    accountId: providerId,
    analysis
  });

  if (analysis.ready) await checkClaudeAlerts(providerId, snap, analysis);
}

async function handleLovableUsage(providerId, data) {
  const snap = normalizeLovableSnapshot(data, providerId);
  if (!snap) return;

  await pushSnapshot(providerId, snap);
  const snapshots = await getSnapshots(providerId);
  const analysis = analyzeLovable(snapshots);

  const payload = {
    type: 'STATE_UPDATE',
    provider: 'lovable',
    accountId: providerId,
    analysis
  };
  broadcastToTabs('https://lovable.dev/*', payload);
  broadcastToTabs('https://*.lovable.dev/*', payload);

  if (analysis.ready) await checkLovableAlerts(providerId, analysis);
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
