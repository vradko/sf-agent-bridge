---
name: agent-bridge-protocol
description: Drive a Salesforce Lightning page through the SF Agent Bridge — handshake, discover, execute LWC actions over BroadcastChannel. Use when automating a Salesforce page that has the Agent Bridge orchestrator, e.g. via Chrome DevTools MCP evaluate_script or CDP Runtime.evaluate.
---

# Driving the SF Agent Bridge

You control Lightning web components on the user's screen by posting messages
on `BroadcastChannel('sf-agent-bridge')` inside the Salesforce tab. The user
sees every change live. You need a way to evaluate JavaScript in that tab
(Chrome DevTools MCP `evaluate_script`, CDP `Runtime.evaluate`, or the console).

## Protocol in one line

`handshake (DOM event) → ping → discover → execute(componentId, actionName, params)`

## 1. Handshake — get the tabId (required once per tab)

```javascript
return await new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error('no bridge on this page')), 3000);
  document.addEventListener('sf-agent-bridge:handshake-response', (e) => resolve(e.detail), { once: true });
  document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', { detail: { requestId: 'hs-1' } }));
});
// → { tabId, orchestratorId, version, requestId }
```

`execute` without this `tabId` is rejected. `ping`/`discover` work unscoped, but
in multi-tab sessions always pass `tabId` to avoid answers from other tabs.

## 2. Request helper (ping / discover / execute)

```javascript
function bridgeCall(action, payload, tabId, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const ch = new BroadcastChannel('sf-agent-bridge');
    const t = setTimeout(() => {
      ch.close();
      reject(new Error('bridge timeout'));
    }, timeoutMs);
    ch.onmessage = (e) => {
      if (e.data?.type === 'response' && e.data.id === id) {
        clearTimeout(t);
        ch.close();
        resolve(e.data);
      }
    };
    ch.postMessage({ type: 'request', id, action, payload: payload || {}, tabId });
  });
}
```

- `discover` → `{ payload: { components: [{ componentId, label, actions }] } }`.
  Each action lists `name`, `description`, `params` (with types/enums), `returns`.
- `execute` payload: `{ componentId, actionName, params, idempotencyKey? }`.
- Response: `status: 'ok' | 'error'`; errors carry `payload.message`.

## Rules that keep you correct

1. **Re-discover after anything that changes the page**: navigation, create,
   delete, page reload. Random component ids change on re-render; only
   `stable:<Label>:<key>` ids survive (typically `stable:Row:<recordId>` —
   use them to target one row in a list).
2. **Mutations need an `idempotencyKey`** (any unique string ≤200 chars).
   A transport timeout does NOT mean the action failed — Apex may still
   complete. Retry only with the SAME key; the orchestrator deduplicates
   matching requests for five minutes and rejects the same key with different
   params.
3. **`dangerous: true` actions pause for human approval.** The user sees a
   modal; the Approve button arms after ~0.7 s; approval expires after 60 s.
   Tell the user to look at the screen. If they reject, you get
   `"Action rejected by user"` — that releases the idempotency key, so if they
   change their mind you may retry with the same key and a fresh prompt appears.
4. **Timeouts**: execute 30 s (60 s after approval), chat 240 s. Treat a
   timeout as an unknown outcome, never as a failure.
5. **Error taxonomy**: `'tabId' is required` → run the handshake;
   `Component ... not found in this tab` → re-discover, ids are stale;
   `Unknown action` / `Validation error: ...` → re-read the action schema;
   `Idempotency key ... already used for another action` → mint a new key.
6. Params are validated against the widget schema (types, enums, min/max,
   required non-blank strings). Send exactly what the schema declares.

## Verify, then report

`ping` returns `{ version, componentCount, tabId, duplicateWarning }` — check
it before starting and after reloads. After a mutation, confirm by re-running
the relevant read action and describe to the user what visibly changed.
