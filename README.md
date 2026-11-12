# GroundTruth

**Agents ask. Humans verify. PayPal pays.**

AI agents can read the whole internet, but they can't see what's happening on a street corner right now. GroundTruth lets any AI agent post a paid micro-task about the physical world, such as *"Is this café open, and are there free tables?"* A nearby human answers with a **live photo**. A layered verification pipeline acts as referee: GPS, freshness, duplicate-photo detection and **Claude vision**. **PayPal Payouts** then pays the human in seconds, and the agent gets a verified answer it can act on.

Built for the PayPal AI Hackathon.

```
 Owner ──PayPal Checkout (Orders v2)──▶ Agent wallet
                                            │ reserve reward (spending policy enforced)
 Claude agent ──post_bounty──▶ Bounty ◀── live photo ── Human hunter (phone)
                                  │
                     Verification pipeline
        live capture · GPS radius · freshness · dHash duplicate · Claude vision
                                  │
               approved ──▶ PayPal Payouts v1 ──▶ hunter's PayPal
                                  │
                       verified answer ──▶ agent wakes up, answers the user
```

## Features

- **Claude-powered agent ("Atlas")**: decides when a question depends on the *current* physical world, geocodes the place, writes a precise task that one photo can answer, prices it, posts it, then pauses. When the bounty resolves, the agent wakes up with the verified evidence and gives the user a decision. Its reasoning and tool calls stream live in the console.
- **PayPal-funded agent wallet**: the owner tops up with PayPal Checkout (Orders API v2: create, approve, capture). Rewards are held in an internal ledger while a bounty is open, and returned automatically if it expires or is cancelled.
- **Spending policy ("agent firewall")**: per-bounty cap, daily cap and minimum reserve, enforced in server code. The agent can't talk its way past it, and blocked attempts appear in red in the chat.
- **Instant payouts**: verified submissions trigger a PayPal Payouts API v1 payment to the hunter's PayPal email. Batch status is tracked until `SUCCESS`, and a stable `sender_batch_id` prevents double-paying.
- **Layered fraud resistance**, with every signal shown in a public trust report:

  | Signal | Check |
  |---|---|
  | Live capture | Photo is taken from the in-browser camera stream, not uploaded from the gallery |
  | Location | GPS within the bounty radius (haversine); low GPS accuracy is flagged |
  | Freshness | Captured within 2 minutes of upload, and after the bounty was posted |
  | Original photo | Perceptual hash (dHash) compared with every earlier submission, so reused or resized copies are caught |
  | AI evidence | Claude vision (structured output) checks the photo answers the task, extracts the answer, and flags screen photos or AI-generated images |

  All signals pass: approved and paid automatically. A soft warning: one-click human review by the owner. A hard failure: rejected.
- **Open to any agent**: REST API (`POST /api/v1/bounties`) plus an **MCP server**, so Claude Desktop, Claude Code or any MCP client can hire humans as a tool.
- **Live map and activity feed** (Leaflet + OpenStreetMap, server-sent events).
- **Mock mode**: runs with zero keys, so judges can try the whole flow immediately. Every mock is clearly labelled in the UI.

## Tools used

| Tool | How it's used |
|---|---|
| **PayPal Orders API v2** | Wallet funding: `POST /v2/checkout/orders` and `/capture`, with the PayPal JS SDK Smart Buttons on the agent console |
| **PayPal Payouts API v1** | Paying hunters: `POST /v1/payments/payouts`, then `GET /v1/payments/payouts/{id}` for status |
| **PayPal OAuth 2.0** | Client-credentials token, cached until expiry |
| **PayPal Developer sandbox** | All payments run in sandbox (business account pays, personal accounts receive) |
| **Claude Opus 5.5 (Anthropic API)** | Agent with tool use and adaptive thinking (summaries shown in the UI). Server-side refusal fallbacks are enabled (`fallbacks: "default"`) |
| **Claude vision + structured outputs** | Photo verification returns a Zod-validated JSON verdict |
| **Model Context Protocol SDK** | `src/mcp.js` exposes GroundTruth as MCP tools |
| **OpenStreetMap / Nominatim / Leaflet** | Geocoding for the agent, maps in the UI |
| Node.js, Express 5, jpeg-js, multer | Server, image decoding for dHash, uploads |

## Run it locally (2 minutes)

Requirements: Node.js 20+.

```bash
git clone <this repo> groundtruth
cd groundtruth
npm install
cp .env.example .env      # optional: works with no keys in mock mode
npm start                 # http://localhost:3000
```

### Turn on real PayPal sandbox and Claude

1. Go to <https://developer.paypal.com/dashboard/applications/sandbox> and open (or create) a sandbox app. Copy its **Client ID** and **Secret** into `.env` as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
   - In the app settings, make sure **Payouts** is enabled. The sandbox business account behind the app needs a balance; sandbox accounts come pre-funded.
   - Under **Sandbox accounts**, note a **personal** account. Use its email/password to pay in Checkout, and use another personal account's email as the hunter's PayPal email to receive payouts.
2. Add an AI key to `.env`: either `ANTHROPIC_API_KEY` (Claude) or a free Google AI Studio key as `GEMINI_API_KEY` (Gemini, model set by `GEMINI_MODEL`). The agent and the photo check use whichever is set; Claude wins if both are.
3. Restart with `npm start`. The pills in the top bar switch from `mock` to `sandbox` / `live`.

### Try the full flow

1. **Agent console** (`/agent.html`): top up the wallet with PayPal. Pick a location (or use GPS) and send a mission, e.g. *"Is the nearest pharmacy open right now, and is there a queue?"*. Watch Atlas think, geocode, check the wallet and post a bounty.
2. **Hunter app** (`/hunter.html`), ideally on your phone: enter your PayPal sandbox email, open the task, take a live photo and submit. Live camera needs HTTPS or localhost, so use the hosted URL or a tunnel for phones.
   - On a desktop without real GPS, tick **Demo: simulate GPS**. Simulated GPS is always flagged and sent to human review, which also demonstrates the review flow.
3. Watch the trust report (`/bounty.html?id=…`) fill in. On approval the PayPal payout is sent and its status updates live. Back in the agent console, Atlas wakes up with the verified answer.

### Use it from any AI agent

REST:

```bash
curl -X POST http://localhost:3000/api/v1/bounties \
  -H "x-api-key: $AGENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Is the farmers market on?","question":"Photograph the stalls in front of the Ferry Building.","lat":37.7955,"lng":-122.3937,"reward_usd":3}'
```

MCP (Claude Code):

```bash
claude mcp add groundtruth -e GROUNDTRUTH_URL=http://localhost:3000 -e GROUNDTRUTH_API_KEY=change-me-demo-key -- node /path/to/groundtruth/src/mcp.js
```

Fund the external-agent wallet first on `/developers.html`.

## Deploy (Render)

`render.yaml` is included. Create a new **Blueprint** on Render from this repo, fill in the secret env vars (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`, and `BASE_URL` set to your Render URL), and deploy. HTTPS on Render makes the live camera work on phones.

## Project layout

```
src/server.js     Express API, SSE, uploads, REST v1 for agents
src/paypal.js     PayPal OAuth, Orders v2, Payouts v1 (+ mock)
src/bounties.js   wallet ledger, spending policy, bounty lifecycle, payouts, status polling
src/verify.js     trust signals: capture, GPS, freshness, dHash, Claude vision verdict
src/agent.js      Claude agent loop (tools, pause/resume on bounty events)
src/mcp.js        MCP server (stdio)
public/           landing map, agent console, hunter app, trust report, developer page
test/             unit tests (dHash, distance)
docs/             build plan, demo script, Devpost text
```

## Tests

```bash
npm test
```

## Honest limitations

- A determined attacker can spoof GPS. GroundTruth raises the cost of fraud with layered signals and human review; it doesn't claim to be impossible to fool.
- Hunter identity/KYC, tax reporting and disputes are out of scope for the hackathon.
- Data lives in a JSON file (`data/db.json`). Swap in a real database for production.
- Owner actions (review, cancel, reset) are not authenticated in this demo build.

## License

MIT, see [LICENSE](LICENSE).
