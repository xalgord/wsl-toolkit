#!/usr/bin/env node
/**
 * WSL Toolkit - SessionStart hook.
 *
 * Purpose: when the active turn workspace is a WSL network share
 * (\\wsl.localhost\<distro>\... or \\wsl$\<distro>\...), the built-in shell
 * tool is refused by the host safety policy. Without this hook the agent
 * discovers that only by hitting the error and retrying it.
 *
 * This hook performs no filesystem access and spawns no process. It only
 * inspects the `cwd` field of the hook input and, when the workspace is a
 * WSL share, injects the correct tool routing as additional context.
 *
 * Contract: local-plugin-hooks.md
 *   SessionStart output -> hookSpecificOutput.additionalContext
 *   No stdout in every other case, exit code 0.
 */

import process from 'node:process';

// Applied to the normalised, forward-slash form of the path. Matching the
// backslash form here is a bug: `\\wsl.localhost\...` is normalised to
// `//wsl.localhost/...` before this runs, so a backslash pattern never fires
// and the hook silently never injects anything.
const UNC_WSL = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i;
const MAX_INPUT_BYTES = 1024 * 1024;

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;

    const finish = () => {
      if (!done) {
        done = true;
        resolve(raw);
      }
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_INPUT_BYTES) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

function parse(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;

  // Test the normalised forward-slash form. For
  // \\wsl.localhost\kali-linux\home\user the captures are
  // 1 = 'kali-linux' (the distro, not the server name) and 2 = '/home/user'.
  const match = UNC_WSL.exec(cwd.replace(/\\/g, '/'));
  if (!match) return null;

  return {
    distro: match[1],
    linuxPath: match[2] || '/',
    windowsPath: cwd,
  };
}

function buildContext(info) {
  return [
    'This session workspace is a WSL network share, so the built-in shell tool is',
    'refused by the host safety policy. Do not retry it and do not report it as a',
    'missing permission - retrying cannot succeed while the workspace stays on a',
    'network share.',
    '',
    'Workspace mapping:',
    '  distro:   ' + info.distro,
    '  linux:    ' + info.linuxPath,
    '',
    'Use the wsl-toolkit MCP tools for everything inside the distro:',
    '  wsl_exec  - run a shell command and get stdout, stderr and the exit code',
    '  wsl_read  - read a file, optionally a line range',
    '  wsl_write - create or overwrite a file',
    '  wsl_edit  - exact string replacement inside a file',
    '  wsl_list  - list a directory, optionally recursive',
    '  wsl_delete - delete a file or directory, recoverable by default',
    '  wsl_info  - list distros and map Windows paths to Linux paths',
    '',
    'These tools accept Linux paths directly, and also accept Windows UNC paths',
    'such as the workspace path above, translating them automatically.',
    'Built-in file tools remain correct for Windows-side paths outside the share.',
  ].join('\n');
}

async function main() {
  const raw = await readStdin();

  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const info = parse(input && input.cwd);
  if (!info) {
    process.exit(0);
  }

  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: buildContext(info),
    },
  };

  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});