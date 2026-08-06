import { LightningElement, api } from 'lwc';
import AgentBridgeMixin from 'c/agentBridgeMixin';
import updateCandidateStageApex from '@salesforce/apex/CandidateController.updateCandidateStage';

export default class CandidateRow extends AgentBridgeMixin(LightningElement) {
  @api candidate;

  _highlighted = false;

  get agentComponentLabel() {
    return 'CandidateRow';
  }

  get agentStableKey() {
    return this.candidate ? this.candidate.Id : null;
  }

  get agentActions() {
    return [
      {
        name: 'getDetails',
        description: 'Returns full details of this candidate',
        params: [],
        returns: { type: 'object', description: 'Candidate record' }
      },
      {
        name: 'updateStage',
        description: 'Updates the stage of this specific candidate',
        params: [
          {
            name: 'stage',
            type: 'string',
            required: true,
            description: 'New stage',
            enum: ['New', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected']
          }
        ],
        returns: { type: 'object', description: 'Updated candidate', schema: { success: 'boolean', stage: 'string' } }
      },
      {
        name: 'highlight',
        description: 'Visually highlights this candidate row for 3 seconds',
        params: [],
        returns: { type: 'object', description: 'Result', schema: { success: 'boolean' } }
      }
    ];
  }

  get rowClass() {
    return this._highlighted ? 'slds-theme_shade slds-theme_alert-texture' : '';
  }

  get stageVariant() {
    const variants = {
      New: 'brand',
      Screening: 'inverse',
      Interview: 'warning',
      Offer: 'success',
      Hired: 'success',
      Rejected: 'error'
    };
    return variants[this.candidate?.Stage__c] || 'brand';
  }

  get fullName() {
    return this.candidate ? `${this.candidate.First_Name__c} ${this.candidate.Last_Name__c}` : '';
  }

  handleViewClick() {
    this.dispatchEvent(
      new CustomEvent('viewrecord', {
        detail: { candidateId: this.candidate.Id },
        bubbles: true,
        composed: true
      })
    );
  }

  async handleAgentAction(actionName, params) {
    switch (actionName) {
      case 'getDetails':
        return {
          id: this.candidate.Id,
          name: this.fullName,
          firstName: this.candidate.First_Name__c,
          lastName: this.candidate.Last_Name__c,
          email: this.candidate.Email__c || '',
          phone: this.candidate.Phone__c || '',
          country: this.candidate.Country__c || '',
          stage: this.candidate.Stage__c,
          interviewDate: this.candidate.Interview_Date__c || null,
          experience: this.candidate.Years_Experience__c ?? null,
          notes: this.candidate.Notes__c || ''
        };
      case 'updateStage':
        return this._updateStage(params.stage);
      case 'highlight':
        return this._highlight();
      default:
        throw new Error(`Unknown action: ${actionName}`);
    }
  }

  async _updateStage(stage) {
    const result = await updateCandidateStageApex({
      candidateId: this.candidate.Id,
      stage
    });
    const returnValue = { success: true, stage: result.Stage__c };
    // Defer parent notification — RESULT must be sent before row is potentially destroyed
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    setTimeout(() => {
      this.dispatchEvent(
        new CustomEvent('stagechanged', {
          detail: { candidateId: this.candidate.Id, stage: result.Stage__c },
          bubbles: true,
          composed: true
        })
      );
    }, 0);
    return returnValue;
  }

  _highlight() {
    this._highlighted = true;
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    setTimeout(() => {
      this._highlighted = false;
    }, 3000);
    return { success: true };
  }
}
