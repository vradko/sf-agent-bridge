import { createElement } from 'lwc';
import AgentChat from 'c/agentChat';
import { InternalAction, MessageType } from 'c/agentBridgeUtils';

const mockStorage = {};
global.sessionStorage = {
  getItem: (key) => mockStorage[key] || null,
  setItem: (key, value) => {
    mockStorage[key] = value;
  },
  removeItem: (key) => {
    delete mockStorage[key];
  }
};

class MockBroadcastChannel {
  static instances = [];

  constructor() {
    this.onmessage = null;
    this.messages = [];
    this.closed = false;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  close() {
    this.closed = true;
  }

  receive(message) {
    this.onmessage?.({ data: message });
  }
}

global.BroadcastChannel = MockBroadcastChannel;

describe('c-agent-chat', () => {
  let element;
  let channel;

  beforeEach(() => {
    MockBroadcastChannel.instances = [];
    element = createElement('c-agent-chat', { is: AgentChat });
    document.body.appendChild(element);
    channel = MockBroadcastChannel.instances[0];
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  function sendMessage(text) {
    const input = element.shadowRoot.querySelector('lightning-input');
    input.value = text;
    input.dispatchEvent(new CustomEvent('change'));
    element.shadowRoot.querySelector('lightning-button-icon').click();
    return channel.messages.find((message) => message.action === InternalAction.CHAT_MESSAGE);
  }

  it('scopes outgoing messages to a chat instance', () => {
    const message = sendMessage('Hello agent');

    expect(message).toEqual(
      expect.objectContaining({
        type: MessageType.INTERNAL,
        action: InternalAction.CHAT_MESSAGE,
        message: 'Hello agent',
        chatId: expect.any(String),
        chatInstanceId: expect.any(String),
        tabId: expect.any(String)
      })
    );
  });

  it('renders only the response matching its pending chat and instance', async () => {
    const outgoing = sendMessage('Hello agent');
    channel.receive({
      type: MessageType.INTERNAL,
      action: InternalAction.CHAT_RESPONSE,
      tabId: outgoing.tabId,
      chatId: outgoing.chatId,
      chatInstanceId: 'another-chat-widget',
      reply: 'Wrong widget'
    });
    await Promise.resolve();
    expect(element.shadowRoot.textContent).not.toContain('Wrong widget');

    channel.receive({
      type: MessageType.INTERNAL,
      action: InternalAction.CHAT_RESPONSE,
      tabId: outgoing.tabId,
      chatId: outgoing.chatId,
      chatInstanceId: outgoing.chatInstanceId,
      reply: 'Matching response'
    });
    await Promise.resolve();
    expect(element.shadowRoot.textContent).toContain('Matching response');
  });

  it('ignores unsolicited responses even for its own instance', async () => {
    const outgoing = sendMessage('Hello agent');
    channel.receive({
      type: MessageType.INTERNAL,
      action: InternalAction.CHAT_RESPONSE,
      tabId: outgoing.tabId,
      chatId: 'not-pending',
      chatInstanceId: outgoing.chatInstanceId,
      reply: 'Unsolicited response'
    });
    await Promise.resolve();
    expect(element.shadowRoot.textContent).not.toContain('Unsolicited response');
  });

  it('closes its channel on disconnect', () => {
    document.body.removeChild(element);
    expect(channel.closed).toBe(true);
  });

  it('fails fast when no orchestrator ever responds', async () => {
    jest.useFakeTimers();
    try {
      sendMessage('Anyone there?');
      jest.advanceTimersByTime(246000);
      await Promise.resolve();
      expect(element.shadowRoot.textContent).toContain('No orchestrator responded');
    } finally {
      jest.useRealTimers();
    }
  });
});
