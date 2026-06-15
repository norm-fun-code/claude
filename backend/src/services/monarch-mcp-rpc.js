// Direct JSON-RPC client for Monarch's MCP server — NO Claude/LLM in the loop.
// The MCP connector in monarch-mcp.js routes through Anthropic for natural-language
// chat; this module instead speaks the MCP Streamable-HTTP protocol directly so the
// daily sync can pull authoritative numbers deterministically (and for free) and
// cache them in PostgreSQL. Reuses the OAuth access-token minting from monarch-mcp.js.
const axios = require('axios');
const { getAccessToken, MCP_URL } = require('./monarch-mcp');

const PROTOCOL_VERSION = process.env.MONARCH_MCP_PROTOCOL_VERSION || '2025-11-25';

// A Streamable-HTTP response is either application/json (single object) or
// text/event-stream (SSE: one-or-more `data:` lines). Normalize both to the
// last JSON-RPC message object.
function parseMcpResponse(contentType, raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw ?? '');
  if (contentType && contentType.includes('text/event-stream')) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^data:\s?(.*)$/);
      if (m && m[1]) {
        try { last = JSON.parse(m[1]); } catch { /* skip non-JSON keepalives */ }
      }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function rpc(sessionId, body, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return axios.post(MCP_URL, body, {
    headers,
    timeout: Number(process.env.MONARCH_MCP_TIMEOUT_MS || 30000),
    responseType: 'text',
    transformResponse: (d) => d, // keep raw so we can detect/parse SSE ourselves
    validateStatus: () => true,
  });
}

// Open an MCP session: initialize handshake (captures Mcp-Session-Id if the
// server is stateful) + the required `initialized` notification.
async function openSession(token) {
  const res = await rpc(
    null,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'NormOS', version: '1.0.0' },
      },
    },
    token
  );
  if (res.status >= 400) {
    throw new Error(`MCP initialize failed: HTTP ${res.status} ${String(res.data).slice(0, 300)}`);
  }
  const sessionId = res.headers['mcp-session-id'] || null;
  await rpc(sessionId, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, token);
  return { sessionId };
}

/** List all tools the Monarch MCP server exposes (name, description, inputSchema). */
async function listTools() {
  const token = await getAccessToken();
  const { sessionId } = await openSession(token);
  const res = await rpc(sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token);
  const parsed = parseMcpResponse(res.headers['content-type'], res.data);
  if (parsed?.error) throw new Error(`MCP tools/list error: ${JSON.stringify(parsed.error)}`);
  return parsed?.result?.tools || [];
}

/** Call a Monarch MCP tool by name. Returns the raw MCP result (content blocks). */
async function callTool(name, args = {}) {
  const token = await getAccessToken();
  const { sessionId } = await openSession(token);
  const res = await rpc(
    sessionId,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } },
    token
  );
  const parsed = parseMcpResponse(res.headers['content-type'], res.data);
  if (parsed?.error) throw new Error(`MCP tools/call error (${name}): ${JSON.stringify(parsed.error)}`);
  return parsed?.result;
}

/** Pull the first text content block out of a tool result and JSON-parse it. */
function extractJsonContent(result) {
  const block = (result?.content || []).find((b) => b.type === 'text');
  if (!block) return null;
  try { return JSON.parse(block.text); } catch { return block.text; }
}

/** Convenience: call a tool and return its parsed JSON payload. */
async function callToolJson(name, args = {}) {
  return extractJsonContent(await callTool(name, args));
}

module.exports = { listTools, callTool, callToolJson, extractJsonContent };
