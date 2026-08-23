# Installing the Wren extension in Claude Desktop

This is a **Desktop Extension** (`.mcpb`) - a one-click install, no terminal needed. It lets Claude Desktop work with your Wren notes: search and read them, capture new ones into your Wren inbox, and edit notes you already have.

> **Local & private.** The extension runs on your computer and only touches the notes folder you choose. Your notes never leave your machine. Claude Desktop only (not the web app or mobile).

## Install

1. **Get `Wren.mcpb`** - download it (or build it yourself: `npm run pack`).
2. Open **Claude Desktop** -> **Settings** -> **Extensions**.
3. **Drag `Wren.mcpb`** into the Extensions window (or use "Install extension" and pick the file).
4. When prompted, set **"Wren notes folder"** to your Wren notes directory (see below).
5. Click **Install**. All 11 Wren tools are now available in your chats.

## Finding your Wren notes folder

It's the folder you chose in the Wren app:

- **Local (File System) Wren:** the folder you picked with "Save to my computer" / "Choose folder." If you're unsure of the exact path, the Wren app shows it in its storage settings (the folder chip in the sidebar header).
- **Google Drive Wren:** the extension reads a **local** folder, so point it at a synced copy of your "Wren Notes" Drive folder (Google Drive for Desktop, **mirror mode**). The pure-cloud Drive folder isn't directly readable by this local extension. Full setup + path examples: [DRIVE.md](DRIVE.md).

The default suggested path is `~/Documents/Wren Notes` - change it to wherever your notes actually live.

## What you can do

Claude gets 11 tools. **Four of them read** your notes:

- *"What Wren notes do I have about the project?"* -> searches the catalog
- *"Read my grocery note"* -> opens one note in full
- *"List everything tagged status:todo"* -> pages through your notes
- *"Give me an overview of my whole notes folder"* -> pulls the catalog at once

**The other seven write.** Read this part before you install, because Claude can change notes you already have:

- *"Make a note that says call the dentist Tuesday"* -> creates a note, staged in your Wren **inbox**
- *"Add this week's numbers to the end of my Q3 note"* -> appends to an existing note
- *"Rewrite the summary in my project note"* -> updates an existing note's body, title or due date
- *"Tag that one status:done and drop priority:high"* -> changes a note's tags
- *"Delete the old draft"* -> soft-deletes a note (recoverable - see below)
- *"Move that inbox draft into my real notes"* -> promotes a staged note into your main notes
- *"Actually, bring back the note you deleted"* -> restores it from the trash

## What keeps the writes safe

The write tools are not a free hand over your notes folder. Five things constrain them:

- **Claude has to read a note before it can change it.** Reading returns a fingerprint of the note's contents, and every edit has to hand that fingerprint back. If the note changed on disk in between - you edited it in Wren, or Drive synced a newer copy - the edit is rejected as a conflict instead of overwriting your version. There is no blind-overwrite path.
- **Edits can be previewed.** Every edit tool takes a dry-run flag that returns the exact diff without touching the file, so Claude can show you a change before it makes it.
- **Deleting is a soft delete.** A deleted note is **moved** into a `.trash` folder inside your notes folder, never actually erased, and a restore tool moves it back. Deleting also requires an explicit confirmation flag, as does promoting a staged note into your main notes.
- **It cannot reach outside your notes folder.** Every path is resolved and checked against the folder you chose; attempts to escape it are rejected.
- **AI edits are labelled.** Notes Claude creates or edits carry `created_by`, `last_edited_by` and `last_edited` in their frontmatter, so an AI-written note is always distinguishable from one you wrote.

There is no server-side read-only switch: the write tools are always registered. What you control is the conversation - Claude asks before it edits, and you can tell it to stay read-only in a given chat. If you want a hard guarantee, don't install the extension, or keep a backup of the folder. They're plain Markdown files, so any backup tool works.

## Where AI-created notes go

Created notes are **staged** in Wren's `_inbox/` - they show up in the Wren app's **Inbox** section, where you review them and either **Move to Notes** (keep) or **Discard**. They are never added to your main notes automatically. Editing an existing note is different: that change lands in the note itself, right away.

## Updating

Install a newer `Wren.mcpb` the same way; Claude Desktop replaces the previous version. Your notes-folder setting is preserved (re-enter it if prompted).

## Troubleshooting

- **"notes folder is not configured"** - open the extension's settings in Claude Desktop and set the Wren notes folder.
- **No notes show up** - confirm the path points at the folder that contains your `.md` files (and, if present, `.wren-index.json`). The extension also works without the index by scanning the folder directly.
- **A created note isn't in Wren** - open the Wren app and check the **Inbox** section; created notes land there, not in the main list.
- **An edit was rejected as a conflict** - that's the safety gate doing its job: the note changed on disk after Claude read it. Ask Claude to re-read the note and try again.
- **A note vanished after a delete** - it's in the `.trash` folder inside your notes folder. Ask Claude to restore it, or move the file back out by hand.