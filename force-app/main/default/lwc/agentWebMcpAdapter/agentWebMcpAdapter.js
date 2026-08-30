import { Timeout } from 'c/agentBridgeUtils';

// Publishes bridge component actions as WebMCP tools (document.modelContext),
// so browser-native agents can drive the page without an external transport.
// The adapter never touches the orchestrator directly: it reads the registry
// and runs actions through the callbacks it is constructed with, which keeps
// the approval gate on the orchestrator side of the boundary.

const TOOL_PREFIX = 'sf';

// Rows rendered from a for:each share a base label ("CandidateRow:<id>"), so
// tools are grouped by base label and disambiguated with a componentId param.
export function baseLabel(label) {
  return String(label || '').split(':')[0] || 'component';
}

export function kebab(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function toolNameFor(label, actionName) {
  return `${TOOL_PREFIX}-${kebab(baseLabel(label))}-${kebab(actionName)}`;
}

export function paramsToJsonSchema(params, componentIds) {
  const properties = {};
  const required = [];

  for (const param of params || []) {
    if (!param?.name) continue;
    const schema = { type: param.type || 'string' };
    if (param.description) schema.description = param.description;
    if (Array.isArray(param.enum)) schema.enum = param.enum;
    if (schema.type === 'array') schema.items = { type: param.items?.type || 'string' };
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength']) {
      if (param[key] !== undefined) schema[key] = param[key];
    }
    properties[param.name] = schema;
    if (param.required) required.push(param.name);
  }

  if (componentIds && componentIds.length > 1) {
    properties.componentId = {
      type: 'string',
      description: 'Which instance to act on. Read the tool list again to map ids to records.',
      enum: componentIds
    };
    required.push('componentId');
  }

  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

export function describeTool(label, action) {
  return [
    action.description || `Runs ${action.name} on ${label}.`,
    `Acts on the Salesforce ${label} component visible on this page.`,
    action.dangerous ? 'Destructive: the user is asked to approve before this runs.' : ''
  ]
    .filter(Boolean)
    .join(' ');
}

// Collapses the registry into one tool per (base label, action).
export function groupRegistry(registry) {
  const groups = new Map();
  for (const [componentId, data] of registry) {
    for (const action of data?.actions || []) {
      if (!action?.name) continue;
      const label = baseLabel(data.label);
      const key = `${label}::${action.name}`;
      const group = groups.get(key) || { label, action, componentIds: [] };
      group.componentIds.push(componentId);
      groups.set(key, group);
    }
  }
  return groups;
}

export default class AgentWebMcpAdapter {
  _controllers = new Map();
  _syncTimer = null;

  /**
   * @param {object} options
   * @param {() => Map} options.getRegistry  current component registry
   * @param {(payload: object) => Promise} options.execute  routes through the approval gate
   */
  constructor({ getRegistry, execute }) {
    this._getRegistry = getRegistry;
    this._execute = execute;
  }

  get available() {
    return !!this.context;
  }

  get context() {
    try {
      const ctx = document.modelContext;
      return ctx && typeof ctx.registerTool === 'function' ? ctx : null;
    } catch {
      return null;
    }
  }

  get publishedToolNames() {
    return [...this._controllers.keys()];
  }

  scheduleSync() {
    if (!this.available) return;
    clearTimeout(this._syncTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this._syncTimer = setTimeout(() => this.sync(), Timeout.WEBMCP_SYNC);
  }

  async sync() {
    const ctx = this.context;
    if (!ctx) return;

    this._abortAll();

    const publications = [...groupRegistry(this._getRegistry()).values()].map((group) => {
      const { label, action, componentIds } = group;
      const name = toolNameFor(label, action.name);
      const controller = new AbortController();

      return ctx
        .registerTool(
          {
            name,
            description: describeTool(label, action),
            inputSchema: paramsToJsonSchema(action.params, componentIds),
            execute: (args) => this.runTool(action.name, componentIds, args)
          },
          { signal: controller.signal }
        )
        .then(() => this._controllers.set(name, controller))
        .catch((error) => {
          console.warn(`AgentWebMcpAdapter: could not publish '${name}':`, error.message);
        });
    });

    await Promise.all(publications);
  }

  async runTool(actionName, componentIds, rawArgs) {
    try {
      // Chrome's preview hands arguments over as a JSON string.
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
      const { componentId: requested, ...params } = args;
      const componentId = requested || componentIds[0];

      if (!this._getRegistry().has(componentId)) {
        throw new Error(`Component '${componentId}' is no longer on the page. Read the tool list again.`);
      }

      const result = await this._execute({ componentId, actionName, params });
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      // Apex faults arrive as { body: { message } }; plain Errors as { message }.
      const reason = error?.body?.message || error?.message || String(error) || 'Action failed';
      // Returned as ordinary content rather than isError: Chrome's preview collapses
      // an isError result into a generic rejection, losing the reason (including
      // "the user declined"). Both forms are rejected today; revisit when the
      // elicitation question in the spec is settled.
      return { content: [{ type: 'text', text: `Action was not completed. Reason: ${reason}` }] };
    }
  }

  teardown() {
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    this._abortAll();
  }

  _abortAll() {
    for (const [, controller] of this._controllers) controller.abort();
    this._controllers.clear();
  }
}
