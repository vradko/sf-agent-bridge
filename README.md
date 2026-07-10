# SF Agent Bridge

A bridge between AI agents and the UI your users already work in.

## Why This Exists

The natural path for AI automation is through APIs — but APIs bypass the UI entirely. That works for bots, but **people still work in the UI**. The UI is built for humans, not for agents.

SF Agent Bridge takes a different approach: instead of replacing the UI with API calls, it lets AI agents **operate the existing UI on behalf of the user**.

**Example 1: Smart filtering.** A recruiter has a table of candidates. Instead of configuring dozens of filters manually, they type: *"Find all candidates with React experience, actively looking, based in Berlin."* The agent interprets the prompt, calls the filter action on the UI component, and the recruiter sees the filtered list on their screen — no clicks, no filter menus.

**Example 2: Form filling from notes.** A loan officer pastes meeting notes and says: *"Fill in the application based on these notes."* The agent extracts the data, opens the form, and pre-fills the fields. The officer reviews the pre-filled form and makes the final decision — the agent assisted, but the human stays in control.

**This is not a replacement for APIs.** It's a bridge that lets AI agents drive the current application through prompts — while the user sees every change happen in real time on their screen. The value scales with the complexity of the UI: the more clicks and configuration a task normally requires, the more time the bridge saves.

## How It Works

```
AI Agent (Claude Code / Cursor / Gemini CLI)
    │ Chrome DevTools MCP → evaluate_script()
    │
    │ 1. CustomEvent handshake → { tabId }
    │ 2. BroadcastChannel('sf-agent-bridge') + tabId
    ▼
┌──────────────────────────────────────┐
│  SALESFORCE PAGE (scoped by tabId)   │
│                                      │
│  AgentOrchestrator ◄── ROLL_CALL ──► │
│       │                              │
│       │ REGISTER / EXECUTE / RESULT  │
│       ▼                              │
│  [Widget A]  [Widget B]  [Widget N]  │
│  (AgentBridgeMixin)                  │
└──────────────────────────────────────┘
```

1. Agent dispatches `sf-agent-bridge:handshake` event → orchestrator responds with `tabId`
2. Agent calls `ping` with `tabId` → only this tab's orchestrator responds
3. Agent calls `discover` → orchestrator sends ROLL_CALL, widgets respond with their action schemas
4. Agent calls `execute(componentId, actionName, params)` → orchestrator routes to the right widget

All communication uses a single `BroadcastChannel('sf-agent-bridge')` scoped by `tabId`. No Lightning Message Service, no DOM events, no iframes.

## Installation

### 1. Deploy to your org

```bash
sf project deploy start --source-dir force-app --target-org your-org
```

### 2. Place the orchestrator

Add `agentOrchestrator` to any Lightning Page via Lightning App Builder, or to the Utility Bar of a Lightning App for cross-page workflows.

### 3. Create bridge-enabled widgets

```javascript
import { LightningElement, api } from 'lwc';
import AgentBridgeMixin from 'c/agentBridgeMixin';

export default class MyWidget extends AgentBridgeMixin(LightningElement) {
    @api recordId;

    get agentComponentLabel() {
        return 'MyWidget';
    }

    get agentActions() {
        return [
            {
                name: 'getData',
                description: 'Returns current data',
                params: [
                    { name: 'filter', type: 'string', required: false, description: 'Optional filter' }
                ],
                returns: { type: 'array', description: 'Data items' }
            },
            {
                name: 'doSomethingDangerous',
                description: 'Deletes all records',
                dangerous: true,
                params: [],
                returns: { type: 'object', description: 'Result' }
            }
        ];
    }

    async handleAgentAction(actionName, params) {
        switch (actionName) {
            case 'getData':
                return this.fetchData(params.filter);
            case 'doSomethingDangerous':
                return this.deleteAll();
            default:
                throw new Error(`Unknown action: ${actionName}`);
        }
    }
}
```

## Framework API

### AgentBridgeMixin

Mixin for any LWC. Override these:

| Member | Type | Required | Description |
|---|---|---|---|
| `agentComponentLabel` | getter | Recommended | Human-readable name shown in discover. Defaults to a PascalCase version of the host tag name (`c-my-widget` → `MyWidget`) |
| `agentActions` | getter | Yes | Array of action definitions |
| `handleAgentAction(name, params)` | async method | Yes | Executes the action, returns result |
| `agentStableKey` | getter | No | Stable identifier for dynamic children (see below) |
| `agentComponentId` | getter | Auto | Unique ID — random UUID or `stable:<label>:<key>` |

> **Pitfall:** if your component defines its own `connectedCallback` / `disconnectedCallback`, you **must** call `super.connectedCallback()` / `super.disconnectedCallback()` inside them — otherwise the component silently never registers with the bridge.

### AgentOrchestrator

Drop-in component. No configuration needed. Place on a Lightning Page or in Utility Bar.

Features:
- Pull-based discovery (ROLL_CALL → 500ms collection window)
- Tab-scoped isolation via DOM event handshake (Lightning Web Security compatible)
- Approval gate for dangerous actions (inline confirmation modal)
- Duplicate orchestrator detection (shows warning banner)
- 30s execute timeout (60s for dangerous actions after approval)
- Filters requests by `tabId` when provided (multi-tab safe)
- Backward compatible — requests without `tabId` are processed by all orchestrators
- Tab-targeted `execute` for an unknown `componentId` returns a `not found` error immediately; broadcast requests (no `tabId`) stay silent so orchestrators in other tabs can answer

### Tab Scoping

The agent obtains the `tabId` via a DOM event handshake:

```javascript
// Step 1: listen for the response
let bridgeInfo;
document.addEventListener('sf-agent-bridge:handshake-response', (e) => {
    bridgeInfo = e.detail;
}, { once: true });

// Step 2: request handshake
document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', {
    detail: { requestId: 'any-id' }
}));

// bridgeInfo = { tabId, orchestratorId, version, requestId }
```

Include `tabId` in BroadcastChannel requests to target a specific tab. Without it, all orchestrators respond (backward compatible).

This approach works within Salesforce Lightning Web Security, which blocks direct `window` property assignment but allows `CustomEvent` on `document`.

### Approval Gate for Dangerous Actions

Actions marked with `dangerous: true` require user confirmation before execution. When the agent calls a dangerous action, the orchestrator shows an inline confirmation modal displaying the action name, component label, and parameters. The agent's request is held until the user clicks **Approve** or **Reject**.

- **Approve** — the action executes with a 60s timeout (instead of the standard 30s)
- **Reject** — the agent receives an error response: `"Action rejected by user"`
- Non-dangerous actions are unaffected — zero overhead, immediate execution
- The Approve button arms after a short delay (~0.7s) every time the modal content changes, so a rapid follow-up request can't capture a click the user aimed at the previous action

```javascript
// Mark an action as dangerous in your component
get agentActions() {
    return [{
        name: 'deleteRecord',
        description: 'Permanently deletes the record',
        dangerous: true,
        params: [{ name: 'recordId', type: 'string', required: true }],
        returns: { type: 'object' }
    }];
}
```

### BroadcastChannel Protocol

**Agent → Orchestrator:**
```javascript
{ type: 'request', id: '<uuid>', action: 'ping' | 'discover' | 'execute', payload: {}, tabId: '<optional>' }
```

**Orchestrator → Agent:**
```javascript
{ type: 'response', id: '<uuid>', status: 'ok' | 'error' | 'pending_approval', payload: {} }
```

**Internal (Orchestrator ↔ Widgets):**
```javascript
{ type: 'internal', action: 'ROLL_CALL' | 'REGISTER' | 'REGISTER_ACK' | 'EXECUTE' | 'RESULT' | ..., tabId: '<uuid>', orchestratorId: '<uuid>' }
```

Widgets adopt the orchestrator that acknowledges their registration (`REGISTER_ACK`) or announces itself (`ORCHESTRATOR_READY` / `ROLL_CALL`), and only accept `EXECUTE` messages carrying that `orchestratorId`.

## Security Model

Be clear about what the approval gate is — and what it is not:

- **It is a safety mechanism for cooperative agents.** An agent using the documented API (`ping` / `discover` / `execute`) cannot run a `dangerous: true` action without the user clicking Approve. Widgets reject `EXECUTE` messages that don't come from their registered orchestrator, so the documented path always goes through the gate.
- **It is not a security boundary against malicious code.** BroadcastChannel is same-origin and public: any script with code execution on the page can sniff internal messages, forge them, or simply manipulate the DOM directly. Nothing built on top of a shared channel can prevent that — if untrusted code runs on your Salesforce origin, you have a bigger problem than the bridge.
- The bridge grants no new privileges: every action executes with the logged-in user's permissions, enforced server-side by Salesforce as usual.

## Patterns

### Stable IDs for Dynamic Children

Components in `for:each` loops get new UUIDs on each re-render. Override `agentStableKey` to keep IDs stable:

```javascript
get agentStableKey() {
    return this.record.Id; // any stable business key
}
// componentId becomes: "stable:MyRow:001xx000001234"
```

### Cross-Page Workflows

Place orchestrator in the **Utility Bar** — it persists across SPA navigation. Widgets register/unregister as pages change. The agent re-discovers after navigation.

### Modal Dialogs

For agent-triggered modals: save data via Apex first, then show modal as visual feedback. Don't block the agent response on modal interaction.

### Row-Level Actions

Child components in `for:each` can each use AgentBridgeMixin independently. Use `agentStableKey` so the agent can target specific rows without re-discovering after data mutations.

## Deployment Options

| Pattern | Use Case | Orchestrator Placement |
|---|---|---|
| Single page | Testing, simple widgets | On the Lightning Page |
| Cross-page | Production workflows | Utility Bar |
| **Never** | — | Both page AND Utility Bar |

## Project Structure

```
force-app/main/default/lwc/
  agentBridgeUtils/       # Shared constants & utilities
  agentBridgeMixin/       # Core mixin — extend your LWC with this
  agentOrchestrator/      # Core hub — drop onto a page or Utility Bar
```

## License

MIT
