## Salesforce Agent Bridge

You have access to a Salesforce instance via Chrome DevTools MCP.
A BroadcastChannel bridge ('sf-agent-bridge') connects you to
Salesforce LWC components on the active page.

### Architecture

- **AgentOrchestrator** — central hub component (on page or in Utility Bar)
- **AgentBridgeMixin** — any LWC widget can use this to expose actions
- **BroadcastChannel** — the single communication channel for all messages

The orchestrator uses **pull-based discovery**: when you call `discover`,
it sends a ROLL_CALL to all widgets, collects their registrations for 500ms,
then returns the aggregated list.

### Workflow

1. Call `ping` to verify the bridge is active
2. Call `discover` to get all available components and their actions
3. Use `execute` to invoke specific actions on specific components
4. **Always re-discover after mutations** that change the component list
   (create, delete, navigation, filter changes)

### Component Types

Components fall into two categories:

**Parent components** (e.g., `CandidateManager`):

- Provide data-level actions: getCandidates, createCandidate, filter, etc.
- Their componentId is a random UUID, changes on page reload
- Actions affect the entire dataset

**Child row components** (`CandidateRow` label with `stable:CandidateRow:<recordId>` IDs):

- Provide row-level actions: getDetails, highlight, updateStage
- Use **stable IDs** based on record data (survive re-renders)
- Their label contains the record ID for easy targeting
- Target a specific item in a list

### Stable vs Unstable IDs

Components that define `agentStableKey` have deterministic IDs that survive
re-renders (format: `stable:<label>:<key>`). After data mutations, these
components keep the same componentId even if the list re-renders.

Components without stable keys get random UUIDs that change on re-render.
Always re-discover to get fresh IDs for these.

### Helper Functions

Execute via `evaluate_script()`:

#### Ping

```javascript
return (async () => {
  const id = crypto.randomUUID();
  const ch = new BroadcastChannel('sf-agent-bridge');
  return new Promise((r, j) => {
    setTimeout(() => {
      ch.close();
      j('no bridge');
    }, 3000);
    ch.onmessage = (e) => {
      if (e.data.id === id) {
        ch.close();
        r(e.data.payload);
      }
    };
    ch.postMessage({ type: 'request', id, action: 'ping', payload: {} });
  });
})();
```

#### Discover

```javascript
return (async () => {
  const id = crypto.randomUUID();
  const ch = new BroadcastChannel('sf-agent-bridge');
  return new Promise((r, j) => {
    setTimeout(() => {
      ch.close();
      j('timeout');
    }, 5000);
    ch.onmessage = (e) => {
      if (e.data.id === id) {
        ch.close();
        r(e.data.payload);
      }
    };
    ch.postMessage({ type: 'request', id, action: 'discover', payload: {} });
  });
})();
```

#### Execute

```javascript
return (async () => {
  const id = crypto.randomUUID();
  const ch = new BroadcastChannel('sf-agent-bridge');
  return new Promise((r, j) => {
    setTimeout(() => {
      ch.close();
      j('timeout');
    }, 30000);
    ch.onmessage = (e) => {
      if (e.data.id === id && e.data.type === 'response') {
        ch.close();
        if (e.data.status === 'error') j(e.data.payload.message);
        else r(e.data.payload);
      }
    };
    ch.postMessage({
      type: 'request',
      id,
      action: 'execute',
      payload: { componentId: 'COMPONENT_ID', actionName: 'ACTION', params: {} }
    });
  });
})();
```

### Rules

- Always `discover` before `execute` to get fresh component list
- Actions with `dangerous: true` open an approval modal in Salesforce — the user must click Approve before the action executes, so allow extra time and explain a rejection calmly
- Respect the params schema — validate types before sending
- If `ping` fails, the page may not have the orchestrator component
- If `ping.duplicateWarning` is true, there are multiple orchestrators — warn the user
- Timeouts: ping=5s, discover=5s, execute=30s (dangerous actions: up to 130s including approval and execution)
- After navigation, wait 2-3 seconds for components to register, then re-discover

### Error Handling

- `Bridge not found` — wrong page or orchestrator not loaded
- `Discover timeout` — no orchestrator responding
- `Execute timeout` — component didn't respond (may have been destroyed)
- `Unknown action` — action name doesn't match component's schema
- `Validation error` — params don't match schema

### Deployment Patterns

**Single-page use**: Place orchestrator on the Lightning Record/App/Home Page alongside your widgets.

**Cross-page workflows**: Place orchestrator in the **Utility Bar** of a Lightning App. It persists across SPA navigation. Widgets register/unregister as pages change.

**Never** place orchestrator on a page AND in the Utility Bar simultaneously.
