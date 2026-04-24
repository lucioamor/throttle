// bridge.js - runs in ISOLATED world at document_start
// Forwards trusted messages from MAIN-world intercept.js to background.

const TOKEN_ATTR = 'data-throttle-token';
const ORG_ID_RE = /^[0-9a-f-]{8,128}$/i;
let bridgeRuntimeInvalidated = false;

ensureBridgeToken();

window.addEventListener('message', (event) => {
  try {
    if (event.source !== window) return;
    if (bridgeRuntimeInvalidated) return;
    if (!isExtensionContextAlive()) return;
    const msg = event.data;
    if (!isBridgeMessage(msg)) return;

    if (msg.type === 'USAGE_RESPONSE') {
      safeSendMessage({
        type: 'USAGE_INTERCEPTED',
        orgId: msg.orgId,
        data: msg.payload
      });
      return;
    }

    if (msg.type === 'ORG_SEEN') {
      safeSendMessage({
        type: 'ORG_SEEN',
        orgId: msg.orgId
      });
      return;
    }

    if (msg.type === 'APP_START_METADATA') {
      safeSendMessage({
        type: 'CLAUDE_APP_START_METADATA',
        data: msg.payload
      });
    }
  } catch (_err) {
    // Never throw from bridge listener.
  }
});

function isExtensionContextAlive() {
  try {
    return typeof chrome !== 'undefined'
      && !!chrome.runtime
      && typeof chrome.runtime.sendMessage === 'function'
      && !!chrome.runtime.id;
  } catch (_err) {
    return false;
  }
}

function safeSendMessage(message) {
  if (bridgeRuntimeInvalidated) return;
  if (!isExtensionContextAlive()) return;
  try {
    chrome.runtime.sendMessage(message, () => {
      const errMsg = String(chrome.runtime?.lastError?.message || '');
      if (errMsg.includes('Extension context invalidated')) {
        bridgeRuntimeInvalidated = true;
      }
    });
  } catch (err) {
    if (String(err?.message || err || '').includes('Extension context invalidated')) {
      bridgeRuntimeInvalidated = true;
    }
    // Context may have been invalidated (e.g., extension reloaded).
  }
}

function ensureBridgeToken() {
  const root = document.documentElement;
  if (!root) return;

  const existing = root.getAttribute(TOKEN_ATTR);
  if (existing) return;

  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  root.setAttribute(TOKEN_ATTR, token);
}

function isBridgeMessage(msg) {
  const root = document.documentElement;
  if (!root) return false;
  if (!msg || typeof msg !== 'object') return false;
  if (msg.source !== 'THROTTLE_CORE') return false;
  if (msg.token !== root.getAttribute(TOKEN_ATTR)) return false;
  if (msg.type !== 'USAGE_RESPONSE' && msg.type !== 'ORG_SEEN' && msg.type !== 'APP_START_METADATA') return false;

  if (msg.type === 'USAGE_RESPONSE') {
    if (!ORG_ID_RE.test(msg.orgId || '')) return false;
    if (!msg.payload || typeof msg.payload !== 'object' || Array.isArray(msg.payload)) return false;
  }

  if (msg.type === 'ORG_SEEN') {
    if (!ORG_ID_RE.test(msg.orgId || '')) return false;
  }

  if (msg.type === 'APP_START_METADATA') {
    if (!isAppStartPayload(msg.payload)) return false;
  }

  return true;
}

function isAppStartPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!Array.isArray(payload.organizations) || payload.organizations.length === 0 || payload.organizations.length > 50) return false;

  if (payload.accountName !== null && payload.accountName !== undefined && typeof payload.accountName !== 'string') return false;
  if (payload.accountEmail !== null && payload.accountEmail !== undefined && typeof payload.accountEmail !== 'string') return false;
  if (typeof payload.primaryOrgId !== 'string' || !ORG_ID_RE.test(payload.primaryOrgId)) return false;

  for (const org of payload.organizations) {
    if (!org || typeof org !== 'object' || Array.isArray(org)) return false;
    if (!ORG_ID_RE.test(org.orgId || '')) return false;
    if (org.orgName !== null && org.orgName !== undefined && typeof org.orgName !== 'string') return false;
  }

  return true;
}
