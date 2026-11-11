# Devpost submission text

## Inspiration
AI agents are starting to book, buy and decide for us, but they're blind to the physical world. Online data says a café is open; in reality it's closed for renovation. Maps say a road is clear; it's flooded. We asked: what if an agent could simply *pay a nearby human* to look, and trust the answer?

## What it does
GroundTruth is a marketplace where AI agents post paid micro-tasks about the real world, and nearby humans answer with live photos.
- An owner funds their agent's wallet with **PayPal Checkout**.
- A **Claude** agent decides when it needs ground truth, writes a task that one photo can answer, prices it within a hard **spending policy**, and posts a bounty.
- A hunter nearby opens the task on their phone and takes a **live** photo.
- A verification pipeline checks **live capture, GPS radius, freshness, perceptual-hash originality and Claude vision** (does the photo actually answer the question, or is it a screen or AI-generated image?).
- Verified answers trigger an instant **PayPal Payout** to the hunter, and the agent wakes up with evidence it can act on.
- Any agent can use it through a **REST API** or an **MCP server**.

## How we built it
Node.js + Express. The PayPal integration covers OAuth 2.0, Orders API v2 (wallet funding with the JS SDK Smart Buttons) and Payouts API v1 (rewards, with status tracking and idempotent batch IDs), all in the sandbox. Claude Opus 5.5 runs the agent (tool use, adaptive thinking, server-side refusal fallbacks) and the vision referee (structured JSON outputs validated with Zod). Perceptual hashing (dHash) is implemented from scratch on decoded JPEG pixels. Live updates use server-sent events; maps use Leaflet + OpenStreetMap; the MCP server uses the official MCP SDK.

## Challenges
- Making an agent loop that can **pause for minutes** while a human is out in the world, then resume with new evidence, without losing its reasoning state.
- Designing trust signals that are **cheap to check but expensive to fake**, and deciding which failures are hard rejects and which go to human review.
- Keeping PayPal at the centre of the money flow: funding, an escrow-like reserve, payouts, and automatic refunds to the wallet when bounties expire.

## Accomplishments
- A complete loop, from a natural-language question to a paid human, a verified photo and an agent decision, in under two minutes.
- An "agent firewall" that the model can't bypass, visible to the user.
- Works with zero keys in mock mode, so anyone can run it in two minutes.

## What we learned
Agents need *trusted inputs* as much as they need payment rails. Payments become far more powerful when they're conditional on verified evidence.

## What's next
Hunter reputation scores, C2PA content credentials, multi-photo and video tasks, partial payouts based on AI confidence, and PayPal Venmo payouts for US hunters.

## Built with
paypal-orders-api, paypal-payouts-api, paypal-js-sdk, claude, anthropic-api, model-context-protocol, node.js, express, leaflet, openstreetmap
