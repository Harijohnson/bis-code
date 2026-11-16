import * as assert from 'assert';
import { needsTrust, toolsForMode, toolsForSubagent } from '../../agent/permissions';
import type { AnyTool } from '../../tools/registry';
import type { ToolPermission } from '../../tools/types';

function tool(name: string, permission: ToolPermission): AnyTool {
	return {
		name,
		permission,
		description: name,
		parameters: { type: 'object', properties: {} },
		execute: async () => ({ ok: true, content: '', summary: '' }),
	};
}

const ALL = [
	tool('read_file', 'auto'),
	tool('grep', 'auto'),
	tool('edit_file', 'edit'),
	tool('run_command', 'command'),
	tool('explore', 'auto'),
	tool('delegate', 'delegate'),
];

const names = (tools: AnyTool[]) => tools.map(t => t.name);

suite('tool permissions', () => {
	test('Agent mode offers every tool, Plan mode only read-only ones, Chat mode none', () => {
		assert.deepStrictEqual(names(toolsForMode('agent', ALL)), names(ALL));
		assert.deepStrictEqual(names(toolsForMode('plan', ALL)), ['read_file', 'grep', 'explore']);
		assert.deepStrictEqual(toolsForMode('chat', ALL), []);
	});

	test('explore sub-agents only read; delegates get the mode tools; neither can start sub-agents', () => {
		assert.deepStrictEqual(names(toolsForSubagent('explore', toolsForMode('agent', ALL))), ['read_file', 'grep']);
		assert.deepStrictEqual(names(toolsForSubagent('delegate', toolsForMode('agent', ALL))), ['read_file', 'grep', 'edit_file', 'run_command']);
		assert.deepStrictEqual(names(toolsForSubagent('delegate', toolsForMode('plan', ALL))), ['read_file', 'grep']);
	});

	test('only edit and command tools need a trusted workspace', () => {
		assert.deepStrictEqual(ALL.filter(needsTrust).map(t => t.name), ['edit_file', 'run_command']);
	});
});
