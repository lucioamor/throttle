const CLAUDE_ORG_ID_RE = /^[0-9a-f-]{8,128}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clamp(value, min, max) {
  if (value === null) return null;
  return Math.min(max, Math.max(min, value));
}

function normalizeExtraUtilPercent(extraUtilRaw, extraUsed, extraLimit) {
  if (!Number.isFinite(extraUtilRaw)) return null;

  const hasAmounts = Number.isFinite(extraUsed) && Number.isFinite(extraLimit) && extraLimit > 0;
  const amountPct = hasAmounts ? clamp((extraUsed / extraLimit) * 100, 0, 100) : null;

  if (extraUtilRaw > 1) return clamp(extraUtilRaw, 0, 100);
  if (extraUtilRaw < 0) return 0;

  if (extraUtilRaw === 0 || extraUtilRaw === 1) {
    // Ambiguous edge values are treated as percent scale unless amounts corroborate a ratio.
    if (amountPct !== null) return amountPct;
    return clamp(extraUtilRaw, 0, 100);
  }

  // For 0 < raw < 1, prefer the interpretation that best matches used/limit when available.
  if (amountPct !== null) {
    const asPercent = clamp(extraUtilRaw, 0, 100);
    const asRatioPercent = clamp(extraUtilRaw * 100, 0, 100);
    return Math.abs(asPercent - amountPct) <= Math.abs(asRatioPercent - amountPct)
      ? asPercent
      : asRatioPercent;
  }

  return clamp(extraUtilRaw * 100, 0, 100);
}

function toIsoOrNull(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function sanitizeText(value, maxLen = 160) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function sanitizeEmail(value) {
  const email = sanitizeText(value, 254);
  if (!email) return null;
  return EMAIL_RE.test(email) ? email : null;
}

function sanitizeOrgEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const orgId = normalizeClaudeOrgId(entry.orgId);
  if (!orgId) return null;
  return {
    orgId,
    orgName: sanitizeText(entry.orgName, 160)
  };
}

export function isValidClaudeOrgId(orgId) {
  return typeof orgId === 'string' && CLAUDE_ORG_ID_RE.test(orgId);
}

export function normalizeClaudeOrgId(orgId) {
  if (typeof orgId !== 'string') return null;
  const normalized = orgId.trim().toLowerCase();
  return isValidClaudeOrgId(normalized) ? normalized : null;
}

export function providerIdFromOrgId(orgId) {
  const normalized = normalizeClaudeOrgId(orgId);
  if (!normalized) return null;
  return `claude:${normalized}`;
}

export function orgIdFromProviderId(providerId) {
  if (typeof providerId !== 'string') return null;
  if (!providerId.startsWith('claude:')) return null;
  const orgId = providerId.slice('claude:'.length);
  return normalizeClaudeOrgId(orgId);
}

export function normalizeClaudeSnapshot(data, now = Date.now()) {
  if (!data || typeof data !== 'object') return null;

  const u5h = clamp(toFiniteNumber(data.five_hour?.utilization), 0, 100);
  const u7d = clamp(toFiniteNumber(data.seven_day?.utilization), 0, 100);
  const extraUsed = toFiniteNumber(data.extra_usage?.used_credits);
  const extraLimit = toFiniteNumber(data.extra_usage?.monthly_limit);
  const extraUtilRaw = toFiniteNumber(data.extra_usage?.utilization);
  const extraUtil = normalizeExtraUtilPercent(extraUtilRaw, extraUsed, extraLimit);

  let monthlyExhausted = false;
  if (Number.isFinite(extraUsed) && Number.isFinite(extraLimit) && extraLimit > 0) {
    monthlyExhausted = extraUsed >= extraLimit;
  } else if (Number.isFinite(extraUtil)) {
    monthlyExhausted = extraUtil >= 100;
  }

  const snap = {
    t: typeof now === 'number' && Number.isFinite(now) ? now : Date.now(),
    u5h,
    u7d,
    reset5h: toIsoOrNull(data.five_hour?.resets_at),
    reset7d: toIsoOrNull(data.seven_day?.resets_at),
    extra_used: extraUsed,
    extra_limit: extraLimit,
    extra_util: extraUtil,
    monthly_exhausted: monthlyExhausted,
    extra_currency: typeof data.extra_usage?.currency === 'string' && data.extra_usage.currency.length <= 8
      ? data.extra_usage.currency
      : null
  };

  if (snap.u5h === null && snap.u7d === null) return null;
  return snap;
}

export function normalizeClaudeAppStartMetadata(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const accountName = sanitizeText(payload.accountName, 120);
  const accountEmail = sanitizeEmail(payload.accountEmail);
  const organizationsRaw = Array.isArray(payload.organizations) ? payload.organizations : [];

  const organizationsById = new Map();
  for (const entry of organizationsRaw) {
    const safe = sanitizeOrgEntry(entry);
    if (!safe) continue;

    const previous = organizationsById.get(safe.orgId);
    if (!previous) {
      organizationsById.set(safe.orgId, safe);
      continue;
    }

    if (!previous.orgName && safe.orgName) {
      organizationsById.set(safe.orgId, safe);
    }
  }

  const organizations = [...organizationsById.values()];
  if (!organizations.length) return null;

  const primaryOrgIdNormalized = normalizeClaudeOrgId(payload.primaryOrgId);
  const primaryOrgId = primaryOrgIdNormalized && organizationsById.has(primaryOrgIdNormalized)
    ? primaryOrgIdNormalized
    : organizations[0].orgId;

  return {
    accountName,
    accountEmail,
    primaryOrgId,
    organizations
  };
}

export function buildClaudeAccountLabel({ accountName, accountEmail, organizationName }) {
  const name = sanitizeText(accountName, 120);
  const email = sanitizeEmail(accountEmail);
  const orgName = sanitizeText(organizationName, 160);

  if (name && email) return `${name} <${email}>`;
  if (email) return email;
  if (name) return name;
  if (orgName) return orgName;
  return null;
}
