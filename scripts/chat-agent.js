#!/usr/bin/env node

/**
 * Chat Agent — autonomous agent that connects to Chrome via CDP,
 * listens for chat messages from agentChat, executes bridge actions,
 * and responds back through BroadcastChannel.
 *
 * Usage: node scripts/chat-agent.js [--port 9444]
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port
 *   - Salesforce page open with agentOrchestrator + agentChat
 *   - npm install ws
 */

const WebSocket = require('ws');
const http = require('http');

const CDP_PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1], 10)
  : 9444;

const POLL_INTERVAL = 800;

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

function cdp(ws, method, params = {}) {
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
    }, 15000);
    ws.on('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws, expression) {
  const r = await cdp(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text || 'JS error');
  }
  return r.result.value;
}

// ── Bridge Helpers ─────────────────────────────────────────────

async function bridgeCall(ws, tabId, action, payload = {}) {
  const callId = 'agent-' + Math.random().toString(36).substring(7);
  const message = {
    type: 'request',
    id: callId,
    action,
    payload,
    tabId
  };
  const code = `
        new Promise((resolve, reject) => {
            const ch = new BroadcastChannel('sf-agent-bridge');
            const t = setTimeout(() => {
                ch.close();
                reject(new Error('bridge timeout'));
            }, 15000);
            ch.onmessage = (e) => {
                if (e.data.type === 'response' && e.data.id === '${callId}') {
                    clearTimeout(t);
                    ch.close();
                    resolve(JSON.stringify(e.data));
                }
            };
            ch.postMessage(${JSON.stringify(message)});
        })
    `;
  return JSON.parse(await evaluate(ws, code));
}

function sendChatResponse(ws, requestId, reply) {
  const safeRequestId = JSON.stringify(requestId);
  return evaluate(
    ws,
    `
        (() => {
            const ch = new BroadcastChannel('sf-agent-bridge');
            ch.postMessage({
                type: 'response',
                id: ${safeRequestId},
                status: 'ok',
                payload: { reply: ${JSON.stringify(reply)} }
            });
            ch.close();
        })()
    `
  );
}

// ── Message Processing ─────────────────────────────────────────

async function processMessage(ws, tabId, userMessage) {
  const msg = userMessage.toLowerCase();
  const isCreateIntent =
    msg.includes('create') || msg.includes('створ') || msg.includes('add') || msg.includes('додай');

  try {
    // Discover components on the page
    const discovery = await bridgeCall(ws, tabId, 'discover');
    const components = discovery.payload?.components || [];

    if (components.length === 0) {
      return 'No bridge components found on this page.';
    }

    const manager = components.find((c) => c.label === 'CandidateManager');
    const rows = components.filter((c) => c.label === 'CandidateRow');
    const recordView = components.find((c) => c.label === 'CandidateRecordView');

    // ── Intent: discover / what's available ────────────────
    if (
      msg.includes('discover') ||
      msg.includes('component') ||
      msg.includes('what can') ||
      msg.includes('що вмієш') ||
      msg.includes('що можеш') ||
      msg.includes('help') ||
      msg.includes('допомог')
    ) {
      const lines = components
        .filter((c) => c.label !== 'CandidateRow')
        .map((c) => {
          const actions = c.actions.map((a) => a.name).join(', ');
          return '• ' + c.label + ': ' + actions;
        });
      let result = 'Found ' + components.length + ' component(s) on this page:\n' + lines.join('\n');
      if (rows.length > 0) {
        result += '\n+ ' + rows.length + ' CandidateRow components';
      }
      return result;
    }

    // ── Intent: show / list / get candidates ───────────────
    if (
      (!isCreateIntent && (msg.includes('candidate') || msg.includes('кандидат'))) ||
      msg.includes('show') ||
      msg.includes('list') ||
      msg.includes('покаж')
    ) {
      const target = manager || recordView;
      if (!target) return 'No candidate component found on this page.';

      if (recordView && !manager) {
        const rec = await bridgeCall(ws, tabId, 'execute', {
          componentId: recordView.componentId,
          actionName: 'getRecord',
          params: {}
        });
        const c = rec.payload;
        if (!c) return 'Could not load candidate record.';
        return (
          'Current candidate:\n' +
          '• Name: ' +
          (c.name || '-') +
          '\n' +
          '• Email: ' +
          (c.email || '-') +
          '\n' +
          '• Phone: ' +
          (c.phone || '-') +
          '\n' +
          '• Stage: ' +
          (c.stage || '-') +
          '\n' +
          '• Notes: ' +
          (c.notes || '-')
        );
      }

      const params = {};
      const stages = {
        interview: 'Interview',
        інтерв: 'Interview',
        screening: 'Screening',
        new: 'New',
        нов: 'New',
        offer: 'Offer',
        офер: 'Offer',
        hired: 'Hired',
        найнят: 'Hired',
        rejected: 'Rejected',
        відхил: 'Rejected'
      };
      for (const [key, val] of Object.entries(stages)) {
        if (msg.includes(key)) {
          params.stage = val;
          break;
        }
      }

      const result = await bridgeCall(ws, tabId, 'execute', {
        componentId: manager.componentId,
        actionName: 'getCandidates',
        params
      });

      const candidates = result.payload || [];
      if (candidates.length === 0) {
        return params.stage
          ? 'No candidates with stage "' + params.stage + '".'
          : 'No candidates found for this account.';
      }

      const lines = candidates.map(
        (c) => '• ' + (c.name || '') + ' — ' + (c.stage || '?') + (c.email ? ' (' + c.email + ')' : '')
      );
      const header = params.stage
        ? candidates.length + ' candidate(s) at "' + params.stage + '":'
        : candidates.length + ' candidate(s):';
      return header + '\n' + lines.join('\n');
    }

    // ── Intent: create candidate ───────────────────────────
    if (isCreateIntent) {
      if (!manager) return 'CandidateManager not found.';
      const result = await bridgeCall(ws, tabId, 'execute', {
        componentId: manager.componentId,
        actionName: 'createCandidate',
        params: {
          firstName: 'Chat',
          lastName: 'Created',
          email: 'chat@agent.test',
          stage: 'New'
        }
      });
      return 'Created candidate: ' + (result.payload?.name || '') + ' (Id: ' + (result.payload?.id || '?') + ')';
    }

    // ── Intent: highlight row ──────────────────────────────
    if (msg.includes('highlight') || msg.includes('підсвіт') || msg.includes('виділ')) {
      if (rows.length === 0) return 'No candidate rows found on this page.';
      const target = rows[0];
      await bridgeCall(ws, tabId, 'execute', {
        componentId: target.componentId,
        actionName: 'highlight',
        params: {}
      });
      return 'Highlighted first row: ' + target.label;
    }

    // ── Intent: ping / status ──────────────────────────────
    if (msg.includes('ping') || msg.includes('status') || msg.includes('alive') || msg.includes('статус')) {
      const ping = await bridgeCall(ws, tabId, 'ping');
      const p = ping.payload;
      return (
        'Bridge is alive!\n' +
        '• Version: ' +
        p.version +
        '\n' +
        '• Components: ' +
        p.componentCount +
        '\n' +
        '• Tab: ' +
        p.tabId.substring(0, 8) +
        '...\n' +
        '• Duplicates: ' +
        (p.duplicateWarning ? 'Yes' : 'No')
      );
    }

    // ── Default ────────────────────────────────────────────
    return (
      'I see ' +
      components.length +
      ' component(s) on this page but I am not sure what you want me to do. ' +
      'Try: "show candidates", "create candidate", "highlight", "ping", or "help".'
    );
  } catch (err) {
    return 'Error: ' + err.message;
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('[chat-agent] Connecting to Chrome CDP on port', CDP_PORT);

  const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  const sfTab =
    tabs.find((t) => t.type === 'page' && t.url.includes('lightning')) ||
    tabs.find((t) => t.type === 'page' && t.url.includes('salesforce'));

  if (!sfTab) {
    console.error('[chat-agent] No Salesforce tab found.');
    process.exit(1);
  }

  console.log('[chat-agent] Tab:', sfTab.title?.substring(0, 60));

  const ws = new WebSocket(sfTab.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));

  // Get tabId via handshake
  const hsRaw = await evaluate(
    ws,
    `
        new Promise((r, j) => {
            const t = setTimeout(() => j(new Error('No orchestrator')), 5000);
            document.addEventListener('sf-agent-bridge:handshake-response', (e) => {
                clearTimeout(t);
                r(JSON.stringify(e.detail));
            }, { once: true });
            document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', {
                detail: { requestId: 'chat-agent' }
            }));
        })
    `
  );
  const hs = JSON.parse(hsRaw);
  console.log('[chat-agent] Orchestrator tabId:', hs.tabId.substring(0, 8) + '...');

  // Inject chat listener into the page
  await evaluate(
    ws,
    `
        (() => {
            if (window.__chatAgentActive) return;
            window.__chatAgentActive = true;
            window.__chatInbox = [];
            const ch = new BroadcastChannel('sf-agent-bridge');
            window.__chatAgentChannel = ch;
            ch.addEventListener('message', (event) => {
                if (event.data.type === 'request' && event.data.action === 'chat') {
                    window.__chatInbox.push({
                        id: event.data.id,
                        message: event.data.payload?.message || '',
                        chatInstanceId: event.data.payload?.chatInstanceId || '',
                        tabId: event.data.payload?.tabId || '',
                        timestamp: new Date().toISOString()
                    });
                }
            });
        })()
    `
  );

  console.log('[chat-agent] Ready. Listening for chat messages...\n');

  // Poll for messages and process them
  let processing = false;
  setInterval(async () => {
    if (processing) return;

    try {
      const raw = await evaluate(
        ws,
        `
                (() => {
                    const msgs = window.__chatInbox || [];
                    if (msgs.length === 0) return null;
                    window.__chatInbox = [];
                    return JSON.stringify(msgs);
                })()
            `
      );

      if (!raw) return;

      processing = true;
      const messages = JSON.parse(raw);

      for (const msg of messages) {
        console.log('[CHAT] User:', msg.message);

        const reply = await processMessage(ws, hs.tabId, msg.message);
        console.log('[CHAT] Agent:', reply.substring(0, 100) + (reply.length > 100 ? '...' : ''));

        await sendChatResponse(ws, msg.id, reply);
        console.log('[CHAT] Response sent\n');
      }

      processing = false;
    } catch (err) {
      processing = false;
      if (err.message.includes('Target closed') || err.message.includes('not open')) {
        console.log('[chat-agent] Tab closed. Exiting.');
        process.exit(0);
      }
      console.error('[chat-agent] Error:', err.message);
    }
  }, POLL_INTERVAL);
}

main().catch((err) => {
  console.error('[chat-agent] Fatal:', err.message);
  process.exit(1);
});
