# Development

The repo root deliberately ships **no npm manifests**. Anyone vendoring the
bridge into their own Salesforce project takes `force-app` components without
inheriting a Node dependency stack. The dev tooling still exists — its
canonical, version-pinned definition lives in [`dev/package.json`](dev/package.json).

## Bootstrap

```bash
cp docs/dev/package.json package.json   # root package.json is gitignored
npm install
```

That's it. `package.json` and the generated `package-lock.json` stay local
(both are in `.gitignore`).

## Checks

```bash
npm run check            # lint + unit tests + formatting, same as CI
npm run lint             # ESLint over force-app, examples, scripts
npm test                 # sfdx-lwc-jest unit tests
npm run test:unit:watch  # watch mode
npm run prettier         # format everything
npm run audit:runtime    # npm audit for runtime deps only (ws)
```

CI (`.github/workflows/ci.yml`) bootstraps the same way — it copies
`docs/dev/package.json` to the root before installing — so green locally
means green in CI.

## Version policy

- Dependency versions in `docs/dev/package.json` are **pinned exactly**.
  There is no committed lockfile, so exact pins are what keeps CI and local
  installs aligned; bump them deliberately and rerun `npm run check`.
- Bridge protocol version lives in `agentBridgeUtils.BRIDGE_VERSION` and is
  the version that matters for agents; keep `docs/dev/package.json` in sync
  when releasing.

## Demo org

See `docs/DEMO_RUNBOOK.md` for the end-to-end scratch-org demo. One-shot setup:

```bash
./scripts/setup-demo-org.sh my-demo-org MyDevHub 30
```
