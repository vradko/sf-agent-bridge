// ── Channel & Storage ──────────────────────────────────────────────

export const CHANNEL_NAME = 'sf-agent-bridge';
export const BRIDGE_VERSION = '1.2.0';

const TAB_ID_KEY = '__sfAgentBridgeTabId';
let fallbackTabId = null;

// ── Message Types ──────────────────────────────────────────────────

export const MessageType = {
  INTERNAL: 'internal',
  REQUEST: 'request',
  RESPONSE: 'response'
};

// ── Internal Actions (Orchestrator ↔ Widgets) ──────────────────────

export const InternalAction = {
  REGISTER: 'REGISTER',
  REGISTER_ACK: 'REGISTER_ACK',
  UNREGISTER: 'UNREGISTER',
  ROLL_CALL: 'ROLL_CALL',
  EXECUTE: 'EXECUTE',
  RESULT: 'RESULT',
  ORCHESTRATOR_READY: 'ORCHESTRATOR_READY',
  ORCHESTRATOR_GONE: 'ORCHESTRATOR_GONE',
  CHAT_MESSAGE: 'CHAT_MESSAGE',
  CHAT_RESPONSE: 'CHAT_RESPONSE'
};

// ── Agent Actions (External → Orchestrator) ────────────────────────

export const AgentAction = {
  PING: 'ping',
  DISCOVER: 'discover',
  EXECUTE: 'execute',
  CHAT: 'chat'
};

// ── Response Status ────────────────────────────────────────────────

export const ResponseStatus = {
  OK: 'ok',
  ERROR: 'error'
};

// ── Timeouts (ms) ──────────────────────────────────────────────────

export const Timeout = {
  EXECUTE: 30000,
  DANGEROUS_EXECUTE: 60000,
  APPROVAL: 60000,
  ROLL_CALL: 500,
  DUPLICATE_CHECK: 1000,
  CHAT: 240000,
  IDEMPOTENCY_TTL: 300000,
  // Anti-clickjacking: Approve stays disabled this long after the modal (re)renders
  APPROVAL_ARM: 700
};

// ── Param Types for Validation ─────────────────────────────────────

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

// ── Utility Functions ──────────────────────────────────────────────

export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function getTabId() {
  try {
    let tabId = sessionStorage.getItem(TAB_ID_KEY);
    if (!tabId) {
      tabId = generateId();
      sessionStorage.setItem(TAB_ID_KEY, tabId);
    }
    return tabId;
  } catch {
    if (!fallbackTabId) {
      fallbackTabId = generateId();
    }
    return fallbackTabId;
  }
}

export function validateParams(params, paramDefs) {
  const errors = [];

  if (!isPlainObject(params)) {
    return ['Parameters must be an object'];
  }
  if (!Array.isArray(paramDefs)) {
    return ['Invalid action schema: params must be an array'];
  }

  for (const def of paramDefs) {
    if (!isPlainObject(def) || typeof def.name !== 'string' || !def.name) {
      errors.push('Invalid action schema: every parameter needs a name');
      continue;
    }

    const value = params[def.name];

    if (def.required && (value === undefined || value === null)) {
      errors.push(`Missing required parameter: ${def.name}`);
      continue;
    }

    if (value === undefined || value === null) continue;

    if (def.type && !SUPPORTED_TYPES.has(def.type)) {
      errors.push(`Invalid action schema for '${def.name}': unsupported type '${def.type}'`);
      continue;
    }

    const typeError = validateType(value, def.type, def.name);
    if (typeError) {
      errors.push(typeError);
      continue;
    }

    if (def.required && typeof value === 'string' && value.trim().length === 0) {
      errors.push(`Parameter '${def.name}' must not be blank`);
    }
    if (typeof value === 'string' && def.minLength !== undefined && value.length < def.minLength) {
      errors.push(`Parameter '${def.name}' must contain at least ${def.minLength} characters`);
    }
    if (typeof value === 'string' && def.maxLength !== undefined && value.length > def.maxLength) {
      errors.push(`Parameter '${def.name}' must contain at most ${def.maxLength} characters`);
    }
    if (typeof value === 'number' && def.minimum !== undefined && value < def.minimum) {
      errors.push(`Parameter '${def.name}' must be at least ${def.minimum}`);
    }
    if (typeof value === 'number' && def.maximum !== undefined && value > def.maximum) {
      errors.push(`Parameter '${def.name}' must be at most ${def.maximum}`);
    }
    if (Array.isArray(value) && def.items?.type) {
      for (let index = 0; index < value.length; index += 1) {
        const itemError = validateType(value[index], def.items.type, `${def.name}[${index}]`);
        if (itemError) errors.push(itemError);
      }
    }

    if (def.enum && !def.enum.includes(value)) {
      errors.push(`Parameter '${def.name}' must be one of: ${def.enum.join(', ')}`);
    }
  }
  return errors;
}

function validateType(value, expectedType, name) {
  if (!expectedType) return null;

  let valid;
  switch (expectedType) {
    case 'array':
      valid = Array.isArray(value);
      break;
    case 'object':
      valid = isPlainObject(value);
      break;
    case 'number':
      valid = typeof value === 'number' && Number.isFinite(value);
      break;
    case 'integer':
      valid = Number.isInteger(value);
      break;
    default:
      valid = typeof value === expectedType;
  }

  return valid ? null : `Parameter '${name}' expected type '${expectedType}', got '${describeType(value)}'`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

function describeType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'non-finite number';
  return typeof value;
}

export function isSameTab(messageTabId, localTabId) {
  return !messageTabId || !localTabId || messageTabId === localTabId;
}
