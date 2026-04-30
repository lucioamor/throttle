# Throttle

**Pace control for AI limits.**

Extensão Chrome que transforma os limites opacos do Claude.ai e Lovable em ritmo operacional mensurável. Velocímetro de consumo em tempo real, previsão de esgotamento, sparkline histórico, alertas de redline — tudo 100% local.

Suporta Claude.ai e Lovable.dev. Arquitetura multi-provider preparada para OpenAI e Gemini.

---

## Proposta

A maioria das ferramentas de "usage tracker" monitora passivamente. Throttle não mede — ela **controla o ritmo**. A métrica central é o índice **PACE**:

```
PACE = ritmo atual / ritmo ideal para zerar no reset × 100
```

- PACE **100** = consumo perfeito, zera no reset
- PACE **<50** = throttle folgado, pode acelerar
- PACE **>130** = redline, vai estourar antes do reset

Essa métrica é estável entre planos (Free, Pro, Max) porque é calculada sobre **percentual** da cota, não sobre tokens absolutos.

---

## Arquitetura

### Captura de dados: interceptação passiva primeiro

Em vez de fazer poll agressivo no endpoint `/usage` (risco de anti-bot e rate limit), Throttle faz **monkey-patch de `window.fetch`** no `MAIN world` do claude.ai. Sempre que o próprio frontend do Claude chama o endpoint, a extensão clona a resposta e processa.

Fluxo:

```
┌─────────────────────────────────────────────────────────────┐
│ CLAUDE.AI (MAIN world)                                      │
│  ├── intercept.js → monkey-patches window.fetch             │
│  └── posta window.postMessage para ISOLATED world           │
├─────────────────────────────────────────────────────────────┤
│ EXTENSION (ISOLATED world)                                  │
│  ├── bridge.js     → forwarding layer                       │
│  ├── content.js    → renderiza Shadow DOM bar               │
│  └── background.js → dedupe, análise, alertas, storage      │
└─────────────────────────────────────────────────────────────┘
```

**Fallback de poll ativo** (a cada 2min configurável) roda apenas quando a interceptação passiva fica silenciosa — minimiza pegada anômala.

**Descoberta de `orgId` via `chrome.webRequest`** detecta qualquer chamada `/api/organizations/{uuid}/...`, aprendendo a org sem exigir que você visite `/settings/usage`.

### UI isolada em Shadow DOM

A barra no topo é montada dentro de um Shadow DOM. Mudanças no CSS do Claude.ai (redesign, novos temas) **não afetam** a extensão. Zero risco de vazamento de estilo.

### Storage plan-agnóstico

O schema de snapshots renderiza apenas os buckets que existem no payload:

```js
{
  t: 1745350800000,
  u5h: 84.0,              // pode ser null
  u7d: 74.0,              // pode ser null
  reset5h: "2026-04-22T17:00:01Z",
  reset7d: "2026-04-23T20:00:00Z",
  extra_used: 15202,      // mensal em BRL
  extra_limit: 27500,
  extra_util: 55.28,
  extra_currency: "BRL"
}
```

Se a Anthropic mudar a estrutura (adicionar `opus` específico, mudar de `five_hour` para `dynamic_window`, etc), o parser tolerante ignora campos desconhecidos e renderiza o que existir.

---

## Funcionalidades

### Barra no topo (24px, sempre visível)

- **THROTTLE** (brand amber neon)
- **5H**: % consumido, ETA de esgotamento (ou tempo até reset)
- **7D**: % consumido, tempo até reset semanal
- **PACE**: valor numérico do pace index, com cor (verde/amarelo/vermelho/azul)

Click na barra força refresh imediato.

### Popup completo

- **Velocímetro SVG** (0–200, 100 = ideal) com agulha animada e animação rev-limiter
- **Legenda contextual** que muda de acordo com o status ("🟢 Pace saudável", "🔴 REDLINE · zera em 42min")
- Status das três janelas Claude (5h / 7d / extra BRL)
- **Stats Lovable**: uso diário e mensal side-by-side com sparkline histórico
- ETAs separados para 15min e 60min
- **Export CSV** completo
- **Settings** de poll, thresholds e toggles

### Alertas via notificação do Chrome

- Janela 5h cruza threshold (default 80%)
- Janela 7d cruza threshold (default 85%)
- PACE entra em redline (>130)
- Telemetria stale (4h+ sem dados = possível mudança de endpoint)

Todos os alertas têm cooldown para evitar spam.

### Multi-conta

Detecta automaticamente trocas de organização via webRequest. Cada org mantém snapshots separados. Dropdown no popup alterna entre elas.

---

## Instalação

1. Baixe/clone a pasta `throttle/`
2. Abra `chrome://extensions`
3. Ative **"Modo do desenvolvedor"**
4. **"Carregar sem compactação"** → selecione a pasta `throttle/`
5. Abra `claude.ai` e envie uma mensagem — a barra aparece no topo
6. Abra `lovable.dev` para ver os créditos Lovable no popup
7. Popup disponível no ícone da extensão

---

## Estrutura de arquivos

```
throttle/
├── manifest.json              Manifest V3 com MAIN+ISOLATED scripts
├── intercept.js               MAIN world — monkey-patches fetch (Claude)
├── interceptor-lovable.js     MAIN world — intercepta fetch do Lovable
├── bridge.js                  ISOLATED world — forwards postMessage
├── background.js              Service worker — análise, alertas, storage
├── content.js                 ISOLATED — Shadow DOM bar (Claude)
├── content-lovable.js         ISOLATED — injeção no Lovable
├── overlay.css                Placeholder (estilos reais no Shadow DOM)
├── popup.html
├── popup.css
├── popup.js                   SVG speedo, sparkline, CSV export, settings
├── lib/
│   ├── storage.js             Multi-conta, retenção 8 dias, dedupe
│   ├── predictor.js           Rates, ETA, PACE, semáforo de status
│   └── providers/
│       ├── claude.js          Parser/normalizer Claude.ai
│       └── lovable.js         Parser/normalizer Lovable.dev
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Decisões de design

### Por que PACE e não "tokens/min"

Tokens absolutos mudam com o plano, o modelo (Sonnet vs Opus) e a carga dos servidores. Percentual da cota é a única métrica estável. PACE como ratio (rate/ideal × 100) também desacopla a interpretação do tempo restante.

### Por que interceptação passiva e não poll puro

Poll contínuo em endpoint privado pode ativar WAF da Anthropic. A própria aplicação do Claude chama `/usage` várias vezes por sessão — piggyback nessas chamadas elimina pegada anômala. Poll ativo só roda como fallback quando o usuário está inativo.

### Por que Shadow DOM

Claude.ai tem redesigns frequentes. Um `<div style="position:fixed; top:0">` em 2026 pode quebrar em 2027. Shadow DOM garante que as regras CSS do host não afetam a extensão e vice-versa.

### Por que 8 dias de retenção

Janela semanal da API é de 7 dias. 8 dias dá margem para o sparkline cobrir o ciclo completo mais a transição do reset.

---

## Limitações conhecidas

| Problema | Mitigação |
|---|---|
| Early-window (logo após reset, poucos dados) | Popup mostra "Aguardando dados de pace" até ter 2+ snapshots |
| Granularidade depende do tráfego | Intercept captura sempre que o Claude chama `/usage`; fallback poll garante mínimo de 1 snapshot/2min |
| Modelo usado (Sonnet vs Opus) não é diferenciado | PACE mede efeito agregado; cruzamento com o tipo de conversa fica a cargo do usuário |
| Endpoint privado pode mudar | Parser tolerante + alerta de "telemetry stale" após 4h sem dados |
| Bloqueio de CSP no MAIN world | Fallback: se monkey-patch falhar, poll ativo continua funcionando |

---

## Suporte multi-LLM

| Provider | Status | Métricas |
|---|---|---|
| **Claude.ai** | ✅ Ativo | 5h window, 7d window, extra mensal |
| **Lovable.dev** | ✅ Ativo | Créditos diários e mensais, sparkline |
| **OpenAI** | Planejado | `platform.openai.com/settings/organization/usage` |
| **Gemini** | Planejado | `aistudio.google.com` quota pages |

Cada provider é um módulo `lib/providers/{name}.js` com `discover()` e `normalize(payload)`. Adicionar novo provider não exige mudança no core.

---

## Privacidade

- **Zero telemetria externa**. Nenhum dado sai da máquina.
- **Zero leitura de conteúdo de chat**. A extensão só lê o endpoint numérico `/usage`.
- **Storage 100% local** em `chrome.storage.local`.
- **Sem analytics, sem tracking, sem backend**.

---

## Licença

Uso pessoal. Não oficial, sem vínculo com Anthropic.
