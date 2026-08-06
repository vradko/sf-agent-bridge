# Demo Runbook — Bharat Dreamin' 2026

Step-by-step live demo script matching `TALK_NARRATIVE.md` slide 9.
Every step has a **fallback** — if the agentic path fails on stage, paste the manual command.

> v1.2.0 was verified end-to-end on 2026-07-31 in a fresh `sf-bridge-v12-browser`
> scratch org created from `MyPersonal`. Confirmed live: handshake → ping →
> discover (15 components before filtering, stable row IDs) →
> filter/sort incl. the Europe scenario (table updates live) → dangerous delete
> (approval modal, arm delay, refresh without reload) → forged-EXECUTE bypass
> blocked → missing-tab execution returns an immediate error → idempotent create
> deduplicates → unknown-component returns instant not-found error → scoped chat loop.
> Demo data: 18 candidates across Acme Corporation (14) + Global Tech (4);
> countries, interview dates (2026-07-12 … 2026-08-03), years of experience.
> Account Ids change on every data reimport — `connect.js` resolves by name,
> and the visible `Agent Bridge Component ID` changes on every page load:
> always `discover` at demo time, never hard-code ids.
>
> **After ANY LWC redeploy: wipe the demo Chrome profile** — Lightning's
> persistent component cache survives reloads and serves stale bundles:
> `pkill -f remote-debugging-port=9444 && rm -rf /tmp/sf-demo-chrome`, then
> `node connect.js` again.

---

## Before leaving home (once)

```bash
# 1. Re-auth DevHub if needed
sf org login web --alias MyPersonal --instance-url https://<your-devhub>.my.salesforce.com --set-default-dev-hub

# 2. Create + deploy + data (one shot, ~5 min)
./scripts/setup-demo-org.sh sf-bridge-demo MyPersonal 30

# 3. Verify unit tests pass
npx jest --silent
```

## Before the talk (in the speaker room, ~10 min)

```bash
# 1. Launch demo Chrome with CDP (dedicated profile — no personal tabs!)
open -na 'Google Chrome' --args --remote-debugging-port=9444 --user-data-dir=/tmp/sf-demo-chrome

# 2. Get login URL and open it in the demo Chrome
sf org open --target-org sf-bridge-demo --url-only
# paste into demo Chrome, then navigate to Acme Corporation account page

# 3. Sanity check the bridge (paste in DevTools console of the SF tab):
#    - handshake responds with tabId
#    - discover shows CandidateManager + CandidateRow components
```

Paste into the console (contents of `scripts/agent/sf-agent-helpers.js`, then):

```javascript
const hs = await sfBridgeHandshake(); // → { tabId, orchestratorId, version: '1.2.0' }
await sfBridgePing(hs.tabId); // → { componentCount: N, ... }
await sfBridgeDiscover(hs.tabId); // → { components: [...] }
```

**Checklist:**

- [ ] Only ONE Salesforce tab open in demo Chrome
- [ ] Terminal font ≥ 18pt, Chrome zoom 125%
- [ ] Notifications off (macOS Focus mode)
- [ ] `chat-bridge.js` NOT yet running (start it in step 7)
- [ ] Backup: screenshots/recording of each step on the desktop

---

## Live demo steps (slide 9)

### The "fair session" (primary agentic path — verified 2026-07-10, cold + warm start)

A fresh Claude Code session with zero project context, so nobody can say the demo was staged:

```bash
cd ~/bharat-demo && claude
```

The folder contains only `CLAUDE.md` (instructions for the session), `SYSTEM_PROMPT.md`, `sf-agent-helpers.js`, `connect.js` (one command: sf login → launch Chrome → open account → wait for bridge), and `cdp.js` (runs bridge calls in the page). The session has never seen the framework source — it discovers components live.

The whole demo is 4–5 natural prompts:

1. `Connect to my Salesforce org and open the Acme Corporation account`
   → Claude runs `node connect.js` → **Chrome opens and logs in by itself on the projector** → "Bridge v1.2.0, 15 components"
2. `What can you do on this page?` → discover, Claude narrates the action schemas
3. ⭐ **The Europe scenario** (semantic reasoning — verified 2026-07-11):
   `Show me all candidates from Europe who are at the Interview stage, sorted by interview date so I can see whose interview is coming up first`
   There is NO "Europe" filter value — the schema lists 14 countries. The agent maps Europe → picks the 8 European countries itself. Verified tool call:
   `getCandidates {"stage":"Interview","countries":["Germany","France","Spain","Poland","Ukraine","United Kingdom","Netherlands","Italy"],"sortBy":"interviewDate","sortDirection":"asc"}`
   Correct answer: **Klaus Mueller (Germany, Jul 13) first**, then Kowalska/Shevchenko/Laurent/Clarke — 5 rows.
   Built-in traps the audience can check: Bob Johnson (US) has the globally soonest interview (Jul 12) but must be excluded by country; Lukas de Vries (Netherlands, Jul 15) must be excluded by stage (Offer). The filter badge above the table shows exactly which countries the agent picked.
4. `Delete Mike Wilson` → approval modal → audience votes → Approve/Reject
5. (chat step — the same Europe prompt also works in the chat widget; simpler warm-up: `How many candidates are in Interview stage?`)

`connect.js` is idempotent: reuses a running demo Chrome or launches one (~40s cold, ~15s warm). Manual fallbacks below execute the same protocol from the DevTools console.

### Step 1 — Handshake

> **Say:** "First, the agent knocks on the door — a DOM event, because Lightning Web Security blocks everything else."

Claude Code prompt: `Connect to the Salesforce tab and do the sf-agent-bridge handshake. Show me the tabId.`

Fallback: `const hs = await sfBridgeHandshake()` → show `hs`.

### Step 2 — Ping

> **Say:** "Ping tells us the bridge is alive and how many components are registered."

Fallback: `await sfBridgePing(hs.tabId)`

### Step 3 — Discover

> **Say:** "Discover is the contract: every component announces its actions with typed parameters. This is what makes it semantic — no screenshots, no clicking coordinates."

Fallback: `const d = await sfBridgeDiscover(hs.tabId); d.components`

Point at `CandidateManager` actions and the `stable:CandidateRow:<id>` ids.

### Step 4 — Filter live

> **Say:** "Now watch the table — not the terminal."

Claude Code prompt: `Filter candidates to Interview stage.`

Fallback:

```javascript
const mgr = d.components.find((c) => c.label === 'CandidateManager');
await sfBridgeExecute(mgr.componentId, 'getCandidates', { stage: 'Interview' }, hs.tabId);
```

### Step 5 — Highlight a row

> **Say:** "Row-level targeting via stable IDs — survives re-renders."

Fallback:

```javascript
const row = d.components.find((c) => c.componentId.startsWith('stable:CandidateRow'));
await sfBridgeExecute(row.componentId, 'highlight', {}, hs.tabId);
```

### Step 6 — Dangerous action → approval modal ⭐

> **Say:** "Now the agent wants to DELETE a candidate. Watch what happens." → modal appears → **ask the audience to vote** → click Approve or Reject.

Fallback:

```javascript
const cand = (await sfBridgeExecute(mgr.componentId, 'getCandidates', {}, hs.tabId)).find((c) =>
  c.name.includes('Wilson')
);
await sfBridgeExecute(mgr.componentId, 'deleteCandidate', { candidateId: cand.id }, hs.tabId);
// modal appears; promise resolves on Approve, rejects on Reject
```

Note: the Approve button arms after ~0.7s — mention it's anti-click-jacking if anyone notices.

### Step 7 — Chat (agent decides on its own) ⭐

> **Say:** "So far I typed the commands. Now the user types — and the model decides which bridge actions to call."

```bash
node scripts/chat-bridge.js --port 9444
# wait for the log line:  [chat-bridge] Orchestrator tabId: ...
```

In the Agent Chat widget on the page, type:

- `How many candidates are in Interview stage?` → watch the terminal log `[TOOL 1] getCandidates {"stage":"Interview"}` → reply appears in chat AND the table filters live
- (optional, if time) `Move Bob Johnson to Offer` → tool call + live table update

**Verified end-to-end 2026-07-10** (typed through the real widget UI): round trip ≈ 20–25s — fill the pause by narrating the terminal log. Restart-safe: if chat-bridge dies mid-demo, just rerun the command — messages are deduped, no double replies. If the page was reloaded, restart chat-bridge after the page finishes loading (it retries the handshake up to a minute).

---

## Alternative transport: Claude in Chrome extension

Verified 2026-07-10: the bridge works through the **Claude in Chrome** extension too — `javascript_tool` ran handshake → ping → discover → execute (highlight) against the org with zero code changes. Good "the bridge is a protocol, not a tool" moment: any agent that can run JS in the page is a client (Claude Code via CDP, Claude in Chrome, console paste, Gemini CLI).

Caveats found live:

- Extension **site permissions** must be granted for the org domain (screenshots were blocked until then; JS execution worked) — check the extension settings on the demo machine beforehand
- `javascript_tool` has no top-level await — wrap in an async IIFE that writes to `window.__result`, then read it in a second call
- The extension opens its own tab group; the chat-bridge Node script still needs the CDP path (port 9444) — the two can't share a tab

On stage: keep CDP as the primary scripted path; the extension is a strong closing flourish ("this also works straight from the Claude extension in my browser") if rehearsal time allows.

## Failure modes & recovery

| Symptom                                | Fix                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Handshake times out                    | Wrong tab / orchestrator not on page — refresh the Account page                                      |
| `Component not found` error on execute | Page re-rendered — run discover again (that's the by-design answer; say so out loud, it's a feature) |
| Approval modal doesn't appear          | You clicked before arming? It's there — scroll up; modal renders at top of orchestrator container    |
| chat-bridge silent                     | Check `claude -p` works standalone; check CDP port 9444                                              |
| Total demo failure                     | Play backup recording, keep talking — the audience remembers the story, not the terminal             |
