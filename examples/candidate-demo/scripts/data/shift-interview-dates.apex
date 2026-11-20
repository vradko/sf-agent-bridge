// Keeps the demo current: moves every interview date by the same number of days so the
// earliest one is three days from today. Order and gaps stay as in sample-candidates.json,
// which the Europe scenario relies on (Bob Johnson soonest overall, Klaus Mueller next).
List<Candidate__c> rows = [
  SELECT Id, Interview_Date__c
  FROM Candidate__c
  WHERE Interview_Date__c != NULL AND Account__r.Name IN ('Acme Corporation', 'Global Tech Industries')
];
Date earliest;
for (Candidate__c row : rows) {
  if (earliest == null || row.Interview_Date__c < earliest) {
    earliest = row.Interview_Date__c;
  }
}
if (earliest != null) {
  Integer shift = earliest.daysBetween(Date.today().addDays(3));
  for (Candidate__c row : rows) {
    row.Interview_Date__c = row.Interview_Date__c.addDays(shift);
  }
  update rows;
}
