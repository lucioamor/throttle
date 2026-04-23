// intercept.js — runs in MAIN world at document_start
// Monkey-patches window.fetch to passively observe /api/organizations/*/usage responses.
// Clones the response (never blocks or alters) and posts the payload to the ISOLATED bridge.

(() => {
  if (window.__THROTTLE_PATCHED__) return;
  window.__THROTTLE_PATCHED__ = true;

  const TOKEN_ATTR = 'data-throttle-token';
  const ORG_ID_RE = /^[0-9a-f-]{8,128}$/i;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const originalFetch = window.fetch;

  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);

    try {
      let url = '';
      const first = args[0];
      if (typeof first === 'string') url = first;
      else if (first && first.url) url = first.url;
      else if (first instanceof URL) url = first.href;

      const match = url.match(/\/api\/organizations\/([0-9a-f-]+)\/usage(\b|$|\?)/);
      if (match) {
        const orgId = match[1];
        // Clone so the app's own consumer still receives an untouched stream.
        response.clone().json().then((data) => {
          const token = document.documentElement.getAttribute(TOKEN_ATTR);
          if (!token) return;
          window.postMessage({
            source: 'THROTTLE_CORE',
            type: 'USAGE_RESPONSE',
            orgId,
            token,
            payload: data
          }, '*');
        }).catch(() => {});
      }

      // Also opportunistically learn orgId from other /api/organizations/{id}/... calls
      const orgOnly = url.match(/\/api\/organizations\/([0-9a-f-]+)\/(?!$)/);
      if (orgOnly) {
        const token = document.documentElement.getAttribute(TOKEN_ATTR);
        if (!token) return response;
        window.postMessage({
          source: 'THROTTLE_CORE',
          type: 'ORG_SEEN',
          orgId: orgOnly[1],
          token
        }, '*');
      }

      const appStartMatch = url.match(/\/edge-api\/bootstrap\/([0-9a-f-]+)\/app_start(\b|$|\?)/i);
      if (appStartMatch) {
        const orgIdHint = appStartMatch[1];
        response.clone().json().then((data) => {
          const token = document.documentElement.getAttribute(TOKEN_ATTR);
          if (!token) return;
          const payload = extractAppStartMetadata(data, orgIdHint);
          if (!payload) return;

          window.postMessage({
            source: 'THROTTLE_CORE',
            type: 'APP_START_METADATA',
            token,
            payload
          }, '*');
        }).catch(() => {});
      }
    } catch (e) {
      // Interception must never break the host app.
    }

    return response;
  };

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

  function safeOrgId(value) {
    return typeof value === 'string' && ORG_ID_RE.test(value) ? value : null;
  }

  function addOrg(map, orgId, orgName) {
    const safeId = safeOrgId(orgId);
    if (!safeId) return;

    const safeName = sanitizeText(orgName, 160);
    const current = map.get(safeId);
    if (!current) {
      map.set(safeId, { orgId: safeId, orgName: safeName });
      return;
    }
    if (!current.orgName && safeName) {
      map.set(safeId, { orgId: safeId, orgName: safeName });
    }
  }

  function extractAppStartMetadata(data, orgIdHint) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    const account = data.account && typeof data.account === 'object' ? data.account : {};
    const user = data.user && typeof data.user === 'object' ? data.user : {};
    const topOrganization = data.organization && typeof data.organization === 'object' ? data.organization : {};

    const accountName = sanitizeText(account.full_name || account.display_name, 120);
    const accountEmail = sanitizeEmail(account.email_address);

    const organizationsById = new Map();
    addOrg(organizationsById, topOrganization.uuid, topOrganization.name);
    addOrg(organizationsById, user.organizationUUID, null);
    addOrg(organizationsById, orgIdHint, null);

    if (Array.isArray(account.memberships)) {
      for (const membership of account.memberships) {
        if (!membership || typeof membership !== 'object') continue;
        const org = membership.organization;
        if (!org || typeof org !== 'object') continue;
        addOrg(organizationsById, org.uuid, org.name);
      }
    }

    const organizations = [...organizationsById.values()];
    if (!organizations.length) return null;

    const primaryOrgId = safeOrgId(topOrganization.uuid)
      || safeOrgId(user.organizationUUID)
      || safeOrgId(orgIdHint)
      || organizations[0].orgId;

    return {
      accountName,
      accountEmail,
      primaryOrgId,
      organizations
    };
  }
})();
