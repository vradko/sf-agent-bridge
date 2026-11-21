import { Timeout } from 'c/agentBridgeUtils';

// Publishes bridge component actions as WebMCP tools (document.modelContext),
// so browser-native agents can drive the page without an external transport.
// The adapter never touches the orchestrator directly: it reads the registry
// and runs actions through the callbacks it is constructed with, which keeps
// the approval gate on the orchestrator side of the boundary.
//
// Tool definitions are kept stable on purpose. Some agent hosts hold on to a
// tool between listing and calling it and treat a re-registered tool as a new
// one, so a tool is only replaced when its definition really changes.

const TOOL_PREFIX = 'sf';
const STABLE_PREFIX = 'stable:';

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

// A plain-string componentId, never an enum of what is on screen right now:
// that enum would change with every filter and force the tool to be replaced.
export function componentIdSchema(label, stableIds) {
  const example = stableIds ? `"${STABLE_PREFIX}${label}:<key>"` : 'the id discover returns';
  return {
    type: 'string',
    description:
      `Which ${label} to act on: its bridge component id, such as ${example}. ` +
      `Ids of the ${label} components on the page now come from discover or a listing action on the page.`
  };
}

/**
 * @param {Array} params  action parameter definitions
 * @param {{label: string, stableIds: boolean}} [instance]  set for per-instance tools (rows):
 *        adds a required componentId
 */
export function paramsToJsonSchema(params, instance) {
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

  if (instance) {
    properties.componentId = componentIdSchema(instance.label, instance.stableIds);
    required.push('componentId');
  }

  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

export function describeTool(label, action, perInstance = false) {
  return [
    action.description || `Runs ${action.name} on ${label}.`,
    perInstance
      ? `Acts on one Salesforce ${label} component on this page, chosen by componentId.`
      : `Acts on the Salesforce ${label} component visible on this page.`,
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

function currentPath() {
  try {
    return window.location.pathname;
  } catch {
    return '';
  }
}

export default class AgentWebMcpAdapter {
  // tool name → { label, actionName, perInstance, stableIds, path, definition, signature, controller }
  _tools = new Map();
  _syncTimer = null;

  /**
   * @param {object} options
   * @param {() => Map} options.getRegistry  current component registry
   * @param {(payload: object) => Promise} options.execute  routes through the approval gate
   * @param {() => string} [options.getPath]  identifies the page; tools of departed components live until it changes
   */
  constructor({ getRegistry, execute, getPath }) {
    this._getRegistry = getRegistry;
    this._execute = execute;
    this._getPath = getPath || currentPath;
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
    return [...this._tools.keys()];
  }

  scheduleSync() {
    if (!this.available) return;
    clearTimeout(this._syncTimer);
    // eslint-disable-next-line @lwc/lwc/no-async-operation
    this._syncTimer = setTimeout(() => this.sync(), Timeout.WEBMCP_SYNC);
  }

  // Reconciles published tools with the registry one by one: an unchanged tool keeps its
  // registration, a changed one is replaced, a new one is added. A tool whose components
  // all left (a filter that shows no rows) stays until the page changes; calling it for
  // a component that is not on the page fails with a clear reason.
  async sync() {
    const ctx = this.context;
    if (!ctx) return;

    const desired = this._desiredTools(this._getPath());

    for (const [name, entry] of this._tools) {
      const spec = desired.get(name);
      if (!spec || spec.signature !== entry.signature) {
        entry.controller.abort();
        this._tools.delete(name);
      } else {
        entry.path = spec.path;
      }
    }

    const publications = [];
    for (const [name, spec] of desired) {
      if (this._tools.has(name)) continue;
      const controller = new AbortController();
      // Tracked before registerTool settles, so teardown or the next sync can cancel it.
      this._tools.set(name, { ...spec, controller });
      publications.push(this._publish(ctx, name, spec, controller));
    }
    await Promise.all(publications);
  }

  async runTool(name, rawArgs) {
    try {
      const entry = this._tools.get(name);
      if (!entry) {
        throw new Error(`Tool '${name}' is no longer published. Read the tool list again.`);
      }
      // Chrome 152 handed arguments over as a JSON string; 157 passes an object.
      const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : rawArgs || {};
      const { componentId: requested, ...params } = args;
      const onPage = this._instancesOf(entry.label, entry.actionName);
      const componentId = requested || (entry.perInstance ? null : onPage[0]);

      if (!componentId) {
        throw new Error(
          onPage.length
            ? `componentId is required: say which ${entry.label} (discover lists the ones on the page).`
            : `${entry.label} is not on the page right now.`
        );
      }
      if (!onPage.includes(componentId)) {
        throw new Error(
          `Component '${componentId}' is not on the page right now. Run discover (or a listing action) for current ids.`
        );
      }

      const result = await this._execute({ componentId, actionName: entry.actionName, params });
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
    } catch (error) {
      // Apex faults arrive as { body: { message } }; plain Errors as { message }.
      const reason = error?.body?.message || error?.message || String(error) || 'Action failed';
      // Returned as ordinary content rather than isError: Chrome 152 collapsed an
      // isError result into a generic rejection and lost the reason ("the user
      // declined"); revisit when the elicitation question in the spec is settled.
      return { content: [{ type: 'text', text: `Action was not completed. Reason: ${reason}` }] };
    }
  }

  teardown() {
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    for (const [, entry] of this._tools) entry.controller.abort();
    this._tools.clear();
  }

  _desiredTools(path) {
    const desired = new Map();
    for (const group of groupRegistry(this._getRegistry()).values()) {
      const name = toolNameFor(group.label, group.action.name);
      const previous = this._tools.get(name);
      // Sticky, so a tool doesn't change shape when the last but one row disappears.
      const stableIds = previous?.stableIds || group.componentIds.some((id) => String(id).startsWith(STABLE_PREFIX));
      const perInstance = previous?.perInstance || stableIds || group.componentIds.length > 1;
      desired.set(name, this._spec(name, group.label, group.action, { perInstance, stableIds, path }));
    }
    for (const [name, entry] of this._tools) {
      if (!desired.has(name) && entry.path === path) desired.set(name, entry);
    }
    return desired;
  }

  _spec(name, label, action, { perInstance, stableIds, path }) {
    const definition = {
      name,
      description: describeTool(label, action, perInstance),
      inputSchema: paramsToJsonSchema(action.params, perInstance ? { label, stableIds } : null)
    };
    return {
      label,
      actionName: action.name,
      perInstance,
      stableIds,
      path,
      definition,
      signature: JSON.stringify(definition)
    };
  }

  _publish(ctx, name, spec, controller) {
    const forget = (error) => {
      if (this._tools.get(name)?.controller === controller) this._tools.delete(name);
      if (!controller.signal.aborted) {
        console.warn(`AgentWebMcpAdapter: could not publish '${name}':`, error?.message || error);
      }
    };
    try {
      const pending = ctx.registerTool(
        { ...spec.definition, execute: (args) => this.runTool(name, args) },
        { signal: controller.signal }
      );
      return Promise.resolve(pending).catch(forget);
    } catch (error) {
      forget(error);
      return Promise.resolve();
    }
  }

  _instancesOf(label, actionName) {
    const ids = [];
    for (const [componentId, data] of this._getRegistry()) {
      if (baseLabel(data?.label) === label && (data?.actions || []).some((a) => a?.name === actionName)) {
        ids.push(componentId);
      }
    }
    return ids;
  }
}
