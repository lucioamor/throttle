const LOVABLE_WS_ID_RE = /^[a-zA-Z0-9_-]{2,128}$/;

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toIsoOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function sanitizeName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

export function isValidLovableWorkspaceId(wsId) {
  return typeof wsId === 'string' && LOVABLE_WS_ID_RE.test(wsId);
}

export function providerIdFromWorkspaceId(wsId) {
  if (!isValidLovableWorkspaceId(wsId)) return null;
  return `lovable:${wsId}`;
}

export function workspaceIdFromProviderId(providerId) {
  if (typeof providerId !== 'string' || !providerId.startsWith('lovable:')) return null;
  const wsId = providerId.slice('lovable:'.length);
  return isValidLovableWorkspaceId(wsId) ? wsId : null;
}

export function normalizeLovableSnapshot(data, providerId, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;

  const fallbackWsId = workspaceIdFromProviderId(providerId);
  const wsId = isValidLovableWorkspaceId(data.ws_id) ? data.ws_id : fallbackWsId;
  if (!wsId) return null;

  const dailyTotal = toFiniteNumber(data.daily_total);
  const monthlyTotal = toFiniteNumber(data.monthly_total);
  const cloudTotal = toFiniteNumber(data.cloud_total);
  const aiTotal = toFiniteNumber(data.ai_total);

  const snap = {
    t: typeof now === 'number' && Number.isFinite(now) ? now : Date.now(),
    ws_id: wsId,
    ws_name: sanitizeName(data.ws_name),
    daily_used: toFiniteNumber(data.daily_used),
    daily_total: dailyTotal === null ? 5 : Math.max(1, dailyTotal),
    daily_reset_at: toIsoOrNull(data.daily_reset_at),
    monthly_used: toFiniteNumber(data.monthly_used),
    monthly_total: monthlyTotal === null ? null : Math.max(0, monthlyTotal),
    monthly_reset_at: toIsoOrNull(data.monthly_reset_at),
    cloud_used: toFiniteNumber(data.cloud_used),
    cloud_total: cloudTotal === null ? null : Math.max(0, cloudTotal),
    ai_used: toFiniteNumber(data.ai_used),
    ai_total: aiTotal === null ? null : Math.max(0, aiTotal)
  };

  if (snap.daily_used === null && snap.monthly_used === null) return null;
  return snap;
}
