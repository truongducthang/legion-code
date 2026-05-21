interface ParallelCodeMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ParallelCodeMcpConfig {
  mcpServers: {
    'parallel-code': ParallelCodeMcpServerConfig;
  };
}

export function isCodexCommand(command: string): boolean {
  return command.split('/').pop()?.includes('codex') === true;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlStringMap(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')} }`;
}

export function buildCodexMcpConfigOverride(config: ParallelCodeMcpConfig): string {
  const server = config.mcpServers['parallel-code'];
  return `mcp_servers.parallel-code={ command = ${tomlString(server.command)}, args = ${tomlStringArray(server.args)}, env = ${tomlStringMap(server.env)} }`;
}

export function buildMcpLaunchArgs(
  command: string,
  configPath: string | undefined,
  config: ParallelCodeMcpConfig,
): string[] {
  if (isCodexCommand(command)) {
    return ['--config', buildCodexMcpConfigOverride(config)];
  }
  return configPath ? ['--mcp-config', configPath] : [];
}
