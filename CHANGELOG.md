# Changelog

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
