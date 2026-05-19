import fs from 'fs';
import os from 'os';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecFileSync, mockExecFile, mockChildProcessSpawn, mockPtySpawn, mockLogDebug } =
  vi.hoisted(() => {
    const mockExecFileSync = vi.fn((command: string, args?: string[]) => {
      if ((command === 'which' || command === 'where') && args?.[0] === 'nonexistent-binary-xyz') {
        throw new Error('not found');
      }
      return '';
    });

    const mockExecFile = vi.fn();
    const mockChildProcessSpawn = vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    }));

    const mockPtySpawn = vi.fn(
      (_command: string, _args: string[], options: { cols: number; rows: number }) => {
        let onDataHandler: ((data: string) => void) | undefined;
        let onExitHandler:
          | ((event: { exitCode: number; signal: number | undefined }) => void)
          | undefined;

        const proc = {
          cols: options.cols,
          rows: options.rows,
          write: vi.fn(),
          resize: vi.fn((cols: number, rows: number) => {
            proc.cols = cols;
            proc.rows = rows;
          }),
          pause: vi.fn(),
          resume: vi.fn(),
          kill: vi.fn(() => {
            onExitHandler?.({ exitCode: 0, signal: 15 });
          }),
          onData: vi.fn((handler: (data: string) => void) => {
            onDataHandler = handler;
          }),
          onExit: vi.fn(
            (handler: (event: { exitCode: number; signal: number | undefined }) => void) => {
              onExitHandler = handler;
            },
          ),
          emitData(data: string) {
            onDataHandler?.(data);
          },
          emitExit(event: { exitCode: number; signal: number | undefined }) {
            onExitHandler?.(event);
          },
        };

        return proc;
      },
    );

    const mockLogDebug = vi.fn();

    return { mockExecFileSync, mockExecFile, mockChildProcessSpawn, mockPtySpawn, mockLogDebug };
  });

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    execFile: mockExecFile,
    spawn: mockChildProcessSpawn,
  };
});

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn,
}));

vi.mock('../log.js', () => ({
  debug: mockLogDebug,
}));

import {
  buildDockerImage,
  DOCKER_CONTAINER_HOME,
  dockerImageExists,
  hashDockerfile,
  killAllAgents,
  projectImageTag,
  resolveProjectDockerfile,
  snapshotRunningAgents,
  spawnAgent,
  subscribeToAgentExit,
  unsubscribeFromAgentExit,
  validateCommand,
  type AgentExitInfo,
} from './pty.js';

let tempPaths: string[] = [];
let agentCounter = 0;

function createMockWindow(): BrowserWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  } as unknown as BrowserWindow;
}

function nextAgentId(): string {
  agentCounter += 1;
  return `agent-${agentCounter}`;
}

function buildSpawnArgs(
  overrides: Partial<Parameters<typeof spawnAgent>[1]> = {},
): Parameters<typeof spawnAgent>[1] {
  return {
    taskId: 'task-1',
    agentId: nextAgentId(),
    command: 'claude',
    args: ['--print', 'hello'],
    cwd: '/workspace/project',
    env: {},
    cols: 120,
    rows: 40,
    dockerMode: true,
    dockerImage: 'parallel-code-agent:test',
    shareDockerAgentAuth: false,
    onOutput: { __CHANNEL_ID__: 'channel-1' },
    ...overrides,
  };
}

function getLastSpawnCall(): {
  command: string;
  args: string[];
  options: {
    cols: number;
    rows: number;
    cwd?: string;
    env: Record<string, string>;
    name: string;
  };
} {
  const lastCall = mockPtySpawn.mock.lastCall;
  expect(lastCall).toBeTruthy();
  const [command, args, options] = lastCall as [
    string,
    string[],
    { cols: number; rows: number; cwd?: string; env: Record<string, string>; name: string },
  ];
  return { command, args, options };
}

function getFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === flag) {
      values.push(args[i + 1]);
    }
  }
  return values;
}

function getSpawnCommandLogCtx(): { args: string[]; command: string } {
  const call = mockLogDebug.mock.calls.find(
    ([category, msg]) => category === 'pty' && String(msg).startsWith('spawn command '),
  );
  expect(call).toBeTruthy();
  return call?.[2] as { args: string[]; command: string };
}

function makeTempHome(entries: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-docker-home-'));
  tempPaths.push(home);

  for (const entry of entries) {
    const target = path.join(home, entry);
    if (entry.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'test');
    }
  }

  return home;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  tempPaths = [];
});

afterEach(() => {
  killAllAgents();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const tempPath of tempPaths) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
  tempPaths = [];
});

describe('DOCKER_CONTAINER_HOME', () => {
  it('uses a home directory writable by arbitrary host-mapped docker users', () => {
    expect(DOCKER_CONTAINER_HOME).toBe('/tmp');
  });
});

describe('spawnAgent docker mode', () => {
  it('injects HOME=/tmp into docker run args', () => {
    vi.stubEnv('HOME', '/Users/tester');

    spawnAgent(createMockWindow(), buildSpawnArgs());

    const { command, args } = getLastSpawnCall();
    expect(command).toBe('docker');
    expect(getFlagValues(args, '-e')).toContain(`HOME=${DOCKER_CONTAINER_HOME}`);
  });

  it('does not forward host or renderer HOME as a generic docker env flag', () => {
    const hostHome = '/Users/host-home';
    const rendererHome = '/Users/renderer-home';
    vi.stubEnv('HOME', hostHome);

    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        env: {
          API_KEY: 'secret',
          HOME: rendererHome,
        },
      }),
    );

    const envFlags = getFlagValues(getLastSpawnCall().args, '-e');
    expect(envFlags).toContain('API_KEY=secret');
    expect(envFlags.filter((value) => value.startsWith('HOME='))).toEqual([
      `HOME=${DOCKER_CONTAINER_HOME}`,
    ]);
    expect(envFlags).not.toContain(`HOME=${hostHome}`);
    expect(envFlags).not.toContain(`HOME=${rendererHome}`);
  });

  it('redacts docker env values in spawn debug logs', () => {
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        env: {
          API_KEY: 'secret-api-key',
          NO_VALUE: '',
        },
      }),
    );

    const ctx = getSpawnCommandLogCtx();
    const logged = ctx.args.join(' ');

    expect(ctx.command).toBe('docker');
    expect(getFlagValues(ctx.args, '-e')).toContain('API_KEY=<redacted>');
    expect(getFlagValues(ctx.args, '-e')).toContain('NO_VALUE=<redacted>');
    expect(getFlagValues(ctx.args, '-e')).toContain(`HOME=<redacted>`);
    expect(logged).not.toContain('secret-api-key');
    expect(logged).not.toContain(`HOME=${DOCKER_CONTAINER_HOME}`);
    expect(logged).toContain('parallel-code-agent:test');
  });

  it('redacts inline docker env values in spawn debug logs', () => {
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        args: ['--env=INLINE_TOKEN=inline-secret', '--env', 'SPLIT_TOKEN=split-secret'],
      }),
    );

    const logged = getSpawnCommandLogCtx().args.join(' ');

    expect(logged).toContain('--env=INLINE_TOKEN=<redacted>');
    expect(logged).toContain('SPLIT_TOKEN=<redacted>');
    expect(logged).not.toContain('inline-secret');
    expect(logged).not.toContain('split-secret');
  });

  it('redacts shell command strings in spawn debug logs', () => {
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({
        command: '/bin/sh',
        args: ['-c', 'codex exec "prompt containing private context"'],
        dockerMode: false,
      }),
    );

    const ctx = getSpawnCommandLogCtx();

    expect(ctx.command).toBe('/bin/sh');
    expect(ctx.args).toEqual(['-c', '<redacted>']);
  });

  it('redirects credential mounts under /tmp inside the container', () => {
    const home = makeTempHome(['.ssh/', '.gitconfig', '.config/gh/']);
    vi.stubEnv('HOME', home);

    spawnAgent(createMockWindow(), buildSpawnArgs());

    const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
    expect(volumeFlags).toContain(`${home}/.ssh:${DOCKER_CONTAINER_HOME}/.ssh:ro`);
    expect(volumeFlags).toContain(`${home}/.gitconfig:${DOCKER_CONTAINER_HOME}/.gitconfig:ro`);
    expect(volumeFlags).toContain(`${home}/.config/gh:${DOCKER_CONTAINER_HOME}/.config/gh:ro`);
  });

  describe('agent config dir mounts (shareDockerAgentAuth)', () => {
    it.each([
      ['claude', '.claude'],
      ['codex', '.codex'],
      ['gemini', '.gemini'],
      ['opencode', '.config/opencode'],
      ['copilot', '.config/github-copilot'],
    ])(
      '%s bind-mounts a user-owned host directory when shareDockerAgentAuth is enabled',
      (command, relDir) => {
        const home = makeTempHome([]);
        vi.stubEnv('HOME', home);

        spawnAgent(createMockWindow(), buildSpawnArgs({ command, shareDockerAgentAuth: true }));

        const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
        const expectedHostDir = `${home}/.parallel-code/agent-auth/${command}/${relDir}`;
        expect(volumeFlags).toContain(`${expectedHostDir}:${DOCKER_CONTAINER_HOME}/${relDir}`);
      },
    );

    it('creates the host auth directory so it is user-owned before mounting', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'claude', shareDockerAgentAuth: true }),
      );

      const hostDir = `${home}/.parallel-code/agent-auth/claude/.claude`;
      expect(fs.existsSync(hostDir)).toBe(true);
    });

    it('bind-mounts .claude.json file for claude so auth persists across containers', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'claude', shareDockerAgentAuth: true }),
      );

      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      const expectedHostFile = `${home}/.parallel-code/agent-auth/claude/.claude.json`;
      expect(volumeFlags).toContain(`${expectedHostFile}:${DOCKER_CONTAINER_HOME}/.claude.json`);
      expect(fs.readFileSync(expectedHostFile, 'utf8')).toBe('{}');
    });

    it('does not mount agent auth directory when shareDockerAgentAuth is disabled', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'claude', shareDockerAgentAuth: false }),
      );

      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      expect(volumeFlags.some((v) => v.includes('.parallel-code/agent-auth'))).toBe(false);
    });

    it('does not mount agent auth directory for an unknown agent command', () => {
      const home = makeTempHome([]);
      vi.stubEnv('HOME', home);

      spawnAgent(
        createMockWindow(),
        buildSpawnArgs({ command: 'unknown-agent', shareDockerAgentAuth: true }),
      );

      const volumeFlags = getFlagValues(getLastSpawnCall().args, '-v');
      expect(volumeFlags.some((v) => v.includes('.parallel-code/agent-auth'))).toBe(false);
    });
  });
});

describe('spawnAgent session reattach', () => {
  it('reuses an existing PTY session and moves live output to the new channel', () => {
    const win = createMockWindow();
    const agentId = 'agent-reattach';
    const args = buildSpawnArgs({
      agentId,
      command: 'claude',
      args: [],
      dockerMode: false,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    spawnAgent(win, args);
    const proc = mockPtySpawn.mock.results[0].value as ReturnType<typeof mockPtySpawn>;
    proc.emitData('before reload');

    spawnAgent(win, {
      ...args,
      cols: 90,
      rows: 30,
      attachExisting: true,
      onOutput: { __CHANNEL_ID__: 'channel-2' },
    });
    proc.emitData('after reload');

    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    expect(proc.resume).toHaveBeenCalled();
    expect(proc.resize).toHaveBeenCalledWith(90, 30);
    expect(win.webContents.send).toHaveBeenCalledWith('channel:channel-2', {
      type: 'Data',
      data: Buffer.from('before reload', 'utf8').toString('base64'),
    });
    expect(win.webContents.send).toHaveBeenLastCalledWith('channel:channel-2', {
      type: 'Data',
      data: Buffer.from('after reload', 'utf8').toString('base64'),
    });
  });

  it('reattaches before validating the launch command', () => {
    const win = createMockWindow();
    const agentId = 'agent-reattach-missing-command';
    const args = buildSpawnArgs({
      agentId,
      command: 'claude',
      args: [],
      dockerMode: false,
      onOutput: { __CHANNEL_ID__: 'channel-1' },
    });

    spawnAgent(win, args);

    expect(() =>
      spawnAgent(win, {
        ...args,
        command: 'nonexistent-binary-xyz',
        attachExisting: true,
        onOutput: { __CHANNEL_ID__: 'channel-2' },
      }),
    ).not.toThrow();
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
  });
});

describe('validateCommand', () => {
  it('does not throw for a command found in PATH', () => {
    expect(() => validateCommand('/bin/sh')).not.toThrow();
  });

  it('throws a descriptive error for a missing command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/not found in PATH/);
  });

  it('throws a descriptive error naming the command', () => {
    expect(() => validateCommand('nonexistent-binary-xyz')).toThrow(/nonexistent-binary-xyz/);
  });

  it('throws for a nonexistent absolute path', () => {
    expect(() => validateCommand('/nonexistent/path/binary')).toThrow(
      /not found or not executable/,
    );
  });

  it('does not throw for a bare command found in PATH', () => {
    expect(() => validateCommand('sh')).not.toThrow();
  });

  it('throws for an empty command string', () => {
    expect(() => validateCommand('')).toThrow(/must not be empty/);
  });

  it('throws for a whitespace-only command string', () => {
    expect(() => validateCommand('   ')).toThrow(/must not be empty/);
  });
});

describe('resolveProjectDockerfile', () => {
  it('returns absolute path when .parallel-code/Dockerfile exists in project root', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);
    const dockerDir = path.join(projectRoot, '.parallel-code');
    fs.mkdirSync(dockerDir, { recursive: true });
    fs.writeFileSync(path.join(dockerDir, 'Dockerfile'), 'FROM node:20\n');

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBe(path.join(projectRoot, '.parallel-code', 'Dockerfile'));
  });

  it('returns null when .parallel-code/Dockerfile does not exist', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBeNull();
  });

  it('returns null when project root does not exist', () => {
    const result = resolveProjectDockerfile('/nonexistent/path/to/project');
    expect(result).toBeNull();
  });

  it('returns null when .parallel-code/Dockerfile is a directory', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-resolve-'));
    tempPaths.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, '.parallel-code', 'Dockerfile'), { recursive: true });

    const result = resolveProjectDockerfile(projectRoot);
    expect(result).toBeNull();
  });
});

describe('projectImageTag', () => {
  it('returns a tag in the format parallel-code-project:<12-char-hash>', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-tag-'));
    tempPaths.push(tmpDir);
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM node:20\nRUN echo hello\n');

    const tag = projectImageTag(dockerfilePath);
    expect(tag).toMatch(/^parallel-code-project:[a-f0-9]{12}$/);
  });

  it('returns parallel-code-project:unknown for non-existent Dockerfile path', () => {
    const tag = projectImageTag('/nonexistent/Dockerfile');
    expect(tag).toBe('parallel-code-project:unknown');
  });
});

describe('hashDockerfile', () => {
  it('returns a SHA-256 hex string for a real file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-hash-'));
    tempPaths.push(tmpDir);
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM ubuntu:22.04\n');

    const hash = hashDockerfile(dockerfilePath);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns null for a non-existent file', () => {
    const hash = hashDockerfile('/nonexistent/Dockerfile');
    expect(hash).toBeNull();
  });
});

describe('dockerImageExists', () => {
  it('fails closed when a custom dockerfile path is unreadable', async () => {
    mockExecFile.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: { encoding: string; timeout: number },
        callback: (err: Error | null, stdout: string) => void,
      ) => callback(null, 'stored-hash'),
    );

    await expect(
      dockerImageExists('parallel-code-project:test', {
        dockerfilePath: '/nonexistent/Dockerfile',
      }),
    ).resolves.toBe(false);
  });
});

describe('subscribeToAgentExit', () => {
  function lastProc(): ReturnType<typeof mockPtySpawn> {
    const results = mockPtySpawn.mock.results;
    return results[results.length - 1].value as ReturnType<typeof mockPtySpawn>;
  }

  it('fires once with { exitCode, signal, lastOutput } when the agent exits', () => {
    const win = createMockWindow();
    const args = buildSpawnArgs({ dockerMode: false, command: 'sh', args: [] });
    spawnAgent(win, args);
    const proc = lastProc();

    const calls: AgentExitInfo[] = [];
    const ok = subscribeToAgentExit(args.agentId, (info) => calls.push(info));
    expect(ok).toBe(true);

    proc.emitData('first line\nsecond line\n');
    proc.emitExit({ exitCode: 42, signal: undefined });

    expect(calls).toHaveLength(1);
    expect(calls[0].exitCode).toBe(42);
    expect(calls[0].signal).toBeNull();
    expect(calls[0].lastOutput).toEqual(['first line', 'second line']);
  });

  it('coerces a numeric exit signal to its string form', () => {
    const win = createMockWindow();
    const args = buildSpawnArgs({ dockerMode: false, command: 'sh', args: [] });
    spawnAgent(win, args);
    const proc = lastProc();

    const calls: AgentExitInfo[] = [];
    subscribeToAgentExit(args.agentId, (info) => calls.push(info));

    proc.emitExit({ exitCode: 0, signal: 15 });

    expect(calls[0].signal).toBe('15');
  });

  it('does not fire after unsubscribe', () => {
    const win = createMockWindow();
    const args = buildSpawnArgs({ dockerMode: false, command: 'sh', args: [] });
    spawnAgent(win, args);
    const proc = lastProc();

    const cb = vi.fn();
    subscribeToAgentExit(args.agentId, cb);
    unsubscribeFromAgentExit(args.agentId, cb);

    proc.emitExit({ exitCode: 0, signal: undefined });

    expect(cb).not.toHaveBeenCalled();
  });

  it('still fires the renderer Exit event alongside exit subscribers', () => {
    const win = createMockWindow();
    const args = buildSpawnArgs({
      dockerMode: false,
      command: 'sh',
      args: [],
      onOutput: { __CHANNEL_ID__: 'channel-x' },
    });
    spawnAgent(win, args);
    const proc = lastProc();

    const cb = vi.fn();
    subscribeToAgentExit(args.agentId, cb);

    proc.emitData('output\n');
    proc.emitExit({ exitCode: 0, signal: undefined });

    expect(cb).toHaveBeenCalledTimes(1);
    const sendMock = win.webContents.send as ReturnType<typeof vi.fn>;
    const exitSend = sendMock.mock.calls.find(
      ([, payload]) => (payload as { type?: string }).type === 'Exit',
    );
    expect(exitSend).toBeTruthy();
    if (!exitSend) return;
    expect(exitSend[1]).toMatchObject({
      type: 'Exit',
      data: { exit_code: 0, signal: null, last_output: ['output'] },
    });
  });

  it('returns false when subscribing to an unknown agent', () => {
    const ok = subscribeToAgentExit('no-such-agent', () => {});
    expect(ok).toBe(false);
  });

  it('fans out to multiple subscribers', () => {
    const win = createMockWindow();
    const args = buildSpawnArgs({ dockerMode: false, command: 'sh', args: [] });
    spawnAgent(win, args);
    const proc = lastProc();

    const calls: number[] = [];
    subscribeToAgentExit(args.agentId, () => calls.push(1));
    subscribeToAgentExit(args.agentId, () => calls.push(2));

    proc.emitExit({ exitCode: 0, signal: undefined });

    expect(calls.sort()).toEqual([1, 2]);
  });
});

describe('snapshotRunningAgents', () => {
  it('initialises lastDataAt to spawn time and stamps it on each onData event', () => {
    const before = Date.now();
    const agentId = 'agent-snapshot-stamp';
    spawnAgent(createMockWindow(), buildSpawnArgs({ agentId, dockerMode: false, isShell: false }));
    const after = Date.now();

    const initial = snapshotRunningAgents().find((s) => s.agentId === agentId);
    if (!initial) throw new Error('snapshot missing fresh agent');
    expect(initial.lastDataAt).toBeGreaterThanOrEqual(before);
    expect(initial.lastDataAt).toBeLessThanOrEqual(after);

    // Emit data and verify the timestamp advances.
    const proc = mockPtySpawn.mock.results[mockPtySpawn.mock.results.length - 1]
      ?.value as ReturnType<typeof mockPtySpawn>;
    const sleepUntil = Date.now() + 5;
    while (Date.now() <= sleepUntil) {
      // busy-wait so we cross at least one ms tick deterministically
    }
    proc.emitData('hi');
    const stamped = snapshotRunningAgents().find((s) => s.agentId === agentId);
    if (!stamped) throw new Error('snapshot lost agent after emit');
    expect(stamped.lastDataAt).toBeGreaterThan(initial.lastDataAt);
  });

  it('excludes shell sessions from the snapshot', () => {
    const shellId = 'agent-shell';
    const agentId = 'agent-real';
    spawnAgent(
      createMockWindow(),
      buildSpawnArgs({ agentId: shellId, dockerMode: false, isShell: true }),
    );
    spawnAgent(createMockWindow(), buildSpawnArgs({ agentId, dockerMode: false, isShell: false }));
    const ids = snapshotRunningAgents().map((s) => s.agentId);
    expect(ids).toContain(agentId);
    expect(ids).not.toContain(shellId);
  });

  it('drops sessions after their PTY exits', () => {
    const agentId = 'agent-exit';
    spawnAgent(createMockWindow(), buildSpawnArgs({ agentId, dockerMode: false, isShell: false }));
    expect(snapshotRunningAgents().some((s) => s.agentId === agentId)).toBe(true);

    const proc = mockPtySpawn.mock.results[mockPtySpawn.mock.results.length - 1]
      ?.value as ReturnType<typeof mockPtySpawn>;
    proc.emitExit({ exitCode: 0, signal: undefined });

    expect(snapshotRunningAgents().some((s) => s.agentId === agentId)).toBe(false);
  });
});

describe('buildDockerImage', () => {
  it('uses the provided build context for a project dockerfile', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-build-context-'));
    tempPaths.push(projectRoot);
    const dockerDir = path.join(projectRoot, '.parallel-code');
    fs.mkdirSync(dockerDir, { recursive: true });
    const dockerfilePath = path.join(dockerDir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, 'FROM node:20\n');

    buildDockerImage(createMockWindow(), 'channel:build-test', {
      dockerfilePath,
      imageTag: 'parallel-code-project:test',
      buildContext: projectRoot,
    } as unknown as Parameters<typeof buildDockerImage>[2]);

    const lastCall = mockChildProcessSpawn.mock.lastCall;
    expect(lastCall).toBeTruthy();
    const args = ((lastCall as unknown as [string, string[]])?.[1] ?? []) as string[];
    expect(args[args.length - 1]).toBe(projectRoot);
  });
});
