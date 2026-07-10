import { LightningElement } from 'lwc';
import AgentBridgeMixin from 'c/agentBridgeMixin';

// Intentionally overrides nothing: exercises the mixin defaults
// (tag-name-derived label, empty actions).
export default class DefaultWidget extends AgentBridgeMixin(LightningElement) {}
