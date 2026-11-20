#!/bin/bash
set -e
ORG=${1:-sf-bridge-demo}
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Importing accounts + candidates (single plan, cross-file refs) ==="
sf data import tree --plan "$DIR/import-plan.json" --target-org "$ORG"

echo ""
echo "=== Moving interview dates into the coming weeks (order and gaps kept) ==="
sf apex run --file "$DIR/shift-interview-dates.apex" --target-org "$ORG" > /dev/null

echo ""
echo "=== Verifying ==="
sf data query --query "SELECT Id, Name FROM Account WHERE Name IN ('Acme Corporation','Global Tech Industries')" --target-org "$ORG"
echo ""
sf data query --query "SELECT Name, First_Name__c, Last_Name__c, Stage__c, Interview_Date__c, Account__r.Name FROM Candidate__c ORDER BY Account__r.Name, Last_Name__c" --target-org "$ORG"
echo "=== Done ==="
