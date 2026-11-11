#!/usr/bin/env node
// GroundTruth MCP server (stdio). Lets Claude Desktop / Claude Code / any MCP client
// hire humans for real-world verification, paid via PayPal.
//
//   GROUNDTRUTH_URL=http://localhost:3000 GROUNDTRUTH_API_KEY=change-me-demo-key node src/mcp.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.GROUNDTRUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.GROUNDTRUTH_API_KEY || process.env.AGENT_API_KEY || 'change-me-demo-key';

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const errorText = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

const server = new McpServer({ name: 'groundtruth', version: '0.1.0' });

server.registerTool(
  'groundtruth_post_bounty',
  {
    title: 'Hire a human to verify the real world',
    description:
      'Post a paid task for a nearby human to capture a live photo answering a question about a physical place ' +
      '(is it open, how busy, is an item in stock, is a road blocked). The reward is paid via PayPal Payouts after ' +
      'the photo passes location, freshness, originality and AI checks. Returns a bounty id to poll with groundtruth_get_bounty.',
    inputSchema: {
      title: z.string().describe('Short title'),
      question: z.string().describe('Exact instruction; must be answerable from one photo'),
      answer_hint: z.string().optional().describe('Short answer format wanted'),
      lat: z.number(),
      lng: z.number(),
      place_name: z.string().optional(),
      radius_m: z.number().optional().describe('50-2000 m, default 150'),
      reward_usd: z.number().describe('Reward in USD, e.g. 2'),
      expires_in_minutes: z.number().optional().describe('Default 60'),
    },
  },
  async (args) => {
    try {
      return text(await call('POST', '/api/v1/bounties', args));
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'groundtruth_get_bounty',
  {
    title: 'Check a GroundTruth bounty',
    description: 'Get the status of a bounty. When resolved, includes the verified answer, evidence photo URL and trust signals.',
    inputSchema: { bounty_id: z.string() },
  },
  async ({ bounty_id }) => {
    try {
      return text(await call('GET', `/api/v1/bounties/${encodeURIComponent(bounty_id)}`));
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'groundtruth_check_wallet',
  {
    title: 'Check GroundTruth wallet',
    description: 'Show the PayPal-funded wallet balance available for bounties and the spending policy limits.',
    inputSchema: {},
  },
  async () => {
    try {
      return text(await call('GET', '/api/v1/wallet'));
    } catch (e) {
      return errorText(e);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`GroundTruth MCP server connected (API: ${BASE})`);
