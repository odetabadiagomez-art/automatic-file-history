# Automatic File History

Local, automatic snapshots of the text files in your workspace — including changes made by
**Copilot and other agents, command-line tools, build scripts, and any external application**,
not just editor saves.

No Git repository. No account. No cloud. No telemetry. Everything stays in a folder on your
machine that you can open, inspect, export from, and delete.

```
Explorer ▸ Automatic File History
  Observed on startup #7 · latest of 7        2 minutes ago · 4.2 KiB
  Disk change          #6                     11 minutes ago · 4.0 KiB
  Editor save          #5                     yesterday, 18:02 · 3.8 KiB
  Baseline             #1                     3 days ago · 1.1 KiB
```

## Why this exists

VS Code's built-in Local History is save-oriented: it snapshots when an editor saves. When a
file is rewritten by something outside the editor — an agent, a script, `sed`, a generator, a
sync tool — those writes do not reliably produce entries, and the previous content is gone.

This extension watches the disk instead of the editor, so a write from any process is captured
on the same footing as a save.

## What it actually promises

**It preserves the initial baseline and every distinct file state successfully observed while
monitoring is active.** Snapshots persist across restarts and are inspectable, comparable,
exportable, and restorable.

It does **not** promise every intermediate write by every tool, and no filesystem watcher can:

| Limitation | Consequence |
| --- | --- |
| A watcher sees changes *after* they land | If a tool writes five times before an observation completes, intermediate states may be merged. The final state is always captured. |
| The extension only runs while VS Code runs | Changes made while VS Code is closed are never observed. On startup the first differing state is labelled **Observed on startup**. |
| The writing process is not identified | Entries say **Disk change**. Only saves from an editor in this window are labelled **Editor save**. Nothing is ever attributed to a specific agent or tool. |
| Retention limits apply | Past a per-file or workspace budget, the oldest snapshots are pruned. The first captured state and the latest state are always kept. |

Every one of these is surfaced in the UI rather than hidden: the status bar item, the status
quick pick, and the per-file empty states all say what is and is not covered.

## Install

> **Students:** follow [STUDENT-INSTALL.md](STUDENT-INSTALL.md) (English / 中文) to have Copilot
> install the extension for you automatically from the
> [latest release](https://github.com/odetabadiagomez-art/automatic-file-history/releases).

From a VSIX:

1. `npm install && npm run package` (or download a release VSIX).
2. VS Code ▸ Extensions ▸ `…` ▸ **Install from VSIX…** ▸ pick `automatic-file-history-<version>.vsix`.
3. Reload the window.

Monitoring starts on its own for trusted local workspaces. Watch the status bar for
`History Initializing` → `History On`.

## Using it

**Explorer ▸ Automatic File History** follows the active editor and lists snapshots newest
first. Selecting one opens it read-only. Per snapshot:

- **Compare with Current File** — diff the snapshot against what is on disk now
- **Compare with Previous Snapshot** — diff two adjacent snapshots
- **Open Snapshot (Read-only)**
- **Restore This Snapshot…** — see the safety sequence below
- **Export Snapshot…** — write the exact bytes to a path you choose

**Explorer ▸ Recently Changed Files** lists tracked workspace files, including deleted ones, so
a file that no longer exists on disk is still discoverable and recoverable.

Right-click any file in the Explorer or editor for **Show Automatic File History**,
**Capture Checkpoint Now**, and **Delete History for This File…**.

To stop the view following your editor, use **Choose File to Follow…** (it pins one file; the
header row shows it is pinned and offers **Follow Active Editor Again**).

### Restore safety sequence

Restoring is deliberately boring and explicit:

1. The stored snapshot's sha256 is verified before anything touches your file.
2. If an editor has unsaved changes, you are asked to save first — unsaved work is never discarded.
3. The current on-disk state is captured, so the restore itself is undoable from history.
4. The file is re-checked for a concurrent external write; on conflict the restore aborts.
5. A modal confirmation names the snapshot and the exact path (including when recreating a deleted file).
6. The write goes through VS Code APIs, and the resulting state is captured and labelled **Restored**.

A cross-process compare-and-swap does not exist on any platform; step 4 narrows the race rather
than claiming to eliminate it, and the extension says so instead of over-promising.

### Status and maintenance

Click the status bar item (or run **Automatic File History: Show Storage and Monitoring Status**)
for the monitoring phase, tracked-file and snapshot counts, storage used against the budget,
pruned counts, the effective limits, and the storage folder. The same quick pick offers
**Remove Orphaned Snapshots Now** and **Apply Retention Budget Now**.

Phases: `Initializing` (first snapshots still being built — not full protection yet),
`Monitoring`, `Paused`, `Error` (with the failure count), `Off`, `Unavailable`.

## Where history is stored

By default history lives **inside your project**, in a hidden `.file-history` folder in the
first workspace folder:

```
<your-project>/.file-history/
  blobs/<xx>/<sha256>     immutable, content-addressed, deduplicated, mode 0400
  files/<fileId>.json     per-file revision metadata, atomically replaced
  lock                    cross-window advisory lock
  .gitignore              contains "*", so snapshots never reach version control
```

Because file identity is derived from paths **relative to the project**, the whole timeline
travels with the folder: zip the project and share it, move it to another machine, or rename
its parent directory, and every file keeps its history when the folder is opened again.

The store is never captured by the extension itself, and it is excluded from capture by
default even on machines where it arrives inside a shared folder. To keep it out of the
Explorer and the file watcher, you can optionally add this to your settings:

```json
"files.exclude": { "**/.file-history": true },
"files.watcherExclude": { "**/.file-history/**": true }
```

Set `automaticFileHistory.storageLocation` to `"extension"` for the previous behavior:

```
<globalStorage>/odetabadiagomez-art.automatic-file-history/workspaces/<workspaceId>/
```

`<globalStorage>` is VS Code's per-extension global storage directory (on macOS:
`~/Library/Application Support/Code/User/globalStorage`). Nothing is written into your
project tree, but history then stays on that machine and is tied to the folder's location —
it does not survive a move or a zip-and-share. Switching locations starts a fresh history in
the new place; the old store is left untouched.

In a multi-root workspace the store lives in the first folder. Files in the other roots are
still tracked, but their history only travels along if all roots keep their relative
positions.

The storage folder is reachable from the status quick pick via **Open Storage Folder**.

**Local storage is not encryption and not a backup.** Snapshots sit on the same disk as your
files, readable by your user account. Use **Export Snapshot…** for anything you need to keep
elsewhere.

## Defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| `automaticFileHistory.enabled` | `true` | Master switch. |
| `automaticFileHistory.storageLocation` | `"workspace"` | `"workspace"` stores history in `.file-history` inside the project so it travels with the folder; `"extension"` keeps it in VS Code global storage on this machine. |
| `automaticFileHistory.maxFileSizeMB` | `2` | Larger files are not tracked. |
| `automaticFileHistory.maxRevisionsPerFile` | `500` | Oldest snapshots pruned past this; the first and latest are always kept. |
| `automaticFileHistory.workspaceBudgetMB` | `1024` | Soft workspace budget; oldest snapshots pruned across files when exceeded. |
| `automaticFileHistory.exclude` | `[]` | Extra globs, matched against the workspace-relative path. |
| `automaticFileHistory.include` | `[]` | Globs that override the built-in exclusions. |
| `automaticFileHistory.captureOnSave` | `true` | Capture on editor saves in addition to disk watching. |
| `automaticFileHistory.stabilizationDelayMs` | `120` | Quiet period before a read. Reduces partial reads; cannot prove a writer finished. |
| `automaticFileHistory.followActiveEditor` | `true` | History view follows the active editor. |
| `automaticFileHistory.showStatusBar` | `true` | Status bar item. |
| `automaticFileHistory.recentFilesLimit` | `50` | Rows in Recently Changed Files. |

### What is not captured

- **Dependency, build and cache trees**: `node_modules`, `.git`, `dist`, `build`, `out`,
  `target`, `coverage`, `__pycache__`, `.venv`, `.next`, `.file-history` (this extension's own
  store), lockfiles, minified bundles, source maps.
- **Likely secrets, excluded on purpose**: `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`,
  `*.pfx`, keystores, `id_rsa`/`id_ed25519`, `secrets.*`, `credentials*`, `*secret*`.
  Capturing these would copy credentials into a second location on disk. Use
  `automaticFileHistory.include` if you really want one of them (for example `**/.env.example`).
- **Binary and non-UTF-8 content**, media, archives, fonts, and executables.
- **Symbolic links** (never followed) and files larger than the size limit.
- **Paths hidden by `files.watcherExclude`** until they are opened or saved — VS Code's own
  watcher exclusions apply to this extension too, and the status output says so.
- **Anything in remote, virtual, or browser workspaces**, and anything in an untrusted workspace.

Every skip is reported with its reason in the history view's empty state — `Excluded`,
`Too large`, `Binary or non-UTF-8 content`, `Symbolic link`, `Capture failed`, or
`No previous state captured` — rather than showing an unexplained blank.

## Privacy

- No network access. No telemetry. No accounts.
- File content is never written to logs. The output channel records paths, counts, and errors only.
- Snapshots are stored with owner-only permissions (`0700` directories, `0400` blobs) where the platform supports it.
- Deleting a file's history removes its manifest and any blob no other file references.
  **Delete All Workspace History…** removes everything for that workspace. Both are immediate and irreversible.

## Behaviour worth knowing

- **Duplicate triggers collapse.** A save and its watcher event for the same resulting content
  produce one snapshot, not two.
- **Returning to older content is a new event.** `A → B → A` stores three states; identical
  *consecutive* content is not stored twice.
- **Deletes are recorded, not erased.** A delete adds a marker; earlier snapshots stay restorable.
- **Renames you make in VS Code keep their history.** Renames are applied per file, and renaming
  a folder moves every tracked file inside it. External delete/create pairs are *not* guessed into
  a rename — they stay two separate histories, because equal content is not evidence.
- **Multiple VS Code windows are safe.** All manifest writes are serialized by an advisory lock
  and re-read inside it, so windows cannot lose each other's revisions. Abandoned locks from dead
  processes are reclaimed.
- **Crash safety.** Blobs are fsynced before any manifest references them, and manifests are
  replaced atomically, so a crash leaves at worst an orphan blob that garbage collection removes —
  never a published snapshot pointing at missing content.

## Development

```bash
npm install
npm run compile        # tsc -> out/
npm run bundle         # esbuild -> dist/extension.js
npm run watch
npm run lint
npm run test:unit      # 60+ headless tests over store, engine, eligibility, scan, lock
npm run test:integration   # downloads VS Code and runs extension-host tests
npm run package        # produces the VSIX
```

Press `F5` to launch an Extension Development Host.

### Layout

```
src/
  extension.ts        activation, commands, lifecycle, trust
  capture.ts          watchers, save/rename hooks, startup scan, status reporting
  historyView.ts      Explorer history view, snapshot rows, pinned state
  filesView.ts        recently changed and deleted files
  restore.ts          compare, export, and the restore safety sequence
  snapshotProvider.ts read-only snapshot documents (afh: scheme)
  status.ts           status bar item and context keys
  config.ts           settings -> capture policy
  format.ts           timestamps, sizes, labels
  core/               no vscode imports; unit tested in plain Node
    types.ts            data model, event labels, honesty notes
    ids.ts              hashing, workspace/file identity, blob layout
    eligibility.ts      exclusions, binary detection, skip explanations
    lock.ts             cross-window advisory lock + in-process mutex
    store.ts            blobs, manifests, retention, budgets, GC
    captureEngine.ts    per-file queues, stabilization, retries, acknowledgement
    scan.ts             workspace walk with pruning, bounded concurrency
test/
  unit/               headless tests for everything in core/
  integration/        extension-host tests
```

`src/core` deliberately never imports `vscode`, which is why the capture and persistence
semantics — including concurrency, retention, and crash windows — are covered by fast headless
tests rather than only by manual checking.

### Native Timeline

The built-in Timeline view is driven by a **proposed** API. This extension therefore ships its
own Explorer view on stable APIs only, and the packaged VSIX has no proposed-API dependency. A
Timeline adapter over the same store is possible as a separate development-only build; it must
be validated in a matching Insiders host with proposals explicitly enabled, and the standard
artifact must never be described as having native Timeline support.

## Removing it

1. Uninstall the extension (Extensions ▸ Automatic File History ▸ Uninstall).
2. Delete the storage folder shown under **Open Storage Folder** to remove all snapshots.

Uninstalling does not delete stored snapshots; step 2 does. Your workspace files are never
modified by removal.

## License

MIT
