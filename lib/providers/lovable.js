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

function extractWorkspaceIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/workspaces\/([^/?#]+)/);
  return isValidLovableWorkspaceId(match?.[1]) ? match[1] : null;
}

function extractArrayPayload(body, preferredKeys = []) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];

  const nestedData = body.data && typeof body.data === 'object' ? body.data : null;
  const candidates = [
    ...preferredKeys.map((key) => body[key]),
    body.data,
    body.items,
    body.results,
    body.workspaces,
    ...(nestedData
      ? [
          ...preferredKeys.map((key) => nestedData[key]),
          nestedData.items,
          nestedData.results,
          nestedData.workspaces
        ]
      : [])
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function hasLovableUsageFields(snap) {
  return snap.daily_used !== null
    || snap.monthly_used !== null
    || snap.cloud_used !== null
    || snap.ai_used !== null;
}

function normalizeWorkspaceApiObject(body, fallbackWsId = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const wsId = pickFirst(body.id, body.workspace_id, body.workspaceId, body.ws_id, fallbackWsId);
  if (!isValidLovableWorkspaceId(wsId)) return null;

  const monthlyCloud = body.monthly_cloud_usage && typeof body.monthly_cloud_usage === 'object'
    ? body.monthly_cloud_usage
    : null;

  const snap = {
    ws_id: wsId,
    ws_name: pickFirst(body.name, body.title, body.workspace_name),

    daily_used: pickFirst(body.daily_credits_used, body.daily_credits_used_in_billing_period),
    daily_total: pickFirst(body.daily_credits_limit, body.daily_credits_total),
    daily_reset_at: pickFirst(body.daily_credits_reset_at, body.daily_reset_at),

    monthly_used: pickFirst(
      body.billing_period_credits_used,
      body.total_credits_used_in_billing_period,
      body.backend_total_used_in_billing_period,
      body.monthly_credits_used,
      body.credits_used
    ),
    monthly_total: pickFirst(
      body.billing_period_credits_limit,
      body.monthly_credits_limit,
      body.credits_limit
    ),
    monthly_reset_at: pickFirst(body.billing_period_end_date, body.credits_reset_at, body.monthly_reset_at),

    cloud_used: pickFirst(monthlyCloud?.cloud_used, body.cloud_usage?.used, body.cloud_credits_used),
    cloud_total: pickFirst(monthlyCloud?.cloud_free, body.cloud_usage?.free, body.cloud_credits_limit),
    ai_used: pickFirst(monthlyCloud?.ai_used, body.ai_gateway_usage?.used, body.ai_credits_used),
    ai_total: pickFirst(monthlyCloud?.ai_free, body.ai_gateway_usage?.free, body.ai_credits_limit)
  };

  return hasLovableUsageFields(snap) ? snap : null;
}

function normalizeMonthlyUsageApiObject(body, fallbackWsId = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!isValidLovableWorkspaceId(fallbackWsId)) return null;

  const snap = {
    ws_id: fallbackWsId,
    ws_name: null,
    daily_used: null,
    daily_total: null,
    daily_reset_at: null,
    monthly_used: null,
    monthly_total: null,
    monthly_reset_at: null,
    cloud_used: pickFirst(body.cloud_usage?.used, body.cloud_used, body.cloud_credits_used),
    cloud_total: pickFirst(body.cloud_usage?.free, body.cloud_free, body.cloud_credits_limit),
    ai_used: pickFirst(body.ai_gateway_usage?.used, body.ai_used, body.ai_credits_used),
    ai_total: pickFirst(body.ai_gateway_usage?.free, body.ai_free, body.ai_credits_limit)
  };

  return hasLovableUsageFields(snap) ? snap : null;
}

export function normalizeLovableApiPayload(data) {
  if (!data || typeof data !== 'object') return [];

  const url = typeof data.url === 'string' ? data.url : '';
  const body = data.body;
  const urlWsId = extractWorkspaceIdFromUrl(url);
  const fallbackWsId = isValidLovableWorkspaceId(data.workspaceId) ? data.workspaceId : urlWsId;

  if (!body) return [];

  if (url.includes('/lovable-cloud-monthly-usage')) {
    const monthlySnap = normalizeMonthlyUsageApiObject(body, fallbackWsId);
    return monthlySnap ? [monthlySnap] : [];
  }

  const workspaces = extractArrayPayload(body, ['workspaces']);
  if (workspaces.length > 0) {
    return workspaces
      .map((workspace) => normalizeWorkspaceApiObject(workspace, fallbackWsId))
      .filter(Boolean);
  }

  const singleWorkspace = normalizeWorkspaceApiObject(body, fallbackWsId);
  return singleWorkspace ? [singleWorkspace] : [];
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

  if (snap.daily_used === null && snap.monthly_used === null && snap.cloud_used === null && snap.ai_used === null) return null;
  return snap;
}
