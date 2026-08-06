@isTest
private class CandidateControllerTest {
  @TestSetup
  static void setup() {
    Account acc = new Account(Name = 'Test Account');
    insert acc;

    List<Candidate__c> candidates = new List<Candidate__c>{
      new Candidate__c(
        First_Name__c = 'Jane',
        Last_Name__c = 'Smith',
        Email__c = 'jane@test.com',
        Stage__c = 'Screening',
        Country__c = 'Germany',
        Years_Experience__c = 8,
        Account__c = acc.Id
      ),
      new Candidate__c(
        First_Name__c = 'Bob',
        Last_Name__c = 'Johnson',
        Email__c = 'bob@test.com',
        Stage__c = 'Interview',
        Country__c = 'Ukraine',
        Years_Experience__c = 2,
        Account__c = acc.Id
      ),
      new Candidate__c(
        First_Name__c = 'Alice',
        Last_Name__c = 'Williams',
        Stage__c = 'New',
        Country__c = 'France',
        Years_Experience__c = 5,
        Account__c = acc.Id
      )
    };
    insert candidates;
  }

  @isTest
  static void testGetCandidatesByAccount() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    List<Candidate__c> result = CandidateController.getCandidatesByAccount(acc.Id);
    System.assertEquals(3, result.size(), 'Should return 3 candidates');
  }

  @isTest
  static void testFilterByStage() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    List<Candidate__c> result = CandidateController.filterCandidates(acc.Id, 'Screening', null, null, null, null, null);
    System.assertEquals(1, result.size(), 'Should return 1 Screening candidate');
    System.assertEquals('Jane', result[0].First_Name__c);
  }

  @isTest
  static void testFilterBySearchTerm() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    List<Candidate__c> result = CandidateController.filterCandidates(acc.Id, null, 'john', null, null, null, null);
    System.assertEquals(1, result.size(), 'Should find Bob Johnson');
  }

  @isTest
  static void testFilterByApostropheSearchTerm() {
    Candidate__c candidate = [SELECT Id, Last_Name__c FROM Candidate__c WHERE First_Name__c = 'Alice' LIMIT 1];
    candidate.Last_Name__c = 'O\'Connor';
    update candidate;

    Account acc = [SELECT Id FROM Account LIMIT 1];
    List<Candidate__c> result = CandidateController.filterCandidates(acc.Id, null, 'O\'Connor', null, null, null, null);
    System.assertEquals(1, result.size(), 'A bound apostrophe must remain searchable');
  }

  @isTest
  static void testFilterByStageAndSearch() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    List<Candidate__c> result = CandidateController.filterCandidates(acc.Id, 'New', 'alice', null, null, null, null);
    System.assertEquals(1, result.size());
  }

  @isTest
  static void testFilterByCountriesAndExperience() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    List<Candidate__c> result = CandidateController.filterCandidates(
      acc.Id,
      null,
      null,
      new List<String>{ 'Germany', 'France' },
      4,
      null,
      null
    );
    System.assertEquals(2, result.size(), 'Jane (Germany, 8) and Alice (France, 5) match');

    result = CandidateController.filterCandidates(
      acc.Id,
      null,
      null,
      new List<String>{ 'Germany', 'France' },
      6,
      null,
      null
    );
    System.assertEquals(1, result.size(), 'Only Jane has 6+ years');
    System.assertEquals('Jane', result[0].First_Name__c);
  }

  @isTest
  static void testFilterSortByExperienceDesc() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    List<Candidate__c> result = CandidateController.filterCandidates(
      acc.Id,
      null,
      null,
      null,
      null,
      'experience',
      'desc'
    );
    System.assertEquals(3, result.size());
    System.assertEquals('Jane', result[0].First_Name__c, 'Highest experience first');
    System.assertEquals('Bob', result[2].First_Name__c, 'Lowest experience last');
  }

  @isTest
  static void testFilterInvalidSortByRejected() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    Boolean caught = false;
    try {
      CandidateController.filterCandidates(acc.Id, null, null, null, null, 'Id; DELETE', null);
    } catch (AuraHandledException e) {
      caught = true;
    }
    System.assert(caught, 'sortBy outside the allowlist must be rejected');
  }

  @isTest
  static void testCreateCandidate() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    Candidate__c result = CandidateController.createCandidate(acc.Id, 'Tom', 'Brown', 'tom@test.com', null, null);
    System.assertNotEquals(null, result.Id);
    System.assertEquals('New', result.Stage__c);
  }

  @isTest
  static void testCreateCandidateWithStage() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    Candidate__c result = CandidateController.createCandidate(acc.Id, 'Sarah', 'Davis', null, null, 'Offer');
    System.assertEquals('Offer', result.Stage__c);
  }

  @isTest
  static void testCreateCandidateInvalidStage() {
    Account acc = [SELECT Id FROM Account LIMIT 1];
    Boolean caught = false;
    try {
      CandidateController.createCandidate(acc.Id, 'Bad', 'Stage', null, null, 'InvalidStage');
    } catch (Exception e) {
      caught = true;
    }
    System.assert(caught, 'Should have thrown for invalid stage');
  }

  @isTest
  static void testUpdateCandidateStage() {
    Candidate__c cand = [SELECT Id FROM Candidate__c WHERE First_Name__c = 'Jane' LIMIT 1];
    Candidate__c result = CandidateController.updateCandidateStage(cand.Id, 'Interview');
    System.assertEquals('Interview', result.Stage__c);
  }

  @isTest
  static void testUpdateCandidateStageInvalid() {
    Candidate__c cand = [SELECT Id FROM Candidate__c LIMIT 1];
    Boolean caught = false;
    try {
      CandidateController.updateCandidateStage(cand.Id, 'BadStage');
    } catch (Exception e) {
      caught = true;
    }
    System.assert(caught, 'Should have thrown for invalid stage');
  }

  @isTest
  static void testDeleteCandidate() {
    Candidate__c cand = [SELECT Id FROM Candidate__c WHERE First_Name__c = 'Alice' LIMIT 1];
    CandidateController.deleteCandidate(cand.Id);
    List<Candidate__c> remaining = [SELECT Id FROM Candidate__c WHERE Id = :cand.Id];
    System.assertEquals(0, remaining.size());
  }

  @isTest
  static void testUpdateCandidate() {
    Candidate__c cand = [SELECT Id FROM Candidate__c WHERE First_Name__c = 'Jane' LIMIT 1];
    Candidate__c result = CandidateController.updateCandidate(
      cand.Id,
      'Janet',
      null,
      'janet@new.com',
      null,
      'Offer',
      'Great candidate'
    );
    System.assertEquals('Janet', result.First_Name__c);
    System.assertEquals('Smith', result.Last_Name__c); // unchanged
    System.assertEquals('janet@new.com', result.Email__c);
    System.assertEquals('Offer', result.Stage__c);
    System.assertEquals('Great candidate', result.Notes__c);
  }

  @isTest
  static void testUpdateCandidateNullsPreserve() {
    Candidate__c cand = [SELECT Id, Email__c FROM Candidate__c WHERE First_Name__c = 'Jane' LIMIT 1];
    String origEmail = cand.Email__c;
    Candidate__c result = CandidateController.updateCandidate(cand.Id, null, null, null, null, null, null);
    System.assertEquals(origEmail, result.Email__c); // nothing changed
  }

  @isTest
  static void testGetCandidate() {
    Candidate__c cand = [SELECT Id FROM Candidate__c WHERE First_Name__c = 'Bob' LIMIT 1];
    Candidate__c result = CandidateController.getCandidate(cand.Id);
    System.assertEquals('Bob', result.First_Name__c);
    System.assertNotEquals(null, result.Account__c);
  }

  @isTest
  static void testUpdateCandidateField() {
    Candidate__c cand = [SELECT Id FROM Candidate__c WHERE First_Name__c = 'Alice' LIMIT 1];
    Candidate__c result = CandidateController.updateCandidateField(cand.Id, 'Stage__c', 'Interview');
    System.assertEquals('Interview', result.Stage__c);
  }

  @isTest
  static void testUpdateCandidateFieldDisallowed() {
    Candidate__c cand = [SELECT Id FROM Candidate__c LIMIT 1];
    Boolean caught = false;
    try {
      CandidateController.updateCandidateField(cand.Id, 'Account__c', 'bad');
    } catch (Exception e) {
      caught = true;
    }
    System.assert(caught, 'Should reject disallowed field');
  }

  @isTest
  static void testGetCandidateNotFound() {
    Candidate__c cand = [SELECT Id FROM Candidate__c LIMIT 1];
    Id staleId = cand.Id;
    delete cand;
    Boolean caught = false;
    try {
      CandidateController.getCandidate(staleId);
    } catch (AuraHandledException e) {
      caught = true;
    }
    System.assert(caught, 'Stale id must produce a handled error, not a raw QueryException');
  }

  @isTest
  static void testUpdateCandidateStageNotFound() {
    Candidate__c cand = [SELECT Id FROM Candidate__c LIMIT 1];
    Id staleId = cand.Id;
    delete cand;
    Boolean caught = false;
    try {
      CandidateController.updateCandidateStage(staleId, 'Offer');
    } catch (AuraHandledException e) {
      caught = true;
    }
    System.assert(caught, 'Stale id must produce a handled error, not a raw QueryException');
  }

  @isTest
  static void testUserModeBlocksUserWithoutObjectAccess() {
    List<Profile> profiles = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
    if (profiles.isEmpty()) {
      return; // org shape without the profile — USER_MODE is still covered by code, skip the runAs assertion
    }
    User restricted = new User(
      Alias = 'noacc',
      Email = 'noaccess@sf-agent-bridge.invalid',
      EmailEncodingKey = 'UTF-8',
      LastName = 'NoAccess',
      LanguageLocaleKey = 'en_US',
      LocaleSidKey = 'en_US',
      ProfileId = profiles[0].Id,
      TimeZoneSidKey = 'Europe/Kyiv',
      Username = 'noaccess.' + System.currentTimeMillis() + '@sf-agent-bridge.invalid'
    );
    insert restricted;
    System.runAs(restricted) {
      Boolean caught = false;
      try {
        CandidateController.getCandidatesByAccount(null);
      } catch (Exception e) {
        caught = true;
      }
      System.assert(caught, 'USER_MODE must block a user without object permissions');
    }
  }
}
