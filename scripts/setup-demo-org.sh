#!/bin/bash
#
# One-shot demo org setup for SF Agent Bridge.
# Creates a scratch org, deploys framework + candidate demo, assigns
# permissions, imports sample data, and prints the demo Account URL.
#
# Usage: ./scripts/setup-demo-org.sh [org-alias] [devhub-alias] [days]
#
set -euo pipefail
ALIAS=${1:-sf-bridge-demo}
DEVHUB=${2:-MyPersonal}
DAYS=${3:-30}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== 1/7 Creating scratch org '$ALIAS' (devhub: $DEVHUB, $DAYS days) ==="
sf org create scratch \
    --definition-file config/project-scratch-def.json \
    --alias "$ALIAS" \
    --duration-days "$DAYS" \
    --target-dev-hub "$DEVHUB" \
    --wait 20

echo ""
echo "=== 2/7 Deploying framework + demo ==="
sf project deploy start --target-org "$ALIAS" --wait 20

echo ""
echo "=== 3/7 Assigning permission set ==="
sf org assign permset --name Agent_Bridge_User --target-org "$ALIAS"

echo ""
echo "=== 4/7 Setting the admin user's locale to en_GB ==="
# New scratch orgs inherit the Dev Hub's locale; keep demo dates readable ("13 Jul 2026") everywhere.
echo "User u = [SELECT Id FROM User WHERE Id = :UserInfo.getUserId()]; u.LocaleSidKey = 'en_GB'; update u;" |
    sf apex run --target-org "$ALIAS" > /dev/null

echo ""
echo "=== 5/7 Running Apex tests ==="
sf apex run test \
    --class-names CandidateControllerTest \
    --target-org "$ALIAS" \
    --wait 20 \
    --result-format human \
    --code-coverage

echo ""
echo "=== 6/7 Importing sample data ==="
./examples/candidate-demo/scripts/data/import-demo-data.sh "$ALIAS"

echo ""
echo "=== 7/7 Demo entry points ==="
ACCOUNT_ID=$(sf data query --query "SELECT Id FROM Account WHERE Name = 'Acme Corporation' LIMIT 1" --target-org "$ALIAS" --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).result.records[0].Id))")
echo "Acme Corporation Account Id: $ACCOUNT_ID"
echo ""
echo "Open the demo page with:"
echo "  sf org open --target-org $ALIAS --path /lightning/r/Account/$ACCOUNT_ID/view"
echo ""
echo "For the live demo, launch Chrome with CDP enabled first:"
echo "  open -na 'Google Chrome' --args --remote-debugging-port=9444 --user-data-dir=/tmp/sf-demo-chrome"
echo "  sf org open --target-org $ALIAS --url-only   # paste URL into that Chrome"
echo "=== Done ==="
