// interceptor-lovable.js — Throttle v2
// Roda no MAIN world (injetado via content-lovable.js).
// Intercepta fetch e XHR da API do Lovable e posta payload normalizado para o bridge.

(() => {
  if (window.__THROTTLE_LOVABLE_PATCHED__) return;
  window.__THROTTLE_LOVABLE_PATCHED__ = true;

  const TOKEN_ATTR = 'data-throttle-lovable-token';
  const WS_ID_RE = /^[a-zA-Z0-9_-]{2,128}$/;
  let lastSnapshot = null;

  function currentToken() {
    return document.documentElement.getAttribute(TOKEN_ATTR);
  }

  // -------- Normalização do payload --------
  // A API do Lovable pode mudar — o parser extrai só o que existe.

  function extractWsId(url) {
    // /workspaces/{id} ou /api/workspaces/{id} ou /v1/workspaces/{id}
    const m = url.match(/workspaces\/([a-zA-Z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function normalizePayload(url, body) {
    if (!body || typeof body !== 'object') return null;

    // Tenta extrair dados de diferentes endpoints conhecidos
    const wsId = extractWsId(url) || body.id || body.workspace_id || body.ws_id;
    if (!wsId || !WS_ID_RE.test(wsId)) return null;

    // Endpoint de workspace/créditos — estrutura observada na extensão atual
    const snap = {
      ws_id:  wsId,
      ws_name: body.name || body.title || body.workspace_name || null,

      // Créditos diários gratuitos
      daily_used:     body.daily_credits_used     ?? body.free_credits_used     ?? null,
      daily_total:    body.daily_credits_total    ?? body.free_credits_total    ?? 5,
      daily_reset_at: body.daily_credits_reset_at ?? body.free_credits_reset_at ?? null,

      // Créditos mensais do workspace
      monthly_used:     body.credits_used     ?? body.monthly_credits_used     ?? null,
      monthly_total:    body.credits_limit    ?? body.monthly_credits_total    ?? null,
      monthly_reset_at: body.credits_reset_at ?? body.monthly_credits_reset_at ?? null,

      // Lovable Cloud (passivo)
      cloud_used:  body.cloud_credits_used  ?? body.lovable_cloud_used  ?? null,
      cloud_total: body.cloud_credits_limit ?? body.lovable_cloud_total ?? null,

      // Lovable AI (passivo)
      ai_used:  body.ai_credits_used  ?? body.lovable_ai_used  ?? null,
      ai_total: body.ai_credits_limit ?? body.lovable_ai_total ?? null,
    };

    // Descarta se não tem dados úteis
    if (snap.daily_used === null && snap.monthly_used === null) return null;
    return snap;
  }

  function isLovableApi(url) {
    return typeof url === 'string' && (
      url.includes('api.lovable.dev') ||
      url.includes('lovable.dev/api')
    );
  }

  function tryPost(snap) {
    const token = currentToken();
    if (!token) return;
    lastSnapshot = snap;
    window.postMessage({
      source: 'THROTTLE_LOVABLE',
      type:   'LOVABLE_USAGE',
      token,
      payload: snap
    }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (msg?.source !== 'THROTTLE_LOVABLE' || msg?.type !== 'FORCE_REFRESH') return;
    if (msg.token !== currentToken()) return;
    if (lastSnapshot) tryPost(lastSnapshot);
  });

  // -------- Fetch patch --------

  const originalFetch = window.fetch;
  window.fetch = async function patchedFetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      let url = '';
      const first = args[0];
      if (typeof first === 'string') url = first;
      else if (first?.url) url = first.url;
      else if (first instanceof URL) url = first.href;

      if (isLovableApi(url)) {
        response.clone().json().then(body => {
          const snap = normalizePayload(url, body);
          if (snap) tryPost(snap);
        }).catch(() => {});
      }
    } catch (e) {}
    return response;
  };

  // -------- XHR patch --------

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._throttleUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        if (!isLovableApi(this._throttleUrl || '')) return;
        const body = JSON.parse(this.responseText);
        const snap = normalizePayload(this._throttleUrl, body);
        if (snap) tryPost(snap);
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

})();
