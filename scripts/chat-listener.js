#!/usr/bin/env node

/**
 * Chat Listener — connects to Chrome via CDP and listens for
 * chat messages from agentChat component. Writes incoming messages
 * to a file that Claude Code can read and act on.
 *
 * Usage: node scripts/chat-listener.js [--port 9222]
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port
 *   - npm install ws (in project or globally)
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CDP_PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1], 10)
  : 9444;

const INBOX_FILE = path.join(__dirname, '..', '.chat-inbox.json');
const OUTBOX_FILE = path.join(__dirname, '..', '.chat-outbox.json');
const POLL_INTERVAL = 1000;

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS error');
  return r.result.value;
}

async function main() {
  console.log('[chat-listener] Connecting to Chrome CDP on port', CDP_PORT);

  const tabs = await httpGet(`http://127.0.0.1:${CDP_PORT}/json`);
  const sfTab =
    tabs.find((t) => t.type === 'page' && t.url.includes('lightning')) ||
    tabs.find((t) => t.type === 'page' && t.url.includes('salesforce'));
  if (!sfTab) {
    console.error('[chat-listener] No Salesforce tab found. Open a SF page first.');
    process.exit(1);
  }

  console.log('[chat-listener] Found tab:', sfTab.title?.substring(0, 50));

  const ws = new WebSocket(sfTab.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));

  // Inject listener into the page
  await evaluate(
    ws,
    `
        (() => {
            if (window.__chatListenerActive) return 'already active';
            window.__chatListenerActive = true;
            window.__chatInbox = [];
            const ch = new BroadcastChannel('sf-agent-bridge');
            window.__chatListenerChannel = ch;
            ch.addEventListener('message', (event) => {
                if (event.data.type === 'request' && event.data.action === 'chat') {
                    window.__chatInbox.push({
                        id: event.data.id,
                        chatId: event.data.payload?.chatId || '',
                        chatInstanceId: event.data.payload?.chatInstanceId || '',
                        message: event.data.payload?.message || '',
                        tabId: event.data.payload?.tabId || '',
                        timestamp: new Date().toISOString()
                    });
                }
            });
            return 'listener injected';
        })()
    `
  );

  console.log('[chat-listener] Listening for chat messages...');
  console.log('[chat-listener] Inbox:', INBOX_FILE);
  console.log('[chat-listener] Outbox:', OUTBOX_FILE);
  console.log('');

  // Clear old files
  try {
    fs.unlinkSync(INBOX_FILE);
  } catch {
    /* ok */
  }
  try {
    fs.unlinkSync(OUTBOX_FILE);
  } catch {
    /* ok */
  }

  // Poll for new messages and outbox replies
  setInterval(async () => {
    try {
      // Check for new chat messages
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

      if (raw) {
        const messages = JSON.parse(raw);
        for (const msg of messages) {
          console.log('[CHAT]', msg.message);
          fs.writeFileSync(INBOX_FILE, JSON.stringify(msg, null, 2));
        }
      }

      // Check for outbox (reply from Claude Code)
      if (fs.existsSync(OUTBOX_FILE)) {
        const outbox = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
        fs.unlinkSync(OUTBOX_FILE);

        if (outbox.reply && outbox.id) {
          console.log('[REPLY]', outbox.reply.substring(0, 80));
          const reply = JSON.stringify(outbox.reply);
          const responseId = JSON.stringify(outbox.id);
          await evaluate(
            ws,
            `
                        (() => {
                            const ch = window.__chatListenerChannel;
                            if (!ch) return;
                            ch.postMessage({
                                type: 'response',
                                id: ${responseId},
                                status: 'ok',
                                payload: { reply: ${reply} }
                            });
                        })()
                    `
          );
        }
      }
    } catch (err) {
      if (err.message.includes('Target closed') || err.message.includes('not open')) {
        console.log('[chat-listener] Tab closed. Exiting.');
        process.exit(0);
      }
    }
  }, POLL_INTERVAL);
}

main().catch((err) => {
  console.error('[chat-listener] Error:', err.message);
  process.exit(1);
});
