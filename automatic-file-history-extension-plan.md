# Automatic File History - Extension Build Plan

## Purpose

Build a local-only VS Code extension that automatically versions documents changed by Copilot, other agents, command-line tools, external applications, and editor saves. No Git repository, commits, account, or cloud service required.

This is a standalone implementation brief for a NEW workspace. Do not build inside or modify the advertising project used to discover the problem.

## 1. Verified diagnosis and constraints

- VS Code's built-in Local History is save-oriented. External disk writes do not reliably produce its normal editor-save snapshots.
- The investigated file had no entry at its exact path in the inspected Local History store. A sibling file with the same name had two stored entries. Absence from Local History does not prove absence of earlier edits.
- No setting change alone establishes reliable history for arbitrary external writers.
- A filesystem watcher detects changes after they happen. It cannot retrieve overwritten bytes unless the extension already captured them.
- Watcher events can be delayed, duplicated, coalesced, or missed. Multiple writes can complete before a snapshot reader runs.
- An extension runs only while the relevant VS Code extension host is running. It cannot capture intermediate changes while VS Code is closed.
- A watcher cannot reliably identify which process or AI agent wrote a file. Label entries "Disk change" unless the origin is actually known.
- Native Timeline contribution currently uses the proposed `timeline` API. Do not assume it is a stable public extension API or a normal Marketplace publishing path.

### Product promise

Automatically preserve an initial baseline and each distinct file state successfully observed while monitoring is active. Retain versions across restarts, with inspectable retention and storage limits.

Do NOT promise "every intermediate write by every tool." That requires cooperation from writers, or a separate interception/versioned-storage system outside this extension's MVP.

## 2. Delivery strategy

### Primary: standard VS Code extension

Use stable APIs for capture, storage, compare, restore, and an Explorer history view named **Automatic File History**.

This gives normal Stable VS Code users automatic versions without developer flags. It is a separate view, not the built-in Timeline.

### Optional: native Timeline integration

Add a thin adapter over the same history store using the proposed Timeline API.

- First validate support in a matching VS Code Insiders extension-development host.
- Follow Microsoft's explicit proposed-API enablement instructions.
- Keep the standard extension artifact free of proposed-API dependencies.
- If implemented, package a separate private/development variant with the necessary proposal declaration and matching typings.
- Verify ordinary installs of the standard artifact work without any proposed APIs enabled.
- Do not edit VS Code's private Local History files, patch VS Code, or call undocumented internal commands to simulate Timeline support.
- If native Timeline is non-negotiable, document the required host/version/enablement before investing in the adapter.

**Implementation order:** reliable capture and recovery first, stable history view second, optional Timeline adapter last.

## 3. MVP scope

### Supported

- Trusted local workspaces on macOS initially, with portable code paths for Windows/Linux.
- Multi-root workspaces.
- Existing and newly created ordinary text files, whether open in an editor or not.
- Markdown, JSON, scripts, source files, and other eligible UTF-8 text.
- Editor saves and external disk writes, including temporary-file replacement saves.
- Persistent local snapshots; compare, restore, export, and explicit history deletion.
- A clear monitoring status, capture failures, and known coverage gaps.

### Not in MVP

- Unsaved keystroke-by-keystroke history.
- Guaranteed capture of every intermediate rapid write.
- Monitoring while VS Code is closed.
- Remote, virtual, or browser workspaces.
- Large binary/media versioning.
- Inferring arbitrary external renames or writer identity.
- Cloud sync, collaboration, or automatic Git commits.
- Reconstruction of historical versions that were never captured.

## 4. Capture design

### Startup

1. Activate automatically for supported trusted workspaces, without requiring a file to be opened.
2. Register watchers before baseline discovery to narrow startup race windows.
3. Discover eligible files and enqueue initial snapshots using bounded concurrency.
4. Serialize baseline and change work per canonical file identity; avoid a baseline task overwriting newer capture metadata.
5. Compare current files against persisted last-known states on restart.
6. Mark newly observed states after downtime as "Observed on startup"; explain that intermediate offline versions are unavailable.
7. Show "Initializing" until the first scan completes. Do not claim full protection before the baseline exists.

### Change handling

- Use `workspace.createFileSystemWatcher` for create/change/delete notifications and `onDidSaveTextDocument` as an additional trigger.
- Test actual watcher coverage, including VS Code watcher exclusions. Report known excluded areas rather than claiming coverage.
- Route every trigger through one per-file capture queue.
- Read bytes and hash content. Skip a snapshot only if identical to the latest captured state; a later return to an older state is still a new history event.
- Avoid a large debounce window that deliberately merges human-meaningful edits.
- Use bounded stability checks/retries for reads racing with writes or atomic replacements. A stability check reduces partial-read risk but does not prove a writer has finished.
- If a new event arrives during capture, schedule another read after the current operation.
- Explicitly report failures after bounded retries. Never present a failed capture as successful.
- Store delete/reappearance events without destroying previous snapshots.
- For renames initiated through VS Code, use rename events to preserve the history relationship.
- For ambiguous external delete/create pairs, keep separate histories; do not guess a rename based only on equal content.
- Ignore the extension's own storage to prevent recursive capture.

### Optional cooperative API, after MVP

Expose commands or a versioned extension API for cooperating tools to capture checkpoints and provide an honest origin label.

For stronger guarantees, a tool must await capture of the old state BEFORE writing, await capture of the completed new state AFTER writing, and serialize its operations. This still cannot guarantee coverage of unrelated concurrent writers.

Do not advertise this as automatic integration with every Copilot tool.

## 5. Storage and integrity

- Store snapshots outside the project, under extension-managed local storage.
- Namespace by workspace and file identity; do not put history in the user's working tree.
- Use content-addressed immutable blobs plus per-file revision metadata.
- Persist original relative path, workspace identity, revision ID, observation timestamp, content hash, byte length, event kind, and a known-origin label only where verified.
- Use a monotonic sequence/revision ID to disambiguate identical timestamps.
- Persist the blob before publishing metadata that references it.
- Use atomic metadata replacement or a small transactional index, choosing the simplest design proven by crash-recovery tests.
- Validate referenced content before offering restore.
- Handle multiple VS Code windows safely: use a tested single-writer/transaction strategy or isolated capture journals with deterministic merging. Do not allow concurrent manifest rewrites to lose history.
- Apply restrictive file permissions where supported. No telemetry, network upload, or source-content logging.
- State clearly that local storage is not encryption or an independent backup.

### Initial policy defaults

Treat these as documented defaults, configurable by users:

- Maximum tracked text-file size: 2 MiB.
- Maximum revisions per file: 500.
- Workspace history budget: 1 GiB.
- No time-based deletion initially.
- Exclude secrets such as `.env` variants and private-key files by default, with explicit explanations.
- Exclude generated/dependency/build folders and extension storage.
- Skip symlinks and unsupported/binary files in MVP; explain skipped coverage.

Retention must preserve the latest recoverable snapshot and collect only unreferenced blobs. Surface budget pressure, pruning, and files skipped due to limits. Do not prune unrelated workspace histories.

## 6. User experience

### Stable history view

- Follow the active editor or selected Explorer file.
- Show newest-first revisions with timestamps, event labels, size, and a useful empty state.
- Selecting a revision opens a read-only snapshot.
- Actions: compare with current, compare with previous, restore, export, refresh, show storage usage, and delete history with confirmation.
- Add Explorer context commands for eligible files.
- Provide a workspace-level recently changed/deleted file list so deleted files remain discoverable.
- Show "Monitoring", "Initializing", "Paused", or "Error" in a status indicator.
- Distinguish "No previous state captured" from "Excluded", "Too large", "Workspace not supported", and "Capture failed".
- Explain how to pin/select a file when the view is not following it.

### Restore safety

1. Verify the selected blob's hash before use.
2. Detect dirty editor buffers and ask the user to resolve them; do not silently discard unsaved work.
3. Capture the current on-disk state before replacing it.
4. Recheck that the file has not changed since the restore was prepared; abort on conflict.
5. Confirm destructive replacement and recreate a deleted file only at an explicitly confirmed path.
6. Write through an appropriate VS Code API and capture the resulting restored state.
7. Surface failures without changing history or claiming completion.

Define and test the remaining external-write race rather than claiming cross-process atomic compare-and-swap guarantees that the platform does not provide.

## 7. Implementation structure

Use TypeScript and the standard VS Code extension scaffold. Prefer a few cohesive modules over a framework:

```text
src/
  extension.ts       activation, commands, lifecycle, trust
  capture.ts         watcher, startup scan, queues, retries
  store.ts           persistence, hashes, retention, integrity
  historyView.ts     tree view, selection, snapshot documents
  restore.ts         compare/export/restore safety
test/
  ...focused unit and extension-host integration tests
```

Keep the optional native Timeline adapter in a separate build surface. Extract more modules only when complexity warrants them.

Use the standard Node runtime bundled with the chosen VS Code host. Add dependencies only when needed; do not introduce a database/native dependency without demonstrating why simpler persistence is insufficient.

## 8. Milestones and completion gates

### M0 - Feasibility and scaffold

- Create a separate extension workspace, package manifest, TypeScript configuration, development-host launch configuration, linting, and tests.
- Confirm the current stable/proposed API boundary.
- Demonstrate capture of an external write to an unopened file in a temporary workspace.
- Decide and document the tested multi-window storage strategy.

### M1 - Reliable capture and persistence

- Implement initial baseline, event queue, hashes, immutable snapshots, restart reconciliation, and explicit errors.
- Test Unicode/spaced paths, multi-root folders, atomic replacement, and excluded files.
- Verify history survives an extension-host restart.

### M2 - Useful history and safe recovery

- Implement stable history view, read-only snapshot provider, comparisons, exports, deleted-file discovery, and safe restore.
- Verify current contents are preserved before restore and dirty editors are not overwritten.

### M3 - Hardening and installable artifact

- Implement limits, retention, multi-window safety, failure recovery, trust restrictions, and monitoring status.
- Build a VSIX; install in a clean standard VS Code profile and test end-to-end.
- Provide concise installation, limitations, privacy, storage-location, backup/export, and removal documentation.

### M4 - Optional native Timeline

- Build only after M3 passes.
- Validate in a supported host with explicit proposed-API enablement.
- Reuse the same revisions, snapshot documents, and recovery operations.
- Verify view refresh, filtering, file selection, and graceful behavior when the proposal is unavailable.
- Do not label the standard artifact as having native Timeline support unless it actually does.

## 9. Acceptance tests

Use temporary test folders, never production advertising documents.

| Scenario | Required result |
| --- | --- |
| Pre-existing eligible file | Baseline exists after initialization completes |
| Five external revisions to an unopened file | Baseline plus five revisions when the test awaits capture acknowledgement between writes |
| VS Code save plus watcher event | One revision for the resulting state, not duplicate entries |
| Rapid unacknowledged write burst | Eventual latest state captured; no false guarantee about intermediate states |
| A -> B -> A | All three observed states represented in order |
| Atomic temporary-file replacement | Final content captured, prior snapshot preserved |
| New file | Initial observed content captured |
| Delete file | Prior snapshots remain discoverable and restorable |
| Rename through VS Code | History relationship preserved |
| Ambiguous external rename | No fabricated relationship or lost snapshots |
| Restart | Persisted revisions remain; startup divergence correctly labeled |
| Two windows on the same workspace | No lost metadata, corrupted blobs, or unsafe pruning |
| Dirty editor during restore | No unsaved content discarded |
| Disk full or permission denied | Explicit failure and degraded monitoring status |
| Crash between blob/index writes | No published revision points to missing/incomplete content |
| Retention pressure | Documented pruning; latest recoverable state preserved |
| Excluded secret, binary, oversized file, symlink | Skipped with an accurate explanation |
| Unsupported/untrusted workspace | No misleading monitoring status or unwanted capture |
| Standard VSIX without API flags | Capture, history view, compare, and restore work |
| Optional Timeline variant | Native Timeline reflects the same stored revisions on the tested host |

Record measured capture latency and startup cost for a representative 1,000-file text workspace. Set explicit performance budgets after the first working prototype; do not invent unverified performance claims.

## 10. Existing missing revisions

This extension will protect future observed changes, not recover the five missing revisions retroactively. A separate recovery investigation could look at agent change records, backups, or other existing revision stores, with permission. Do not fabricate revisions or insert synthetic entries into VS Code's private history.

## 11. Handoff prompt for the new workspace

> Build the extension described in this plan in this new workspace. Start with M0 and prove external-write capture for unopened files before building the UI. Deliver the stable-API history view first. Native Timeline support is optional and must respect its proposed-API restrictions. Use local-only storage, no Git, no source uploads, no undocumented VS Code internals, and no promise that a filesystem watcher captures every intermediate write. Add tests, package a VSIX, and verify it in a clean profile. Do not modify the original advertising workspace.

## Sources checked

- [Built-in Local History behavior and settings](https://code.visualstudio.com/updates/v1_66#_local-history)
- [VS Code FileSystemWatcher API](https://code.visualstudio.com/api/references/vscode-api#FileSystemWatcher)
- [Timeline proposed API declaration](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.timeline.d.ts)
- [Using proposed APIs and private VSIX distribution](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)

Recheck the API boundary against the exact host version when implementation starts.
