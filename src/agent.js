// "Atlas" — a Claude-powered concierge agent that hires humans for real-world ground truth.
// Manual tool loop so the conversation can pause while a bounty is open and resume when it resolves.
import Anthropic from '@anthropic-ai/sdk';
import { config, aiMock, aiProvider } from './config.js';
import { generate as geminiGenerate, toGeminiTools } from './gemini.js';
import { chat as openrouterChat, toOpenAITools } from './openrouter.js';
import { db, save, emit, id, getMission, getBounty } from './store.js';
import { geocode, haversineMeters } from './geo.js';
import { createBounty, walletView, policyView, PolicyError, onBountyResolved, publicBounty } from './bounties.js';

const client = aiProvider === 'claude' ? new Anthropic({ apiKey: config.anthropic.apiKey }) : null;
const AGENT_ID = 'atlas';

const SYSTEM = `You are Atlas, a local concierge AI agent. You help a user make real-world decisions (where to eat, whether a place is open or crowded, whether an item is in stock, whether a street is passable).

Online data is often stale. You have a superpower: you can hire a nearby human through GroundTruth to capture live photo evidence, paid from your PayPal-funded wallet. Use it when the decision depends on the CURRENT physical state of a place and you cannot know it reliably otherwise. Don't use it for things you can answer from general knowledge.

When you post a bounty:
- Resolve the exact place first with geocode_place (prefer the match nearest the user). Check list_open_bounties to avoid paying twice for the same question.
- Write ONE question that a single photo can answer unambiguously (e.g. "Photograph the entrance and the seating area so we can see if it is open and how many tables are free").
- Give an answer_hint describing the short answer you want back.
- Price fairly: $1-3 for a quick photo on a busy street, $3-6 if it requires going inside or waiting. Respect the wallet and policy limits returned by check_wallet; never try to work around them.
- Choose an expiry that matches the user's urgency (usually 15-60 minutes).
After posting, end your turn with a short message telling the user what you are checking and roughly how long it may take. Do not invent the answer.

When you receive a [GroundTruth event] message, a human-verified answer has arrived (photo checked for location, freshness, originality and relevance). Use it to give the user a clear, decisive recommendation. Mention that it was verified live and when. If the evidence is inconclusive, say so and suggest a next step.

Keep replies short and practical.`;

const TOOLS = [
  {
    name: 'geocode_place',
    description: 'Look up a place or address and return candidate coordinates. Results are biased toward the user location.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Place name and city, or an address' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_wallet',
    description: 'Return the agent wallet (funded by the owner via PayPal) and the spending policy limits.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_open_bounties',
    description: 'List currently open GroundTruth bounties within 3 km of a point, to avoid posting duplicates.',
    input_schema: {
      type: 'object',
      properties: { lat: { type: 'number' }, lng: { type: 'number' } },
      required: ['lat', 'lng'],
      additionalProperties: false,
    },
  },
  {
    name: 'post_bounty',
    description:
      'Post a paid real-world verification task. The reward is reserved from the wallet and paid via PayPal Payouts to the first human whose live photo passes verification.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title, e.g. "Is Blue Bottle Coffee open & busy?"' },
        question: { type: 'string', description: 'Exact instruction for the human; must be answerable from one photo.' },
        answer_hint: { type: 'string', description: 'The short answer format wanted, e.g. "open/closed + approx free tables"' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        place_name: { type: 'string' },
        radius_m: { type: 'number', description: 'How close the human must be, 50-500 m. Default 150.' },
        reward_usd: { type: 'number' },
        expires_in_minutes: { type: 'number' },
      },
      required: ['title', 'question', 'answer_hint', 'lat', 'lng', 'place_name', 'reward_usd', 'expires_in_minutes'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bounty',
    description: 'Get the status of a bounty you posted, including the verified answer if resolved.',
    input_schema: {
      type: 'object',
      properties: { bounty_id: { type: 'string' } },
      required: ['bounty_id'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- tool execution

async function runTool(mission, name, input) {
  switch (name) {
    case 'geocode_place': {
      const near = mission.userLocation;
      const rows = await geocode(String(input.query), near);
      return rows.map((r) => ({
        ...r,
        distance_from_user_m: near ? Math.round(haversineMeters(near.lat, near.lng, r.lat, r.lng)) : null,
      }));
    }
    case 'check_wallet':
      return { wallet: walletView(AGENT_ID), policy: policyView(AGENT_ID) };
    case 'list_open_bounties':
      return db.bounties
        .filter((b) => b.status === 'open' && haversineMeters(input.lat, input.lng, b.lat, b.lng) < 3000)
        .map((b) => ({ id: b.id, title: b.title, question: b.question, rewardUsd: b.rewardUsd, expiresAt: b.expiresAt }));
    case 'post_bounty': {
      const b = createBounty({
        agentId: AGENT_ID,
        missionId: mission.id,
        title: input.title,
        question: input.question,
        answerHint: input.answer_hint,
        lat: input.lat,
        lng: input.lng,
        placeName: input.place_name,
        radiusM: input.radius_m ?? 150,
        rewardUsd: input.reward_usd,
        expiresInMinutes: input.expires_in_minutes,
      });
      mission.bountyIds.push(b.id);
      return { bounty_id: b.id, status: b.status, reward_usd: b.rewardUsd, expires_at: b.expiresAt, link: `${config.baseUrl}/bounty.html?id=${b.id}` };
    }
    case 'get_bounty': {
      const b = getBounty(input.bounty_id);
      if (!b) throw new Error('No such bounty');
      return publicBounty(b);
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- mission lifecycle

function log(mission, entry) {
  const e = { at: new Date().toISOString(), ...entry };
  mission.log.push(e);
  save();
  emit('mission.log', { missionId: mission.id, entry: e });
}

export function startMission({ goal, userLocation }) {
  const mission = {
    id: id('msn'),
    agentId: AGENT_ID,
    goal: String(goal).slice(0, 2000),
    userLocation: userLocation && typeof userLocation.lat === 'number' ? userLocation : null,
    status: 'running',
    createdAt: new Date().toISOString(),
    messages: [],
    log: [],
    bountyIds: [],
    pending: [],
    running: false,
  };
  db.missions.push(mission);
  const loc = mission.userLocation
    ? `The user is at lat ${mission.userLocation.lat.toFixed(5)}, lng ${mission.userLocation.lng.toFixed(5)}.`
    : 'The user location is unknown; ask for a city if needed.';
  mission.messages.push({ role: 'user', content: `${mission.goal}\n\n(${loc} Current time: ${new Date().toISOString()})` });
  log(mission, { kind: 'user', text: mission.goal });
  save();
  emit('mission.started', { missionId: mission.id, goal: mission.goal });
  drive(mission).catch((e) => fail(mission, e));
  return mission;
}

/** Follow-up message from the user in an existing conversation. */
export function continueMission(mission, { text, userLocation }) {
  text = String(text).slice(0, 2000);
  if (userLocation && typeof userLocation.lat === "number") mission.userLocation = userLocation;
  const loc = mission.userLocation
    ? `The user is at lat ${mission.userLocation.lat.toFixed(5)}, lng ${mission.userLocation.lng.toFixed(5)}.`
    : "The user location is unknown.";
  const msg = { role: "user", content: `${text}

(${loc} Current time: ${new Date().toISOString()})` };
  log(mission, { kind: "user", text });
  if (mission.running) mission.pending.push(msg);
  else {
    mission.messages.push(msg);
    drive(mission).catch((e) => fail(mission, e));
  }
  return mission;
}

function fail(mission, e) {
  console.error('[agent]', e);
  mission.status = 'error';
  mission.running = false;
  log(mission, { kind: 'error', text: e.message });
}

async function drive(mission) {
  if (mission.running) return;
  mission.running = true;
  mission.status = 'running';
  save();
  try {
    if (aiMock) await mockTurn(mission);
    else if (aiProvider === 'gemini') await geminiLoop(mission);
    else if (aiProvider === 'openrouter') await openrouterLoop(mission);
    else await claudeLoop(mission);
  } finally {
    mission.running = false;
    const waiting = mission.bountyIds.some((bid) => getBounty(bid)?.status === 'open');
    if (mission.status !== 'error') mission.status = waiting ? 'waiting' : 'done';
    save();
    emit('mission.status', { missionId: mission.id, status: mission.status });
    if (mission.pending.length) {
      mission.messages.push(...mission.pending.splice(0));
      drive(mission).catch((e) => fail(mission, e));
    }
  }
}

async function claudeLoop(mission) {
  for (let i = 0; i < 12; i++) {
    const response = await client.beta.messages.create({
      model: config.anthropic.model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: TOOLS,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: mission.messages,
    });

    // Append-only history (keeps thinking blocks valid across turns).
    mission.messages.push({ role: 'assistant', content: response.content });
    for (const block of response.content) {
      if (block.type === 'thinking' && block.thinking) log(mission, { kind: 'thought', text: block.thinking });
      if (block.type === 'text' && block.text.trim()) log(mission, { kind: 'agent', text: block.text });
    }
    save();

    if (response.stop_reason === 'refusal') {
      log(mission, { kind: 'error', text: 'The model declined this request.' });
      return;
    }
    if (response.stop_reason === 'pause_turn') continue;
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) return;

    const results = [];
    for (const tu of toolUses) {
      log(mission, { kind: 'tool', tool: tu.name, input: tu.input });
      try {
        const out = await runTool(mission, tu.name, tu.input);
        log(mission, { kind: 'tool_result', tool: tu.name, output: out });
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
      } catch (e) {
        const blocked = e instanceof PolicyError;
        log(mission, { kind: blocked ? 'policy_block' : 'tool_error', tool: tu.name, text: e.message });
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          is_error: true,
          content: blocked ? `BLOCKED BY SPENDING POLICY (${e.rule}): ${e.message}` : e.message,
        });
      }
    }
    mission.messages.push({ role: 'user', content: results });
    save();
  }
  log(mission, { kind: 'error', text: 'Stopped after 12 steps.' });
}

// OpenRouter (OpenAI-compatible) version of the same loop, with its own history (ocontents).
const OPENAI_TOOLS = toOpenAITools(TOOLS);

async function openrouterLoop(mission) {
  mission.ocontents ||= [{ role: 'system', content: SYSTEM }];
  mission.oSynced ||= 0;
  for (; mission.oSynced < mission.messages.length; mission.oSynced++) {
    const m = mission.messages[mission.oSynced];
    if (m.role === 'user' && typeof m.content === 'string') mission.ocontents.push({ role: 'user', content: m.content });
  }
  for (let i = 0; i < 12; i++) {
    const choice = await openrouterChat({ messages: mission.ocontents, tools: OPENAI_TOOLS, max_tokens: 4000 });
    const msg = choice.message || { role: 'assistant', content: '' };
    const calls = msg.tool_calls || [];
    mission.ocontents.push({ role: 'assistant', content: msg.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (msg.reasoning?.trim()) log(mission, { kind: 'thought', text: msg.reasoning.trim() });
    if (typeof msg.content === 'string' && msg.content.trim()) log(mission, { kind: 'agent', text: msg.content.trim() });
    save();

    if (!calls.length) {
      if (choice.finish_reason && !['stop', 'length', 'tool_calls'].includes(choice.finish_reason))
        log(mission, { kind: 'error', text: `The model stopped early (${choice.finish_reason}).` });
      return;
    }
    for (const call of calls) {
      const name = call.function?.name;
      let input = {};
      let content;
      try {
        input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        content = 'Error: tool arguments were not valid JSON. Call the tool again with valid JSON.';
      }
      if (content === undefined) {
        log(mission, { kind: 'tool', tool: name, input });
        try {
          const out = await runTool(mission, name, input);
          log(mission, { kind: 'tool_result', tool: name, output: out });
          content = JSON.stringify(out);
        } catch (e) {
          const blocked = e instanceof PolicyError;
          log(mission, { kind: blocked ? 'policy_block' : 'tool_error', tool: name, text: e.message });
          content = blocked ? `BLOCKED BY SPENDING POLICY (${e.rule}): ${e.message}` : `Error: ${e.message}`;
        }
      }
      mission.ocontents.push({ role: 'tool', tool_call_id: call.id, content });
    }
    save();
  }
  log(mission, { kind: 'error', text: 'Stopped after 12 steps.' });
}

// Gemini version of the same loop. Its own history (gcontents) keeps model turns verbatim,
// including thought signatures; plain user/event messages are copied over from mission.messages.
const GEMINI_TOOLS = toGeminiTools(TOOLS);

async function geminiLoop(mission) {
  mission.gcontents ||= [];
  mission.gSynced ||= 0;
  for (; mission.gSynced < mission.messages.length; mission.gSynced++) {
    const m = mission.messages[mission.gSynced];
    if (m.role === 'user' && typeof m.content === 'string') mission.gcontents.push({ role: 'user', parts: [{ text: m.content }] });
  }
  for (let i = 0; i < 12; i++) {
    const cand = await geminiGenerate({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: mission.gcontents,
      tools: GEMINI_TOOLS,
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    });
    const content = cand.content || { role: 'model', parts: [] };
    content.role = 'model';
    mission.gcontents.push(content);
    const parts = content.parts || [];
    for (const p of parts) {
      if (p.thought && p.text) log(mission, { kind: 'thought', text: p.text });
      else if (p.text?.trim()) log(mission, { kind: 'agent', text: p.text });
    }
    save();

    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason))
        log(mission, { kind: 'error', text: `The model stopped early (${cand.finishReason}).` });
      return;
    }
    const responses = [];
    for (const { functionCall: fc } of calls) {
      const input = fc.args || {};
      log(mission, { kind: 'tool', tool: fc.name, input });
      let response;
      try {
        const out = await runTool(mission, fc.name, input);
        log(mission, { kind: 'tool_result', tool: fc.name, output: out });
        response = { result: out };
      } catch (e) {
        const blocked = e instanceof PolicyError;
        log(mission, { kind: blocked ? 'policy_block' : 'tool_error', tool: fc.name, text: e.message });
        response = { error: blocked ? `BLOCKED BY SPENDING POLICY (${e.rule}): ${e.message}` : e.message };
      }
      responses.push({ functionResponse: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, response } });
    }
    mission.gcontents.push({ role: 'user', parts: responses });
    save();
  }
  log(mission, { kind: 'error', text: 'Stopped after 12 steps.' });
}

// Deterministic stand-in so the app is fully demoable without an Anthropic key.
async function mockTurn(mission) {
  const last = mission.messages[mission.messages.length - 1];
  const text = typeof last.content === 'string' ? last.content : '';
  if (text.startsWith('[GroundTruth event]')) {
    const b = getBounty(mission.bountyIds[mission.bountyIds.length - 1]);
    log(mission, {
      kind: 'agent',
      text: `(mock agent) A nearby human just verified it live: "${b?.answer}". Based on that verified photo, go ahead.`,
    });
    return;
  }
  log(mission, { kind: 'thought', text: '(mock agent) This depends on the current state of a physical place — posting a GroundTruth bounty.' });
  const loc = mission.userLocation || { lat: 37.7749, lng: -122.4194 };
  const input = {
    title: mission.goal.slice(0, 60),
    question: `Take a clear photo that answers: ${mission.goal}`,
    answer_hint: 'one short sentence',
    lat: loc.lat,
    lng: loc.lng,
    place_name: 'Near the user',
    radius_m: 300,
    reward_usd: 2,
    expires_in_minutes: 30,
  };
  log(mission, { kind: 'tool', tool: 'post_bounty', input });
  try {
    const out = await runTool(mission, 'post_bounty', input);
    log(mission, { kind: 'tool_result', tool: 'post_bounty', output: out });
    log(mission, { kind: 'agent', text: `(mock agent) I posted a $2 bounty for a live photo. I'll report back as soon as a human verifies it.` });
  } catch (e) {
    log(mission, { kind: e instanceof PolicyError ? 'policy_block' : 'tool_error', tool: 'post_bounty', text: e.message });
    log(mission, { kind: 'agent', text: `(mock agent) I couldn't post the bounty: ${e.message}` });
  }
}

// Wake the agent when one of its bounties gets a verified answer.
onBountyResolved((bounty, submission) => {
  const mission = bounty.missionId && getMission(bounty.missionId);
  if (!mission) return;
  const passed = submission.signals.filter((s) => s.status === 'pass').map((s) => s.label).join(', ');
  const msg = {
    role: 'user',
    content:
      `[GroundTruth event] Bounty ${bounty.id} ("${bounty.title}") was answered and verified.\n` +
      `Verified answer: ${bounty.answer}\n` +
      `Scene: ${submission.ai?.scene_description || 'n/a'}\n` +
      `Checks passed: ${passed || 'reviewed by a human'}${submission.reviewedBy ? ' (approved by human reviewer)' : ''}\n` +
      `Captured at: ${submission.capturedAt}. Reward of $${bounty.rewardUsd} paid to the human via PayPal Payouts.`,
  };
  log(mission, { kind: 'event', text: `Bounty verified: ${bounty.answer}`, bountyId: bounty.id });
  if (mission.running) mission.pending.push(msg);
  else {
    mission.messages.push(msg);
    drive(mission).catch((e) => fail(mission, e));
  }
});

export function missionView(m) {
  const { messages, pending, gcontents, gSynced, ocontents, oSynced, ...rest } = m;
  return rest;
}

/** On restart, missions that were mid-run are no longer running. */
export function recoverMissions() {
  for (const m of db.missions) if (m.running) m.running = false;
  save();
}
