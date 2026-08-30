import AgentWebMcpAdapter, {
  baseLabel,
  kebab,
  toolNameFor,
  paramsToJsonSchema,
  describeTool,
  groupRegistry
} from 'c/agentWebMcpAdapter';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function registryOf(entries) {
  return new Map(entries);
}

const GET_ITEMS = { name: 'getItems', description: 'Returns items', params: [] };
const DELETE_ITEM = {
  name: 'deleteItem',
  description: 'Deletes an item',
  dangerous: true,
  params: [{ name: 'itemId', type: 'string', required: true, description: 'Record id' }]
};

describe('naming helpers', () => {
  it('strips the instance suffix from a row label', () => {
    expect(baseLabel('CandidateRow:a00KE000002IRDl')).toBe('CandidateRow');
    expect(baseLabel('CandidateManager')).toBe('CandidateManager');
    expect(baseLabel(undefined)).toBe('component');
  });

  it('kebab-cases camel case and punctuation', () => {
    expect(kebab('CandidateManager')).toBe('candidate-manager');
    expect(kebab('getRowComponents')).toBe('get-row-components');
    expect(kebab('Weird__Name!!')).toBe('weird-name');
  });

  it('builds a prefixed tool name', () => {
    expect(toolNameFor('CandidateRow:a00x', 'updateStage')).toBe('sf-candidate-row-update-stage');
  });
});

describe('paramsToJsonSchema', () => {
  it('maps types, enums, required and bounds', () => {
    const schema = paramsToJsonSchema([
      { name: 'stage', type: 'string', required: true, description: 'Stage', enum: ['New', 'Hired'] },
      { name: 'countries', type: 'array', items: { type: 'string' } },
      { name: 'minExperience', type: 'number', minimum: 0, maximum: 40 }
    ]);
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['stage']);
    expect(schema.properties.stage.enum).toEqual(['New', 'Hired']);
    expect(schema.properties.countries).toEqual({ type: 'array', items: { type: 'string' } });
    expect(schema.properties.minExperience).toEqual({ type: 'number', minimum: 0, maximum: 40 });
  });

  it('adds a required componentId only when several instances share the tool', () => {
    expect(paramsToJsonSchema([], ['one']).properties.componentId).toBeUndefined();
    const shared = paramsToJsonSchema([], ['one', 'two']);
    expect(shared.properties.componentId.enum).toEqual(['one', 'two']);
    expect(shared.required).toContain('componentId');
  });

  it('ignores malformed parameter definitions', () => {
    const schema = paramsToJsonSchema([null, {}, { name: 'ok', type: 'string' }]);
    expect(Object.keys(schema.properties)).toEqual(['ok']);
  });
});

describe('describeTool', () => {
  it('warns about destructive actions', () => {
    expect(describeTool('CandidateManager', DELETE_ITEM)).toContain('user is asked to approve');
  });

  it('stays quiet for safe actions', () => {
    expect(describeTool('CandidateManager', GET_ITEMS)).not.toContain('approve');
  });
});

describe('groupRegistry', () => {
  it('collapses repeated rows into one tool per action', () => {
    const groups = groupRegistry(
      registryOf([
        ['row-1', { label: 'CandidateRow:1', actions: [GET_ITEMS] }],
        ['row-2', { label: 'CandidateRow:2', actions: [GET_ITEMS] }],
        ['mgr', { label: 'CandidateManager', actions: [GET_ITEMS, DELETE_ITEM] }]
      ])
    );
    expect(groups.size).toBe(3);
    expect(groups.get('CandidateRow::getItems').componentIds).toEqual(['row-1', 'row-2']);
    expect(groups.get('CandidateManager::deleteItem').componentIds).toEqual(['mgr']);
  });
});

describe('AgentWebMcpAdapter', () => {
  let registry;
  let execute;
  let registered;

  beforeEach(() => {
    registered = [];
    registry = registryOf([['mgr', { label: 'CandidateManager', actions: [GET_ITEMS, DELETE_ITEM] }]]);
    execute = jest.fn().mockResolvedValue({ ok: true });
    global.document.modelContext = {
      registerTool: jest.fn((tool) => {
        registered.push(tool);
        return Promise.resolve();
      })
    };
  });

  afterEach(() => {
    delete global.document.modelContext;
  });

  const build = () => new AgentWebMcpAdapter({ getRegistry: () => registry, execute });

  it('reports availability from document.modelContext', () => {
    expect(build().available).toBe(true);
    delete global.document.modelContext;
    expect(build().available).toBe(false);
  });

  it('publishes one tool per action', async () => {
    const adapter = build();
    await adapter.sync();
    expect(registered.map((t) => t.name).sort()).toEqual([
      'sf-candidate-manager-delete-item',
      'sf-candidate-manager-get-items'
    ]);
    expect(adapter.publishedToolNames).toHaveLength(2);
  });

  it('routes execution through the injected execute callback', async () => {
    const adapter = build();
    await adapter.sync();
    const tool = registered.find((t) => t.name === 'sf-candidate-manager-delete-item');
    const result = await tool.execute(JSON.stringify({ itemId: 'a01' }));
    expect(execute).toHaveBeenCalledWith({
      componentId: 'mgr',
      actionName: 'deleteItem',
      params: { itemId: 'a01' }
    });
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  it('accepts arguments as an object as well as a JSON string', async () => {
    const adapter = build();
    await adapter.sync();
    const tool = registered.find((t) => t.name === 'sf-candidate-manager-get-items');
    await tool.execute({ any: 'thing' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ params: { any: 'thing' } }));
  });

  it('honours an explicit componentId', async () => {
    registry = registryOf([
      ['row-1', { label: 'CandidateRow:1', actions: [GET_ITEMS] }],
      ['row-2', { label: 'CandidateRow:2', actions: [GET_ITEMS] }]
    ]);
    const adapter = build();
    await adapter.sync();
    const tool = registered.find((t) => t.name === 'sf-candidate-row-get-items');
    await tool.execute(JSON.stringify({ componentId: 'row-2' }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ componentId: 'row-2' }));
  });

  it('surfaces the reason when the action is refused', async () => {
    execute = jest.fn().mockRejectedValue(new Error('Action rejected by user'));
    const adapter = build();
    await adapter.sync();
    const tool = registered.find((t) => t.name === 'sf-candidate-manager-delete-item');
    const result = await tool.execute(JSON.stringify({ itemId: 'a01' }));
    expect(result.content[0].text).toContain('Action rejected by user');
  });

  it('unwraps Apex fault bodies', async () => {
    execute = jest.fn().mockRejectedValue({ body: { message: 'Invalid stage: Nope' } });
    const adapter = build();
    await adapter.sync();
    const tool = registered.find((t) => t.name === 'sf-candidate-manager-get-items');
    const result = await tool.execute('{}');
    expect(result.content[0].text).toContain('Invalid stage: Nope');
  });

  it('refuses to act on a component that left the page', async () => {
    const adapter = build();
    await adapter.sync();
    const tool = registered.find((t) => t.name === 'sf-candidate-manager-get-items');
    registry.clear();
    const result = await tool.execute('{}');
    expect(result.content[0].text).toContain('no longer on the page');
    expect(execute).not.toHaveBeenCalled();
  });

  it('replaces previously published tools on re-sync', async () => {
    const adapter = build();
    await adapter.sync();
    const aborted = [];
    for (const [name] of adapter._controllers) aborted.push(name);
    await adapter.sync();
    expect(adapter.publishedToolNames.sort()).toEqual(aborted.sort());
    expect(global.document.modelContext.registerTool).toHaveBeenCalledTimes(4);
  });

  it('keeps going when one tool fails to publish', async () => {
    global.document.modelContext.registerTool = jest.fn((tool) => {
      if (tool.name.includes('delete')) {
        return Promise.reject(new Error('Duplicate tool name'));
      }
      registered.push(tool);
      return Promise.resolve();
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = build();
    await adapter.sync();
    expect(adapter.publishedToolNames).toEqual(['sf-candidate-manager-get-items']);
    console.warn.mockRestore();
  });

  it('does nothing when the browser has no WebMCP support', async () => {
    delete global.document.modelContext;
    const adapter = build();
    adapter.scheduleSync();
    await adapter.sync();
    await flush();
    expect(adapter.publishedToolNames).toEqual([]);
  });

  it('debounces a burst of registrations into one publish', async () => {
    jest.useFakeTimers();
    const adapter = build();
    const spy = jest.spyOn(adapter, 'sync').mockResolvedValue();
    adapter.scheduleSync();
    adapter.scheduleSync();
    adapter.scheduleSync();
    jest.runAllTimers();
    expect(spy).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('drops every published tool on teardown', async () => {
    const adapter = build();
    await adapter.sync();
    adapter.teardown();
    expect(adapter.publishedToolNames).toEqual([]);
  });
});
