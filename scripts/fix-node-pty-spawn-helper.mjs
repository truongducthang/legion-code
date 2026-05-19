import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import process from 'process';

// Platform-specific node-pty fixups applied automatically after `npm install`.
//
// macOS: some npm cache restores strip the +x bit from the prebuilt
// spawn-helper binary, which then makes unixTerminal.js fail to launch it.
// Re-add 0755 so the spawn path keeps working.
//
// Windows: node-pty's ConPTY kill path forks `conpty_console_list_agent.js`
// to query the console process list before killing the PTY. The agent calls
// the native `getConsoleProcessList`, which internally calls Win32
// `AttachConsole`. When the shell process is already gone (or another
// console is already attached), AttachConsole throws — the forked agent
// crashes with heap corruption and *takes the parent Electron process with
// it* (exit code 0xC0000374 / 3221226356). Wrap the call in try/catch and
// fall back to `[shellPid]` so node-pty's kill flow completes cleanly.
//
// The Windows project officially targets macOS and Linux (see CLAUDE.md),
// so this patch is a dev-experience fix rather than a supported runtime.

if (process.platform === 'darwin') {
  const helperPath = join(
    process.cwd(),
    'node_modules',
    'node-pty',
    'prebuilds',
    `darwin-${process.arch}`,
    'spawn-helper',
  );

  if (existsSync(helperPath)) {
    chmodSync(helperPath, 0o755);
  }
}

if (process.platform === 'win32') {
  const agentPath = join(
    process.cwd(),
    'node_modules',
    'node-pty',
    'lib',
    'conpty_console_list_agent.js',
  );

  if (existsSync(agentPath)) {
    const src = readFileSync(agentPath, 'utf8');
    const PATCH_MARKER = '/* pcode-patched-attach-console */';
    if (!src.includes(PATCH_MARKER)) {
      const ORIGINAL = 'var consoleProcessList = getConsoleProcessList(shellPid);';
      const REPLACEMENT = [
        `var consoleProcessList; ${PATCH_MARKER}`,
        'try { consoleProcessList = getConsoleProcessList(shellPid); }',
        'catch (e) { consoleProcessList = [shellPid]; }',
      ].join('\n');
      if (src.includes(ORIGINAL)) {
        writeFileSync(agentPath, src.replace(ORIGINAL, REPLACEMENT), 'utf8');
      }
    }
  }
}
