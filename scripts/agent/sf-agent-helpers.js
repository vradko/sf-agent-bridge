/**
 * SF Agent Bridge — Helper Scripts v3
 *
 * Execute via Chrome DevTools MCP evaluate_script() or browser console.
 * All functions use BroadcastChannel('sf-agent-bridge').
 *
 * Recommended flow:
 *   const { tabId } = await sfBridgeHandshake();
 *   await sfBridgePing(tabId);
 *   const { components } = await sfBridgeDiscover(tabId);
 *   await sfBridgeExecute(components[0].componentId, 'someAction', {...}, tabId);
 *
 * tabId scopes every call to the current tab's orchestrator. Execute requires
 * it; ping and discover retain legacy broadcast mode, but should also receive
 * the handshake tabId to avoid cross-tab responses.
 */

function sfBridgeHandshake(timeout) {
  return new Promise((resolve, reject) => {
    const handler = (e) => {
      clearTimeout(timer);
      resolve(e.detail);
    };
    const timer = setTimeout(() => {
      document.removeEventListener('sf-agent-bridge:handshake-response', handler);
      reject(new Error('No orchestrator responded to handshake'));
    }, timeout || 5000);
    document.addEventListener('sf-agent-bridge:handshake-response', handler, { once: true });
    document.dispatchEvent(
      new CustomEvent('sf-agent-bridge:handshake', {
        detail: { requestId: crypto.randomUUID() }
      })
    );
  });
}

function sfBridgeRequest(action, payload, tabId, timeout, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const ch = new BroadcastChannel('sf-agent-bridge');
    const timer = setTimeout(() => {
      ch.close();
      reject(new Error(timeoutMessage));
    }, timeout);
    ch.onmessage = (e) => {
      if (e.data.id === id && e.data.type === 'response') {
        clearTimeout(timer);
        ch.close();
        if (e.data.status === 'error') reject(new Error(e.data.payload.message));
        else resolve(e.data.payload);
      }
    };
    const msg = { type: 'request', id, action, payload: payload || {} };
    if (tabId) msg.tabId = tabId;
    ch.postMessage(msg);
  });
}

function sfBridgePing(tabId, timeout) {
  return sfBridgeRequest('ping', {}, tabId, timeout || 5000, 'Bridge not found');
}

function sfBridgeDiscover(tabId, timeout) {
  return sfBridgeRequest('discover', {}, tabId, timeout || 5000, 'Discover timeout');
}

function sfBridgeExecute(componentId, actionName, params, tabId, timeout, idempotencyKey) {
  if (!tabId) {
    return Promise.reject(new Error('tabId is required. Call sfBridgeHandshake() before execute.'));
  }
  // Up to 60s for approval plus 60s for execution, with transport headroom.
  return sfBridgeRequest(
    'execute',
    { componentId, actionName, params: params || {}, idempotencyKey },
    tabId,
    timeout || 130000,
    `Execute timeout for '${actionName}'`
  );
}

if (typeof module !== 'undefined') {
  module.exports = { sfBridgeHandshake, sfBridgePing, sfBridgeDiscover, sfBridgeExecute };
}
