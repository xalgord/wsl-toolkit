'use strict';

/**
 * WSL Toolkit server tests. Zero dependencies, run with the built-in runner:
 *
 *   node --test test/
 *
 * The pure helpers are covered exhaustively because they are where the real
 * bugs lived: path translation, `..` normalisation and shell quoting all sit
 * on the boundary between untrusted input and a running shell.
 */

const test = require('node:test');
const assert = require('node:assert');

const server = require('../servers/wsl-server.js');

const {
  toLinuxPath,
  normaliseLinuxPath,
  distroFromPath,
  isProtectedPath,
  resolveTarget,
  singleQuote,
  handleMessage,
  TOOLS,
} = server;

test('toLinuxPath leaves Linux paths untouched', () => {
  assert.strictEqual(toLinuxPath('/etc/wsl.conf'), '/etc/wsl.conf');
  assert.strictEqual(toLinuxPath('/home/user'), '/home/user');
  assert.strictEqual(toLinuxPath('/'), '/');
});

test('toLinuxPath translates WSL UNC paths in both separator styles', () => {
  const backslash = '\\\\wsl.localhost\\kali-linux\\home\\user\\project';
  const forward = '//wsl.localhost/kali-linux/home/user/project';
  assert.strictEqual(toLinuxPath(backslash), '/home/user/project');
  assert.strictEqual(toLinuxPath(forward), '/home/user/project');
  assert.strictEqual(toLinuxPath('\\\\wsl$\\Ubuntu\\home\\me'), '/home/me');
  assert.strictEqual(toLinuxPath('//wsl.localhost/kali-linux'), '/');
});

test('toLinuxPath translates Windows drive paths', () => {
  // Regression: the original pattern required a leading slash, so `C:/...`
  // never matched and Windows paths were handed to bash unchanged.
  assert.strictEqual(toLinuxPath('C:\\Users\\me\\file.txt'), '/mnt/c/Users/me/file.txt');
  assert.strictEqual(toLinuxPath('C:/Users/me/file.txt'), '/mnt/c/Users/me/file.txt');
  assert.strictEqual(toLinuxPath('d:\\work'), '/mnt/d/work');
  assert.strictEqual(toLinuxPath('C:'), '/mnt/c');
});

test('normaliseLinuxPath collapses . and ..', () => {
  assert.strictEqual(normaliseLinuxPath('/etc/'), '/etc');
  assert.strictEqual(normaliseLinuxPath('/tmp/../etc'), '/etc');
  assert.strictEqual(normaliseLinuxPath('/a/b/../c'), '/a/c');
  assert.strictEqual(normaliseLinuxPath('/a/b/../../..'), '/');
  assert.strictEqual(normaliseLinuxPath('/home/user'), '/home/user');
  assert.strictEqual(normaliseLinuxPath('relative/path'), '/relative/path');
});

test('distroFromPath reads the distro out of a UNC path', () => {
  assert.strictEqual(distroFromPath('\\\\wsl.localhost\\kali-linux\\home'), 'kali-linux');
  assert.strictEqual(distroFromPath('//wsl$/Ubuntu/home'), 'Ubuntu');
  assert.strictEqual(distroFromPath('/etc/passwd'), undefined);
});

test('resolveTarget normalises and infers the distro together', () => {
  const target = resolveTarget({ path: '\\\\wsl.localhost\\kali-linux\\tmp\\..\\etc\\hosts' });
  assert.strictEqual(target.linuxPath, '/etc/hosts');
  assert.strictEqual(target.distro, 'kali-linux');
});

test('the deletion guard survives .. traversal', () => {
  // Regression: the guard compared the raw path, so /tmp/../etc slipped past
  // the protected list and would have deleted /etc.
  assert.strictEqual(isProtectedPath(normaliseLinuxPath('/tmp/../etc')), true);
  assert.strictEqual(isProtectedPath(normaliseLinuxPath('/var/../etc')), true);
  assert.strictEqual(isProtectedPath(normaliseLinuxPath('/')), true);
  assert.strictEqual(isProtectedPath(normaliseLinuxPath('/tmp/scratch')), false);
});

test('singleQuote escapes embedded single quotes', () => {
  assert.strictEqual(singleQuote('/tmp/a'), "'/tmp/a'");
  assert.strictEqual(singleQuote("/tmp/it's"), "'/tmp/it'\\''s'");
  // A path that tries to break out of its quoting must stay inert.
  const hostile = singleQuote("/tmp/a'; rm -rf /; echo '");
  assert.ok(hostile.startsWith("'") && hostile.endsWith("'"));
  assert.ok(hostile.includes("'\\''"));
});

test('readScript embeds the path and keeps it quoted', () => {
  const script = server.readScript('/tmp/example.txt');
  assert.ok(script.includes("P='/tmp/example.txt'"));
  assert.ok(script.includes('"$P"'));
});

test('the tool list advertises the real default timeout', () => {
  // Regression: the description claimed 120000 while the code used 25000.
  const exec = TOOLS.find((t) => t.name === 'wsl_exec');
  assert.ok(exec, 'wsl_exec is advertised');
  assert.match(
    exec.inputSchema.properties.timeout_ms.description,
    /Default 25000/,
    'advertised default timeout matches DEFAULT_TIMEOUT_MS'
  );
});

test('all seven tools are advertised with a schema', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepStrictEqual(names, [
    'wsl_delete',
    'wsl_edit',
    'wsl_exec',
    'wsl_info',
    'wsl_list',
    'wsl_read',
    'wsl_write',
  ]);
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.description.length > 10, tool.name + ' has a description');
    assert.strictEqual(tool.inputSchema.type, 'object', tool.name + ' takes an object');
  }
});

test('initialize and tools/list answer correctly', () => {
  const init = handleMessage({ id: 1, method: 'initialize', params: {} });
  assert.strictEqual(init.result.protocolVersion, '2024-11-05');
  assert.strictEqual(init.result.serverInfo.name, 'wsl-toolkit');

  const list = handleMessage({ id: 2, method: 'tools/list', params: {} });
  assert.strictEqual(list.result.tools.length, 7);

  const unknown = handleMessage({ id: 3, method: 'tools/call', params: { name: 'nope' } });
  assert.strictEqual(unknown.result.isError, true);
});

test('wsl_exec with a cwd does not throw', () => {
  // Regression: `const script = command` was reassigned when cwd was supplied,
  // which raised "Assignment to constant variable" and broke every cwd call.
  // A TypeError here means the bug is back.
  const outcome = handleMessage({
    id: 4,
    method: 'tools/call',
    params: { name: 'wsl_exec', arguments: { command: 'pwd', cwd: '/tmp' } },
  });

  const text = outcome.result.content[0].text;
  assert.ok(
    !/Assignment to constant variable/i.test(text),
    'wsl_exec must not raise a TypeError when cwd is supplied, got: ' + text
  );
  assert.ok(!/\bTypeError\b/.test(text), 'no TypeError leaked into the tool result: ' + text);
});