---
name: wsl-command-execution
description: Run shell commands inside a Windows Subsystem for Linux distro through the wsl_exec tool, with correct quoting, timeouts, exit code handling and long-running command patterns. Use when the built-in shell cannot reach a WSL workspace or when a command must run inside the distro rather than on the Windows host.
---

# WSL command execution

## When this applies

Use `wsl_exec` when a command must run **inside** a distro. The built-in shell
runs on Windows and is refused outright while the workspace is a WSL network
share, so retrying it is never the fix.

Commands that belong on the Windows side, such as starting a service or opening
an Explorer window, stay in the built-in shell. WSL Toolkit only covers the
distro side.

## Calling convention

```text
wsl_exec
  command    required, executed by bash -c inside the distro
  distro     optional, defaults to the default distro
  cwd        optional Linux path or Windows UNC path
  timeout_ms optional, default 120000, maximum 900000
```

The result always reports `exit_code` first, then stdout and stderr. Read the exit
code before reading the output: a command that printed something and still failed
is common, and the interesting part is usually in stderr.

## Quoting

The whole `command` string is passed to `bash -c`, so normal shell quoting
applies:

```text
wsl_exec  command: cd /tmp && rm -f 'report (final).txt'
wsl_exec  command: grep -rn 'needle with spaces' /home/user/project
wsl_exec  command: awk -F, '{print $2}' /home/user/data.csv
```

Two rules that prevent most breakage:

- prefer single quotes around any value that may contain spaces or shell
  metacharacters, and escape an embedded single quote as `'\''`;
- chain steps with `&&` so a failing earlier step stops the chain instead of
  letting a later destructive step run anyway.

## Working directory

Pass `cwd` rather than prefixing `cd`. It is applied before the command and a
failure to enter the directory aborts with exit 1, which is easier to read than a
cascade of "no such file" errors from later steps:

```text
wsl_exec  command: go build ./...
         cwd: /home/user/project
```

## Long-running commands

A tool call is synchronous, so anything that does not return will hold the turn
until it finishes or hits the timeout. Prefer these shapes:

| Situation | Approach |
| --- | --- |
| Command exceeds the tool timeout | rerun it detached with `nohup cmd > /tmp/x.log 2>&1 &`, then poll the log |
| Needs minutes, not seconds | raise `timeout_ms` up to 900000 in one call |
| Needs hours | always detach and poll; never hold a turn open for it |

Detached pattern:

```text
wsl_exec  command: nohup go test ./... > /tmp/test.log 2>&1 & echo started
wsl_exec  command: tail -n 40 /tmp/test.log
```

Report progress as it actually appears. Do not describe a build as finished
before reading the log.

## Exit codes worth recognising

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | general failure, most often a missing path or a failed `&&` chain |
| 2 | misuse, for example a bad flag or missing argument |
| 126 | found but not executable |
| 127 | command not found, the tool is not installed in this distro |
| 130 | interrupted, typically Ctrl-C inside the distro |

A 127 is the important one here: it usually means a package is missing in the
distro rather than a broken command. Say which tool is missing instead of
retrying.

## Working with the filesystem from commands

`wsl_exec` can do file work, but prefer the dedicated tools for it: `wsl_read`,
`wsl_write`, `wsl_edit` and `wsl_delete` transfer content over stdin, so they
have no quoting or encoding hazards, and `wsl_delete` is recoverable. Use
`wsl_exec` for things those tools do not cover, such as `find`, `du`, `df`,
package management, `git`, and service control.

## Troubleshooting

- **Everything fails at once**: run `wsl_info` first. It reports the distros,
  their state, and the default environment, which separates "WSL is broken" from
  "this command is wrong".
- **A command works in a terminal but not here**: interactive terminal state,
  aliases and shell functions from an interactive profile do not exist under
  `bash -c`. Use absolute paths or the command name, and call the binary
  directly.
- **Output looks truncated**: stdout is capped at 60000 characters and the
  result says so. Narrow the command rather than rerunning it unchanged.