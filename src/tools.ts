export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface ToolRegistry {
  definitions: ToolDefinition[];
  dispatch(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface BuildToolRegistryOptions {
  toolResultMaxBytes?: number;
}

export function buildToolRegistry(_opts: BuildToolRegistryOptions): ToolRegistry {
  const definitions: ToolDefinition[] = [];
  const handlers = new Map<string, ToolHandler>();

  return {
    definitions,
    async dispatch(name, args) {
      const handler = handlers.get(name);
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return await handler(args);
    },
  };
}
