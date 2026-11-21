# Changelog

## Unreleased

### Fixed

- Errors thrown by Apex (`{ body: { message } }`) reach the agent with their message instead of `[object Object]` (new `describeError` in `agentBridgeUtils`).
- The approval dialog no longer sits on a full-height white column: SLDS gives `.slds-modal__container` full height and vertical padding, so the container now shrinks to the dialog.
- WebMCP tools keep their registration while the page changes. The adapter used to abort and re-register every tool after any registry change (a filter, a discover, a row leaving), so agent hosts that hold a tool between listing and calling it — Codex's built-in browser, for one — saw "stale" tools. It now reconciles tool by tool: unchanged tools stay, changed ones are replaced, new ones added. Abort controllers are tracked before `registerTool` settles, so teardown also cancels pending registrations.
- Per-row tools have a stable schema: `componentId` is a required string instead of an enum of the rows on screen (which changed with every filter and disappeared at one row). Agents get ids from discover or a listing action such as `getRowComponents`; the adapter checks at call time that the component is on the page and supports the action. Tools whose components all left (a filter with no rows) stay published until the page URL changes.

### Candidate demo

- Rows stay mounted while the table reloads (the spinner overlays them). Row widgets no longer unregister for the length of every Apex call, so their WebMCP tools stay published.
- `getCandidates` search matches full names: every word has to match the first or the last name ("Mike Wilson").
- `deleteCandidate` takes `candidateName`. The approval dialog shows it, and Apex refuses the delete when it is not the record's name.
- `import-demo-data.sh` moves interview dates so the earliest is three days out (order and gaps kept); `setup-demo-org.sh` sets the admin user's locale to en_GB.

## 1.2.0

### Breaking

- `execute` requests now require the handshake-scoped `tabId`; unscoped execute is rejected (previously it could be silently ignored or, if the component id matched, executed). Run the DOM handshake first.
- Widget `RESULT` messages are now correlated by `componentId` and `orchestratorId`. Deploy the orchestrator and mixin together — a 1.2 orchestrator ignores results from 1.1 widgets, so their executions time out.

### Added / Changed

- Optional execute idempotency keys; outcomes are retained for five minutes. A user rejection or approval timeout releases the key, so a retry with the same key shows a fresh approval prompt.
- Queue dangerous-action approvals and improve dialog keyboard behavior (focus trap, Escape rejects, focus restore).
- Isolate multiple Agent Chat instances, align end-to-end timeouts, and fail fast in the chat widget when no orchestrator answers.
- Remove shell command construction from the Claude bridge process.
- Add AI skills (`skills/`) describing the protocol for agents and the widget-authoring contract.
- Restore reproducible dev tooling and CI. The repo root intentionally ships no npm manifests — see `docs/DEVELOPMENT.md` for the one-command bootstrap.
