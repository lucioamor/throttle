// lib/storage.js — Throttle v2
// Namespacing: todas as chaves de conta usam "provider:id"
// ex: "claude:abc123", "lovable:ws-xyz"
// Não há activeOrgId global — contexto ativo é por aba no content script.

const SNAPSHOT_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS_PER_ACCOUNT = 15000;

export function areSnapshotsEquivalent(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('t');
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export async function getAllAccounts() {
  const { accounts = {} } = await chrome.storage.local.get('accounts');
  return accounts;
}

export async function getAccount(providerId) {
  const accounts = await getAllAccounts();
  return accounts[providerId] || null;
}

export async function removeAccount(providerId) {
  const accounts = await getAllAccounts();
  if (!accounts[providerId]) return false;
  delete accounts[providerId];
  await chrome.storage.local.set({ accounts });
  return true;
}

export async function upsertAccount(providerId, meta = {}) {
  const accounts = await getAllAccounts();
  if (!accounts[providerId]) {
    accounts[providerId] = {
      providerId,
      label: meta.label || providerId.slice(0, 24),
      plan: meta.plan || 'unknown',
      snapshots: [],
      createdAt: Date.now()
    };
  }
  if (meta.label) accounts[providerId].label = meta.label;
  if (meta.plan)  accounts[providerId].plan  = meta.plan;
  await chrome.storage.local.set({ accounts });
  return accounts[providerId];
}

export async function pushSnapshot(providerId, snap) {
  const accounts = await getAllAccounts();
  if (!accounts[providerId]) {
    await upsertAccount(providerId);
    return pushSnapshot(providerId, snap);
  }
  const arr = accounts[providerId].snapshots;
  const last = arr[arr.length - 1];
  const snapTs = typeof snap.t === 'number' && Number.isFinite(snap.t) ? snap.t : Date.now();
  const deltaMs = last ? (snapTs - last.t) : Infinity;
  if (last && deltaMs >= 0 && deltaMs < 10000 && areSnapshotsEquivalent(last, snap)) {
    return null;
  }
  arr.push(snap);
  const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
  let pruned = arr.filter(s => s.t >= cutoff);
  if (pruned.length > MAX_SNAPSHOTS_PER_ACCOUNT) {
    pruned.splice(0, pruned.length - MAX_SNAPSHOTS_PER_ACCOUNT);
  }
  accounts[providerId].snapshots = pruned;
  await chrome.storage.local.set({ accounts });
  return snap;
}

export async function getSnapshots(providerId, sinceMs = null) {
  const account = await getAccount(providerId);
  if (!account) return [];
  if (sinceMs === null) return account.snapshots;
  return account.snapshots.filter(s => s.t >= sinceMs);
}

// Fallback para o popup (sem contexto de aba)
export async function getActiveProviderId(provider) {
  const result = await chrome.storage.local.get(`active_${provider}`);
  return result[`active_${provider}`] || null;
}

export async function setActiveProviderId(provider, providerId) {
  await chrome.storage.local.set({ [`active_${provider}`]: providerId });
}

export async function getAccountsByProvider(provider) {
  const accounts = await getAllAccounts();
  const prefix = `${provider}:`;
  return Object.fromEntries(
    Object.entries(accounts).filter(([k]) => k.startsWith(prefix))
  );
}

const DEFAULT_SETTINGS = {
  activePollSeconds: 120,
  alertThreshold5h: 80,
  alertThreshold7d: 85,
  alertOnRedline: true,
  showBar: true,
  barPosition: 'top',
  alertLovableDailyPace: 130,
  alertLovableMonthlyBurn: 80
};

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const merged = { ...current, ...patch };
  await chrome.storage.local.set({ settings: merged });
  return merged;
}

export async function wasAlertFired(key, withinMs = 5 * 60 * 1000) {
  const { alertLog = {} } = await chrome.storage.local.get('alertLog');
  const last = alertLog[key];
  if (!last) return false;
  return (Date.now() - last) < withinMs;
}

export async function markAlertFired(key) {
  const { alertLog = {} } = await chrome.storage.local.get('alertLog');
  alertLog[key] = Date.now();
  const entries = Object.entries(alertLog);
  if (entries.length > 200) {
    entries.sort((a, b) => b[1] - a[1]);
    await chrome.storage.local.set({ alertLog: Object.fromEntries(entries.slice(0, 200)) });
  } else {
    await chrome.storage.local.set({ alertLog });
  }
}
