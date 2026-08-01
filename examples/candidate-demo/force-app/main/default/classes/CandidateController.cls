public with sharing class CandidateController {
  private static final Set<String> VALID_STAGES = new Set<String>{
    'New',
    'Screening',
    'Interview',
    'Offer',
    'Hired',
    'Rejected'
  };

  // Whitelists for dynamic ORDER BY — never interpolate raw input into SOQL
  private static final Map<String, String> SORT_FIELDS = new Map<String, String>{
    'name' => 'Last_Name__c',
    'stage' => 'Stage__c',
    'country' => 'Country__c',
    'interviewDate' => 'Interview_Date__c',
    'experience' => 'Years_Experience__c'
  };
  private static final String FIELD_LIST =
    'Id, Name, First_Name__c, Last_Name__c, Email__c, Phone__c, Stage__c, ' +
    'Notes__c, Country__c, Interview_Date__c, Years_Experience__c';

  // not cacheable: reads must reflect agent mutations immediately, without a page reload
  @AuraEnabled
  public static List<Candidate__c> getCandidatesByAccount(Id accountId) {
    return Database.query(
      'SELECT ' +
        FIELD_LIST +
        ' FROM Candidate__c WHERE Account__c = :accountId ' +
        'WITH USER_MODE ORDER BY Last_Name__c, First_Name__c LIMIT 500'
    );
  }

  @AuraEnabled
  public static List<Candidate__c> filterCandidates(
    Id accountId,
    String stage,
    String searchTerm,
    List<String> countries,
    Decimal minExperience,
    String sortBy,
    String sortDirection
  ) {
    String query = 'SELECT ' + FIELD_LIST + ' FROM Candidate__c WHERE Account__c = :accountId';

    if (String.isNotBlank(stage)) {
      query += ' AND Stage__c = :stage';
    }
    if (String.isNotBlank(searchTerm)) {
      // Bind variables are escaped by Salesforce. Manual escaping would break names such as O'Connor.
      searchTerm = '%' + searchTerm + '%';
      query += ' AND (First_Name__c LIKE :searchTerm OR Last_Name__c LIKE :searchTerm)';
    }
    if (countries != null && !countries.isEmpty()) {
      query += ' AND Country__c IN :countries';
    }
    if (minExperience != null) {
      query += ' AND Years_Experience__c >= :minExperience';
    }

    String orderBy = 'Last_Name__c, First_Name__c';
    if (String.isNotBlank(sortBy)) {
      if (!SORT_FIELDS.containsKey(sortBy)) {
        throw new AuraHandledException(
          'Invalid sortBy: ' + sortBy + '. Valid: ' + String.join(new List<String>(SORT_FIELDS.keySet()), ', ')
        );
      }
      String direction = 'desc'.equalsIgnoreCase(sortDirection) ? 'DESC' : 'ASC';
      orderBy = SORT_FIELDS.get(sortBy) + ' ' + direction + ' NULLS LAST, Last_Name__c';
    }
    query += ' WITH USER_MODE ORDER BY ' + orderBy + ' LIMIT 500';

    return Database.query(query);
  }

  @AuraEnabled
  public static Candidate__c createCandidate(
    Id accountId,
    String firstName,
    String lastName,
    String email,
    String phone,
    String stage
  ) {
    if (String.isBlank(stage)) {
      stage = 'New';
    }
    if (!VALID_STAGES.contains(stage)) {
      throw new AuraHandledException('Invalid stage: ' + stage);
    }

    Candidate__c candidate = new Candidate__c(
      Account__c = accountId,
      First_Name__c = firstName,
      Last_Name__c = lastName,
      Email__c = email,
      Phone__c = phone,
      Stage__c = stage
    );
    insert as user candidate;
    return [
      SELECT
        Id,
        Name,
        First_Name__c,
        Last_Name__c,
        Email__c,
        Phone__c,
        Stage__c,
        Country__c,
        Interview_Date__c,
        Years_Experience__c
      FROM Candidate__c
      WHERE Id = :candidate.Id
      WITH USER_MODE
    ];
  }

  @AuraEnabled
  public static Candidate__c updateCandidateStage(Id candidateId, String stage) {
    if (!VALID_STAGES.contains(stage)) {
      throw new AuraHandledException('Invalid stage: ' + stage);
    }
    Candidate__c candidate = [SELECT Id FROM Candidate__c WHERE Id = :candidateId WITH USER_MODE];
    candidate.Stage__c = stage;
    update as user candidate;
    return [
      SELECT
        Id,
        Name,
        First_Name__c,
        Last_Name__c,
        Email__c,
        Phone__c,
        Stage__c,
        Country__c,
        Interview_Date__c,
        Years_Experience__c
      FROM Candidate__c
      WHERE Id = :candidateId
      WITH USER_MODE
    ];
  }

  @AuraEnabled
  public static Candidate__c updateCandidate(
    Id candidateId,
    String firstName,
    String lastName,
    String email,
    String phone,
    String stage,
    String notes
  ) {
    Candidate__c candidate = [
      SELECT Id, First_Name__c, Last_Name__c, Email__c, Phone__c, Stage__c, Notes__c
      FROM Candidate__c
      WHERE Id = :candidateId
      WITH USER_MODE
    ];
    if (firstName != null)
      candidate.First_Name__c = firstName;
    if (lastName != null)
      candidate.Last_Name__c = lastName;
    if (email != null)
      candidate.Email__c = email;
    if (phone != null)
      candidate.Phone__c = phone;
    if (stage != null) {
      if (!VALID_STAGES.contains(stage)) {
        throw new AuraHandledException('Invalid stage: ' + stage);
      }
      candidate.Stage__c = stage;
    }
    if (notes != null)
      candidate.Notes__c = notes;
    update as user candidate;
    return [
      SELECT
        Id,
        Name,
        First_Name__c,
        Last_Name__c,
        Email__c,
        Phone__c,
        Stage__c,
        Notes__c,
        Country__c,
        Interview_Date__c,
        Years_Experience__c
      FROM Candidate__c
      WHERE Id = :candidateId
      WITH USER_MODE
    ];
  }

  @AuraEnabled
  public static Candidate__c getCandidate(Id candidateId) {
    return [
      SELECT
        Id,
        Name,
        First_Name__c,
        Last_Name__c,
        Email__c,
        Phone__c,
        Stage__c,
        Notes__c,
        Country__c,
        Interview_Date__c,
        Years_Experience__c,
        Account__c
      FROM Candidate__c
      WHERE Id = :candidateId
      WITH USER_MODE
    ];
  }

  @AuraEnabled
  public static Candidate__c updateCandidateField(Id candidateId, String fieldName, String fieldValue) {
    Set<String> allowedFields = new Set<String>{
      'First_Name__c',
      'Last_Name__c',
      'Email__c',
      'Phone__c',
      'Stage__c',
      'Notes__c',
      'Country__c'
    };
    if (!allowedFields.contains(fieldName)) {
      throw new AuraHandledException('Field not allowed: ' + fieldName);
    }
    if (fieldName == 'Stage__c' && !VALID_STAGES.contains(fieldValue)) {
      throw new AuraHandledException('Invalid stage: ' + fieldValue);
    }
    Candidate__c candidate = [SELECT Id FROM Candidate__c WHERE Id = :candidateId WITH USER_MODE];
    candidate.put(fieldName, fieldValue);
    update as user candidate;
    return [
      SELECT
        Id,
        Name,
        First_Name__c,
        Last_Name__c,
        Email__c,
        Phone__c,
        Stage__c,
        Notes__c,
        Country__c,
        Interview_Date__c,
        Years_Experience__c,
        Account__c
      FROM Candidate__c
      WHERE Id = :candidateId
      WITH USER_MODE
    ];
  }

  @AuraEnabled
  public static void deleteCandidate(Id candidateId) {
    Candidate__c candidate = [SELECT Id FROM Candidate__c WHERE Id = :candidateId WITH USER_MODE];
    delete as user candidate;
  }
}
