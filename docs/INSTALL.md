# Installing the Wren extension in Claude Desktop

This is a **Desktop Extension** (`.mcpb`) — a one-click install, no terminal needed. It lets Claude Desktop read your Wren notes and capture new ones into your Wren inbox for review.

> **Local & private.** The extension runs on your computer and only reads the notes folder you choose. Your notes never leave your machine. Claude Desktop only (not the web app or mobile).

## Install

1. **Get `Wren.mcpb`** — download it (or build it yourself: `npm run pack`).
2. Open **Claude Desktop** → **Settings** → **Extensions**.
3. **Drag `Wren.mcpb`** into the Extensions window (or use "Install extension" and pick the file).
4. When prompted, set **"Wren notes folder"** to your Wren notes directory (see below).
5. Click **Install**. The five Wren tools are now available in your chats.

## Finding your Wren notes folder

It's the folder you chose in the Wren app:

- **Local (File System) Wren:** the folder you picked with "Save to my computer" / "Choose folder." If you're unsure of the exact path, the Wren app shows it in its storage settings (the folder chip in the sidebar header).
- **Google Drive Wren:** the extension reads a **local** folder, so point it at a synced copy of your "Wren Notes" Drive folder (Google Drive for Desktop, **mirror mode**). The pure-cloud Drive folder isn't directly readable by this local extension. Full setup + path examples: [DRIVE.md](DRIVE.md).

The default suggested path is `~/Documents/Wren Notes` — change it to wherever your notes actually live.

## What you can do

Once installed, ask Claude things like:

- *"What Wren notes do I have about the project?"* → searches the catalog
- *"Read my grocery note"* → opens it by id
- *"Make a note that says call the dentist Tuesday"* → creates a note **in your Wren inbox**

Created notes are **staged** in Wren's `_inbox/` — they show up in the Wren app's **Inbox** section, where you review them and either **Move to Notes** (keep) or **Discard**. They are never added to your main notes automatically.

## Updating

Install a newer `Wren.mcpb` the same way; Claude Desktop replaces the previous version. Your notes-folder setting is preserved (re-enter it if prompted).

## Troubleshooting

- **"notes folder is not configured"** — open the extension's settings in Claude Desktop and set the Wren notes folder.
- **No notes show up** — confirm the path points at the folder that contains your `.md` files (and, if present, `.wren-index.json`). The extension also works without the index by scanning the folder directly.
- **A created note isn't in Wren** — open the Wren app and check the **Inbox** section; created notes land there, not in the main list.
