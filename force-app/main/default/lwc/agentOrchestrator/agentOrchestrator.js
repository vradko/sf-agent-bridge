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
import AgentWebMcpAdapter from 'c/agentWebMcpAdapter';

const MAX_APPROVAL_VALUE_LENGTH = 500;

function safeDisplayValue(value) {
  try {
    const serialized = JSON.stringify(value);
    const text = serialized === undefined ? String(value) : serialized;
    return text.length > MAX_APPROVAL_VALUE_LENGTH ? `${text.slice(0, MAX_APPROVAL_VALUE_LENGTH)}…` : text;
  } catch {
    return '[Value cannot be displayed]';
  }
}

function executionFingerprint(payload) {
  try {
    return JSON.stringify({
      componentId: payload.componentId,
      actionName: payload.actionName,
      params: payload.params || {}
    });
  } catch {
    throw new Error('Execute params must be JSON-serializable');
  }
}

// Failures where EXECUTE was never dispatched — no side effects are possible,
// so the idempotency key can be released and a retry re-prompts the user.
function preDispatchError(message) {
  const error = new Error(message);
  error.executionNotStarted = true;
  return error;
}

export default class AgentOrchestrator extends LightningElement {
  _registry = new Map();
  _pendingRequests = new Map();
  _pendingChats = new Map();
  _idempotencyCache = new Map();
  _channel = null;
  _orchestratorId = null;
  _tabId = null;
  _duplicateWarning = false;
  _warningDismissed = false;
  @track _approvalState = null;
  _approvalQueue = [];
  _approvalArmed = false;
  _armTimerId = null;
  _approvalNeedsFocus = false;
  _previousFocus = null;
  _duplicateProbe = null;
  _duplicateTimerId = null;
  _webmcp = null;

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
    this._executeImmediate(payload, Timeout.DANGEROUS_EXECUTE).then(resolve).catch(reject);
  }

  handleReject() {
    if (!this._approvalState) return;
    const { reject, timeoutId } = this._approvalState;
    clearTimeout(timeoutId);
    this._clearApprovalUi();
    reject(preDispatchError('Action rejected by user'));
  }

  handleApprovalKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.handleReject();
      return;
    }
    if (event.key !== 'Tab') return;

    const buttons = [...this.template.querySelectorAll('[data-action]')].filter((button) => !button.disabled);
    if (buttons.length === 0) return;

    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (
      event.shiftKey &&
      (event.target === first || event.target === this.template.querySelector('[data-approval-dialog]'))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && event.target === last) {
      event.preventDefault();
      first.focus();
    }
  }

  renderedCallback() {
    if (this._showApproval && this._approvalNeedsFocus) {
      const dialog = this.template.querySelector('[data-approval-dialog]');
      if (dialog) {
        this._approvalNeedsFocus = false;
        dialog.focus();
      }
    }
  }

  _clearApprovalUi(showNext = true) {
    this._approvalState = null;
    this._approvalArmed = false;
    if (this._armTimerId) {
      clearTimeout(this._armTimerId);
      this._armTimerId = null;
    }
    if (showNext && this._approvalQueue.length > 0) {
      this._showNextApproval();
    } else if (this._previousFocus?.focus) {
      this._previousFocus.focus();
      this._previousFocus = null;
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
    this._webmcp = new AgentWebMcpAdapter({
      getRegistry: () => this._registry,
      execute: (payload) => this._execute(payload)
    });
    this._webmcp.scheduleSync();
  }

  disconnectedCallback() {
    this._broadcast(InternalAction.ORCHESTRATOR_GONE, {
      orchestratorId: this._orchestratorId
    });
    this._stopListeningForHandshake();
    if (this._approvalState) {
      clearTimeout(this._approvalState.timeoutId);
      this._approvalState.reject(new Error('Orchestrator disconnected'));
      this._clearApprovalUi(false);
    }
    for (const queued of this._approvalQueue) {
      queued.reject(new Error('Orchestrator disconnected'));
    }
    this._approvalQueue = [];
    if (this._duplicateTimerId) clearTimeout(this._duplicateTimerId);
    if (this._duplicateProbe) this._duplicateProbe.close();
    this._duplicateTimerId = null;
    this._duplicateProbe = null;
    if (this._channel) {
      this._channel.close();
      this._channel = null;
    }
    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Orchestrator disconnected'));
    }
    this._pendingRequests.clear();
    for (const [, pending] of this._pendingChats) {
      clearTimeout(pending.timeoutId);
    }
    this._pendingChats.clear();
    for (const [, cached] of this._idempotencyCache) {
      clearTimeout(cached.timeoutId);
    }
    this._idempotencyCache.clear();
    this._webmcp?.teardown();
    this._webmcp = null;
  }

  // ── Handshake (Agent → Orchestrator via DOM events) ─────────────

  _listenForHandshake() {
    this._handshakeHandler = (event) => {
      document.dispatchEvent(
        new CustomEvent('sf-agent-bridge:handshake-response', {
          detail: {
            tabId: this._tabId,
            orchestratorId: this._orchestratorId,
            version: BRIDGE_VERSION,
            requestId: event.detail?.requestId || null
          }
        })
      );
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
    this._duplicateProbe = probe;
    probe.onmessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === MessageType.RESPONSE && data.id === checkId && data.payload?.tabId === this._tabId) {
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
    this._duplicateTimerId = setTimeout(() => {
      probe.close();
      this._duplicateProbe = null;
      this._duplicateTimerId = null;
      const others = sameTabResponses.filter((id) => id !== this._orchestratorId);
      if (others.length > 0) {
        this._duplicateWarning = true;
        console.warn('AgentOrchestrator: Multiple orchestrators detected in this tab.');
      }
    }, Timeout.DUPLICATE_CHECK);
  }

  // ── Message Router ─────────────────────────────────────────────

  _onMessage(data) {
    if (!data || typeof data !== 'object') return;
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
        if (typeof data.componentId !== 'string' || !data.componentId) break;
        this._registry.set(data.componentId, {
          label: typeof data.label === 'string' && data.label ? data.label : data.componentId,
          actions: Array.isArray(data.actions) ? data.actions : []
        });
        this._broadcast(InternalAction.REGISTER_ACK, {
          componentId: data.componentId
        });
        this._webmcp?.scheduleSync();
        break;
      case InternalAction.UNREGISTER:
        this._registry.delete(data.componentId);
        this._webmcp?.scheduleSync();
        break;
      case InternalAction.RESULT:
        this._resolveResult(data);
        break;
      case InternalAction.ORCHESTRATOR_READY:
        if (data.orchestratorId !== this._orchestratorId && data.tabId === this._tabId) {
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
    if (data.orchestratorId !== this._orchestratorId) return;
    if (data.componentId !== pending.componentId) return;
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
    const { id, action, payload = {} } = data;
    if (typeof id !== 'string' || !id) return;
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
          if (!data.tabId) {
            throw new Error("'tabId' is required for execute requests. Run the handshake first.");
          }
          result = await this._execute(payload);
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
        message: error?.message || String(error || 'Unknown error')
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
    // Rebuild from a fresh roll call so disconnected/crashed widgets cannot remain stale.
    this._registry.clear();
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

  _execute(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Execute payload must be an object');
    }

    const idempotencyKey = payload.idempotencyKey;
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200)
    ) {
      throw new Error('idempotencyKey must be a non-blank string of at most 200 characters');
    }

    if (idempotencyKey) {
      const fingerprint = executionFingerprint(payload);
      const cached = this._idempotencyCache.get(idempotencyKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new Error(`Idempotency key '${idempotencyKey}' was already used for another action`);
        }
        return cached.promise;
      }

      const promise = this._executeNew(payload);
      // eslint-disable-next-line @lwc/lwc/no-async-operation
      const timeoutId = setTimeout(() => {
        this._idempotencyCache.delete(idempotencyKey);
      }, Timeout.IDEMPOTENCY_TTL);
      this._idempotencyCache.set(idempotencyKey, { fingerprint, promise, timeoutId });
      promise.catch((error) => {
        if (!error?.executionNotStarted) return;
        const entry = this._idempotencyCache.get(idempotencyKey);
        if (entry?.promise === promise) {
          clearTimeout(entry.timeoutId);
          this._idempotencyCache.delete(idempotencyKey);
        }
      });
      return promise;
    }

    return this._executeNew(payload);
  }

  _executeNew(payload) {
    const { componentId, actionName } = payload;

    if (!this._registry.has(componentId)) {
      throw new Error(`Component '${componentId}' not found in this tab. Run 'discover' to refresh component ids.`);
    }

    const componentData = this._registry.get(componentId);
    const actionDef = componentData.actions.find((a) => a?.name === actionName);
    if (!actionDef) {
      throw new Error(`Unknown action '${actionName}' on component '${componentId}'`);
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
        reject(
          new Error(
            `Execution timeout for action '${actionName}'. ` +
              'The action may still complete; retry only with the same idempotencyKey.'
          )
        );
      }, timeout);

      this._pendingRequests.set(correlationId, {
        componentId,
        resolve,
        reject,
        timeoutId
      });

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
    return new Promise((resolve, reject) => {
      this._approvalQueue.push({ componentData, actionDef, payload, resolve, reject });
      this._showNextApproval();
    });
  }

  _showNextApproval() {
    if (this._approvalState || this._approvalQueue.length === 0) return;

    const request = this._approvalQueue.shift();
    const { componentData, actionDef, payload, resolve, reject } = request;
    const approvalId = generateId();
    // capture only for the first modal of a burst — later queue entries would
    // capture the previous modal's (soon-detached) button and lose user focus
    if (!this._previousFocus) {
      this._previousFocus = document.activeElement;
    }

    // re-arm on every modal content change (see Timeout.APPROVAL_ARM)
    this._approvalArmed = false;
    if (this._armTimerId) clearTimeout(this._armTimerId);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this._armTimerId = setTimeout(() => {
      this._approvalArmed = true;
    }, Timeout.APPROVAL_ARM);

    // eslint-disable-next-line @lwc/lwc/no-async-operation
    const timeoutId = setTimeout(() => {
      if (this._approvalState?.approvalId !== approvalId) return;
      this._clearApprovalUi();
      reject(preDispatchError(`Approval timeout for action '${actionDef.name}'`));
    }, Timeout.APPROVAL);

    const params = payload.params || {};
    this._approvalState = {
      approvalId,
      actionName: actionDef.name,
      description: actionDef.description || '',
      componentLabel: componentData.label,
      paramSummary: Object.entries(params).map(([key, value]) => ({ key, value: safeDisplayValue(value) })),
      payload,
      resolve,
      reject,
      timeoutId
    };
    this._approvalNeedsFocus = true;
  }

  // ── Chat Routing ──────────────────────────────────────────────

  _handleChatMessage(data) {
    const { chatId, chatInstanceId, message } = data;
    if (
      typeof chatId !== 'string' ||
      !chatId ||
      typeof chatInstanceId !== 'string' ||
      !chatInstanceId ||
      typeof message !== 'string' ||
      !message.trim()
    ) {
      return;
    }
    const requestId = generateId();

    // eslint-disable-next-line @lwc/lwc/no-async-operation
    const timeoutId = setTimeout(() => {
      const pending = this._pendingChats.get(requestId);
      if (pending) {
        this._pendingChats.delete(requestId);
        this._broadcast(InternalAction.CHAT_RESPONSE, {
          chatId: pending.chatId,
          chatInstanceId: pending.chatInstanceId,
          error: true,
          reply: 'No agent responded within the timeout period.'
        });
      }
    }, Timeout.CHAT);
    this._pendingChats.set(requestId, { chatId, chatInstanceId, timeoutId });

    if (this._channel) {
      this._channel.postMessage({
        type: MessageType.REQUEST,
        id: requestId,
        action: AgentAction.CHAT,
        payload: { message, chatId, chatInstanceId, tabId: this._tabId },
        tabId: this._tabId
      });
    }
  }

  _handleChatResponse(data) {
    const pending = this._pendingChats.get(data.id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this._pendingChats.delete(data.id);

    this._broadcast(InternalAction.CHAT_RESPONSE, {
      chatId: pending.chatId,
      chatInstanceId: pending.chatInstanceId,
      error: data.status === ResponseStatus.ERROR,
      reply:
        data.status === ResponseStatus.OK
          ? data.payload?.reply || data.payload?.message || JSON.stringify(data.payload)
          : data.payload?.message || 'Agent returned an error.'
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
        tabId: this._tabId,
        orchestratorId: this._orchestratorId,
        payload
      });
    }
  }
}
