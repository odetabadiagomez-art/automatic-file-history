# Change Log

All notable changes to this extension are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 0.1.0

Initial release.

### Capture

- Watches every workspace folder for create/change/delete events, so writes from agents,
  command-line tools, build scripts, and external applications are captured on the same footing
  as editor saves — including for files that are not open in any editor.
- Editor saves are captured through `onDidSaveTextDocument` and labelled with a known origin.
  Everything else is labelled **Disk change**; the writing process is never guessed.
- Per-file serialized capture queue with coalescing: requests that arrive during a pass produce
  one follow-up pass, and every caller receives an honest acknowledgement.
- Bounded stability checks before reading, plus bounded read retries with a size re-check, to
  reduce partial reads during atomic temporary-file replacement.
- Startup baseline scan with bounded concurrency, directory pruning, and reconciliation against
  persisted state. A state that diverged while VS Code was closed is labelled
  **Observed on startup** rather than being passed off as a continuous history.
- Files missing on startup are marked deleted so they stay discoverable and restorable.
- VS Code-initiated renames move history per file, including every tracked file inside a renamed
  folder. External delete/create pairs are kept as separate histories; no rename is inferred.
- The extension's own storage is never captured, preventing recursive capture.
- Failures are reported explicitly with a reason; a failed capture is never presented as success.

### Storage and integrity

- Content-addressed immutable blobs (`0400`) plus per-file revision manifests (`0600`) inside
  owner-only directories (`0700`), stored in VS Code global storage — never in the project tree.
- Blobs are fsynced and renamed before any manifest references them; manifests are replaced
  atomically. A crash leaves at worst an orphan blob, never a published snapshot pointing at
  missing content.
- sha256 is verified before any snapshot is opened, diffed, exported, or restored.
- Monotonic per-file sequence numbers disambiguate identical timestamps.
- Cross-window advisory lock with dead-process reclamation; every manifest mutation re-reads the
  newest state inside the lock, so two windows cannot lose each other's revisions.
- Retention keeps the first captured state and the latest state; oldest snapshots are pruned
  past the per-file limit or the workspace budget. Garbage collection removes only unreferenced
  blobs and respects a grace period so a concurrent capture is never stranded.
- No network access, no telemetry, and no file content in logs.

### User experience

- Explorer view **Automatic File History** that follows the active editor or a pinned file, with
  newest-first snapshots showing event label, relative time, and size.
- Explorer view **Recently Changed Files**, including deleted files.
- Read-only snapshot documents, compare with current, compare with previous, export, restore,
  capture checkpoint, refresh, delete file history, delete all workspace history.
- Explorer and editor context-menu actions for eligible files.
- Status bar item showing `Initializing`, `Monitoring`, `Paused`, `Error`, `Off`, or
  `Unavailable`, with a status and maintenance quick pick reporting storage usage, limits,
  pruned counts, watcher-exclusion caveats, and the storage folder.
- Empty states that distinguish **No previous state captured** from **Excluded**, **Too large**,
  **Binary or non-UTF-8 content**, **Symbolic link**, **Capture failed**, and
  **Workspace not supported**.
- Restore follows a documented safety sequence: verify the blob, resolve dirty editors, capture
  the state being replaced, re-check for a concurrent write, confirm the exact path, write
  through VS Code APIs, then capture the restored state.

### Not included

- Unsaved keystroke-level history, guaranteed capture of every intermediate rapid write,
  monitoring while VS Code is closed, remote/virtual/browser workspaces, large binary or media
  versioning, inference of external renames or writer identity, cloud sync, collaboration,
  automatic Git commits, and recovery of versions that were never captured.
- Native Timeline integration (proposed API); the packaged artifact depends only on stable APIs.
