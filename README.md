# Throttle

**Pace control for AI limits.**

Chrome extension that turns the opaque limits of Claude.ai and Lovable into measurable operational rhythm. Real-time consumption speedometer, depletion forecasting, historical sparkline, redline alerts — 100% local.

Supports Claude.ai and Lovable.dev. Multi-provider architecture ready for OpenAI and Gemini.

---

## Purpose

Most usage tracker tools monitor passively. Throttle doesn't just measure — it **controls the pace**. The core metric is the **PACE** index:

```
PACE = current rate / ideal rate to reach zero at reset × 100
```

- PACE **100** = perfect consumption, zeroes out at reset
- PACE **<50** = throttle is loose, can accelerate
- PACE **>130** = redline, will blow up before reset

This metric is stable across plans (Free, Pro, Max) because it's calculated on **percentage of quota**, not absolute tokens.

---

## Architecture

### Data capture: passive interception first

Instead of aggressively polling the `/usage` endpoint (anti-bot and rate limit risk), Throttle **monkey-patches `window.fetch`** in the `MAIN world` of claude.ai. Whenever Claude's own frontend calls the endpoint, the extension clones the response and processes it.

Flow:

```
┌─────────────────────────────────────────────────────────────┐
│ CLAUDE.AI (MAIN world)                                      │
│  ├── intercept.js → monkey-patches window.fetch             │
│  └── posts window.postMessage to ISOLATED world             │
├─────────────────────────────────────────────────────────────┤
│ EXTENSION (ISOLATED world)                                  │
│  ├── bridge.js     → forwarding layer                       │
│  ├── content.js    → renders Shadow DOM bar                 │
│  └── background.js → dedupe, analysis, alerts, storage      │
└─────────────────────────────────────────────────────────────┘
```

**Active poll fallback** (every 2min, configurable) runs only when passive interception goes silent — minimizes anomalous footprint.

**`orgId` discovery via `chrome.webRequest`** detects any call to `/api/organizations/{uuid}/...`, learning the org without requiring you to visit `/settings/usage`.

### Shadow DOM isolated UI

The top bar is mounted inside a Shadow DOM. Changes to Claude.ai's CSS (redesigns, new themes) **do not affect** the extension. Zero style leakage risk.

### Plan-agnostic storage

The snapshot schema renders only the buckets present in the payload:

```js
{
  t: 1745350800000,
  u5h: 84.0,              // may be null
  u7d: 74.0,              // may be null
  reset5h: "2026-04-22T17:00:01Z",
  reset7d: "2026-04-23T20:00:00Z",
  extra_used: 15202,      // monthly in BRL
  extra_limit: 27500,
  extra_util: 55.28,
  extra_currency: "BRL"
}
```

If Anthropic changes the structure (adds an `opus`-specific field, renames `five_hour` to `dynamic_window`, etc), the tolerant parser ignores unknown fields and renders whatever exists.

---

## Features

### Top bar (24px, always visible)

- **THROTTLE** (brand amber neon)
- **5H**: % consumed, depletion ETA (or time to reset)
- **7D**: % consumed, time to weekly reset
- **PACE**: numeric pace index with color coding (green/yellow/red/blue)

Clicking the bar forces an immediate refresh.

### Full popup

- **SVG speedometer** (0–200, 100 = ideal) with animated needle and rev-limiter animation
- **Contextual legend** that changes with status ("🟢 Healthy pace", "🔴 REDLINE · zeroes in 42min")
- Claude window status (5h / 7d / extra BRL)
- **Lovable stats**: daily and monthly usage side-by-side with historical sparkline
- Separate ETAs for 15min and 60min
- **Full CSV export**
- **Settings** for poll interval, thresholds, and toggles

### Chrome notification alerts

- 5h window crosses threshold (default 80%)
- 7d window crosses threshold (default 85%)
- PACE enters redline (>130)
- Stale telemetry (4h+ without data = possible endpoint change)

All alerts have cooldown to prevent spam.

### Multi-account

Automatically detects organization switches via webRequest. Each org maintains separate snapshots. Dropdown in popup switches between them.

---

## Installation

1. Download/clone the `throttle/` folder
2. Open `chrome://extensions`
3. Enable **"Developer mode"**
4. **"Load unpacked"** → select the `throttle/` folder
5. Open `claude.ai` and send a message — the bar appears at the top
6. Open `lovable.dev` to see Lovable credits in the popup
7. Popup available via the extension icon

---

## File structure

```
throttle/
├── manifest.json              Manifest V3 with MAIN+ISOLATED scripts
├── intercept.js               MAIN world — monkey-patches fetch (Claude)
├── interceptor-lovable.js     MAIN world — intercepts Lovable fetch
├── bridge.js                  ISOLATED world — forwards postMessage
├── background.js              Service worker — analysis, alerts, storage
├── content.js                 ISOLATED — Shadow DOM bar (Claude)
├── content-lovable.js         ISOLATED — injection on Lovable
├── overlay.css                Placeholder (real styles live in Shadow DOM)
├── popup.html
├── popup.css
├── popup.js                   SVG speedo, sparkline, CSV export, settings
├── lib/
│   ├── storage.js             Multi-account, 8-day retention, dedupe
│   ├── predictor.js           Rates, ETA, PACE, status semaphore
│   └── providers/
│       ├── claude.js          Claude.ai parser/normalizer
│       └── lovable.js         Lovable.dev parser/normalizer
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Design decisions

### Why PACE and not "tokens/min"

Absolute tokens change with the plan, the model (Sonnet vs Opus), and server load. Quota percentage is the only stable metric. PACE as a ratio (rate/ideal × 100) also decouples the interpretation from remaining time.

### Why passive interception and not pure polling

Continuous polling of a private endpoint can trigger Anthropic's WAF. Claude's own application calls `/usage` multiple times per session — piggybacking on those calls eliminates anomalous footprint. Active polling only runs as fallback when the user is inactive.

### Why Shadow DOM

Claude.ai has frequent redesigns. A `<div style="position:fixed; top:0">` in 2026 may break in 2027. Shadow DOM ensures the host's CSS rules don't affect the extension and vice versa.

### Why 8 days retention

The API's weekly window is 7 days. 8 days gives the sparkline room to cover the full cycle plus the reset transition.

---

## Known limitations

| Issue | Mitigation |
|---|---|
| Early-window (just after reset, sparse data) | Popup shows "Waiting for pace data" until 2+ snapshots exist |
| Granularity depends on traffic | Intercept captures every time Claude calls `/usage`; fallback poll guarantees minimum 1 snapshot/2min |
| Model used (Sonnet vs Opus) not differentiated | PACE measures aggregate effect; correlation with conversation type is left to the user |
| Private endpoint may change | Tolerant parser + "telemetry stale" alert after 4h without data |
| CSP block in MAIN world | Fallback: if monkey-patch fails, active polling continues working |

---

## Multi-LLM support

| Provider | Status | Metrics |
|---|---|---|
| **Claude.ai** | ✅ Active | 5h window, 7d window, monthly extra |
| **Lovable.dev** | ✅ Active | Daily and monthly credits, sparkline |
| **OpenAI** | Planned | `platform.openai.com/settings/organization/usage` |
| **Gemini** | Planned | `aistudio.google.com` quota pages |

Each provider is a `lib/providers/{name}.js` module with `discover()` and `normalize(payload)`. Adding a new provider requires no changes to the core.

---

## Privacy

- **Zero external telemetry.** No data leaves the machine.
- **Zero chat content reading.** The extension only reads the numeric `/usage` endpoint.
- **100% local storage** in `chrome.storage.local`.
- **No analytics, no tracking, no backend.**

---

## License

Personal use. Unofficial, no affiliation with Anthropic.
