# Automatic File History

[English](#english) | [中文说明](#中文说明) |
[Student install / 学生安装（含 Copilot 提示词）](STUDENT-INSTALL.md)

## English

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
exportable, and restorable. **Nothing is ever deleted automatically** — by default every
snapshot is kept forever, so the full history of each file survives no matter how much the
storage folder grows.

It does **not** promise every intermediate write by every tool, and no filesystem watcher can:

| Limitation | Consequence |
| --- | --- |
| A watcher sees changes *after* they land | If a tool writes five times before an observation completes, intermediate states may be merged. The final state is always captured. |
| The extension only runs while VS Code runs | Changes made while VS Code is closed are never observed. On startup the first differing state is labelled **Observed on startup**. |
| The writing process is not identified | Entries say **Disk change**. Only saves from an editor in this window are labelled **Editor save**. Nothing is ever attributed to a specific agent or tool. |
| History grows without bound | Every distinct state is kept forever and nothing is pruned automatically, so the `.file-history` folder grows with your edits. This is deliberate: no version is ever silently lost. If you want a cap, `automaticFileHistory.maxRevisionsPerFile` and `automaticFileHistory.workspaceBudgetMB` are opt-in, and even then the first captured state and the latest state are always kept. |

Every one of these is surfaced in the UI rather than hidden: the status bar item, the status
quick pick, and the per-file empty states all say what is and is not covered.

## Install

> **Students:** follow [STUDENT-INSTALL.md](STUDENT-INSTALL.md) (English / 中文) to have Copilot
> install the extension for you automatically from the
> [latest release](https://github.com/odetabadiagomez-art/automatic-file-history/releases).

**Install with Copilot:** open Copilot Chat in **Agent** mode, then copy the
[English installation prompt](STUDENT-INSTALL.md#how-to-install-it-automatically-with-copilot).
It downloads the VSIX, checks its SHA-256 checksum, installs or updates the extension, and
verifies the installed version. You will be asked to approve commands when needed.

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
for the monitoring phase, tracked-file and snapshot counts, storage used, the effective limits
(by default none — every snapshot is kept), pruned counts, and the storage folder. The same
quick pick offers **Remove Orphaned Snapshots Now** and **Apply Retention Budget Now** (the
latter does nothing unless you have set a workspace budget).

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
it does not survive a move or a zip-and-share. Reload the window after switching locations.
The two stores are separate: existing history in the selected location is reused, or a new
history starts there; the old store is left untouched. History from v0.1.0 is not migrated
automatically; select `"extension"` to access it again.

When sharing, make sure your ZIP tool includes the hidden `.file-history` folder. The recipient
needs this extension installed and must trust the extracted workspace to browse its history.
Review history before sharing: it can contain older content you have since removed.

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
| `automaticFileHistory.maxRevisionsPerFile` | `0` | Snapshots kept per file. `0` (default) keeps every snapshot forever; a positive value caps history, always keeping the first captured state and the latest state. |
| `automaticFileHistory.workspaceBudgetMB` | `0` | Soft workspace budget in MB. `0` (default) means no budget, so nothing is pruned for size; a positive value prunes the oldest snapshots across files when exceeded. |
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

---

## 中文说明

**Automatic File History（自动文件历史）**会自动为工作区中的文本文件创建本地快照。
它不仅记录编辑器保存，还能记录 **Copilot 等 AI 智能体、命令行工具、构建脚本及其他应用程序**
写入磁盘的修改。

**无需 Git 仓库、无需账号、不上云、无遥测。** 历史记录默认保存在项目内，支持查看、比较、
导出和恢复。以下中文说明介绍的是扩展的使用方法；扩展界面中的命令和状态名称仍为英文，
因此下文保留这些名称，方便你在 VS Code 中查找。

### 为什么需要它

VS Code 内置的 Local History 主要在编辑器保存时创建快照。如果智能体、脚本、生成器或同步工具
在编辑器外重写文件，这些修改不一定留下历史记录。本扩展监视磁盘，让外部写入也有机会被记录，
而不只依赖手动保存。

### 能保证什么，以及有哪些限制

**扩展会保留初始基线，以及监控期间成功观察到的每一种不同文件状态。** 历史记录在重启后仍然
存在，可以查看、对比、导出和恢复。**默认永不自动删除**：每一个快照都会被永久保留，无论存储
文件夹增长到多大，每个文件的完整历史都不会丢失。但它不保证捕获每一次瞬间写入。

| 限制 | 意味着什么 |
| --- | --- |
| 文件监视器在修改发生后才收到通知 | 如果工具在一次读取完成前连续写入多次，中间状态可能合并，不能保证每次写入都有独立快照。 |
| 扩展只在 VS Code 运行时工作 | 关闭期间的中间变化不会被观察；再次启动时发现的不同状态标为 **Observed on startup**。 |
| 无法识别外部写入进程 | 外部修改标为 **Disk change**；只有当前窗口的编辑器保存才标为 **Editor save**，不会猜测是哪个智能体或工具所为。 |
| 历史记录默认无限增长 | 每个不同状态都会被永久保留，不会自动清理，因此 `.file-history` 文件夹会随编辑不断增大。这是有意为之，任何版本都不会被悄悄删除。如需设置上限，可显式配置 `automaticFileHistory.maxRevisionsPerFile` 或 `automaticFileHistory.workspaceBudgetMB`；即便如此，首次捕获的状态和最新状态仍会始终保留。 |

状态栏、状态面板和文件历史的空状态说明会显示当前监控状态、限制及跳过原因。

### 安装或更新

> **学生推荐：**打开[学生安装指南（English / 中文）](STUDENT-INSTALL.md)，复制其中的
> [中文 Copilot 安装提示词](STUDENT-INSTALL.md#如何用-copilot-自动安装)。
> 在 VS Code 的 Copilot Chat 中切换到 **Agent（智能体）** 模式，粘贴提示词并按需批准命令。
> Copilot 会下载安装包、校验 SHA-256、安装或更新扩展，并检查安装版本。

手动安装：

1. 从 [GitHub 最新版本页面](https://github.com/odetabadiagomez-art/automatic-file-history/releases/latest)
   下载 `automatic-file-history-<版本号>.vsix`。
2. 在 VS Code 中打开**扩展**侧边栏，点击 `…` → **Install from VSIX…（从 VSIX 安装…）**，
   选择下载的文件。
3. 打开命令面板，执行 **Developer: Reload Window（开发人员: 重新加载窗口）**。
4. 打开本地项目。仅在确认项目可信时选择信任工作区，随后留意状态栏从
   `History Initializing` 变为 `History On`。

这是 **GitHub VSIX 发布包**，不是 Visual Studio Marketplace 发布版本。安装新版本时可使用相同
流程更新，无需先卸载。开发者也可以运行 `npm install && npm run package` 自行打包。

### 查看、对比和恢复历史

**资源管理器 ▸ Automatic File History** 默认跟随当前编辑器，将最新快照排在最前面。
点击快照会以只读方式打开。每个快照提供以下操作：

- **Compare with Current File**：与磁盘上的当前文件对比。
- **Compare with Previous Snapshot**：与前一个快照对比。
- **Open Snapshot (Read-only)**：只读查看。
- **Restore This Snapshot…**：恢复该快照。
- **Export Snapshot…**：将快照的原始内容导出到指定位置。

**资源管理器 ▸ Recently Changed Files** 显示已跟踪文件，包括已删除文件，因此删除后仍可找到
历史并恢复。

在资源管理器或编辑器中右键文件，还可使用 **Show Automatic File History**（查看历史）、
**Capture Checkpoint Now**（立即捕获检查点）和 **Delete History for This File…**（删除该文件历史）。

使用 **Choose File to Follow…** 可以固定查看某个文件；使用 **Follow Active Editor Again**
可恢复跟随当前编辑器。

#### 恢复前的安全检查

1. 先校验已存快照的 SHA-256，校验失败则不写入文件。
2. 如编辑器中有未保存修改，会要求先保存，不会丢弃未保存内容。
3. 先为磁盘上的当前状态创建快照，方便日后从历史中撤回这次恢复。
4. 再次检查文件是否被外部程序同时修改；如发现冲突则中止。
5. 弹出确认框，明确显示快照和目标路径；恢复已删除文件时也会提示。
6. 通过 VS Code API 写入，并将恢复后的状态记录为 **Restored**。

并发检查只能缩小冲突发生的时间窗口，不能彻底消除跨进程写入竞争。

#### 状态和维护

点击状态栏，或运行 **Automatic File History: Show Storage and Monitoring Status**，可查看监控阶段、
已跟踪文件数、快照数、容量使用情况、当前限制（默认无限制，保留全部快照）、清理数量和存储路径。
同一面板还提供 **Remove Orphaned Snapshots Now**（清理孤立快照）和
**Apply Retention Budget Now**（仅在设置了工作区预算时才会清理，否则不执行任何操作）。

状态包括 `Initializing`（正在建立初始快照，尚未完成）、`Monitoring`（监控中）、
`Paused`（暂停）、`Error`（错误及失败数量）、`Off`（关闭）和 `Unavailable`（不可用）。

### 历史存在哪里，如何随项目一起分享

默认保存在**第一个工作区文件夹内**的隐藏目录：

```text
<你的项目>/.file-history/
  blobs/<xx>/<sha256>   按内容哈希存储并去重的快照，权限 0400
  files/<fileId>.json   每个文件的版本元数据，以原子替换方式更新
  lock                 跨窗口协调锁
  .gitignore           默认内容为 "*"，让 Git 忽略历史文件
```

文件身份根据**相对于项目的路径**计算。因此移动项目、重命名项目的父目录，或压缩后在另一台
电脑解压，只要文件在项目内的相对位置保持不变，历史就能继续关联。

**提交或分享作业时：**

1. 确认压缩工具包含隐藏的 `.file-history` 文件夹；只复制当前源文件不会携带历史。
2. 接收者需要安装本扩展，并在确认项目可信后信任解压的本地工作区。
3. 分享前检查历史内容：即使某段内容已从当前文件删除，旧快照仍可能保留它。
4. 多根工作区的历史存于第一个文件夹；分享时需要携带相关根目录并保持它们的相对位置。

扩展不会捕获自己的存储目录。即使接收者改用扩展全局存储模式，`.file-history` 默认也被排除。
如需从资源管理器中隐藏它并减少文件监视事件，可在设置中添加：

```json
{
  "files.exclude": { "**/.file-history": true },
  "files.watcherExclude": { "**/.file-history/**": true }
}
```

如希望历史只留在本机，可将 `automaticFileHistory.storageLocation` 改为 `"extension"`，
然后重新加载窗口。此时存储位置为：

```text
<globalStorage>/odetabadiagomez-art.automatic-file-history/workspaces/<workspaceId>/
```

macOS 上 `<globalStorage>` 通常为 `~/Library/Application Support/Code/User/globalStorage`。
该模式不写入项目目录，但历史与本机文件夹位置绑定，不能仅靠压缩项目携带。
两种位置的历史相互独立：切换时会复用目标位置已有的历史，或在目标位置建立新历史，
原位置不被删除。**v0.1.0 的旧历史不会自动迁移**；选择 `"extension"` 并重新加载即可再次访问。

可从状态面板中的 **Open Storage Folder** 打开存储目录。
**本地历史不是加密，也不等同于备份**：快照和项目通常位于同一磁盘。需要异地保留时，请导出快照
或另行备份。

### 默认设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `automaticFileHistory.enabled` | `true` | 是否启用捕获。 |
| `automaticFileHistory.storageLocation` | `"workspace"` | 项目内存储；改为 `"extension"` 使用本机 VS Code 全局存储，切换后需重新加载。 |
| `automaticFileHistory.maxFileSizeMB` | `2` | 超过该大小的文件不跟踪。 |
| `automaticFileHistory.maxRevisionsPerFile` | `0` | 每个文件保留的快照数量。`0`（默认）表示永久保留全部；设为正数则限制数量，且始终保留首次捕获的状态和最新状态。 |
| `automaticFileHistory.workspaceBudgetMB` | `0` | 工作区软容量预算（MB）。`0`（默认）表示不设预算、不因容量清理；设为正数则超限时清理最旧快照。 |
| `automaticFileHistory.exclude` | `[]` | 额外排除规则，匹配工作区相对路径。 |
| `automaticFileHistory.include` | `[]` | 可覆盖内置排除规则的包含规则，请谨慎使用。 |
| `automaticFileHistory.captureOnSave` | `true` | 除磁盘监控外，也在编辑器保存时捕获。 |
| `automaticFileHistory.stabilizationDelayMs` | `120` | 读取前等待文件稳定的毫秒数；不能证明外部写入已完成。 |
| `automaticFileHistory.followActiveEditor` | `true` | 历史视图跟随当前编辑器。 |
| `automaticFileHistory.showStatusBar` | `true` | 显示状态栏项目。 |
| `automaticFileHistory.recentFilesLimit` | `50` | 最近修改文件视图的行数。 |

#### 哪些内容不会被捕获

- **依赖、构建和缓存目录**：如 `node_modules`、`.git`、`dist`、`build`、`out`、`target`、
  `coverage`、`__pycache__`、`.venv`、`.next`、`.file-history`，以及锁文件、压缩后的代码和 source map。
- **疑似密钥和凭据**：如 `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、
  密钥库、`id_rsa`、`id_ed25519`、`secrets.*`、`credentials*` 和 `*secret*`。
  如确实需要捕获示例文件，可使用包含规则，例如 `**/.env.example`。
- **二进制及非 UTF-8 内容**，包括媒体、压缩包、字体和可执行文件。
- **符号链接**（不会跟随）及超过大小限制的文件。
- **被 `files.watcherExclude` 隐藏的路径**：在打开或保存前，磁盘监控可能无法发现其变化。
- **远程、虚拟、浏览器或不受信任的工作区**。

跳过原因会显示在历史视图中，例如 `Excluded`（已排除）、`Too large`（过大）、
`Binary or non-UTF-8 content`、`Symbolic link`、`Capture failed`，或 `No previous state captured`。

### 隐私和数据删除

- 扩展本身不访问网络，不收集遥测，不需要账号。
- 不会把文件内容写入日志；输出通道只记录路径、数量和错误。
- 在平台支持时，目录采用 `0700`、快照采用 `0400` 的仅所有者权限。
- 删除某文件的历史会移除其元数据和未被其他文件引用的快照。
- **Delete All Workspace History…** 会删除整个工作区的历史；这些删除操作不可撤销。

### 其他行为说明

- **重复触发会合并**：同一次保存和对应的文件监视事件不会生成两份相同快照。
- **恢复旧内容也算新状态**：`A → B → A` 会保留三个状态；只有连续相同内容才去重。
- **删除不会抹去旧快照**：会增加删除标记，之前的快照仍可恢复。
- **在 VS Code 中重命名会携带历史**：重命名文件夹会逐个迁移内部已跟踪文件的历史。
  外部删除和新建不会被猜测为重命名，即使内容相同也保留为两条历史。
- **支持多个 VS Code 窗口协调写入**：元数据更新由锁串行处理，已退出进程留下的锁可被回收。
- **崩溃一致性**：先持久化快照，再原子更新元数据，避免发布指向尚未持久化内容的记录；
  崩溃留下的孤立快照可由清理操作移除。

### 开发和测试

```bash
npm install
npm run compile           # TypeScript 编译到 out/
npm run bundle            # esbuild 打包到 dist/extension.js
npm run watch             # 监听并重新打包
npm run lint              # 静态检查
npm run test:unit         # 编译后运行核心单元测试
npm run test:integration  # 下载 VS Code 并运行扩展宿主测试
npm run package           # 生成 VSIX 安装包
```

按 `F5` 启动 Extension Development Host。项目结构见上方 [Layout](#layout)：
`src/` 包含 VS Code 激活、捕获、历史视图和恢复逻辑；`src/core/` 不依赖 `vscode`，
便于在 Node 中测试存储、并发、保留策略和崩溃边界；`test/` 包含单元测试和扩展宿主集成测试。

VS Code 内置 Timeline 视图依赖 **proposed API（提议中的 API）**。本扩展使用稳定 API 提供自己的
资源管理器历史视图，发布包不依赖提议中的 API，也不应被描述为已经支持原生 Timeline。
如需开发原生适配器，应作为独立开发构建，在启用相应提议的 Insiders 宿主中验证。

### 卸载

1. 在扩展侧边栏卸载 Automatic File History。
2. 如需同时删除全部快照，手动删除 **Open Storage Folder** 所显示的存储目录。

卸载扩展本身不会自动删除历史。删除历史目录不会修改项目的源文件。

### 许可证

MIT
