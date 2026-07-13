import { LightningElement, track } from 'lwc';
import {
    BRIDGE_VERSION,
    CHANNEL_NAME,
    MessageType,
    InternalAction,
    AgentAction,
    ResponseStatus,
    Timeout,
    generateId,
    getTabId
} from 'c/agentBridgeUtils';

export default class AgentOrchestrator extends LightningElement {
    _registry = new Map();
    _pendingRequests = new Map();
    _pendingChats = new Map();
    _channel = null;
    _orchestratorId = null;
    _tabId = null;
    _duplicateWarning = false;
    _warningDismissed = false;
    @track _approvalState = null;
    _approvalArmed = false;
    _armTimerId = null;

    get _showWarning() {
        return this._duplicateWarning && !this._warningDismissed;
    }

    get _showApproval() {
        return this._approvalState !== null;
    }

    get _approvalActionName() {
        return this._approvalState?.actionName || '';
    }

    get _approvalDescription() {
        return this._approvalState?.description || '';
    }

    get _approvalComponentLabel() {
        return this._approvalState?.componentLabel || '';
    }

    get _approvalParamSummary() {
        return this._approvalState?.paramSummary || [];
    }

    get _approveDisabled() {
        return !this._approvalArmed;
    }

    handleDismissWarning() {
        this._warningDismissed = true;
    }

    handleApprove() {
        if (!this._approvalState || !this._approvalArmed) return;
        const { payload, resolve, reject, timeoutId } = this._approvalState;
        clearTimeout(timeoutId);
        this._clearApprovalUi();
        this._executeImmediate(payload, Timeout.DANGEROUS_EXECUTE)
            .then(resolve)
            .catch(reject);
    }

    handleReject() {
        if (!this._approvalState) return;
        const { reject, timeoutId } = this._approvalState;
        clearTimeout(timeoutId);
        this._clearApprovalUi();
        reject(new Error('Action rejected by user'));
    }

    _clearApprovalUi() {
        this._approvalState = null;
        this._approvalArmed = false;
        if (this._armTimerId) {
            clearTimeout(this._armTimerId);
            this._armTimerId = null;
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────

    connectedCallback() {
        this._orchestratorId = generateId();
        this._tabId = getTabId();
        this._channel = new BroadcastChannel(CHANNEL_NAME);
        this._channel.onmessage = (event) => this._onMessage(event.data);
        this._broadcast(InternalAction.ORCHESTRATOR_READY, {
            orchestratorId: this._orchestratorId
        });
        this._listenForHandshake();
        this._checkForDuplicates();
    }

    disconnectedCallback() {
        this._broadcast(InternalAction.ORCHESTRATOR_GONE, {
            orchestratorId: this._orchestratorId
        });
        this._stopListeningForHandshake();
        if (this._approvalState) {
            clearTimeout(this._approvalState.timeoutId);
            this._approvalState.reject(new Error('Orchestrator disconnected'));
            this._clearApprovalUi();
        }
        if (this._channel) {
            this._channel.close();
            this._channel = null;
        }
        for (const [, pending] of this._pendingRequests) {
            clearTimeout(pending.timeoutId);
        }
        this._pendingRequests.clear();
    }

    // ── Handshake (Agent → Orchestrator via DOM events) ─────────────

    _listenForHandshake() {
        this._handshakeHandler = (event) => {
            document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake-response', {
                detail: {
                    tabId: this._tabId,
                    orchestratorId: this._orchestratorId,
                    version: BRIDGE_VERSION,
                    requestId: event.detail?.requestId || null
                }
            }));
        };
        document.addEventListener('sf-agent-bridge:handshake', this._handshakeHandler);
    }

    _stopListeningForHandshake() {
        if (this._handshakeHandler) {
            document.removeEventListener('sf-agent-bridge:handshake', this._handshakeHandler);
            this._handshakeHandler = null;
        }
    }

    // ── Duplicate Detection ────────────────────────────────────────

    _checkForDuplicates() {
        const checkId = generateId();
        const sameTabResponses = [];

        const probe = new BroadcastChannel(CHANNEL_NAME);
        probe.onmessage = (event) => {
            const data = event.data;
            if (data.type === MessageType.RESPONSE && data.id === checkId
                && data.payload?.tabId === this._tabId) {
                sameTabResponses.push(data.payload.orchestratorId);
            }
        };
        probe.postMessage({
            type: MessageType.REQUEST,
            id: checkId,
            action: AgentAction.PING,
            payload: {},
            tabId: this._tabId
        });

        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            probe.close();
            const others = sameTabResponses.filter(
                (id) => id !== this._orchestratorId
            );
            if (others.length > 0) {
                this._duplicateWarning = true;
                console.warn('AgentOrchestrator: Multiple orchestrators detected in this tab.');
            }
        }, Timeout.DUPLICATE_CHECK);
    }

    // ── Message Router ─────────────────────────────────────────────

    _onMessage(data) {
        if (data.type === MessageType.INTERNAL) {
            if (data.tabId && data.tabId !== this._tabId) return;
            this._handleInternal(data);
        } else if (data.type === MessageType.REQUEST) {
            if (data.tabId && data.tabId !== this._tabId) return;
            this._handleAgentRequest(data);
        } else if (data.type === MessageType.RESPONSE) {
            this._handleChatResponse(data);
        }
    }

    _handleInternal(data) {
        switch (data.action) {
            case InternalAction.REGISTER:
                this._registry.set(data.componentId, {
                    label: data.label,
                    actions: data.actions
                });
                this._broadcast(InternalAction.REGISTER_ACK, {
                    componentId: data.componentId
                });
                break;
            case InternalAction.UNREGISTER:
                this._registry.delete(data.componentId);
                break;
            case InternalAction.RESULT:
                this._resolveResult(data);
                break;
            case InternalAction.ORCHESTRATOR_READY:
                if (data.orchestratorId !== this._orchestratorId
                    && data.tabId === this._tabId) {
                    this._duplicateWarning = true;
                    console.warn('AgentOrchestrator: Another orchestrator detected in this tab.');
                }
                break;
            case InternalAction.CHAT_MESSAGE:
                this._handleChatMessage(data);
                break;
            default:
                break;
        }
    }

    _resolveResult(data) {
        const pending = this._pendingRequests.get(data.correlationId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this._pendingRequests.delete(data.correlationId);
        if (data.error) {
            pending.reject(new Error(data.errorMessage || 'Unknown error'));
        } else {
            pending.resolve(data.result);
        }
    }

    // ── Agent Request Handler ──────────────────────────────────────

    async _handleAgentRequest(data) {
        const { id, action, payload } = data;
        try {
            let result;
            switch (action) {
                case AgentAction.PING:
                    result = this._ping();
                    break;
                case AgentAction.DISCOVER:
                    result = await this._discover();
                    break;
                case AgentAction.EXECUTE:
                    result = await this._execute(payload, data.tabId);
                    if (result === null) return;
                    break;
                case AgentAction.CHAT:
                    return;
                default:
                    throw new Error(`Unknown action: ${action}`);
            }
            this._respond(id, ResponseStatus.OK, result);
        } catch (error) {
            this._respond(id, ResponseStatus.ERROR, {
                error: true,
                message: error.message
            });
        }
    }

    // ── Actions ────────────────────────────────────────────────────

    _ping() {
        return {
            version: BRIDGE_VERSION,
            componentCount: this._registry.size,
            orchestratorId: this._orchestratorId,
            tabId: this._tabId,
            duplicateWarning: this._duplicateWarning
        };
    }

    _discover() {
        this._broadcast(InternalAction.ROLL_CALL);

        return new Promise((resolve) => {
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            setTimeout(() => {
                const components = [];
                for (const [componentId, data] of this._registry) {
                    components.push({
                        componentId,
                        label: data.label,
                        actions: data.actions
                    });
                }
                resolve({ components });
            }, Timeout.ROLL_CALL);
        });
    }

    _execute(payload, requestTabId) {
        const { componentId, actionName } = payload;

        if (!this._registry.has(componentId)) {
            // no tabId → broadcast request: stay silent, another tab's orchestrator may own it
            if (requestTabId) {
                throw new Error(
                    `Component '${componentId}' not found in this tab. ` +
                    `Run 'discover' to refresh component ids.`
                );
            }
            return null;
        }

        const componentData = this._registry.get(componentId);
        const actionDef = componentData.actions.find((a) => a.name === actionName);
        if (!actionDef) {
            throw new Error(
                `Unknown action '${actionName}' on component '${componentId}'`
            );
        }

        if (actionDef.dangerous) {
            return this._requestApproval(componentData, actionDef, payload);
        }

        return this._executeImmediate(payload);
    }

    _executeImmediate(payload, timeoutMs) {
        const { componentId, actionName, params } = payload;
        const correlationId = generateId();
        const timeout = timeoutMs || Timeout.EXECUTE;

        return new Promise((resolve, reject) => {
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            const timeoutId = setTimeout(() => {
                this._pendingRequests.delete(correlationId);
                reject(new Error(`Execution timeout for action '${actionName}'`));
            }, timeout);

            this._pendingRequests.set(correlationId, { resolve, reject, timeoutId });

            this._broadcast(InternalAction.EXECUTE, {
                componentId,
                correlationId,
                actionName,
                params
            });
        });
    }

    // ── Approval Gate ─────────────────────────────────────────────

    _requestApproval(componentData, actionDef, payload) {
        if (this._approvalState) {
            clearTimeout(this._approvalState.timeoutId);
            this._approvalState.reject(new Error('Superseded by new approval request'));
        }

        // re-arm on every modal content change (see Timeout.APPROVAL_ARM)
        this._approvalArmed = false;
        if (this._armTimerId) clearTimeout(this._armTimerId);
        // eslint-disable-next-line @lwc/lwc/no-async-operation
        this._armTimerId = setTimeout(() => {
            this._approvalArmed = true;
        }, Timeout.APPROVAL_ARM);

        return new Promise((resolve, reject) => {
            // eslint-disable-next-line @lwc/lwc/no-async-operation
            const timeoutId = setTimeout(() => {
                this._clearApprovalUi();
                reject(new Error(`Approval timeout for action '${actionDef.name}'`));
            }, Timeout.DANGEROUS_EXECUTE);

            const params = payload.params || {};
            this._approvalState = {
                actionName: actionDef.name,
                description: actionDef.description || '',
                componentLabel: componentData.label,
                paramSummary: Object.entries(params).map(
                    ([key, value]) => ({ key, value: JSON.stringify(value) })
                ),
                payload,
                resolve,
                reject,
                timeoutId
            };
        });
    }

    // ── Chat Routing ──────────────────────────────────────────────

    _handleChatMessage(data) {
        const { chatId, message } = data;
        const requestId = generateId();

        this._pendingChats.set(requestId, chatId);

        // eslint-disable-next-line @lwc/lwc/no-async-operation
        setTimeout(() => {
            if (this._pendingChats.has(requestId)) {
                this._pendingChats.delete(requestId);
                this._broadcast(InternalAction.CHAT_RESPONSE, {
                    chatId,
                    error: true,
                    reply: 'No agent responded within the timeout period.'
                });
            }
        }, Timeout.CHAT);

        if (this._channel) {
            this._channel.postMessage({
                type: MessageType.REQUEST,
                id: requestId,
                action: AgentAction.CHAT,
                payload: { message, chatId, tabId: this._tabId },
                tabId: this._tabId
            });
        }
    }

    _handleChatResponse(data) {
        const chatId = this._pendingChats.get(data.id);
        if (!chatId) return;
        this._pendingChats.delete(data.id);

        this._broadcast(InternalAction.CHAT_RESPONSE, {
            chatId,
            error: data.status === ResponseStatus.ERROR,
            reply: data.status === ResponseStatus.OK
                ? (data.payload?.reply || data.payload?.message || JSON.stringify(data.payload))
                : (data.payload?.message || 'Agent returned an error.')
        });
    }

    // ── Transport ──────────────────────────────────────────────────

    _broadcast(action, extra) {
        if (this._channel) {
            this._channel.postMessage({
                type: MessageType.INTERNAL,
                action,
                tabId: this._tabId,
                orchestratorId: this._orchestratorId,
                ...extra
            });
        }
    }

    _respond(id, status, payload) {
        if (this._channel) {
            this._channel.postMessage({
                type: MessageType.RESPONSE,
                id,
                status,
                payload
            });
        }
    }
}
