import {
    CHANNEL_NAME,
    MessageType,
    InternalAction,
    generateId,
    getTabId,
    validateParams
} from 'c/agentBridgeUtils';

const AgentBridgeMixin = (Base) =>
    class extends Base {
        _agentComponentId = null;
        _channel = null;
        _tabId = null;
        _orchestratorId = null;

        // ── Public API (override in consumer) ──────────────────────

        get agentComponentId() {
            if (!this._agentComponentId) {
                const stableKey = this.agentStableKey;
                this._agentComponentId = stableKey
                    ? `stable:${this.agentComponentLabel}:${stableKey}`
                    : generateId();
            }
            return this._agentComponentId;
        }

        get agentComponentLabel() {
            // constructor.name gets minified in production; the tag name doesn't
            const tag = this.template?.host?.tagName;
            if (tag) {
                return tag
                    .toLowerCase()
                    .replace(/^c-/, '')
                    .replace(/(?:^|-)([a-z0-9])/g, (_, ch) => ch.toUpperCase());
            }
            return this.constructor.name;
        }

        /**
         * Override to provide a stable identifier for this component.
         * When provided, componentId becomes deterministic: `stable:<label>:<key>`
         * This survives component re-creation (e.g., for:each re-renders).
         */
        get agentStableKey() {
            return null;
        }

        get agentActions() {
            return [];
        }

        // eslint-disable-next-line no-unused-vars
        async handleAgentAction(actionName, params) {
            throw new Error('handleAgentAction must be implemented');
        }

        // ── Lifecycle ──────────────────────────────────────────────

        connectedCallback() {
            if (super.connectedCallback) {
                super.connectedCallback();
            }
            this._agentComponentId = null;
            this._orchestratorId = null;
            this._tabId = getTabId();
            this._channel = new BroadcastChannel(CHANNEL_NAME);
            this._channel.onmessage = (event) => this._onMessage(event.data);
            this._sendRegister();
        }

        disconnectedCallback() {
            if (super.disconnectedCallback) {
                super.disconnectedCallback();
            }
            this._sendUnregister();
            if (this._channel) {
                this._channel.close();
                this._channel = null;
            }
        }

        // ── Message Handler ────────────────────────────────────────

        _onMessage(data) {
            if (data.type !== MessageType.INTERNAL) return;
            if (data.tabId && this._tabId && data.tabId !== this._tabId) return;

            switch (data.action) {
                case InternalAction.ROLL_CALL:
                case InternalAction.ORCHESTRATOR_READY:
                    if (data.orchestratorId) {
                        this._orchestratorId = data.orchestratorId;
                    }
                    this._sendRegister();
                    break;
                case InternalAction.REGISTER_ACK:
                    if (data.componentId === this.agentComponentId && data.orchestratorId) {
                        this._orchestratorId = data.orchestratorId;
                    }
                    break;
                case InternalAction.ORCHESTRATOR_GONE:
                    if (data.orchestratorId === this._orchestratorId) {
                        this._orchestratorId = null;
                    }
                    break;
                case InternalAction.EXECUTE:
                    if (data.componentId !== this.agentComponentId) break;
                    // forged EXECUTE bypassing the orchestrator (and its approval gate) is dropped
                    if (!data.orchestratorId || data.orchestratorId !== this._orchestratorId) {
                        console.warn(
                            `AgentBridge: '${this.agentComponentLabel}' ignored EXECUTE from unrecognized orchestrator`
                        );
                        break;
                    }
                    this._handleExecute(data);
                    break;
                default:
                    break;
            }
        }

        // ── Registration ───────────────────────────────────────────

        _sendRegister() {
            this._send(InternalAction.REGISTER, {
                componentId: this.agentComponentId,
                label: this.agentComponentLabel,
                actions: this.agentActions
            });
        }

        _sendUnregister() {
            this._send(InternalAction.UNREGISTER, {
                componentId: this.agentComponentId
            });
        }

        // ── Execute ────────────────────────────────────────────────

        async _handleExecute(data) {
            const { correlationId, actionName, params } = data;

            try {
                const actionDef = this.agentActions.find((a) => a.name === actionName);
                if (!actionDef) {
                    throw new Error(`Unknown action: ${actionName}`);
                }

                const validationErrors = validateParams(params || {}, actionDef.params);
                if (validationErrors.length > 0) {
                    throw new Error(`Validation error: ${validationErrors.join('; ')}`);
                }

                const result = await this.handleAgentAction(actionName, params || {});
                this._send(InternalAction.RESULT, { correlationId, result });
            } catch (error) {
                this._send(InternalAction.RESULT, {
                    correlationId,
                    error: true,
                    errorMessage: error.message || 'Unknown error'
                });
            }
        }

        // ── Transport ──────────────────────────────────────────────

        _send(action, extra) {
            if (this._channel) {
                this._channel.postMessage({
                    type: MessageType.INTERNAL,
                    action,
                    tabId: this._tabId,
                    ...extra
                });
            }
        }
    };

export default AgentBridgeMixin;
