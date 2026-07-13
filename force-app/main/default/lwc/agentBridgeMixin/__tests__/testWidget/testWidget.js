import { LightningElement } from 'lwc';
import AgentBridgeMixin from 'c/agentBridgeMixin';

export default class TestWidget extends AgentBridgeMixin(LightningElement) {
    _items = [
        { id: '1', name: 'Item A' },
        { id: '2', name: 'Item B' }
    ];

    get agentComponentLabel() {
        return 'TestWidget';
    }

    get agentActions() {
        return [
            {
                name: 'getItems',
                description: 'Returns all items',
                params: [],
                returns: { type: 'array', description: 'Items' }
            },
            {
                name: 'addItem',
                description: 'Adds an item',
                params: [
                    { name: 'name', type: 'string', required: true, description: 'Item name' }
                ],
                returns: { type: 'object', description: 'Created item' }
            }
        ];
    }

    async handleAgentAction(actionName, params) {
        switch (actionName) {
            case 'getItems':
                return this._items;
            case 'addItem': {
                const item = { id: String(this._items.length + 1), name: params.name };
                this._items.push(item);
                return item;
            }
            default:
                throw new Error(`Unknown: ${actionName}`);
        }
    }
}
