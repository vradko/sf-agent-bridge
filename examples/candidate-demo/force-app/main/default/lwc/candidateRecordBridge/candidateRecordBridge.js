import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import AgentBridgeMixin from 'c/agentBridgeMixin';
import getCandidate from '@salesforce/apex/CandidateController.getCandidate';
import updateCandidateField from '@salesforce/apex/CandidateController.updateCandidateField';

export default class CandidateRecordBridge extends NavigationMixin(AgentBridgeMixin(LightningElement)) {
  @api recordId;

  _candidate;

  get agentComponentLabel() {
    return 'CandidateRecordView';
  }

  get agentActions() {
    return [
      {
        name: 'getRecord',
        description: 'Returns full details of the current candidate record',
        params: [],
        returns: { type: 'object', description: 'Candidate record with all fields' }
      },
      {
        name: 'updateField',
        description: 'Updates a single field on this candidate',
        params: [
          {
            name: 'fieldName',
            type: 'string',
            required: true,
            description: 'API name of the field',
            enum: ['First_Name__c', 'Last_Name__c', 'Email__c', 'Phone__c', 'Stage__c', 'Notes__c', 'Country__c']
          },
          { name: 'value', type: 'string', required: true, description: 'New field value' }
        ],
        returns: { type: 'object', description: 'Updated candidate', schema: { success: 'boolean' } }
      },
      {
        name: 'navigateToAccount',
        description: 'Navigates back to the parent Account record page',
        params: [],
        returns: { type: 'object', description: 'Navigation result', schema: { success: 'boolean' } }
      }
    ];
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadRecord();
  }

  _loadError = null;

  async _loadRecord() {
    try {
      this._loadError = null;
      this._candidate = await getCandidate({ candidateId: this.recordId });
    } catch (e) {
      this._loadError = e.body ? e.body.message : e.message;
      this._candidate = null;
      console.error('CandidateRecordBridge: failed to load record', e);
    }
  }

  get candidateName() {
    return this._candidate ? `${this._candidate.First_Name__c} ${this._candidate.Last_Name__c}` : 'Loading...';
  }

  async handleAgentAction(actionName, params) {
    switch (actionName) {
      case 'getRecord':
        return this._getRecord();
      case 'updateField':
        return this._updateField(params);
      case 'navigateToAccount':
        return this._navigateToAccount();
      default:
        throw new Error(`Unknown action: ${actionName}`);
    }
  }

  async _getRecord() {
    await this._loadRecord();
    if (!this._candidate) {
      throw new Error(this._loadError || 'Failed to load candidate record');
    }
    const c = this._candidate;
    return {
      id: c.Id,
      name: `${c.First_Name__c} ${c.Last_Name__c}`,
      firstName: c.First_Name__c,
      lastName: c.Last_Name__c,
      email: c.Email__c || '',
      phone: c.Phone__c || '',
      stage: c.Stage__c,
      notes: c.Notes__c || '',
      accountId: c.Account__c
    };
  }

  async _updateField({ fieldName, value }) {
    const result = await updateCandidateField({
      candidateId: this.recordId,
      fieldName,
      fieldValue: value
    });
    this._candidate = result;
    return {
      success: true,
      field: fieldName,
      value: result[fieldName]
    };
  }

  _navigateToAccount() {
    if (!this._candidate || !this._candidate.Account__c) {
      throw new Error('No parent account found');
    }
    this[NavigationMixin.Navigate]({
      type: 'standard__recordPage',
      attributes: {
        recordId: this._candidate.Account__c,
        objectApiName: 'Account',
        actionName: 'view'
      }
    });
    return { success: true, accountId: this._candidate.Account__c };
  }
}
