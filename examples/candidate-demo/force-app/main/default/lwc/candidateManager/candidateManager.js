import { LightningElement, api } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import AgentBridgeMixin from 'c/agentBridgeMixin';
import { stableComponentId } from 'c/agentBridgeUtils';
import CandidateEditModal from 'c/candidateEditModal';
import getCandidatesByAccount from '@salesforce/apex/CandidateController.getCandidatesByAccount';
import filterCandidates from '@salesforce/apex/CandidateController.filterCandidates';
import createCandidateApex from '@salesforce/apex/CandidateController.createCandidate';
import updateCandidateStageApex from '@salesforce/apex/CandidateController.updateCandidateStage';
import updateCandidateApex from '@salesforce/apex/CandidateController.updateCandidate';
import deleteCandidateApex from '@salesforce/apex/CandidateController.deleteCandidate';

export default class CandidateManager extends NavigationMixin(AgentBridgeMixin(LightningElement)) {
  @api recordId;

  _candidates = [];
  _error;
  _loading = true;
  _activeStageFilter = '';
  _activeSearchTerm = '';
  _activeCountries = [];
  _activeMinExperience = null;
  _activeSortBy = '';
  _activeSortDirection = '';

  get agentComponentLabel() {
    return 'CandidateManager';
  }

  get agentActions() {
    return [
      {
        name: 'getCandidates',
        description:
          'Returns candidates for the current account, optionally filtered and sorted. The live table updates to match.',
        params: [
          {
            name: 'stage',
            type: 'string',
            required: false,
            description: 'Filter by stage',
            enum: ['New', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected']
          },
          { name: 'searchTerm', type: 'string', required: false, description: 'Search by name' },
          {
            name: 'countries',
            type: 'array',
            required: false,
            description:
              'Filter by country (array of exact values). Valid values: Germany, France, Spain, Poland, Ukraine, United Kingdom, Netherlands, Italy, India, United States, Canada, Brazil, Japan, Australia'
          },
          { name: 'minExperience', type: 'number', required: false, description: 'Minimum years of experience' },
          {
            name: 'sortBy',
            type: 'string',
            required: false,
            description: 'Sort results by field',
            enum: ['name', 'stage', 'country', 'interviewDate', 'experience']
          },
          {
            name: 'sortDirection',
            type: 'string',
            required: false,
            description: 'Sort direction, default asc',
            enum: ['asc', 'desc']
          }
        ],
        returns: {
          type: 'array',
          description: 'Candidate objects with id, name, email, country, stage, interviewDate, experience'
        }
      },
      {
        name: 'createCandidate',
        description: 'Creates a new candidate for this account',
        params: [
          { name: 'firstName', type: 'string', required: true, description: 'First name' },
          { name: 'lastName', type: 'string', required: true, description: 'Last name' },
          { name: 'email', type: 'string', required: false, description: 'Email' },
          { name: 'phone', type: 'string', required: false, description: 'Phone' },
          {
            name: 'stage',
            type: 'string',
            required: false,
            description: 'Stage (default: New)',
            enum: ['New', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected']
          }
        ],
        returns: { type: 'object', description: 'Created candidate' }
      },
      {
        name: 'updateCandidateStage',
        description: 'Updates pipeline stage of a candidate',
        params: [
          { name: 'candidateId', type: 'string', required: true, description: 'Record Id' },
          {
            name: 'stage',
            type: 'string',
            required: true,
            description: 'New stage',
            enum: ['New', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected']
          }
        ],
        returns: { type: 'object', description: 'Updated candidate' }
      },
      {
        name: 'editCandidate',
        description:
          'Opens an edit modal with pre-filled fields, auto-submits after 1 second so agent can see the UI interaction. Use for demonstrating modal workflows.',
        params: [
          { name: 'candidateId', type: 'string', required: true, description: 'Record Id' },
          { name: 'firstName', type: 'string', required: false, description: 'New first name' },
          { name: 'lastName', type: 'string', required: false, description: 'New last name' },
          { name: 'email', type: 'string', required: false, description: 'New email' },
          { name: 'phone', type: 'string', required: false, description: 'New phone' },
          {
            name: 'stage',
            type: 'string',
            required: false,
            description: 'New stage',
            enum: ['New', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected']
          },
          { name: 'notes', type: 'string', required: false, description: 'New notes' }
        ],
        returns: { type: 'object', description: 'Updated candidate' }
      },
      {
        name: 'updateCandidate',
        description: 'Updates candidate fields directly without opening a modal. Use for fast programmatic updates.',
        params: [
          { name: 'candidateId', type: 'string', required: true, description: 'Record Id' },
          { name: 'firstName', type: 'string', required: false, description: 'New first name' },
          { name: 'lastName', type: 'string', required: false, description: 'New last name' },
          { name: 'email', type: 'string', required: false, description: 'New email' },
          { name: 'phone', type: 'string', required: false, description: 'New phone' },
          {
            name: 'stage',
            type: 'string',
            required: false,
            description: 'New stage',
            enum: ['New', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected']
          },
          { name: 'notes', type: 'string', required: false, description: 'New notes' }
        ],
        returns: { type: 'object', description: 'Updated candidate' }
      },
      {
        name: 'navigateToCandidate',
        description: 'Navigates to candidate record page',
        params: [{ name: 'candidateId', type: 'string', required: true, description: 'Record Id' }],
        returns: { type: 'object', description: 'Navigation result' }
      },
      {
        name: 'getRowComponents',
        description: 'Returns mapping of candidate record IDs to stable bridge component IDs for row-level targeting',
        params: [],
        returns: { type: 'object', description: 'Map of candidateId to componentId' }
      },
      {
        name: 'deleteCandidate',
        description: 'Permanently deletes a candidate',
        dangerous: true,
        params: [{ name: 'candidateId', type: 'string', required: true, description: 'Record Id' }],
        returns: { type: 'object', description: 'Deletion result' }
      }
    ];
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadCandidates();
  }

  get hasError() {
    return !!this._error;
  }

  get hasCandidates() {
    return this._candidates.length > 0;
  }

  get stageOptions() {
    return [
      { label: 'All Stages', value: '' },
      { label: 'New', value: 'New' },
      { label: 'Screening', value: 'Screening' },
      { label: 'Interview', value: 'Interview' },
      { label: 'Offer', value: 'Offer' },
      { label: 'Hired', value: 'Hired' },
      { label: 'Rejected', value: 'Rejected' }
    ];
  }

  get filterSummary() {
    const parts = [];
    if (this._activeStageFilter) parts.push(`Stage: ${this._activeStageFilter}`);
    if (this._activeSearchTerm) parts.push(`Search: "${this._activeSearchTerm}"`);
    if (this._activeCountries.length) parts.push(`Countries: ${this._activeCountries.join(', ')}`);
    if (this._activeMinExperience !== null) parts.push(`Experience ≥ ${this._activeMinExperience}`);
    if (this._activeSortBy) parts.push(`Sorted by: ${this._activeSortBy} ${this._activeSortDirection || 'asc'}`);
    return parts.length > 0 ? parts.join(' | ') : '';
  }

  get hasActiveFilter() {
    return !!(
      this._activeStageFilter ||
      this._activeSearchTerm ||
      this._activeCountries.length ||
      this._activeMinExperience !== null ||
      this._activeSortBy
    );
  }

  // --- UI Handlers ---

  handleStageFilterChange(event) {
    this._activeStageFilter = event.detail.value;
    this._loadCandidates();
  }

  handleSearchChange(event) {
    this._activeSearchTerm = event.target.value;
  }

  handleSearchKeyUp(event) {
    if (event.key === 'Enter') {
      this._loadCandidates();
    }
  }

  handleClearFilters() {
    this._activeStageFilter = '';
    this._activeSearchTerm = '';
    this._activeCountries = [];
    this._activeMinExperience = null;
    this._activeSortBy = '';
    this._activeSortDirection = '';
    this._loadCandidates();
  }

  handleViewRecord(event) {
    const candidateId = event.detail.candidateId;
    this._navigateToCandidate({ candidateId });
  }

  handleStageChanged() {
    this._loadCandidates();
  }

  // --- Data Loading ---

  async _loadCandidates() {
    this._loading = true;
    this._error = undefined;
    try {
      if (this.hasActiveFilter) {
        this._candidates = await filterCandidates({
          accountId: this.recordId,
          stage: this._activeStageFilter || null,
          searchTerm: this._activeSearchTerm || null,
          countries: this._activeCountries.length ? this._activeCountries : null,
          minExperience: this._activeMinExperience,
          sortBy: this._activeSortBy || null,
          sortDirection: this._activeSortDirection || null
        });
      } else {
        this._candidates = await getCandidatesByAccount({ accountId: this.recordId });
      }
    } catch (error) {
      this._error = error.body ? error.body.message : error.message;
      this._candidates = [];
    }
    this._loading = false;
  }

  // --- Agent Actions ---

  async handleAgentAction(actionName, params) {
    switch (actionName) {
      case 'getCandidates':
        return this._getCandidates(params);
      case 'createCandidate':
        return this._createCandidate(params);
      case 'updateCandidateStage':
        return this._updateStage(params);
      case 'editCandidate':
        return this._editCandidate(params);
      case 'updateCandidate':
        return this._updateCandidateDirect(params);
      case 'navigateToCandidate':
        return this._navigateToCandidate(params);
      case 'getRowComponents':
        return this._getRowComponents();
      case 'deleteCandidate':
        return this._deleteCandidate(params);
      default:
        throw new Error(`Unknown action: ${actionName}`);
    }
  }

  async _getCandidates({ stage, searchTerm, countries, minExperience, sortBy, sortDirection }) {
    this._activeStageFilter = stage || '';
    this._activeSearchTerm = searchTerm || '';
    this._activeCountries = Array.isArray(countries) ? countries : [];
    this._activeMinExperience = minExperience === undefined || minExperience === null ? null : minExperience;
    this._activeSortBy = sortBy || '';
    this._activeSortDirection = sortDirection || '';
    await this._loadCandidates();
    if (this._error) {
      throw new Error(this._error);
    }
    return this._candidates.map((c) => ({
      id: c.Id,
      name: `${c.First_Name__c} ${c.Last_Name__c}`,
      email: c.Email__c || '',
      phone: c.Phone__c || '',
      country: c.Country__c || '',
      stage: c.Stage__c,
      interviewDate: c.Interview_Date__c || null,
      experience: c.Years_Experience__c ?? null
    }));
  }

  async _createCandidate({ firstName, lastName, email, phone, stage }) {
    const result = await createCandidateApex({
      accountId: this.recordId,
      firstName,
      lastName,
      email: email || null,
      phone: phone || null,
      stage: stage || null
    });
    await this._loadCandidates();
    return { id: result.Id, name: `${result.First_Name__c} ${result.Last_Name__c}`, success: true };
  }

  async _updateStage({ candidateId, stage }) {
    const result = await updateCandidateStageApex({ candidateId, stage });
    await this._loadCandidates();
    return {
      id: result.Id,
      name: `${result.First_Name__c} ${result.Last_Name__c}`,
      stage: result.Stage__c,
      success: true
    };
  }

  async _editCandidate(params) {
    const { candidateId } = params;

    // 1. Save data via Apex (only non-null params are updated)
    const updated = await updateCandidateApex({
      candidateId,
      firstName: params.firstName === undefined ? null : params.firstName,
      lastName: params.lastName === undefined ? null : params.lastName,
      email: params.email === undefined ? null : params.email,
      phone: params.phone === undefined ? null : params.phone,
      stage: params.stage === undefined ? null : params.stage,
      notes: params.notes === undefined ? null : params.notes
    });

    // 2. Show modal briefly for visual feedback, then auto-close
    CandidateEditModal.open({
      size: 'medium',
      candidateId,
      firstName: updated.First_Name__c,
      lastName: updated.Last_Name__c,
      email: updated.Email__c || '',
      phone: updated.Phone__c || '',
      stage: updated.Stage__c,
      notes: updated.Notes__c || '',
      autoSubmitMode: 'true'
    });

    await this._loadCandidates();
    return {
      id: updated.Id,
      name: `${updated.First_Name__c} ${updated.Last_Name__c}`,
      stage: updated.Stage__c,
      success: true,
      modalShown: true
    };
  }

  async _updateCandidateDirect(params) {
    const updated = await updateCandidateApex({
      candidateId: params.candidateId,
      firstName: params.firstName === undefined ? null : params.firstName,
      lastName: params.lastName === undefined ? null : params.lastName,
      email: params.email === undefined ? null : params.email,
      phone: params.phone === undefined ? null : params.phone,
      stage: params.stage === undefined ? null : params.stage,
      notes: params.notes === undefined ? null : params.notes
    });
    await this._loadCandidates();
    return {
      id: updated.Id,
      name: `${updated.First_Name__c} ${updated.Last_Name__c}`,
      stage: updated.Stage__c,
      success: true
    };
  }

  _navigateToCandidate({ candidateId }) {
    this[NavigationMixin.Navigate]({
      type: 'standard__recordPage',
      attributes: { recordId: candidateId, objectApiName: 'Candidate__c', actionName: 'view' }
    });
    return { success: true };
  }

  _getRowComponents() {
    const mapping = {};
    for (const c of this._candidates) {
      mapping[c.Id] = stableComponentId('CandidateRow', c.Id);
    }
    return mapping;
  }

  async _deleteCandidate({ candidateId }) {
    await deleteCandidateApex({ candidateId });
    await this._loadCandidates();
    return { success: true };
  }
}
