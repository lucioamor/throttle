// interceptor-lovable.js - Throttle v2
// Runs in the MAIN world and relays raw Lovable API responses to the bridge.

(() => {
  if (window.__THROTTLE_LOVABLE_PATCHED__) return;
  window.__THROTTLE_LOVABLE_PATCHED__ = true;

  const TOKEN_ATTR = 'data-throttle-lovable-token';
  const WS_ID_RE = /^[a-zA-Z0-9_-]{2,128}$/;
  let lastApiPayload = null;

  function currentToken() {
    return document.documentElement.getAttribute(TOKEN_ATTR);
  }

  function isLovableApi(url) {
    return typeof url === 'string' && (
      url.includes('api.lovable.dev') ||
      url.includes('lovable.dev/api')
    );
  }

  function extractWsId(url) {
    const match = typeof url === 'string' ? url.match(/\/workspaces\/([a-zA-Z0-9_-]+)/) : null;
    return match && WS_ID_RE.test(match[1]) ? match[1] : null;
  }

  function getHeaderValue(headers, name) {
    if (!headers) return null;
    const lowerName = name.toLowerCase();
    try {
      if (headers instanceof Headers) return headers.get(name) || headers.get(lowerName);
      if (Array.isArray(headers)) {
        const entry = headers.find(([key]) => String(key).toLowerCase() === lowerName);
        return entry ? entry[1] : null;
      }
      if (typeof headers === 'object') return headers[name] || headers[lowerName] || null;
    } catch (_err) {}
    return null;
  }

  function postToBridge(type, payload) {
    const token = currentToken();
    if (!token) return;
    window.postMessage({
      source: 'THROTTLE_LOVABLE',
      type,
      token,
      payload
    }, '*');
  }

  function postApiPayload(payload) {
    lastApiPayload = payload;
    postToBridge('LOVABLE_API_DATA', payload);
  }

  function postAuthToken(authToken, url) {
    if (!authToken) return;
    postToBridge('LOVABLE_AUTH_TOKEN', { authToken, url });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.source !== 'THROTTLE_LOVABLE' || msg?.type !== 'FORCE_REFRESH') return;
    if (msg.token !== currentToken()) return;
    if (lastApiPayload) postApiPayload(lastApiPayload);
  });

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);

    try {
      let url = '';
      const first = args[0];
      if (typeof first === 'string') url = first;
      else if (first instanceof URL) url = first.href;
      else if (first?.url) url = first.url;

      if (isLovableApi(url)) {
        const init = args[1] || {};
        const method = init.method || first?.method || 'GET';
        const authHeader = getHeaderValue(init.headers, 'Authorization')
          || getHeaderValue(first?.headers, 'Authorization');

        postAuthToken(authHeader, url);

        response.clone().json().then((body) => {
          postApiPayload({
            url,
            method,
            workspaceId: extractWsId(url),
            body
          });
        }).catch(() => {});
      }
    } catch (_err) {}

    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._throttleUrl = url;
    this._throttleMethod = method;
    this._throttleHeaders = {};
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._throttleHeaders) this._throttleHeaders[name] = value;
    return origSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const url = this._throttleUrl || '';
        if (!isLovableApi(url)) return;

        const authHeader = this._throttleHeaders?.Authorization || this._throttleHeaders?.authorization;
        postAuthToken(authHeader, url);

        const body = JSON.parse(this.responseText);
        postApiPayload({
          url,
          method: this._throttleMethod || 'GET',
          workspaceId: extractWsId(url),
          body
        });
      } catch (_err) {}
    });
    return origSend.apply(this, args);
  };
})();
