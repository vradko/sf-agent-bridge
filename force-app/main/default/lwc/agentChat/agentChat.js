import { LightningElement, track } from 'lwc';
import { CHANNEL_NAME, MessageType, InternalAction, generateId, getTabId } from 'c/agentBridgeUtils';

export default class AgentChat extends LightningElement {
  @track _messages = [];
  _inputValue = '';
  _isWaiting = false;
  _channel = null;
  _tabId = null;
  _chatInstanceId = null;
  _pendingChatIds = new Set();

  get _hasMessages() {
    return this._messages.length > 0;
  }

  get _isDisabled() {
    return this._isWaiting;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  connectedCallback() {
    this._tabId = getTabId();
    this._chatInstanceId = generateId();
    this._channel = new BroadcastChannel(CHANNEL_NAME);
    this._channel.onmessage = (event) => this._onMessage(event.data);
  }

  disconnectedCallback() {
    if (this._channel) {
      this._channel.close();
      this._channel = null;
    }
    this._pendingChatIds.clear();
    this._isWaiting = false;
  }

  // ── Message Handler ────────────────────────────────────────────

  _onMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type !== MessageType.INTERNAL) return;
    if (data.tabId && this._tabId && data.tabId !== this._tabId) return;

    if (data.action === InternalAction.CHAT_RESPONSE) {
      if (data.chatInstanceId !== this._chatInstanceId) return;
      this._handleChatResponse(data);
    }
  }

  _handleChatResponse(data) {
    if (!this._pendingChatIds.has(data.chatId)) return;
    this._pendingChatIds.delete(data.chatId);

    const pendingIdx = this._messages.findIndex((m) => m.chatId === data.chatId && m.role === 'pending');

    if (pendingIdx !== -1) {
      this._messages.splice(pendingIdx, 1);
    }

    this._messages = [
      ...this._messages,
      {
        id: generateId(),
        role: 'agent',
        cssClass: data.error ? 'agent error' : 'agent',
        content: data.reply || 'No response.',
        error: data.error || false,
        timestamp: new Date().toLocaleTimeString()
      }
    ];

    this._isWaiting = false;
    this._scrollToBottom();
  }

  // ── UI Handlers ────────────────────────────────────────────────

  handleInputChange(event) {
    this._inputValue = event.target.value;
  }

  handleKeyUp(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      this.handleSend();
    }
  }

  handleSend() {
    const message = this._inputValue?.trim();
    if (!message || this._isWaiting) return;

    const chatId = generateId();

    this._messages = [
      ...this._messages,
      {
        id: generateId(),
        role: 'user',
        cssClass: 'user',
        content: message,
        timestamp: new Date().toLocaleTimeString()
      },
      {
        id: generateId(),
        chatId,
        role: 'pending',
        cssClass: 'pending',
        isPending: true,
        content: '',
        timestamp: ''
      }
    ];

    this._inputValue = '';
    this._isWaiting = true;
    this._pendingChatIds.add(chatId);

    if (this._channel) {
      this._channel.postMessage({
        type: MessageType.INTERNAL,
        action: InternalAction.CHAT_MESSAGE,
        tabId: this._tabId,
        chatInstanceId: this._chatInstanceId,
        chatId,
        message
      });
    }

    this._scrollToBottom();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  _scrollToBottom() {
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    setTimeout(() => {
      const container = this.template.querySelector('.chat-messages');
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }, 50);
  }
}
