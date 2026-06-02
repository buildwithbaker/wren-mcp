# Using Wren on the Google Drive backend

If your Wren notes live in **Google Drive** (you chose "Save to Google Drive" in the Wren app), you can still use this extension — point it at your Drive folder **synced to your computer** by Google Drive for Desktop. The server reads that already-synced local copy. **Nothing extra is sent to the cloud or to any Wren server** — it's the same local-first model as the on-disk backend, just pointed at a Drive-synced folder.

> This is "Path A": a local server reading a local (Drive-synced) folder. There is no remote server, no Google sign-in, and no Drive API access in this extension.

## Requirements

1. **Install [Google Drive for Desktop](https://www.google.com/drive/download/).**
2. **Set the Wren Notes folder to "mirror" mode — not "stream" / online-only.**
   - In Drive for Desktop → Settings → **Google Drive** → choose **"Mirror files"** (or, if you keep stream mode globally, right-click the **Wren Notes** folder → **Offline access → Available offline**).
   - Why: in **stream** mode a note can be an online-only *placeholder* — 0 bytes on disk, or unreadable until Drive downloads it on demand. The server skips such placeholders (and logs a warning) rather than showing blank notes, but they won't be searchable/readable until they're materialized. **Mirror mode keeps the files on disk**, so every note is always readable.

## Find the local path

Point the extension's **"Wren notes folder"** setting at the synced Wren Notes folder:

- **Windows:** `G:\My Drive\...\Wren Notes` (the Drive letter you assigned; could be another letter).
- **macOS:** `~/Library/CloudStorage/GoogleDrive-<your-account>/My Drive/.../Wren Notes`
  (older setups: `~/Google Drive/.../Wren Notes`).

The Wren app's "Wren Notes" folder lives at the top of *My Drive* by default; adjust the `...` for any subfolder you keep it in.

## Configure the extension

Same as the local backend (see [INSTALL.md](INSTALL.md)) — in Claude Desktop → Settings → Extensions → Wren, set **"Wren notes folder"** to the Drive-synced path above. That's the only change.

## Freshness caveat

When you edit or create a note in the **Wren PWA on Drive**, it's written to Google Drive first, then Google Drive for Desktop syncs it **down** to your computer a moment later. Until that sync completes, the server won't see the change.

The server is built to tolerate the in-between state:

- If the synced **`.wren-index.json` lags** the note files (or is briefly missing mid-sync), the server reconciles against the actual `.md` files on disk — a note that has synced down but isn't in the index yet still shows up.
- On read, if a note **file on disk is newer than the index**, the server returns the **on-disk** content (the file is the source of truth).

So once a change has synced down, the server reflects it — even before Wren regenerates its index. If a note seems stale, give Drive a moment to finish syncing.

## Troubleshooting

- **A note reads as an error mentioning "online-only / mirror mode"** — that file is an unhydrated Drive placeholder. Switch the folder to mirror mode (or mark it available offline) and let it download.
- **A new note from the Wren app isn't showing** — it hasn't synced down yet; wait for Drive for Desktop to pull it, then try again.
- **Notes created via Claude** land in the Wren `_inbox/`, sync **up** to Drive, and appear in the Wren app's Inbox for review — same as the local backend.
