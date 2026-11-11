# GroundTruth — Build Plan

**Pitch:** AI agents can read the whole internet, but they can't see what's happening on a street corner right now. GroundTruth lets any AI agent post a paid micro-task about the physical world ("Is this café open and how busy is it?"). A nearby human answers with a live photo, a layered verification pipeline (GPS, freshness, duplicate detection, Claude vision) acts as referee, and PayPal Payouts pays the human in seconds.

**Tagline:** Agents ask. Humans verify. PayPal pays.

**Deadline:** Nov 12, 2026, 12:00 PM PT.

**Status (Nov 9):** Phases 1–8 are built and tested end to end in mock mode. Still to do: test with real PayPal sandbox + Anthropic keys, test the camera on a real phone over HTTPS, deploy to Render, record the video, submit.

---

## Money flow (PayPal is central)

1. **Fund (PayPal Orders API v2):** The agent's owner tops up the agent's wallet with PayPal Checkout (create order, then capture). The captured amount becomes the agent's spendable budget.
2. **Escrow (internal ledger):** When the agent posts a bounty, the reward is reserved from the wallet, so an agent can't promise money it doesn't have.
3. **Pay (PayPal Payouts API v1):** When a submission is verified, the reward is paid to the hunter's PayPal email through Payouts. The batch status is tracked until it's SUCCESS.
4. **Refund to wallet:** Expired or cancelled bounties release their reserve back to the wallet.

**Spending policy ("agent firewall"):** a per-bounty cap, a daily cap and a minimum wallet reserve, enforced in code before every bounty. The agent can't bypass it.

## AI (Claude)

- **Agent (Claude Opus 5.5, tool use):** Tools are `geocode_place`, `list_open_bounties`, `post_bounty` and `get_bounty`. The agent decides when it needs ground truth, writes a precise and verifiable task, prices it, and posts it. When a bounty resolves, the server wakes the agent with the verified result so it can finish its answer to the user.
- **Verifier (Claude Opus 5.5 vision with structured output):** Checks that the photo answers the task, extracts the answer, and flags screen photos, AI-generated images and irrelevant photos. It returns strict JSON.

## Trust signals (layered fraud resistance)

| Signal | How |
|---|---|
| Live capture | The camera is opened in the browser (getUserMedia). No gallery uploads. |
| Location | The browser's GPS position must be within the bounty radius (haversine). GPS accuracy is also recorded. |
| Freshness | The capture timestamp must be within 2 minutes of server receipt, and inside the bounty window. |
| Duplicate | A perceptual hash (dHash) is compared with every previous submission (Hamming distance ≤ 6 means reused). |
| Vision AI | Claude checks relevance, extracts the answer and flags screen photos or AI-generated images. |

Score: all pass means **APPROVED**, so the payout fires automatically. A soft fail means **NEEDS_REVIEW**, and the owner approves with one click. A hard fail means **REJECTED**.

---

## Phases

### Phase 1: Scaffold ✅ target day 1
- Node 24 + Express 5, plain HTML/JS frontend (no build step, so judges can run it easily)
- JSON-file store, `.env` config, **mock mode** when keys are missing so the app always runs

### Phase 2: PayPal layer — day 1
- OAuth client-credentials token cache
- Orders: create and capture (wallet funding), JS SDK button on the agent console
- Payouts: create a batch and poll its status
- Mock implementations with the same interface

### Phase 3: Verification pipeline — day 1–2
- Server-side JPEG decode (jpeg-js), dHash, Hamming distance
- Geo and freshness checks
- Claude vision verdict with Zod structured output
- Decision engine, then automatic payout

### Phase 4: Agent — day 2
- Manual tool loop with the conversation persisted (append-only), resumable on bounty events
- Spending policy enforcement in `post_bounty`
- Activity log shown in the UI (the agent's reasoning and tool calls)

### Phase 5: UI — day 2
- `/` landing page with a live map (Leaflet + OpenStreetMap) and live stats
- `/agent.html`: mission chat, wallet + PayPal funding, policy, activity log
- `/hunter.html`: mobile-first map and list, live camera, submit, payout result
- `/bounty.html?id=`: trust report (each signal), photo, AI verdict, payout status

### Phase 6: Open agent access — day 2–3
- REST API `POST /api/v1/bounties` with API-key auth, so any agent can hire humans
- **MCP server** (`npm run mcp`), so Claude Desktop, Claude Code or any MCP client can post bounties as a tool

### Phase 7: End-to-end test — day 3
- Full flow in the browser in mock mode, then sandbox mode once keys are added

### Phase 8: Submission — day 3
- README (setup, architecture, tools used), MIT license, `render.yaml` for hosted demo
- Demo video script (under 3 min), Devpost text

## Out of scope (say so honestly in the submission)
- Real identity/KYC for hunters, production payout compliance, dispute handling
- Proof against a determined GPS spoofer (we raise cost of fraud; we don't claim perfection)
