import type { ToolDefinition } from '../openrouter/types';
import { diagnosticsTool } from './diagnostics';
import { editFileTool } from './editFile';
import { globTool } from './glob';
import { grepTool } from './grep';
import { listDirTool } from './listDir';
import { readFileTool } from './readFile';
import { runCommandTool } from './runCommand';
import { delegateTool, exploreTool } from './subagents';
import type { Tool } from './types';
import { writeFileTool } from './writeFile';

export type AnyTool = Tool<any>;

export class ToolRegistry {
	private readonly tools = new Map<string, AnyTool>();

	constructor(tools: AnyTool[]) {
		for (const t of tools) {
			this.tools.set(t.name, t);
		}
	}

	get(name: string): AnyTool | undefined {
		return this.tools.get(name);
	}

	all(): AnyTool[] {
		return [...this.tools.values()];
	}

	static definitions(tools: AnyTool[]): ToolDefinition[] {
		return tools.map(t => ({
			type: 'function',
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));
	}
}

export function createToolRegistry(): ToolRegistry {
	return new ToolRegistry([
		readFileTool,
		listDirTool,
		globTool,
		grepTool,
		diagnosticsTool,
		editFileTool,
		writeFileTool,
		runCommandTool,
		exploreTool,
		delegateTool,
	]);
}
