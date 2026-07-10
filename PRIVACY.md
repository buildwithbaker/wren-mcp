# Privacy Policy - Wren (wren-mcp)

_Last updated: 2026-07-09_

**Summary: Wren-mcp is a local-only server. Your notes never leave your computer.**

## What this software is

Wren-mcp is a local [Model Context Protocol](https://modelcontextprotocol.io) server, distributed as a Claude Desktop extension (`.mcpb`). Claude Desktop launches it on your own machine and communicates with it over stdio (standard input/output). There is no hosted service, no account, and no login.

## What it accesses

- It reads and writes **only** the single notes folder you configure (`WREN_NOTES_DIR`, set via the extension's folder picker). It does not scan, read, or modify anything else on your computer.
- Within that folder it touches note `.md` files, the optional `.wren-index.json` catalog, the `_inbox/` staging folder, and its own `.trash/` soft-delete folder.

## What it does NOT do

- **No network activity.** The server makes no outbound network requests of any kind - no telemetry, no analytics, no crash/error reporting, no update checks, no "phone home." It contains no code path that transmits your notes, their contents, your queries, or any derived metadata off the device.
- **No third-party sharing.** Because nothing leaves your machine, nothing is shared with the author or any third party.
- **No tracking.** The author (Build with Baker) cannot see your notes, your usage, or whether you have the extension installed.

## Data handling

- Note contents are processed in memory only to fulfill the specific tool call you (through Claude) invoked, then returned to your local Claude Desktop client.
- The server persists nothing beyond the note files in your chosen folder. Soft-deleted notes are moved (not erased) to a `.trash/` subfolder so they can be restored.
- Your Claude Desktop client and Anthropic's models process the tool results under [Anthropic's own privacy policy](https://www.anthropic.com/legal/privacy); that is outside the scope of this local server.

## Security

Path access is constrained to the configured notes folder (traversal attempts are rejected), and note bodies are treated strictly as untrusted data, never as instructions. See [`SECURITY.md`](SECURITY.md) for the full security model and how to report a vulnerability.

## Contact

Questions or concerns: open an issue at <https://github.com/buildwithbaker/wren-mcp/issues>.

## Changes

Material changes to this policy will be reflected in this file with an updated date and noted in the project changelog.
