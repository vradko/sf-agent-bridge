import { createElement } from 'lwc';
import { validateParams, MessageType, InternalAction } from 'c/agentBridgeUtils';
import TestWidget from './testWidget/testWidget';
import DefaultWidget from './defaultWidget/defaultWidget';

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
    this._messages = [];
    MockBroadcastChannel.instances.push(this);
  }
  postMessage(data) {
    this._messages.push(data);
  }
  close() {}
  _receive(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}
global.BroadcastChannel = MockBroadcastChannel;

describe('AgentBridgeMixin', () => {
  let element;
  let channel;

  beforeEach(() => {
    jest.clearAllMocks();
    MockBroadcastChannel.instances = [];
    element = createElement('c-test-widget', { is: TestWidget });
    document.body.appendChild(element);
    channel = MockBroadcastChannel.instances[0];
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  describe('Registration', () => {
    it('sends REGISTER on connect', () => {
      const reg = channel._messages.find((m) => m.action === InternalAction.REGISTER);
      expect(reg).toBeTruthy();
      expect(reg.type).toBe(MessageType.INTERNAL);
      expect(reg.label).toBe('TestWidget');
      expect(reg.actions).toHaveLength(2);
    });

    it('has a componentId (UUID when no stable key)', () => {
      const reg = channel._messages.find((m) => m.action === InternalAction.REGISTER);
      expect(reg.componentId).toBeTruthy();
      expect(reg.componentId).not.toContain('stable:');
    });

    it('re-registers on ROLL_CALL', () => {
      const before = channel._messages.filter((m) => m.action === InternalAction.REGISTER).length;
      channel._receive({ type: MessageType.INTERNAL, action: InternalAction.ROLL_CALL });
      expect(channel._messages.filter((m) => m.action === InternalAction.REGISTER).length).toBe(before + 1);
    });

    it('re-registers on ORCHESTRATOR_READY', () => {
      const before = channel._messages.filter((m) => m.action === InternalAction.REGISTER).length;
      channel._receive({ type: MessageType.INTERNAL, action: InternalAction.ORCHESTRATOR_READY });
      expect(channel._messages.filter((m) => m.action === InternalAction.REGISTER).length).toBe(before + 1);
    });

    it('sends UNREGISTER on disconnect', () => {
      document.body.removeChild(element);
      expect(channel._messages.find((m) => m.action === InternalAction.UNREGISTER)).toBeTruthy();
    });

    it('includes tabId in all internal messages', () => {
      const reg = channel._messages.find((m) => m.action === InternalAction.REGISTER);
      expect(reg.tabId).toBeTruthy();
    });

    it('ignores internal messages from different tab', async () => {
      const componentId = channel._messages.find((m) => m.action === InternalAction.REGISTER).componentId;
      const before = channel._messages.length;
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'x1',
        actionName: 'getItems',
        params: {},
        tabId: 'different-tab-id'
      });
      expect(channel._messages.length).toBe(before);
    });
  });

  describe('EXECUTE handling', () => {
    const ORCH_ID = 'orch-1';
    let componentId;

    beforeEach(() => {
      componentId = channel._messages.find((m) => m.action === InternalAction.REGISTER).componentId;
      // Widget adopts the orchestrator that acknowledges its registration
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER_ACK,
        componentId,
        orchestratorId: ORCH_ID
      });
    });

    it('ignores EXECUTE for other components', async () => {
      const before = channel._messages.length;
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId: 'other-id',
        correlationId: 'c1',
        actionName: 'getItems',
        params: {},
        orchestratorId: ORCH_ID
      });
      expect(channel._messages.length).toBe(before);
    });

    it('executes action and sends RESULT', async () => {
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'c2',
        actionName: 'getItems',
        params: {},
        orchestratorId: ORCH_ID
      });
      const result = channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'c2');
      expect(result).toBeTruthy();
      expect(Array.isArray(result.result)).toBe(true);
      expect(result.result).toHaveLength(2);
    });

    it('sends error for unknown action', async () => {
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'c3',
        actionName: 'nonexistent',
        params: {},
        orchestratorId: ORCH_ID
      });
      const result = channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'c3');
      expect(result.error).toBe(true);
    });

    it('sends error for invalid params', async () => {
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'c4',
        actionName: 'addItem',
        params: {},
        orchestratorId: ORCH_ID
      });
      const result = channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'c4');
      expect(result.error).toBe(true);
      expect(result.errorMessage).toContain('Missing required parameter');
    });

    it('executes action with valid params', async () => {
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'c5',
        actionName: 'addItem',
        params: { name: 'Item C' },
        orchestratorId: ORCH_ID
      });
      const result = channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'c5');
      expect(result.result).toEqual({ id: '3', name: 'Item C' });
    });
  });

  describe('Orchestrator trust (approval-gate bypass protection)', () => {
    let componentId;

    beforeEach(() => {
      componentId = channel._messages.find((m) => m.action === InternalAction.REGISTER).componentId;
    });

    it('ignores EXECUTE when no orchestrator has been adopted', async () => {
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'b1',
        actionName: 'getItems',
        params: {}
      });
      expect(channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'b1')).toBeFalsy();
    });

    it('ignores EXECUTE from a different orchestrator', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER_ACK,
        componentId,
        orchestratorId: 'orch-legit'
      });
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'b2',
        actionName: 'getItems',
        params: {},
        orchestratorId: 'orch-forged'
      });
      expect(channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'b2')).toBeFalsy();
    });

    it('adopts orchestrator from ORCHESTRATOR_READY', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.ORCHESTRATOR_READY,
        orchestratorId: 'orch-2'
      });
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'b3',
        actionName: 'getItems',
        params: {},
        orchestratorId: 'orch-2'
      });
      expect(
        channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'b3')
      ).toBeTruthy();
    });

    it('drops trust after ORCHESTRATOR_GONE', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER_ACK,
        componentId,
        orchestratorId: 'orch-3'
      });
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.ORCHESTRATOR_GONE,
        orchestratorId: 'orch-3'
      });
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'b4',
        actionName: 'getItems',
        params: {},
        orchestratorId: 'orch-3'
      });
      expect(channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'b4')).toBeFalsy();
    });

    it('derives default label from host tag name when not overridden', () => {
      const el = createElement('c-default-widget', { is: DefaultWidget });
      document.body.appendChild(el);
      const ch = MockBroadcastChannel.instances[MockBroadcastChannel.instances.length - 1];
      const reg = ch._messages.find((m) => m.action === InternalAction.REGISTER);
      expect(reg).toBeTruthy();
      expect(reg.label).toBe('DefaultWidget');
    });

    it('ignores REGISTER_ACK addressed to another component', async () => {
      channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.REGISTER_ACK,
        componentId: 'someone-else',
        orchestratorId: 'orch-4'
      });
      await channel._receive({
        type: MessageType.INTERNAL,
        action: InternalAction.EXECUTE,
        componentId,
        correlationId: 'b5',
        actionName: 'getItems',
        params: {},
        orchestratorId: 'orch-4'
      });
      expect(channel._messages.find((m) => m.action === InternalAction.RESULT && m.correlationId === 'b5')).toBeFalsy();
    });
  });
});

describe('validateParams', () => {
  const defs = [
    { name: 'name', type: 'string', required: true, description: 'Name' },
    { name: 'age', type: 'number', required: false, description: 'Age' },
    { name: 'tags', type: 'array', required: false, description: 'Tags' },
    { name: 'role', type: 'string', required: false, description: 'Role', enum: ['admin', 'user'] }
  ];

  it('valid params', () => expect(validateParams({ name: 'John', age: 30 }, defs)).toEqual([]));
  it('missing required', () => expect(validateParams({}, defs)).toContain('Missing required parameter: name'));
  it('wrong type', () =>
    expect(validateParams({ name: 123 }, defs).some((e) => e.includes('expected type'))).toBe(true));
  it('invalid enum', () =>
    expect(validateParams({ name: 'J', role: 'x' }, defs).some((e) => e.includes('must be one of'))).toBe(true));
  it('non-array', () =>
    expect(validateParams({ name: 'J', tags: 'x' }, defs).some((e) => e.includes("expected type 'array'"))).toBe(true));
  it('optional absent', () => expect(validateParams({ name: 'John' }, defs)).toEqual([]));
  it('rejects blank required strings', () =>
    expect(validateParams({ name: '   ' }, defs).some((e) => e.includes('must not be blank'))).toBe(true));
  it('rejects arrays when an object is required', () => {
    expect(validateParams({ value: [] }, [{ name: 'value', type: 'object' }])).not.toEqual([]);
  });
  it('validates integer and array item types', () => {
    const schema = [
      { name: 'count', type: 'integer', required: true },
      { name: 'values', type: 'array', items: { type: 'string' } }
    ];
    expect(validateParams({ count: 1.5, values: ['ok', 2] }, schema)).toHaveLength(2);
  });
  it('reports unsupported schema types', () => {
    expect(validateParams({ name: 'John' }, [{ name: 'name', type: 'date' }])[0]).toContain('unsupported type');
  });
  it('rejects non-object params and malformed schemas', () => {
    expect(validateParams([], defs)).toContain('Parameters must be an object');
    expect(validateParams({}, null)).toContain('Invalid action schema: params must be an array');
  });
});
