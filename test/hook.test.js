'use strict';

/**
 * SessionStart hook tests.
 *
 * The hook is spawned as a real child process and fed a hook payload on stdin,
 * exactly as the runtime does. The parser is not exported on purpose: the
 * regression worth guarding is an end-to-end one, where a WSL workspace path
 * silently fails to produce any output at all.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'session-start.mjs');

function runHook(payload) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('a WSL share workspace produces routing context', () => {
  // Regression: the regex expected backslashes but was tested against the
  // normalised forward-slash path, so it never matched and the hook stayed
  // silent on exactly the workspaces it exists for.
  const run = runHook({
    hook_event_name: 'SessionStart',
    cwd: '\\\\wsl.localhost\\kali-linux\\home\\xalgord\\project',
  });

  assert.strictEqual(run.status, 0, 'hook exits 0');
  assert.ok(run.stdout.trim() !== '', 'hook must emit context for a WSL share, stderr: ' + run.stderr);

  const parsed = JSON.parse(run.stdout);
  assert.strictEqual(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = parsed.hookSpecificOutput.additionalContext;
  assert.match(context, /kali-linux/, 'names the distro');
  assert.match(context, /\/home\/xalgord\/project/, 'maps the Linux path');
  assert.match(context, /wsl_exec/);
});

test('the distro is the share name, not the server name', () => {
  // Regression: segments[0] of //wsl.localhost/<distro>/... is the literal
  // string 'wsl.localhost', which was being reported as the distro.
  const run = runHook({
    hook_event_name: 'SessionStart',
    cwd: '\\\\wsl$\\Ubuntu\\home\\me',
  });
  const context = JSON.parse(run.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /Ubuntu/);
  assert.ok(!/distro:\s+wsl\.localhost/.test(context), 'does not report wsl.localhost as the distro');
});

test('a normal Windows workspace stays silent', () => {
  const run = runHook({ hook_event_name: 'SessionStart', cwd: 'C:\\Users\\me\\project' });
  assert.strictEqual(run.status, 0);
  assert.strictEqual(run.stdout, '', 'no output for a non-WSL workspace');
});

test('malformed input fails open without crashing', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
});