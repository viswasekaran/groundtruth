# Demo video script (target 2:45)

**Setup before recording**
- Deploy to Render (HTTPS), with real PayPal sandbox and Anthropic keys set. Both pills show `sandbox` / `live`.
- Reset data: `POST /api/demo/reset`. Have two windows: laptop (agent console) and phone (hunter app, screen-recorded).
- Stand within ~100 m of a real café or shop. Have the phone logged in to nothing; type a sandbox personal email.
- Sandbox accounts ready: buyer (to fund) and receiver (hunter).

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Landing page, map | "AI agents can read the whole internet, but they can't see the street. When your agent needs to know if a café is open or a road is flooded *right now*, the data online is stale. GroundTruth fixes that." |
| 0:15–0:35 | Agent console → PayPal button → sandbox checkout → wallet shows $25 | "I fund my agent's wallet with PayPal Checkout. This is the Orders API: create, approve, capture. The agent can only spend what's here, inside a spending policy enforced in code." |
| 0:35–1:05 | Type mission: "I want to work from a quiet café near me in the next 30 min, find one with free tables right now." Show thoughts, geocode, check_wallet, post_bounty | "Atlas is a Claude agent. It realizes this depends on the current state of a real place, finds the café, writes a task that a single photo can answer, prices it at $3, and posts a bounty. $3 is now reserved in escrow." |
| 1:05–1:35 | Phone: hunter app shows the task "45 m away, you are in range", opens live camera, snap, add note, submit | "Anyone nearby can earn. The camera is live, so there are no gallery uploads. GPS, timestamp and the photo go to the referee." |
| 1:35–2:00 | Phone result: ✅ verified, trust signals all green, PayPal payout PENDING → SUCCESS | "Five checks: live capture, inside the radius, fresh, not a reused photo (perceptual hash), and Claude vision confirms the photo actually answers the question. Everything passes, so PayPal Payouts pays the hunter instantly." |
| 2:00–2:15 | Laptop: agent console wakes up with the verified answer and recommendation | "The agent wakes up with verified ground truth and makes the call." |
| 2:15–2:30 | Quick cuts: resubmit same photo → rejected (duplicate); ask agent to post a $20 bounty → red policy block | "Fraud and runaway agents are handled. A recycled photo is rejected, and an agent trying to overspend is blocked by the firewall." |
| 2:30–2:45 | developers.html (MCP config) | "Any agent can use it. It's a REST API and an MCP server, so Claude or any MCP client can hire humans with one tool call. GroundTruth: agents ask, humans verify, PayPal pays." |

**Tips**
- Record the phone with its built-in screen recorder and splice it in. Keep the cursor visible on the laptop.
- If the café is busy, a photo of the seating area makes the AI answer more impressive.
- Upload as Unlisted/Public on YouTube at least 3 hours before the deadline.
