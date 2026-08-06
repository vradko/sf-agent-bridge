# Candidate Management Demo

Example implementation of SF Agent Bridge on an Account Record Page.

Demonstrates: Apex CRUD, filtering, modal dialogs, per-row bridge components with stable IDs, cross-page navigation.

## Setup

One command from the repo root (creates scratch org, deploys, assigns permset, imports data):

```bash
./scripts/setup-demo-org.sh my-demo-org MyDevHub 30
```

Or step by step against an existing org:

```bash
# 1. Deploy framework + demo
sf project deploy start --target-org your-org

# 2. Assign permissions
sf org assign permset --name Agent_Bridge_User --target-org your-org

# 3. Import test data (accounts + candidates via a single plan)
./examples/candidate-demo/scripts/data/import-demo-data.sh your-org
```

No Lightning App Builder clicks needed: the deploy includes record-page
flexipages (`Account_Agent_Bridge`, `Candidate_Agent_Bridge`) activated as
org defaults via action overrides, plus the `Agent Bridge Test` app page
with the orchestrator and chat widget.

## Components

| Component               | Page                                | Actions                                                                                                                                      |
| ----------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidateManager`      | Account Record Page                 | getCandidates, createCandidate, updateCandidateStage, editCandidate, updateCandidate, navigateToCandidate, getRowComponents, deleteCandidate |
| `candidateRow`          | (child of candidateManager)         | getDetails, updateStage, highlight                                                                                                           |
| `candidateEditModal`    | (modal, opened by candidateManager) | —                                                                                                                                            |
| `candidateRecordBridge` | Candidate Record Page               | getRecord, updateField, navigateToAccount                                                                                                    |

Candidate queries are capped at 500 rows because this package is a browser demo, not a pagination reference implementation.

## Demo Scenario

```
Agent: "Show me all candidates for this account"
→ discover + execute getCandidates

Agent: "Filter to Interview stage only"
→ execute getCandidates { stage: 'Interview' }

Agent: "Move Bob Johnson to Offer"
→ execute updateCandidateStage { candidateId: '...', stage: 'Offer' }

Agent: "Open Bob's record"
→ execute navigateToCandidate { candidateId: '...' }
(page navigates to Candidate record)

Agent: "Update his notes"
→ discover (finds CandidateRecordView)
→ execute updateField { fieldName: 'Notes__c', value: 'Great candidate' }

Agent: "Go back to the account"
→ execute navigateToAccount
```
