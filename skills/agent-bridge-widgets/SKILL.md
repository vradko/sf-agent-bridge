---
name: agent-bridge-widgets
description: Author Salesforce LWC widgets that expose actions to AI agents via AgentBridgeMixin — action schemas, stable keys, dangerous flags, lifecycle pitfalls. Use when writing or reviewing LWC code that integrates with SF Agent Bridge.
---

# Authoring bridge-enabled LWC widgets

A widget is any LWC wrapped in `AgentBridgeMixin`. It declares actions; the
orchestrator routes agent calls to it; results flow back automatically.

## Minimal contract

```javascript
import { LightningElement } from 'lwc';
import AgentBridgeMixin from 'c/agentBridgeMixin';

export default class MyWidget extends AgentBridgeMixin(LightningElement) {
  get agentComponentLabel() {
    return 'MyWidget'; // stable human name shown in discover
  }

  get agentActions() {
    return [
      {
        name: 'getData',
        description: 'What it does and when the agent should use it',
        params: [{ name: 'filter', type: 'string', required: false, description: '...' }],
        returns: { type: 'array', description: 'What comes back' }
      }
    ];
  }

  async handleAgentAction(actionName, params) {
    switch (actionName) {
      case 'getData':
        return this._getData(params);
      default:
        throw new Error(`Unknown action: ${actionName}`);
    }
  }
}
```

## Action schema — write it for an LLM

The schema is the agent's only documentation. Param fields the bridge
validates automatically: `type` (`string|number|integer|boolean|object|array`),
`required` (required strings must be non-blank), `enum`, `minLength`/`maxLength`,
`minimum`/`maximum`, `items: { type }` for arrays.

- Put valid values in `enum`, not prose.
- Say in `description` when to use the action and what visibly happens in the UI.
- Mark anything destructive or irreversible `dangerous: true` — the
  orchestrator then requires explicit user approval before your handler runs.

## Rules and pitfalls

1. **If you define `connectedCallback`/`disconnectedCallback`, call
   `super.connectedCallback()` / `super.disconnectedCallback()`** — otherwise
   the widget silently never registers.
2. **Rows in `for:each` need `agentStableKey`** (return the record Id). The
   component id becomes deterministic `stable:<label>:<key>` and survives
   re-renders, so agents can target a row without re-discovering. Build such
   ids elsewhere only via `stableComponentId(label, key)` from
   `c/agentBridgeUtils` — never hand-format the string.
3. **Notify parents AFTER returning the result.** If your handler calls Apex
   and then dispatches an event that makes the parent re-render (and destroy
   this row), the RESULT message dies with the component. Defer the event:

   ```javascript
   const result = await updateViaApex(...);
   // eslint-disable-next-line @lwc/lwc/no-async-operation
   setTimeout(() => this.dispatchEvent(new CustomEvent('changed', { ... })), 0);
   return { success: true };
   ```

4. **Modals: save first, show second.** Persist via Apex, then open the modal
   as fire-and-forget visual feedback. Never block the agent response on modal
   interaction.
5. **Return JSON-serializable plain data** (ids, names, scalars) — not sObjects
   or DOM nodes. Include the record id in every mutation result.
6. **Throw `Error` with a human-readable message** for failures; the agent
   receives it verbatim and will react to it.
7. Handlers may run while your component is mid-render; read state defensively
   (`this.record?.Id`).

## Placement

One orchestrator per tab: on the Lightning Page for single-page use, in the
Utility Bar for cross-page workflows — never both (duplicate-orchestrator
warning appears). Widgets work anywhere on the page, including inside
`for:each` lists.

## Review checklist

- [ ] `super.connectedCallback()` / `super.disconnectedCallback()` called
- [ ] every action has description, typed params, `returns`
- [ ] destructive actions flagged `dangerous: true`
- [ ] list rows override `agentStableKey`
- [ ] parent notifications deferred with `setTimeout(..., 0)`
- [ ] results are plain serializable objects
