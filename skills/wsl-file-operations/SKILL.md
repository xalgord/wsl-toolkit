---
name: wsl-file-operations
description: Read, write, edit, list and delete files inside a Windows Subsystem for Linux distro through the wsl-toolkit MCP tools. Use whenever a target path is a Linux path or a WSL network share path, especially when the built-in shell is refused because the workspace is on \\wsl.localhost.
---

# WSL file operations

## When this applies

Use these tools whenever the file being worked on lives inside a WSL distro.
Two signals mean you are in that situation:

- the path starts with `/` and refers to a distro filesystem such as `/etc/wsl.conf`, `/home/<user>/...`;
- the path looks like `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`.

The built-in file tools address the Windows filesystem and the built-in shell is
refused outright when the workspace itself is a WSL share. That refusal is a host
safety policy, not a permission problem, and retrying never helps.

## Path translation

Every tool accepts either form. Translation happens in the server, not in the
prompt, so both of these reach the same file:

| Given | Resolved inside the distro |
| --- | --- |
| `/etc/wsl.conf` | `/etc/wsl.conf` |
| `\\wsl.localhost\kali-linux\home\user\project\file.txt` | `/home/user/project/file.txt` |
| `C:\Users\user\file.txt` | `/mnt/c/Users/user/file.txt` |

When a Windows UNC path is given, the distro name is taken from it unless an
explicit `distro` argument overrides that.

## Choosing the tool

| Intent | Tool | Key arguments |
| --- | --- | --- |
| Read a file | `wsl_read` | `path`, optional `start_line` / `end_line` |
| Create or replace a file | `wsl_write` | `path`, `content`, `mode` |
| Change part of a file | `wsl_edit` | `path`, `old_string`, `new_string`, `replace_all` |
| Inspect a directory | `wsl_list` | `path`, `show_hidden`, `max_depth` |
| Remove a file or tree | `wsl_delete` | `path`, `recursive` |
| Confirm the environment | `wsl_info` | optional `windows_cwd` |

## Working rules

1. **Read before editing.** `wsl_edit` matches exact bytes. Read the region
   first so `old_string` matches reality, including indentation and line endings.
2. **`wsl_edit` refuses ambiguity.** When `old_string` occurs more than once the
   call fails and reports the count. Extend the match with surrounding context or
   pass `replace_all: true`. Never guess which occurrence was meant.
3. **Verify writes.** `wsl_write` and `wsl_edit` report the byte count. Re-read
   when a file is large or the change is structural.
4. **Preserve line endings.** Content crosses as UTF-8 text. If a file on disk
   uses CRLF, keep CRLF in the content you send rather than normalising it.
5. **Ownership stays with the writing user.** These tools do not elevate
   privileges. Writing to `/etc` or `/usr` normally fails unless the distro user
   has rights. Do not silently switch to `sudo`; report the permission failure
   and let the user decide.

## Deletion is recoverable by default

`wsl_delete` moves the target to `~/.local/share/Trash/wsl-toolkit/<timestamp>-<name>`
and returns the exact restore command. Two consequences:

- pass `permanent: true` only when the user explicitly asks for irreversible
  deletion, never to "clean up faster";
- deleting a directory requires `recursive: true`, which is a deliberate signal
  rather than a default.

System roots such as `/`, `/etc`, `/usr`, `/var`, `/home` and `/lib` are refused
outright. Delete a specific child instead.

## When something fails

- `path does not exist` on `wsl_read`: confirm the distro with `wsl_info`, since
  the same path can exist in a different distro or not at all.
- permission denied: the file needs elevation. Report it, do not work around it.
- empty output from `wsl_exec`: check the exit code first, it is reported above
  the output blocks.