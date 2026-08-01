# Changelog

## 1.2.0

- Require a handshake-scoped `tabId` for every execute request.
- Add optional execute idempotency keys and retain outcomes for five minutes.
- Queue dangerous-action approvals and improve dialog keyboard behavior.
- Correlate widget results with both component and orchestrator identities.
- Isolate multiple Agent Chat instances and align end-to-end timeouts.
- Remove shell command construction from the Claude bridge process.
- Restore reproducible Node tooling, CI, formatting, demo metadata, and documentation.
