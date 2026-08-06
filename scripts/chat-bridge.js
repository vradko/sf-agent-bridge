#!/usr/bin/env node

/**
 * Chat Bridge — connects Salesforce Agent Chat to Claude Code.
 *
 * Agentic tool-use loop: Claude receives the discovered component/action
 * schemas and decides which bridge actions to call. The bridge executes
 * them over CDP/BroadcastChannel and feeds results back until Claude
 * produces a final reply.
 *
 *   User (agentChat LWC) → orchestrator → this script
 *        → claude -p  (decides: call tool | reply)
 *        → bridge execute … repeat …
 *        → final reply → orchestrator → agentChat
 *
 * Usage: node scripts/chat-bridge.js [--port 9444]
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');

const CDP_PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1], 10)
  : 9444;

const POLL_INTERVAL = 1500;
const MAX_TOOL_STEPS = 5;
const AGENT_TURN_TIMEOUT = 225000;
const PROJECT_DIR = path.join(__dirname, '..');

// ── CDP Helpers ────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

function cdp(ws, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e5);
    const handler = (msg) => {
      const d = JSON.parse(msg);
      if (d.id === id) {
        clearTimeout(timeout);
        ws.off('message', handler);
        d.error ? reject(new Error(d.error.message)) : resolve(d.result);
      }
    };
    const timeout = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('CDP timeout: ' + method));
    }, timeoutMs);
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression, timeoutMs) {
  const r = await cdp(
    ws,
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true
    },
    timeoutMs
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text || 'JS error');
  }
  return r.result.value;
}

// ── Bridge Helpers ─────────────────────────────────────────────

async function bridgeCall(ws, tabId, action, payload = {}, timeoutMs = 15000) {
  const callId = 'bridge-' + Math.random().toString(36).substring(7);
  // omit tabId when unknown — a stringified null is silently ignored
  const msg = { type: 'request', id: callId, action, payload };
  if (tabId) msg.tabId = tabId;
  const code = `
        new Promise((resolve, reject) => {
            const ch = new BroadcastChannel('sf-agent-bridge');
            const t = setTimeout(() => {
                ch.close();
                reject(new Error('bridge timeout'));
            }, ${timeoutMs - 2000});
            ch.onmessage = (e) => {
                if (e.data.type === 'response' && e.data.id === '${callId}') {
                    clearTimeout(t);
                    ch.close();
                    resolve(JSON.stringify(e.data));
                }
            };
            ch.postMessage(${JSON.stringify(msg)});
        })
    `;
  return JSON.parse(await evaluate(ws, code, timeoutMs));
}

async function handshake(ws) {
  const raw = await evaluate(
    ws,
    'new Promise((r,j)=>{const t=setTimeout(()=>j(new Error("no orch")),5000);document.addEventListener("sf-agent-bridge:handshake-response",e=>{clearTimeout(t);r(JSON.stringify(e.detail));},{once:true});document.dispatchEvent(new CustomEvent("sf-agent-bridge:handshake",{detail:{requestId:"bridge"}}));})'
  );
  return JSON.parse(raw).tabId;
}

// ── Claude Tool-Use Loop ───────────────────────────────────────

function buildSystemPrompt(components) {
  return [
    'You are an AI agent operating a live Salesforce page through SF Agent Bridge.',
    'A user is chatting with you from a chat widget inside Salesforce.',
    '',
    'Components currently available on the page (with their action schemas):',
    JSON.stringify(components, null, 2),
    '',
    'To act, respond with ONLY a JSON object — no prose, no markdown fences:',
    '  {"tool": {"componentId": "<id>", "actionName": "<name>", "params": {...}}}',
    'You will receive the result and can call another tool or answer.',
    '',
    'When you have enough information, respond with ONLY:',
    '  {"reply": "<your final answer to the user>"}',
    '',
    'Rules:',
    '- The user SEES the page: when you filter or update, the UI changes live in front of them.',
    '- Actions marked dangerous:true show the user an approval dialog; if rejected, explain that calmly.',
    '- Reply in the same language the user writes in.',
    '- Keep replies concise — this is a small chat window.'
  ].join('\n');
}

function parseAgentJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.substring(start, end + 1));
  } catch {
    return null;
  }
}

function callClaude(prompt, sessionId, timeoutMs) {
  const args = ['-p', prompt];
  if (sessionId) args.push('--resume', sessionId);
  args.push(
    '--output-format',
    'json',
    '--disallowedTools',
    'Bash Read Edit Write Glob Grep WebSearch WebFetch Task Agent'
  );
  const output = execFileSync('claude', args, {
    cwd: PROJECT_DIR,
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim();
  const parsed = JSON.parse(output);
  return { text: parsed.result || '', sessionId: parsed.session_id || sessionId };
}

async function runAgentTurn(ws, tabId, userMessage, sessionId) {
  const deadline = Date.now() + AGENT_TURN_TIMEOUT;
  const remainingTime = () => deadline - Date.now();
  // per-turn nonce keeps idempotency keys unique across turns even if the CLI
  // ever returns a stable session id; params hash guards against step-index reuse
  const turnNonce = crypto.randomBytes(4).toString('hex');

  // fresh discover every turn — the page may have changed
  let components = [];
  try {
    const disc = await bridgeCall(ws, tabId, 'discover');
    components = disc.payload?.components || [];
  } catch (e) {
    console.log('[chat-bridge] discover failed:', e.message, '— continuing without components');
  }

  let prompt = sessionId
    ? `User message: ${userMessage}\n\nCurrent components on page:\n${JSON.stringify(components)}`
    : `${buildSystemPrompt(components)}\n\nUser message: ${userMessage}`;

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    if (remainingTime() < 5000) {
      return { reply: 'This request took too long. Please try a narrower request.', sessionId };
    }
    let res;
    try {
      res = callClaude(prompt, sessionId, Math.min(60000, remainingTime() - 2000));
    } catch (e) {
      return { reply: 'Error: ' + (e.message || 'unknown').substring(0, 120), sessionId };
    }
    sessionId = res.sessionId;

    const parsed = parseAgentJson(res.text);
    if (!parsed) {
      return { reply: res.text || 'No response.', sessionId };
    }
    if (parsed.reply) {
      return { reply: parsed.reply, sessionId };
    }
    if (parsed.tool) {
      const { componentId, actionName, params } = parsed.tool;
      console.log(`  [TOOL ${step + 1}] ${actionName}`, JSON.stringify(params || {}));
      let toolResult;
      try {
        const toolTimeout = Math.min(130000, remainingTime() - 2000);
        if (toolTimeout < 5000) throw new Error('Agent turn deadline reached');
        const paramsHash = crypto
          .createHash('sha1')
          .update(JSON.stringify(params || {}))
          .digest('hex')
          .slice(0, 8);
        const r = await bridgeCall(
          ws,
          tabId,
          'execute',
          {
            componentId,
            actionName,
            params: params || {},
            idempotencyKey: `chat:${turnNonce}:${step}:${componentId}:${actionName}:${paramsHash}`
          },
          toolTimeout
        );
        toolResult = r.status === 'error' ? { error: true, message: r.payload?.message || 'Unknown error' } : r.payload;
      } catch (e) {
        toolResult = { error: true, message: e.message };
      }
      // stale componentId after page reload: give the model fresh ids to retry with
      if (toolResult && toolResult.error && /not found/i.test(toolResult.message || '')) {
        try {
          const rd = await bridgeCall(ws, tabId, 'discover');
          toolResult.currentComponents = (rd.payload?.components || []).map((c) => ({
            componentId: c.componentId,
            label: c.label
          }));
          toolResult.hint = 'Component ids changed (page reloaded). Retry with one of currentComponents.';
        } catch {
          /* discover also failed — let the model see the original error */
        }
      }
      prompt = `Tool result for ${actionName}:\n${JSON.stringify(toolResult)}`;
      continue;
    }
    return { reply: res.text, sessionId };
  }
  return { reply: 'I hit my tool-call limit for this request. Try narrowing it down.', sessionId };
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('[chat-bridge] Connecting to Chrome CDP on port', CDP_PORT);

  const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  const sfTab =
    tabs.find((t) => t.type === 'page' && t.url.includes('lightning')) ||
    tabs.find((t) => t.type === 'page' && t.url.includes('salesforce'));

  if (!sfTab) {
    console.error('[chat-bridge] No Salesforce tab found.');
    process.exit(1);
  }

  console.log('[chat-bridge] Tab:', sfTab.title?.substring(0, 60));

  const ws = new WebSocket(sfTab.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.setMaxListeners(0); // each CDP call adds a short-lived listener; default cap of 10 warns

  // retry while the Lightning page is still rendering
  let tabId = null;
  for (let attempt = 1; attempt <= 12 && !tabId; attempt++) {
    try {
      tabId = await handshake(ws);
      console.log('[chat-bridge] Orchestrator tabId:', tabId.substring(0, 8) + '...');
    } catch (e) {
      console.log(`[chat-bridge] Handshake attempt ${attempt}: ${e.message} — retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (!tabId) {
    console.log('[chat-bridge] No orchestrator found — continuing, will retry per message.');
  }

  // idempotent (restart must not double listeners); lives in the page,
  // dies on reload — the poll loop re-injects
  const injectChatListener = () =>
    evaluate(
      ws,
      `(() => {
            if (window.__chatBridgeChannel) {
                try { window.__chatBridgeChannel.close(); } catch (e) { /* already closed */ }
            }
            window.__chatBridgeInbox = [];
            const ch = new BroadcastChannel("sf-agent-bridge");
            window.__chatBridgeChannel = ch;
            ch.addEventListener("message", (event) => {
                if (event.data.type === "request" && event.data.action === "chat") {
                    window.__chatBridgeInbox.push({
                        id: event.data.id,
                        message: event.data.payload?.message || "",
                        chatInstanceId: event.data.payload?.chatInstanceId || "",
                        tabId: event.data.payload?.tabId || "",
                        timestamp: new Date().toISOString()
                    });
                }
            });
        })()`
    );
  await injectChatListener();

  console.log('[chat-bridge] Listening for chat messages...\n');

  const sessions = new Map();
  let processing = false;
  const seenIds = new Set(); // orphaned in-page listeners can double-push
  setInterval(async () => {
    if (processing) return;

    try {
      const raw = await evaluate(
        ws,
        '(() => { if (!window.__chatBridgeChannel) return "REINJECT"; const m = window.__chatBridgeInbox || []; if (!m.length) return null; window.__chatBridgeInbox = []; return JSON.stringify(m); })()'
      );

      if (raw === 'REINJECT') {
        console.log('[chat-bridge] Page reloaded — re-injecting chat listener');
        await injectChatListener();
        return;
      }
      if (!raw) return;
      processing = true;

      const messages = JSON.parse(raw).filter((m) => {
        if (seenIds.has(m.id)) return false;
        seenIds.add(m.id);
        if (seenIds.size > 500) seenIds.clear();
        return true;
      });
      for (const msg of messages) {
        console.log('[USER]', msg.message);

        if (!tabId) {
          try {
            tabId = await handshake(ws);
          } catch {
            /* keep broadcast mode */
          }
        }
        if (!tabId) {
          const reply = 'The Salesforce bridge is not available yet. Please try again after the page finishes loading.';
          await sendChatReply(ws, msg.id, reply);
          continue;
        }

        const sessionKey = msg.chatInstanceId || 'default';
        const turn = await runAgentTurn(ws, tabId, msg.message, sessions.get(sessionKey) || null);
        if (turn.sessionId) sessions.set(sessionKey, turn.sessionId);
        const reply = turn.reply;

        console.log('[AGENT]', reply.substring(0, 120) + (reply.length > 120 ? '...' : ''));

        await sendChatReply(ws, msg.id, reply);
        console.log('[SENT]\n');
      }

      processing = false;
    } catch (err) {
      processing = false;
      if (err.message.includes('Target closed') || err.message.includes('not open')) {
        console.log('[chat-bridge] Tab closed. Exiting.');
        process.exit(0);
      }
      console.error('[chat-bridge] Error:', err.message);
    }
  }, POLL_INTERVAL);
}

function sendChatReply(ws, requestId, reply) {
  const safeId = JSON.stringify(requestId);
  const safeReply = JSON.stringify(reply);
  return evaluate(
    ws,
    `(() => {
            const ch = window.__chatBridgeChannel;
            if (ch) {
                ch.postMessage({
                    type: "response",
                    id: ${safeId},
                    status: "ok",
                    payload: { reply: ${safeReply} }
                });
            }
        })()`
  );
}

main().catch((err) => {
  console.error('[chat-bridge] Fatal:', err.message);
  process.exit(1);
});
