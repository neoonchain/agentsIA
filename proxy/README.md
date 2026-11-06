# Kairos free-trial proxy

A small server that holds **your** OpenRouter key so it never ships inside the app. Each install gets 2 free instructions (Ask or Analyse). After that, users add their own key. No dependencies.

## Run locally

```bash
OPENROUTER_API_KEY=sk-or-... IP_SALT=$(openssl rand -hex 16) node proxy/server.js
```

## Deploy (Docker: any VPS, Fly.io, Render, Railway…)

```bash
docker build -t kairos-proxy proxy/
docker run -d -p 8787:8787 -v kairos-data:/data \
  -e OPENROUTER_API_KEY=sk-or-... -e IP_SALT=<random> -e TRUST_PROXY=1 kairos-proxy
```

Put it behind HTTPS. Most hosts do this for you; set `TRUST_PROXY=1` only when a load balancer sets `X-Forwarded-For`. Mount `/data` so usage survives restarts.

Then point the app at it, either by setting `DEFAULT_FREE_PROXY` in `src/lib/config.js` before building the desktop app, or with `KAIROS_FREE_PROXY=https://your-proxy.example`.

## Limits (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `FREE_PER_INSTALL` | 2 | Free instructions per install |
| `FREE_PER_IP` | 6 | Per IP per `IP_WINDOW_DAYS` (30), so wiping the install id isn't enough |
| `DAILY_INSTRUCTIONS` | 300 | Global cap per day |
| `DAILY_BUDGET_USD` | 15 | Pauses the free trial for the day once OpenRouter reports this much spend |
| `CALLS_PER_TICKET` | 6 | Model calls one instruction may make (team mode uses 2–4) |
| `TICKET_TTL_SEC` | 600 | Unused tickets expire and give their slot back |
| `MAX_TOKENS` | 2000 | Output cap per call |
| `MAX_PROMPT_CHARS` | 60000 | Input cap per call |
| `FREE_MODELS` | the 7 app models | Allowlist; anything else is refused |
| `REQ_PER_MIN` | 40 | Rate limit per IP |

The proxy strips web search, tools and any extra fields, and only stores hashed IPs.

## Known limit

Without user accounts, someone determined could still rotate IPs to get more free instructions. The daily budget caps what that can cost you. If it becomes a problem, add sign-up (email or OAuth) and count per account instead.
