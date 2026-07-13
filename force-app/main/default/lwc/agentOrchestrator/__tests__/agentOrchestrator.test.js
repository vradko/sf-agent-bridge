import { createElement } from 'lwc';
import AgentOrchestrator from 'c/agentOrchestrator';
import { MessageType, InternalAction, AgentAction, ResponseStatus } from 'c/agentBridgeUtils';

// Mock sessionStorage
const mockStorage = {};
global.sessionStorage = {
    getItem: (key) => mockStorage[key] || null,
    setItem: (key, val) => { mockStorage[key] = val; },
    removeItem: (key) => { delete mockStorage[key]; }
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
    postMessage(data) { this._messages.push(data); }
    get _lastMessage() { return this._messages[this._messages.length - 1]; }
    close() { this._closed = true; }
    _receive(data) { if (this.onmessage) this.onmessage({ data }); }
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
            expect(channel._lastMessage).toEqual(expect.objectContaining({
                type: MessageType.RESPONSE, id: 'r1', status: ResponseStatus.OK,
                payload: expect.objectContaining({
                    version: '1.1.0', componentCount: 0,
                    orchestratorId: expect.any(String),
                    tabId: expect.any(String),
                    duplicateWarning: false
                })
            }));
        });
    });

    describe('Registry', () => {
        it('registers and unregisters', async () => {
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.REGISTER, componentId: 'c1', label: 'W', actions: [] });
            await channel._receive({ type: MessageType.REQUEST, id: 'p1', action: AgentAction.PING, payload: {} });
            expect(channel._lastMessage.payload.componentCount).toBe(1);

            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.UNREGISTER, componentId: 'c1' });
            await channel._receive({ type: MessageType.REQUEST, id: 'p2', action: AgentAction.PING, payload: {} });
            expect(channel._lastMessage.payload.componentCount).toBe(0);
        });

        it('acknowledges REGISTER with REGISTER_ACK carrying orchestratorId', () => {
            const ownId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).orchestratorId;
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.REGISTER, componentId: 'c1', label: 'W', actions: [] });
            const ack = channel._messages.find((m) => m.action === InternalAction.REGISTER_ACK);
            expect(ack).toBeTruthy();
            expect(ack.componentId).toBe('c1');
            expect(ack.orchestratorId).toBe(ownId);
        });

        it('includes orchestratorId in EXECUTE broadcasts', async () => {
            const ownId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).orchestratorId;
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.REGISTER, componentId: 'c1', label: 'W', actions: [{ name: 'doIt', description: 'd', params: [], returns: { type: 'object' } }] });
            channel._receive({ type: MessageType.REQUEST, id: 'ex1', action: AgentAction.EXECUTE, payload: { componentId: 'c1', actionName: 'doIt', params: {} } });
            await Promise.resolve();
            const execMsg = channel._messages.find((m) => m.action === InternalAction.EXECUTE);
            expect(execMsg.orchestratorId).toBe(ownId);
        });
    });

    describe('DISCOVER', () => {
        it('broadcasts ROLL_CALL and returns components', async () => {
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.REGISTER, componentId: 'c1', label: 'W', actions: [{ name: 'a', description: 'd', params: [], returns: { type: 'object' } }] });
            channel._receive({ type: MessageType.REQUEST, id: 'd1', action: AgentAction.DISCOVER, payload: {} });
            expect(channel._messages).toContainEqual(expect.objectContaining({ action: InternalAction.ROLL_CALL }));
            await new Promise((r) => setTimeout(r, 600));
            const resp = channel._messages.find((m) => m.id === 'd1');
            expect(resp.payload.components).toHaveLength(1);
        });
    });

    describe('EXECUTE', () => {
        beforeEach(() => {
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.REGISTER, componentId: 'c1', label: 'W', actions: [{ name: 'doIt', description: 'd', params: [], returns: { type: 'object' } }] });
        });

        it('routes execute and resolves on RESULT', async () => {
            channel._receive({ type: MessageType.REQUEST, id: 'e1', action: AgentAction.EXECUTE, payload: { componentId: 'c1', actionName: 'doIt', params: {} } });
            await Promise.resolve();
            const execMsg = channel._messages.find((m) => m.action === InternalAction.EXECUTE);
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.RESULT, correlationId: execMsg.correlationId, result: { v: 1 } });
            await new Promise((r) => setTimeout(r, 0));
            const resp = channel._messages.find((m) => m.id === 'e1' && m.status === ResponseStatus.OK);
            expect(resp.payload).toEqual({ v: 1 });
        });

        it('silently ignores unknown component on broadcast (no tabId) requests', async () => {
            const before = channel._messages.length;
            await channel._receive({ type: MessageType.REQUEST, id: 'e2', action: AgentAction.EXECUTE, payload: { componentId: 'unknown', actionName: 'doIt', params: {} } });
            expect(channel._messages.length).toBe(before);
        });

        it('returns a not-found error for unknown component on tab-targeted requests', async () => {
            const tabId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).tabId;
            await channel._receive({ type: MessageType.REQUEST, id: 'e3', action: AgentAction.EXECUTE, tabId, payload: { componentId: 'unknown', actionName: 'doIt', params: {} } });
            const resp = channel._messages.find((m) => m.id === 'e3');
            expect(resp).toBeTruthy();
            expect(resp.status).toBe(ResponseStatus.ERROR);
            expect(resp.payload.message).toContain('not found');
        });

        it('holds dangerous actions for approval instead of executing', async () => {
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.REGISTER, componentId: 'c2', label: 'W2', actions: [{ name: 'destroy', description: 'd', dangerous: true, params: [], returns: { type: 'object' } }] });
            channel._receive({ type: MessageType.REQUEST, id: 'e4', action: AgentAction.EXECUTE, payload: { componentId: 'c2', actionName: 'destroy', params: {} } });
            await Promise.resolve();
            const execMsg = channel._messages.find((m) => m.action === InternalAction.EXECUTE && m.componentId === 'c2');
            expect(execMsg).toBeFalsy();
            const resp = channel._messages.find((m) => m.id === 'e4');
            expect(resp).toBeFalsy();
        });
    });

    describe('Duplicate detection', () => {
        it('warns when another orchestrator in same tab', () => {
            const tabId = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY).tabId;
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.ORCHESTRATOR_READY, orchestratorId: 'other-id', tabId });
            channel._receive({ type: MessageType.REQUEST, id: 'dp1', action: AgentAction.PING, payload: {} });
            expect(channel._messages.find((m) => m.id === 'dp1').payload.duplicateWarning).toBe(true);
        });

        it('does not warn for own ORCHESTRATOR_READY', () => {
            const ready = channel._messages.find((m) => m.action === InternalAction.ORCHESTRATOR_READY);
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.ORCHESTRATOR_READY, orchestratorId: ready.orchestratorId, tabId: ready.tabId });
            channel._receive({ type: MessageType.REQUEST, id: 'dp2', action: AgentAction.PING, payload: {} });
            expect(channel._messages.find((m) => m.id === 'dp2').payload.duplicateWarning).toBe(false);
        });

        it('ignores ORCHESTRATOR_READY from different tab', () => {
            channel._receive({ type: MessageType.INTERNAL, action: InternalAction.ORCHESTRATOR_READY, orchestratorId: 'x', tabId: 'other-tab' });
            channel._receive({ type: MessageType.REQUEST, id: 'dp3', action: AgentAction.PING, payload: {} });
            expect(channel._messages.find((m) => m.id === 'dp3').payload.duplicateWarning).toBe(false);
        });
    });

    describe('Handshake', () => {
        it('responds to handshake event with bridge info', () => {
            let response = null;
            document.addEventListener('sf-agent-bridge:handshake-response', (e) => {
                response = e.detail;
            }, { once: true });
            document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', { detail: { requestId: 'h1' } }));
            expect(response).toBeTruthy();
            expect(response.tabId).toBeTruthy();
            expect(response.orchestratorId).toBeTruthy();
            expect(response.version).toBe('1.1.0');
            expect(response.requestId).toBe('h1');
        });

        it('stops listening on disconnect', () => {
            document.body.removeChild(element);
            let response = null;
            document.addEventListener('sf-agent-bridge:handshake-response', (e) => {
                response = e.detail;
            }, { once: true });
            document.dispatchEvent(new CustomEvent('sf-agent-bridge:handshake', { detail: {} }));
            expect(response).toBeNull();
        });
    });

    describe('REQUEST tabId filtering', () => {
        it('ignores REQUEST with different tabId', async () => {
            const before = channel._messages.length;
            await channel._receive({ type: MessageType.REQUEST, id: 'rt1', action: AgentAction.PING, payload: {}, tabId: 'other-tab' });
            expect(channel._messages.length).toBe(before);
        });

        it('processes REQUEST with matching tabId', async () => {
            let tabId;
            document.addEventListener('sf-agent-bridge:handshake-response', (e) => { tabId = e.detail.tabId; }, { once: true });
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
