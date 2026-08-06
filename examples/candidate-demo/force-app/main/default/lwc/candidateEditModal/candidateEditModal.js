import LightningModal from 'lightning/modal';
import { api } from 'lwc';

const AUTO_SUBMIT_DELAY_MS = 1200;

export default class CandidateEditModal extends LightningModal {
  @api candidateId;
  @api firstName;
  @api lastName;
  @api email;
  @api phone;
  @api stage;
  @api notes;
  @api autoSubmitMode; // Pass 'true' string to auto-save

  _firstName;
  _lastName;
  _email;
  _phone;
  _stage;
  _notes;
  _autoSubmitScheduled = false;

  get stageOptions() {
    return [
      { label: 'New', value: 'New' },
      { label: 'Screening', value: 'Screening' },
      { label: 'Interview', value: 'Interview' },
      { label: 'Offer', value: 'Offer' },
      { label: 'Hired', value: 'Hired' },
      { label: 'Rejected', value: 'Rejected' }
    ];
  }

  connectedCallback() {
    super.connectedCallback();
    this._firstName = this.firstName || '';
    this._lastName = this.lastName || '';
    this._email = this.email || '';
    this._phone = this.phone || '';
    this._stage = this.stage || 'New';
    this._notes = this.notes || '';
  }

  renderedCallback() {
    if (this.autoSubmitMode === 'true' && !this._autoSubmitScheduled) {
      this._autoSubmitScheduled = true;
      // eslint-disable-next-line @lwc/lwc/no-async-operation
      setTimeout(() => this.handleSave(), AUTO_SUBMIT_DELAY_MS);
    }
  }

  handleFieldChange(event) {
    const field = event.target.dataset.field;
    this['_' + field] = event.detail.value ?? event.target.value;
  }

  handleSave() {
    this.close({
      candidateId: this.candidateId,
      firstName: this._firstName,
      lastName: this._lastName,
      email: this._email,
      phone: this._phone,
      stage: this._stage,
      notes: this._notes
    });
  }

  handleCancel() {
    this.close(null);
  }
}
