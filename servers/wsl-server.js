#!/usr/bin/env node
'use strict';

/**
 * WSL Toolkit - MCP server (stdio, zero dependencies).
 *
 * Purpose: the built-in shell tool is refused when the active turn workspace is
 * a WSL network share (\\wsl.localhost\...). This server gives the agent a real
 * path into the distro by shelling out to wsl.exe from the Windows host and
 * returning structured results over MCP.
 *
 * Design rules:
 *  - No npm dependencies, only Node.js built-ins, so it starts anywhere.
 *  - Scripts are delivered on stdin to `bash -s`, never as a `-c` argument, and
 *    file content travels inside the script as base64. See callWsl for why.
 *  - Values are embedded in the script with single-quote escaping. Nothing
 *    user-controlled reaches the shell unescaped, so quoting and injection
 *    bugs are structurally impossible.
 *  - Deletion is recoverable by default: files move to
 *    ~/.local/share/Trash/wsl-toolkit/ and the restore command is returned.
 *
 * Invocation: wsl.exe [-d <distro>] -- bash -c <script>
 */

const { spawnSync } = require('node:child_process');

const SERVER_NAME = 'wsl-toolkit';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const WSL = 'wsl.exe';
// Kept below the MCP request budget on purpose. When an operation runs long the
// server must return its own actionable error rather than letting the client
// time out with no explanation. Callers that genuinely need longer pass an
// explicit timeout_ms.
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_TIMEOUT_MS = 900000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 60000;
const MAX_EDIT_BYTES = 8 * 1024 * 1024;
const TRASH_SUBDIR = '.local/share/Trash/wsl-toolkit';
const NUL = String.fromCharCode(0);

// Critical system paths that must never be deleted through this server.
const PROTECTED_PATHS = [
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text, isError) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: Boolean(isError),
  };
}

function clip(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.length <= MAX_OUTPUT_CHARS) {
    return { text: text, truncated: false, length: text.length };
  }
  return {
    text: text.slice(0, MAX_OUTPUT_CHARS),
    truncated: true,
    length: text.length,
  };
}

function singleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Windows UNC or drive path to Linux path. Linux input is returned unchanged.
 *
 * Both separator styles are accepted because callers pass raw Windows paths.
 * The drive-letter branch deliberately has no leading slash: after
 * normalisation `C:\Users\me` is `C:/Users/me`, which does not start with `/`.
 */
function toLinuxPath(value) {
  if (typeof value !== 'string' || value === '') return undefined;

  const unified = value.replace(/\\/g, '/');
  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i.exec(unified);
  if (unc) {
    const rest = unc[2] || '/';
    if (rest === '/') return '/';
    return rest.replace(/\/+$/, '');
  }

  const drive = /^([a-zA-Z]):(?:\/(.*))?$/.exec(unified);
  if (drive) {
    const tail = drive[2] || '';
    return tail === '' ? '/mnt/' + drive[1].toLowerCase() : '/mnt/' + drive[1].toLowerCase() + '/' + tail;
  }

  return unified;
}

/**
 * Collapse `.` and `..` lexically.
 *
 * This matters for the deletion guard: without it `/tmp/../etc` fails the
 * protected-path check and would happily delete `/etc`. This is a lexical
 * normalisation only, it does not resolve symlinks, so it is a correctness
 * guard rather than a security boundary.
 */
function normaliseLinuxPath(value) {
  const absolute = String(value).charAt(0) === '/' ? String(value) : '/' + value;
  const out = [];
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

/** Distro name encoded in a Windows UNC path, if any. */
function distroFromPath(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  const unc = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)/i.exec(value.replace(/\\/g, '/'));
  return unc ? unc[1] : undefined;
}

function resolveTarget(args) {
  const raw = args && typeof args.path === 'string' ? args.path.trim() : '';
  const converted = toLinuxPath(raw);
  const linuxPath = converted === undefined ? undefined : normaliseLinuxPath(converted);
  const distro =
    (typeof args.distro === 'string' && args.distro.trim()) ||
    distroFromPath(raw) ||
    process.env.WSL_DEFAULT_DISTRO ||
    undefined;
  return { raw: raw, linuxPath: linuxPath, distro: distro };
}

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(parsed), MAX_TIMEOUT_MS);
}

function runWsl(argv, options) {
  const opts = options || {};
  const env = Object.assign({}, process.env);
  if (opts.env) {
    for (const key of Object.keys(opts.env)) env[key] = String(opts.env[key]);
  }

  const result = spawnSync(WSL, argv, {
    input: opts.input === undefined ? '' : opts.input,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    env: env,
  });

  return {
    ok: !result.error && result.status === 0,
    status: typeof result.status === 'number' ? result.status : -1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : '',
    signal: result.signal || '',
  };
}

/**
 * Run a shell script inside the distro.
 *
 * The script is delivered on stdin and executed with `bash -s`. This is the
 * only delivery method that works reliably from a Windows host process.
 *
 * `wsl.exe -- bash -c SCRIPT` does not survive. wsl.exe hands that argument to
 * the distro's *default login shell*, which parses the script text itself. On
 * Kali that shell is zsh, so `$VAR` and `$(...)` are expanded by zsh before bash
 * sees them, and a multi-line script gets split across separate shell commands,
 * leaving only the first line to run as `bash -c`.
 *
 * Observed directly: `P='/tmp/x'` followed by `echo "P=[$P]"` printed `P=[]`,
 * and `echo "zero=[$0]"` returned `/usr/bin/zsh`, which proves the script ran in
 * zsh rather than in the bash it was meant to be given to. Environment variables
 * are not forwarded either, so neither transport works.
 *
 * stdin, by contrast, is forwarded intact, and `bash -s` reads its program from
 * stdin, so bash parses the script exactly as written.
 */
function callWsl(options) {
  const opts = options || {};
  const argv = [];
  if (opts.distro) argv.push('-d', opts.distro);
  argv.push('--', 'bash', '-s');

  const shared = { input: opts.script, timeoutMs: opts.timeoutMs };
  let result = runWsl(argv, shared);

  const noBash = /bash:\s*(not found|No such file)|executable file not found/i.test(result.stderr);
  if (!result.ok && noBash) {
    result = runWsl(argv.slice(0, argv.length - 2).concat(['sh', '-s']), shared);
  }

  return result;
}

/** wsl.exe --list emits UTF-16LE on several Windows builds. Normalise it. */
function normaliseListOutput(text) {
  if (typeof text !== 'string' || text === '') return '';
  if (text.indexOf(NUL) === -1) return text;
  try {
    return Buffer.from(text, 'latin1').toString('utf16le').split(NUL).join('');
  } catch (error) {
    return text;
  }
}

/** Turn a failed run into a message that says what to do next. */
function describeFailure(result) {
  if (result.error) {
    if (/ETIMEDOUT/i.test(result.error) || result.signal === 'SIGTERM') {
      return 'timed out and was killed after the default 25s. Retry with an explicit timeout_ms, ' +
        'up to 900000. Very large directories and slow disks are the usual cause; narrow the ' +
        'path or lower max_depth.';
    }
    if (/ENOENT/i.test(result.error)) {
      return 'wsl.exe was not found on PATH. WSL Toolkit runs on the Windows host, so WSL itself ' +
        'must be installed and enabled.';
    }
    return result.error;
  }
  return result.stderr.trim() || 'unknown error';
}

function formatExecution(result, meta) {
  const lines = [];
  lines.push('exit_code: ' + result.status);

  if (meta && meta.distro) lines.push('distro: ' + meta.distro);
  if (meta && meta.cwd) lines.push('cwd: ' + meta.cwd);

  if (result.error) {
    const hint = /ENOENT/i.test(result.error)
      ? 'wsl.exe was not found on PATH. WSL Toolkit runs on the Windows host, so WSL itself must be installed and enabled.'
      : result.error;
    lines.push('spawn_error: ' + hint);
  }

  const out = clip(result.stdout.trim());
  const err = clip(result.stderr.trim());

  lines.push('', '--- stdout ---');
  lines.push(out.text === '' ? '(empty)' : out.text);
  if (out.truncated) {
    lines.push('[truncated: ' + out.length + ' characters total]');
  }

  if (err.text !== '') {
    lines.push('', '--- stderr ---');
    lines.push(err.text);
    if (err.truncated) {
      lines.push('[truncated: ' + err.length + ' characters total]');
    }
  }

  return textResult(lines.join('\n'), !result.ok);
}

// ---------------------------------------------------------------------------
// Shared shell fragments
// ---------------------------------------------------------------------------

function readScript(pathValue) {
  return [
    'P=' + singleQuote(pathValue),
    'if [ ! -e "$P" ]; then echo "path does not exist: $P" >&2; exit 2; fi',
    'if [ -d "$P" ]; then echo "path is a directory, use wsl_list: $P" >&2; exit 3; fi',
    "base64 < \"$P\" | tr -d '\\n'",
  ].join('\n');
}

function readFileInDistro(target, timeoutMs) {
  return callWsl({
    distro: target.distro,
    script: readScript(target.linuxPath),
    timeoutMs: timeoutMs,
  });
}

function decodeBase64Payload(result) {
  return Buffer.from(result.stdout.replace(/\s+/g, ''), 'base64');
}

function writeFileInDistro(target, content, mode, timeoutMs) {
  // stdin now carries the script itself, so file content travels inside the
  // script as base64. Base64 is alphanumeric plus / and =, which needs no
  // escaping at all and survives any shell untouched.
  const encoded = Buffer.from(content, 'utf8').toString('base64');

  const script = [
    'set -e',
    'P=' + singleQuote(target.linuxPath),
    'M=' + singleQuote(mode),
    'if [ "$M" = "create" ] && [ -e "$P" ]; then',
    '  echo "file already exists: $P" >&2; exit 4;',
    'fi',
    'D="$(dirname -- "$P")"',
    'mkdir -p "$D"',
    'if [ "$M" = "append" ]; then',
    '  printf %s ' + singleQuote(encoded) + ' | base64 -d >> "$P"',
    'else',
    // Write to a sibling temp file and rename over the target. A rename
    // inside one filesystem is atomic, so an interrupted or failed write
    // can never leave a truncated or half-written file behind.
    '  T="$D/.wsltk.tmp.$$"',
    '  printf %s ' + singleQuote(encoded) + ' | base64 -d > "$T"',
    '  if [ -e "$P" ]; then chmod --reference="$P" "$T" 2>/dev/null || true; fi',
    '  mv -f "$T" "$P"',
    'fi',
    'wc -c < "$P"',
  ].join('\n');

  return callWsl({
    distro: target.distro,
    script: script,
    timeoutMs: timeoutMs,
  });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleExec(args) {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) {
    return textResult('wsl_exec: "command" is required and must be a non-empty string.', true);
  }

  const cwd = args.cwd ? toLinuxPath(String(args.cwd)) : undefined;
  const distro =
    (typeof args.distro === 'string' && args.distro.trim()) ||
    distroFromPath(args.cwd) ||
    process.env.WSL_DEFAULT_DISTRO ||
    undefined;

  let script = command;
  if (cwd) {
    script = 'cd ' + singleQuote(cwd) + ' || exit 1\n' + command;
  }

  const result = callWsl({
    distro: distro,
    script: script,
    timeoutMs: clampTimeout(args.timeout_ms),
  });

  return formatExecution(result, { distro: distro, cwd: cwd });
}

function handleRead(args) {
  const target = resolveTarget(args);
  if (!target.linuxPath) {
    return textResult('wsl_read: "path" is required.', true);
  }

  const result = readFileInDistro(target, clampTimeout(args.timeout_ms));
  if (!result.ok) {
    return textResult(
      'wsl_read failed for ' + target.linuxPath + '\n' + describeFailure(result),
      true
    );
  }

  const buffer = decodeBase64Payload(result);
  const allLines = buffer.toString('utf8').split('\n');
  const total = allLines.length;

  const startLine = Math.max(1, Math.floor(Number(args.start_line) || 1));
  const endLineRaw = Number(args.end_line);
  const endLine = Number.isFinite(endLineRaw) && endLineRaw > 0 ? Math.min(total, Math.floor(endLineRaw)) : total;

  if (startLine > total) {
    return textResult(
      'wsl_read: start_line ' + startLine + ' is past the end of ' + target.linuxPath + ' (' + total + ' lines).',
      true
    );
  }

  const body = allLines.slice(startLine - 1, endLine).join('\n');
  const header =
    'path: ' + target.linuxPath +
    '\nbytes: ' + buffer.length +
    '\nlines: ' + startLine + '-' + endLine + ' of ' + total;

  return textResult(header + '\n---\n' + body);
}

function handleWrite(args) {
  const target = resolveTarget(args);
  if (!target.linuxPath) {
    return textResult('wsl_write: "path" is required.', true);
  }

  const mode = ['overwrite', 'append', 'create'].indexOf(args.mode) !== -1 ? args.mode : 'overwrite';
  const content = typeof args.content === 'string' ? args.content : '';
  const result = writeFileInDistro(target, content, mode, clampTimeout(args.timeout_ms));

  if (!result.ok) {
    return textResult(
      'wsl_write failed for ' + target.linuxPath + '\n' + describeFailure(result),
      true
    );
  }

  const written = Number(result.stdout.trim());
  return textResult(
    'wrote ' + target.linuxPath +
    '\nmode: ' + mode +
    '\nbytes: ' + (Number.isFinite(written) ? written : Buffer.byteLength(content, 'utf8'))
  );
}

function handleEdit(args) {
  const target = resolveTarget(args);
  if (!target.linuxPath) {
    return textResult('wsl_edit: "path" is required.', true);
  }

  const oldString = typeof args.old_string === 'string' ? args.old_string : '';
  const newString = typeof args.new_string === 'string' ? args.new_string : '';

  if (oldString === '') {
    return textResult('wsl_edit: "old_string" is required and must not be empty.', true);
  }

  const replaceAll = args.replace_all === true;
  const readResult = readFileInDistro(target, clampTimeout(args.timeout_ms));

  if (!readResult.ok) {
    return textResult(
      'wsl_edit could not read ' + target.linuxPath + '\n' + describeFailure(readResult),
      true
    );
  }

  const buffer = decodeBase64Payload(readResult);
  if (buffer.length > MAX_EDIT_BYTES) {
    return textResult(
      'wsl_edit refuses files larger than ' + MAX_EDIT_BYTES + ' bytes, this one is ' + buffer.length +
      '. Use wsl_exec with a streaming command for very large files.',
      true
    );
  }

  const original = buffer.toString('utf8');
  const occurrences = original.split(oldString).length - 1;

  if (occurrences === 0) {
    return textResult(
      'wsl_edit: old_string was not found in ' + target.linuxPath + '. Read the file again before retrying.',
      true
    );
  }

  if (occurrences > 1 && !replaceAll) {
    return textResult(
      'wsl_edit: old_string appears ' + occurrences + ' times in ' + target.linuxPath +
      '. Pass replace_all: true, or include more surrounding context to make it unique.',
      true
    );
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);

  const writeResult = writeFileInDistro(target, updated, 'overwrite', clampTimeout(args.timeout_ms));
  if (!writeResult.ok) {
    return textResult(
      'wsl_edit matched but failed to write ' + target.linuxPath + '\n' + describeFailure(writeResult),
      true
    );
  }

  return textResult(
    'edited ' + target.linuxPath +
    '\nreplacements: ' + (replaceAll ? occurrences : 1) +
    '\nbytes before: ' + buffer.length +
    '\nbytes after: ' + Buffer.byteLength(updated, 'utf8')
  );
}

function isProtectedPath(path) {
  return PROTECTED_PATHS.indexOf(path) !== -1;
}

function handleDelete(args) {
  const target = resolveTarget(args);
  if (!target.linuxPath) {
    return textResult('wsl_delete: "path" is required.', true);
  }

  const path = target.linuxPath.replace(/\/+$/, '') || '/';
  const permanent = args.permanent === true;
  const recursive = args.recursive === true;

  if (isProtectedPath(path)) {
    return textResult(
      'wsl_delete refused: ' + path + ' is a protected system path. Delete a specific child instead.',
      true
    );
  }

  const script = [
    'set -e',
    'P=' + singleQuote(path),
    'PERM=' + singleQuote(permanent ? '1' : '0'),
    'REC=' + singleQuote(recursive ? '1' : '0'),
    'if [ ! -e "$P" ] && [ ! -L "$P" ]; then',
    '  echo "path does not exist: $P" >&2; exit 2;',
    'fi',
    'if [ "$PERM" = "1" ]; then',
    '  if [ -d "$P" ] && [ "$REC" != "1" ]; then',
    '    echo "target is a directory, pass recursive: true" >&2; exit 5;',
    '  fi',
    '  rm -rf -- "$P"',
    '  echo "PERMANENT"',
    '  exit 0',
    'fi',
    'TRASH="$HOME/' + TRASH_SUBDIR + '"',
    'mkdir -p "$TRASH"',
    'STAMP=$(date +%Y%m%d-%H%M%S)',
    'BASE=$(basename -- "$P")',
    'DEST="$TRASH/$STAMP-$BASE"',
    'N=1',
    'while [ -e "$DEST" ]; do DEST="$TRASH/$STAMP-$BASE.$N"; N=$((N+1)); done',
    'mv -- "$P" "$DEST"',
    'echo "$DEST"',
  ].join('\n');

  const result = callWsl({
    distro: target.distro,
    script: script,
    timeoutMs: clampTimeout(args.timeout_ms),
  });

  if (!result.ok) {
    return textResult(
      'wsl_delete failed for ' + path + '\n' + describeFailure(result),
      true
    );
  }

  const destination = result.stdout.trim();
  if (destination === 'PERMANENT') {
    return textResult('permanently deleted ' + path + '\nThis cannot be restored.');
  }

  return textResult(
    'moved to trash: ' + destination +
    '\nrestore with: mv ' + singleQuote(destination) + ' ' + singleQuote(path) +
    '\nempty the trash with: rm -rf -- "$HOME/' + TRASH_SUBDIR + '"'
  );
}

function handleList(args) {
  const target = resolveTarget(args);
  if (!target.linuxPath) {
    return textResult('wsl_list: "path" is required.', true);
  }

  const depth = Math.min(Math.max(Math.floor(Number(args.max_depth) || 1), 1), 8);
  const showHidden = args.show_hidden === true;

  const script = [
    'set -e',
    'P=' + singleQuote(target.linuxPath),
    'D=' + singleQuote(String(depth)),
    'H=' + singleQuote(showHidden ? '1' : '0'),
    'if [ ! -d "$P" ]; then',
    '  echo "not a directory: $P, use wsl_read for files" >&2; exit 2;',
    'fi',
    'if [ "$D" -le 1 ]; then',
    '  if [ "$H" = "1" ]; then',
    '    ls -la --time-style=long-iso "$P" 2>/dev/null || ls -la "$P";',
    '  else',
    '    ls -l --time-style=long-iso "$P" 2>/dev/null || ls -l "$P";',
    '  fi',
    'else',
    '  find "$P" -maxdepth "$D"',
    'fi',
  ].join('\n');

  const result = callWsl({
    distro: target.distro,
    script: script,
    timeoutMs: clampTimeout(args.timeout_ms),
  });

  if (!result.ok) {
    return textResult(
      'wsl_list failed for ' + target.linuxPath + '\n' + describeFailure(result),
      true
    );
  }

  let body = result.stdout.replace(/\n$/, '');
  if (!showHidden && depth > 1) {
    const prefix = target.linuxPath + '/';
    body = body
      .split('\n')
      .filter((line) => {
        if (line === target.linuxPath || line.indexOf(prefix) !== 0) return true;
        // Test every remaining path component, not just the first one. A
        // hidden file nested below a visible directory is still hidden.
        return !line
          .slice(prefix.length)
          .split('/')
          .some((part) => part.length > 1 && part.charAt(0) === '.');
      })
      .join('\n');
  }

  const out = clip(body);
  const header =
    'path: ' + target.linuxPath +
    '\ndepth: ' + depth +
    '\nhidden: ' + (showHidden ? 'included' : 'excluded');

  return textResult(
    header + '\n---\n' + (out.text === '' ? '(empty)' : out.text) +
    (out.truncated ? '\n[truncated: ' + out.length + ' characters total]' : '')
  );
}

function handleInfo(args) {
  const lines = [];
  const windowsCwd = typeof args.windows_cwd === 'string' ? args.windows_cwd : undefined;

  const listed = runWsl(['--list', '--quiet'], { timeoutMs: 15000 });
  const distros = normaliseListOutput(listed.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.charAt(0) !== '*');

  const verbose = runWsl(['--list', '--verbose'], { timeoutMs: 15000 });
  const states = normaliseListOutput(verbose.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  lines.push('distros:');
  if (distros.length === 0) {
    lines.push('  (none reported by wsl.exe' + (listed.error ? ': ' + listed.error : '') + ')');
  } else {
    for (const line of distros) lines.push('  ' + line);
  }

  if (states.length > 0) {
    lines.push('', 'status:');
    for (const line of states) lines.push('  ' + line);
  }

  const environment = callWsl({
    script: [
      'echo "user:   $(id -un)"',
      'echo "home:   $HOME"',
      'echo "pwd:    $(pwd)"',
      'echo "kernel: $(uname -sr)"',
      'echo "shell:  $SHELL"',
      'if [ -r /etc/os-release ]; then echo "os:     $(. /etc/os-release && echo "$PRETTY_NAME")"; fi',
    ].join('\n'),
    timeoutMs: 15000,
  });

  if (environment.ok) {
    lines.push('', 'default environment:');
    for (const line of environment.stdout.trim().split('\n')) lines.push('  ' + line);
  } else {
    lines.push('', 'default environment: unavailable (' + (environment.stderr.trim() || environment.error || 'unknown') + ')');
  }

  if (windowsCwd) {
    lines.push('', 'path mapping:');
    lines.push('  windows: ' + windowsCwd);
    lines.push('  linux:   ' + (toLinuxPath(windowsCwd) || '(not inside WSL or /mnt)'));
    const inferred = distroFromPath(windowsCwd);
    if (inferred) lines.push('  distro:  ' + inferred);
  }

  return textResult(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'wsl_exec',
    description:
      'Run a shell command inside a Windows Subsystem for Linux distro and return stdout, stderr and the exit code. ' +
      'Use this instead of the built-in shell when the workspace is a WSL share or a Linux path is involved.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run, executed by bash -c inside the distro. Example: df -h /',
        },
        distro: {
          type: 'string',
          description: 'WSL distro name. Defaults to the default distro, or to WSL_DEFAULT_DISTRO when set.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory. Accepts a Linux path or a Windows UNC path under a WSL share.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Kill the command after this many milliseconds. Default 25000, maximum 900000. ' +
            'Very large directories and slow disks are the usual cause of a timeout.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'wsl_read',
    description: 'Read a file inside a WSL distro. Returns decoded UTF-8 text with the byte count and line range.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute Linux path, or a Windows UNC path under a WSL share.' },
        distro: { type: 'string', description: 'WSL distro name. Inferred from a UNC path when possible.' },
        start_line: { type: 'number', description: 'First line to return, 1-based and inclusive.' },
        end_line: { type: 'number', description: 'Last line to return, 1-based and inclusive.' },
        timeout_ms: { type: 'number', description: 'Kill the operation after this many milliseconds.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'wsl_write',
    description:
      'Create or overwrite a file inside a WSL distro, creating parent directories as needed. ' +
      'Content is transferred over stdin, so no shell quoting or escaping is involved.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute Linux path, or a Windows UNC path under a WSL share.' },
        content: { type: 'string', description: 'Full file content to write.' },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append', 'create'],
          description: 'overwrite (default), append, or create which fails when the file already exists.',
        },
        distro: { type: 'string', description: 'WSL distro name.' },
        timeout_ms: { type: 'number', description: 'Kill the operation after this many milliseconds.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'wsl_edit',
    description:
      'Replace an exact string inside a file in a WSL distro. Fails when old_string is absent or ambiguous, ' +
      'unless replace_all is true. Reports the number of replacements and the byte count before and after.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute Linux path, or a Windows UNC path under a WSL share.' },
        old_string: { type: 'string', description: 'Exact text to replace. Must not be empty.' },
        new_string: { type: 'string', description: 'Replacement text. An empty string deletes the match.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
        distro: { type: 'string', description: 'WSL distro name.' },
        timeout_ms: { type: 'number', description: 'Kill the operation after this many milliseconds.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'wsl_list',
    description: 'List a directory inside a WSL distro, optionally recursive up to 8 levels.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute Linux directory path, or a Windows UNC path under a WSL share.' },
        show_hidden: { type: 'boolean', description: 'Include dotfiles. Default false.' },
        max_depth: { type: 'number', description: 'Recursion depth, 1 to 8. Default 1.' },
        distro: { type: 'string', description: 'WSL distro name.' },
        timeout_ms: { type: 'number', description: 'Kill the operation after this many milliseconds.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'wsl_delete',
    description:
      'Delete a file or directory in a WSL distro. Recoverable by default: the target moves to ' +
      '~/.local/share/Trash/wsl-toolkit and the restore command is returned. Protected system paths are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute Linux path, or a Windows UNC path under a WSL share.' },
        recursive: { type: 'boolean', description: 'Required to delete a directory.' },
        permanent: { type: 'boolean', description: 'Delete irreversibly instead of moving to trash. Default false.' },
        distro: { type: 'string', description: 'WSL distro name.' },
        timeout_ms: { type: 'number', description: 'Kill the operation after this many milliseconds.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'wsl_info',
    description:
      'List WSL distros and their state, report the default environment, and map a Windows path to its Linux path.',
    inputSchema: {
      type: 'object',
      properties: {
        windows_cwd: {
          type: 'string',
          description: 'Optional Windows path to translate, for example a workspace path under a WSL share.',
        },
      },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  wsl_exec: handleExec,
  wsl_read: handleRead,
  wsl_write: handleWrite,
  wsl_edit: handleEdit,
  wsl_list: handleList,
  wsl_delete: handleDelete,
  wsl_info: handleInfo,
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio, newline delimited
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handleMessage(message) {
  const method = message && message.method;
  const params = (message && message.params) || {};

  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };

    case 'tools/list':
      return { result: { tools: TOOLS } };

    case 'tools/call': {
      const handler = HANDLERS[params.name];
      if (!handler) {
        return {
          result: textResult(
            'Unknown tool: ' + String(params.name) + '. Available: ' + Object.keys(HANDLERS).join(', '),
            true
          ),
        };
      }
      let output;
      try {
        output = handler(params.arguments || {});
      } catch (error) {
        output = textResult(String((error && error.message) || error), true);
      }
      return { result: output };
    }

    case 'ping':
      return { result: {} };

    default:
      return { error: { code: -32601, message: 'Method not found: ' + String(method) } };
  }
}

function processLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    return;
  }

  if (!message || typeof message !== 'object') return;

  const isNotification = message.id === undefined || message.id === null;
  const outcome = handleMessage(message);

  if (isNotification) return;
  if (outcome && outcome.error) {
    send({ jsonrpc: '2.0', id: message.id, error: outcome.error });
  } else {
    send({ jsonrpc: '2.0', id: message.id, result: outcome.result });
  }
}

function main() {
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      processLine(line);
      index = buffer.indexOf('\n');
    }
  });

  process.stdin.on('end', () => {
    if (buffer.trim() !== '') processLine(buffer);
    process.exit(0);
  });

  process.stdin.on('error', () => process.exit(0));
}

// Only start the stdio loop when executed directly, so the test suite can
// require this file and exercise the helpers without spawning a server.
if (require.main === module) {
  main();
}

module.exports = {
  TOOLS,
  HANDLERS,
  handleMessage,
  toLinuxPath,
  normaliseLinuxPath,
  distroFromPath,
  isProtectedPath,
  resolveTarget,
  singleQuote,
  readScript,
  PROTECTED_PATHS,
};