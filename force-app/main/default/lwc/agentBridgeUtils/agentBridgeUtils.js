// ── Channel & Storage ──────────────────────────────────────────────

export const CHANNEL_NAME = 'sf-agent-bridge';
export const BRIDGE_VERSION = '1.0.0';

const TAB_ID_KEY = '__sfAgentBridgeTabId';

// ── Message Types ──────────────────────────────────────────────────

export const MessageType = {
    INTERNAL: 'internal',
    REQUEST: 'request',
    RESPONSE: 'response'
};

// ── Internal Actions (Orchestrator ↔ Widgets) ──────────────────────

export const InternalAction = {
    REGISTER: 'REGISTER',
    UNREGISTER: 'UNREGISTER',
    ROLL_CALL: 'ROLL_CALL',
    EXECUTE: 'EXECUTE',
    RESULT: 'RESULT',
    ORCHESTRATOR_READY: 'ORCHESTRATOR_READY',
    ORCHESTRATOR_GONE: 'ORCHESTRATOR_GONE'
};

// ── Agent Actions (External → Orchestrator) ────────────────────────

export const AgentAction = {
    PING: 'ping',
    DISCOVER: 'discover',
    EXECUTE: 'execute'
};

// ── Response Status ────────────────────────────────────────────────

export const ResponseStatus = {
    OK: 'ok',
    ERROR: 'error',
    PENDING_APPROVAL: 'pending_approval'
};

// ── Timeouts (ms) ──────────────────────────────────────────────────

export const Timeout = {
    EXECUTE: 30000,
    DANGEROUS_EXECUTE: 60000,
    ROLL_CALL: 500,
    DUPLICATE_CHECK: 1000
};

// ── Param Types for Validation ─────────────────────────────────────

const SCALAR_TYPES = new Set(['string', 'number', 'boolean', 'object']);

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
        return null;
    }
}

export function validateParams(params, paramDefs) {
    const errors = [];
    for (const def of paramDefs) {
        const value = params[def.name];

        if (def.required && (value === undefined || value === null)) {
            errors.push(`Missing required parameter: ${def.name}`);
            continue;
        }

        if (value === undefined || value === null) continue;

        if (def.type === 'array' && !Array.isArray(value)) {
            errors.push(`Parameter '${def.name}' expected an array`);
        } else if (def.type && SCALAR_TYPES.has(def.type) && typeof value !== def.type) {
            errors.push(`Parameter '${def.name}' expected type '${def.type}', got '${typeof value}'`);
        }

        if (def.enum && !def.enum.includes(value)) {
            errors.push(`Parameter '${def.name}' must be one of: ${def.enum.join(', ')}`);
        }
    }
    return errors;
}

export function isSameTab(messageTabId, localTabId) {
    return !messageTabId || !localTabId || messageTabId === localTabId;
}
