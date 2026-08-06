import { createElement } from 'lwc';
import AgentOrchestrator from 'c/agentOrchestrator';
import { MessageType, InternalAction, AgentAction, ResponseStatus } from 'c/agentBridgeUtils';

// Mock sessionStorage
const mockStorage = {};
global.sessionStorage = {
  getItem: (key) => mockStorage[key] || null,
  setItem: (key, val) => {
    mockStorage[key] = val;
  },
  removeItem: (key) => {
    delete mockStorage[key];
  }
};

// Mock BroadcastChannel
class MockBroadcastChannel {
  static instances = [];
  constructor() {
    this.onmessage = null;
    this._closed = false;
    this._messages = [];
    MockBroadcastChannel.instances.push(this);
  }
  postMessage(data) {
    this._messages.push(data);
  }
  get _lastMessage() {
    return this._messages[this._messages.length - 1];
  }
  close() {
    this._closed = true;
  }
  _receive(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}
global.BroadcastChannel = MockBroadcastChannel;
global.crypto = { randomUUID: () => 'test-uuid-' + Math.random().toString(36).substring(7) };

describe('c-agent-orchestrator', () => {
  let element;
  let channel;

  beforeEach(() => {
    jest.clearAllMocks();
    MockBroadcastChannel.instances = [];
    element = createElement('c-agent-orchestrator', { is: AgentOrchestrator });
    document.body.appendChild(element);
    channel = MockBroadcastChannel.instances[0];
  });

  const currentTabId = () =>
    channel._messages.find((message) => message.action === InternalAction.ORCHESTRATOR_READY).tabId;

  const currentOrchestratorId = () =>
    channel._messages.find((message) => message.action === InternalAction.ORCHESTRATOR_READY).orchestratorId;

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it('broadcasts ORCHESTRATOR_READY on connect', () => {
    const ready = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY);
    expect(ready).toBeTruthy();
    expect(ready.orchestratorId).toBeTruthy();
    expect(ready.tabId).toBeTruthy();
  });

  describe('PING', () => {
    it('responds with version, component count, orchestratorId, tabId', async () => {
      await channel._receive({ type: MessageType.REQUEST, id: 'r1', action: AgentAction.PING, payload: {} });
      expect(channel._lastMessage).toEqual(
        expect.objectContaining({
          type: MessageType.RESPONSE,
          id: 'r1',
          status: ResponseStatus.OK,
          payload: expect.objectContaining({
            version: '1.2.0',
            componentCount: 0,
            orchestratorId: expect.any(String),
            tabId: expect.any(String),
            duplicateWarning: false
          })
        })
      );
    });
  });

  describe('Registry', () => {
    it('registers and unregisters', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c1',
        label: 'W',
        actions: []
      });
      await channel._receive({ type: MessageType.REQUEST, id: 'p1', action: AgentAction.PING, payload: {} });
      expect(channel._lastMessage.payload.componentCount).toBe(1);

      channel._receive({ type: MessageType.INTERNAL, action: InternalAction.UNREGISTER, componentId: 'c1' });
      await channel._receive({ type: MessageType.REQUEST, id: 'p2', action: AgentAction.PING, payload: {} });
      expect(channel._lastMessage.payload.componentCount).toBe(0);
    });

    it('acknowledges REGISTER with REGISTER_ACK carrying orchestratorId', () => {
      const ownId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).orchestratorId;
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c1',
        label: 'W',
        actions: []
      });
      const ack = channel._messages.find((m) => m.action === InternalAction.REGISTER_ACK);
      expect(ack).toBeTruthy();
      expect(ack.componentId).toBe('c1');
      expect(ack.orchestratorId).toBe(ownId);
    });

    it('includes orchestratorId in EXECUTE broadcasts', async () => {
      const ownId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).orchestratorId;
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c1',
        label: 'W',
        actions: [{ name: 'doIt', description: 'd', params: [], returns: { type: 'object' } }]
      });
      channel._receive({
        type: MessageType.REQUEST,
        id: 'ex1',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload: { componentId: 'c1', actionName: 'doIt', params: {} }
      });
      await Promise.resolve();
      const execMsg = channel._messages.find((m) => m.action === InternalAction.EXECUTE);
      expect(execMsg.orchestratorId).toBe(ownId);
    });
  });

  describe('DISCOVER', () => {
    it('broadcasts ROLL_CALL and returns components', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c1',
        label: 'W',
        actions: [{ name: 'a', description: 'd', params: [], returns: { type: 'object' } }]
      });
      channel._receive({ type: MessageType.REQUEST, id: 'd1', action: AgentAction.DISCOVER, payload: {} });
      expect(channel._messages).toContainEqual(expect.objectContaining({ action: InternalAction.ROLL_CALL }));
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c1',
        label: 'W',
        actions: [{ name: 'a', description: 'd', params: [], returns: { type: 'object' } }]
      });
      await new Promise((r) => setTimeout(r, 600));
      const resp = channel._messages.find((m) => m.id === 'd1');
      expect(resp.payload.components).toHaveLength(1);
    });
  });

  describe('EXECUTE', () => {
    beforeEach(() => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c1',
        label: 'W',
        actions: [{ name: 'doIt', description: 'd', params: [], returns: { type: 'object' } }]
      });
    });

    it('routes execute and resolves on RESULT', async () => {
      channel._receive({
        type: MessageType.REQUEST,
        id: 'e1',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload: { componentId: 'c1', actionName: 'doIt', params: {} }
      });
      await Promise.resolve();
      const execMsg = channel._messages.find((m) => m.action === InternalAction.EXECUTE);
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.RESULT,
        correlationId: execMsg.correlationId,
        componentId: 'c1',
        orchestratorId: currentOrchestratorId(),
        result: { v: 1 }
      });
      await new Promise((r) => setTimeout(r, 0));
      const resp = channel._messages.find((m) => m.id === 'e1' && m.status === ResponseStatus.OK);
      expect(resp.payload).toEqual({ v: 1 });
    });

    it('rejects execute without tabId before routing it', async () => {
      await channel._receive({
        type: MessageType.REQUEST,
        id: 'e2',
        action: AgentAction.EXECUTE,
        payload: { componentId: 'unknown', actionName: 'doIt', params: {} }
      });
      const response = channel._messages.find((message) => message.id === 'e2');
      expect(response.status).toBe(ResponseStatus.ERROR);
      expect(response.payload.message).toContain('tabId');
      expect(channel._messages.find((message) => message.action === InternalAction.EXECUTE)).toBeFalsy();
    });

    it('returns a not-found error for unknown component on tab-targeted requests', async () => {
      const tabId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).tabId;
      await channel._receive({
        type: MessageType.REQUEST,
        id: 'e3',
        action: AgentAction.EXECUTE,
        tabId,
        payload: { componentId: 'unknown', actionName: 'doIt', params: {} }
      });
      const resp = channel._messages.find((m) => m.id === 'e3');
      expect(resp).toBeTruthy();
      expect(resp.status).toBe(ResponseStatus.ERROR);
      expect(resp.payload.message).toContain('not found');
    });

    it('holds dangerous actions for approval instead of executing', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c2',
        label: 'W2',
        actions: [{ name: 'destroy', description: 'd', dangerous: true, params: [], returns: { type: 'object' } }]
      });
      channel._receive({
        type: MessageType.REQUEST,
        id: 'e4',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload: { componentId: 'c2', actionName: 'destroy', params: {} }
      });
      await Promise.resolve();
      const execMsg = channel._messages.find((m) => m.action === InternalAction.EXECUTE && m.componentId === 'c2');
      expect(execMsg).toBeFalsy();
      const resp = channel._messages.find((m) => m.id === 'e4');
      expect(resp).toBeFalsy();
    });

    it('executes a dangerous action only after the approval button arms', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c2',
        label: 'W2',
        actions: [{ name: 'destroy', description: 'd', dangerous: true, params: [], returns: { type: 'object' } }]
      });
      channel._receive({
        type: MessageType.REQUEST,
        id: 'e5',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload: { componentId: 'c2', actionName: 'destroy', params: {}, idempotencyKey: 'delete-1' }
      });
      await Promise.resolve();

      const approve = element.shadowRoot.querySelector('[data-action="approve"]');
      expect(approve.disabled).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 750));
      approve.click();
      await Promise.resolve();

      expect(
        channel._messages.find((message) => message.action === InternalAction.EXECUTE && message.componentId === 'c2')
      ).toBeTruthy();
    });

    it('returns an error when the user rejects a dangerous action', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c2',
        label: 'W2',
        actions: [{ name: 'destroy', description: 'd', dangerous: true, params: [], returns: { type: 'object' } }]
      });
      channel._receive({
        type: MessageType.REQUEST,
        id: 'e6',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload: { componentId: 'c2', actionName: 'destroy', params: {} }
      });
      await Promise.resolve();

      const reject = element.shadowRoot.querySelector('[data-action="reject"]');
      reject.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const response = channel._messages.find((message) => message.id === 'e6');
      expect(response.status).toBe(ResponseStatus.ERROR);
      expect(response.payload.message).toContain('rejected');
    });

    it('deduplicates execute requests with the same idempotency key', async () => {
      const payload = {
        componentId: 'c1',
        actionName: 'doIt',
        params: {},
        idempotencyKey: 'same-operation'
      };
      channel._receive({
        type: MessageType.REQUEST,
        id: 'idem-1',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload
      });
      channel._receive({
        type: MessageType.REQUEST,
        id: 'idem-2',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload
      });
      await Promise.resolve();

      const executions = channel._messages.filter((message) => message.action === InternalAction.EXECUTE);
      expect(executions).toHaveLength(1);
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.RESULT,
        correlationId: executions[0].correlationId,
        componentId: 'c1',
        orchestratorId: currentOrchestratorId(),
        result: { success: true }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(channel._messages.find((message) => message.id === 'idem-1').status).toBe(ResponseStatus.OK);
      expect(channel._messages.find((message) => message.id === 'idem-2').status).toBe(ResponseStatus.OK);
    });

    it('releases the idempotency key when the user rejects the approval', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER,
        componentId: 'c2',
        label: 'W2',
        actions: [{ name: 'destroy', description: 'd', dangerous: true, params: [], returns: { type: 'object' } }]
      });
      const payload = { componentId: 'c2', actionName: 'destroy', params: {}, idempotencyKey: 'retry-after-reject' };
      channel._receive({
        type: MessageType.REQUEST,
        id: 'rj-1',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      element.shadowRoot.querySelector('[data-action="reject"]').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(channel._messages.find((message) => message.id === 'rj-1').status).toBe(ResponseStatus.ERROR);

      // same key again: must show a fresh approval prompt, not replay the rejection
      channel._receive({
        type: MessageType.REQUEST,
        id: 'rj-2',
        action: AgentAction.EXECUTE,
        tabId: currentTabId(),
        payload
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(element.shadowRoot.querySelector('[data-approval-dialog]')).toBeTruthy();
      expect(channel._messages.find((message) => message.id === 'rj-2')).toBeFalsy();
    });
  });

  describe('Duplicate detection', () => {
    it('warns when another orchestrator in same tab', () => {
      const tabId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).tabId;
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.ORCHESTRATOR_READY,
        orchestratorId: 'other-id',
        tabId
      });
      channel._receive({ type: MessageType.REQUEST, id: 'dp1', action: AgentAction.PING, payload: {} });
      expect(channel._messages.find((m) => m.id === 'dp1').payload.duplicateWarning).toBe(true);
    });

    it('does not warn for own ORCHESTRATOR_READY', () => {
      const ready = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY);
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.ORCHESTRATOR_READY,
        orchestratorId: ready.orchestratorId,
        tabId: ready.tabId
      });
      channel._receive({ type: MessageType.REQUEST, id: 'dp2', action: AgentAction.PING, payload: {} });
      expect(channel._messages.find((m) => m.id === 'dp2').payload.duplicateWarning).toBe(false);
    });

    it('ignores ORCHESTRATOR_READY from different tab', () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.ORCHESTRATOR_READY,
        orchestratorId: 'x',
        tabId: 'other-tab'
      });
      channel._receive({ type: MessageType.REQUEST, id: 'dp3', action: AgentAction.PING, payload: {} });
      expect(channel._messages.find((m) => m.id === 'dp3').payload.duplicateWarning).toBe(false);
    });
  });

  describe('Handshake', () => {
    it('responds to handshake event with bridge info', () => {
      let response = null;
      document.addEventListener(
        'sf-agent-bridge:handshake-response',
        (e) => {
          response = e.detail;
        },
        { once: true }
      );
      document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', { detail: { requestId: 'h1' } }));
      expect(response).toBeTruthy();
      expect(response.tabId).toBeTruthy();
      expect(response.orchestratorId).toBeTruthy();
      expect(response.version).toBe('1.2.0');
      expect(response.requestId).toBe('h1');
    });

    it('stops listening on disconnect', () => {
      document.body.removeChild(element);
      let response = null;
      document.addEventListener(
        'sf-agent-bridge:handshake-response',
        (e) => {
          response = e.detail;
        },
        { once: true }
      );
      document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', { detail: {} }));
      expect(response).toBeNull();
    });
  });

  describe('REQUEST tabId filtering', () => {
    it('ignores REQUEST with different tabId', async () => {
      const before = channel._messages.length;
      await channel._receive({
        type: MessageType.REQUEST,
        id: 'rt1',
        action: AgentAction.PING,
        payload: {},
        tabId: 'other-tab'
      });
      expect(channel._messages.length).toBe(before);
    });

    it('processes REQUEST with matching tabId', async () => {
      let tabId;
      document.addEventListener(
        'sf-agent-bridge:handshake-response',
        (e) => {
          tabId = e.detail.tabId;
        },
        { once: true }
      );
      document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', { detail: {} }));
      await channel._receive({ type: MessageType.REQUEST, id: 'rt2', action: AgentAction.PING, payload: {}, tabId });
      expect(channel._messages.find((m) => m.id === 'rt2')).toBeTruthy();
    });

    it('processes REQUEST without tabId (backward compat)', async () => {
      await channel._receive({ type: MessageType.REQUEST, id: 'rt3', action: AgentAction.PING, payload: {} });
      expect(channel._messages.find((m) => m.id === 'rt3')).toBeTruthy();
    });
  });

  describe('Cleanup', () => {
    it('closes channel and broadcasts ORCHESTRATOR_GONE', () => {
      document.body.removeChild(element);
      expect(channel._closed).toBe(true);
      expect(channel._messages).toContainEqual(expect.objectContaining({ action: InternalAction.ORCHESTRATOR_GONE }));
    });
  });
});
