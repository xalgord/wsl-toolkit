# WSL Toolkit

A local MiniMax Code plugin that gives an agent real access to a Windows
Subsystem for Linux distro: run commands, read, write, edit, list and delete
files inside the distro.

It exists because of a specific failure mode. When a session's workspace is a
WSL network share such as `\\wsl.localhost\kali-linux\home\user\project`, the
built-in shell tool is refused outright by the host safety policy. The built-in
file tools address the Windows filesystem and cannot see inside the distro
either. The result is an agent that can read the workspace path but cannot act
on a single file in it.

This plugin closes that gap from the other side: it runs `wsl.exe` from the
Windows host and returns structured results over MCP.

## Tools

| Tool | Purpose |
| --- | --- |
| `wsl_exec` | Run a shell command in the distro and get stdout, stderr and the exit code |
| `wsl_read` | Read a file, optionally a line range, with byte counts |
| `wsl_write` | Create or overwrite a file, creating parent directories |
| `wsl_edit` | Exact string replacement, refusing an absent or ambiguous match |
| `wsl_list` | List a directory, optionally recursive to depth 8 |
| `wsl_delete` | Delete a file or directory, recoverable by default |
| `wsl_info` | List distros and state, report the environment, map Windows paths to Linux |

Every tool accepts either a Linux path (`/etc/wsl.conf`) or a Windows UNC path
(`\\wsl.localhost\kali-linux\home\user\file.txt`) and translates it internally.
A UNC path also implies its distro unless `distro` says otherwise.

## Design notes

**Deletion is recoverable.** `wsl_delete` moves the target to
`~/.local/share/Trash/wsl-toolkit/<timestamp>-<name>` and returns the exact
restore command. Irreversible deletion requires passing `permanent: true`, and
system roots such as `/`, `/etc`, `/usr` and `/home` are refused outright.

**Scripts travel on stdin, never as an argument.** This is the part worth
knowing if you ever change the server. Passing a script as
`wsl.exe -- bash -c SCRIPT` does not work: wsl.exe hands that argument to the
distro's *default login shell*, which parses it itself. On Kali that shell is
zsh, so `$VAR` and `$(...)` are expanded by zsh before bash sees them, and a
multi-line script is split into separate shell commands. The visible symptom is
a script whose variables are mysteriously empty. Environment variables are not
forwarded into the distro at all, and trailing argv entries are dropped when
the preceding argument is a multi-line string containing quotes.

stdin, by contrast, is forwarded intact, so the server writes the script to
stdin and runs `bash -s`. File content rides inside the script as base64.

**Nothing user-controlled reaches a shell unescaped.** Values are embedded in
the script with single-quote escaping, and `'\''` correctly escapes an embedded
quote.

**No npm dependencies.** Only Node.js built-ins, so the server starts anywhere
Node is installed.

## Skills

- `wsl-command-execution` — quoting, timeouts, exit codes, and long-running
  command patterns.
- `wsl-file-operations` — path translation, edit safety, and deletion policy.

## Hook

A `SessionStart` hook inspects the session workspace. When it is a WSL share,
the hook injects the distro name, the Linux path mapping and instructions to use
these tools, so an agent does not have to discover the blocked shell by hitting
the error and retrying. It spawns nothing and touches no files.

## Install

Requires Node.js on the Windows host and WSL with at least one distro.

```bash
git clone https://github.com/xalgord/wsl-toolkit.git \
  ~/.minimax/plugins/wsl-toolkit
```

MiniMax Code discovers local plugins automatically. The server is also
runnable standalone for inspection:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node servers/wsl-server.js
```

## Known limits

- Very large directories can exceed the default 25s timeout on slow disks.
  Narrow the path, lower `max_depth`, or pass a larger `timeout_ms`.
- Output is truncated at 60,000 characters, and `wsl_edit` refuses files larger
  than 8 MiB.
- These tools do not elevate privileges. Writing to `/etc` fails unless the
  distro user already has rights; that is reported rather than worked around.

## License

MIT