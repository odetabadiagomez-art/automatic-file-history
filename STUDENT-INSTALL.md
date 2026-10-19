# Automatic File History — Student Install Guide / 学生安装指南

This page is for students. Pick your language, read the short explanation, then paste the
Copilot prompt into VS Code and let it do the install for you.

本页面向学生。选择你的语言，阅读简短说明，然后把 Copilot 提示词粘贴到 VS Code 中，让它自动完成安装。

---

## English

### What is this extension for?

**Automatic File History** takes local snapshots of the text files in your workspace
automatically. It captures changes made by *any* process — you, **Copilot and other AI
agents**, command-line tools, build scripts, sync tools — not just editor saves. VS Code's
built-in Local History only snapshots on save, so when an agent or a script rewrites a file,
the previous content can silently disappear. This extension watches the disk instead, so
those writes are captured too.

With it you can:

- see every stored version of the current file under **Explorer ▸ Automatic File History**;
- diff any snapshot against the current file, or against the previous snapshot;
- restore any version — the restore is safe (checksum-verified, your current state is
  snapshotted first, nothing unsaved is ever discarded);
- recover **deleted files** from **Explorer ▸ Recently Changed Files**;
- export any snapshot to a path you choose.

Everything stays on your own machine: **no account, no cloud, no telemetry, no Git
repository required**. Snapshots live in a hidden `.file-history` folder inside your project
(ignored by Git automatically), so the timeline travels with the folder if you zip and share
it. Secrets-like files (`.env`, `*.pem`, `*.key`, …) are deliberately *not* captured. Monitoring
starts automatically once you **trust** a local workspace — watch the status bar for
`History On`.

It is especially useful in AI-assisted coursework: whenever Copilot rewrites your code, the
previous version is always one click away.

### How to install it automatically with Copilot

1. Open VS Code and open Copilot Chat (`Ctrl/Cmd + Shift + I`).
2. Switch Copilot Chat to **Agent** mode (the mode selector at the bottom of the chat input).
3. Paste the prompt below and press Enter. Approve the terminal commands when VS Code asks.

```text
Please install the "Automatic File History" VS Code extension on this computer by following
these steps exactly:

1. Download the extension package (VSIX) from:
   https://github.com/odetabadiagomez-art/automatic-file-history/releases/download/v0.2.0/automatic-file-history-0.2.0.vsix
   Save it to a temporary location (for example the system temp folder). Use
   `curl -L -o <destination> <url>` (available on macOS, Linux, and Windows 10+); if curl is
   not available, use PowerShell:
   `Invoke-WebRequest -Uri <url> -OutFile <destination>`.
2. Download the checksum file from the same release:
   https://github.com/odetabadiagomez-art/automatic-file-history/releases/download/v0.2.0/SHA256SUMS
   Verify that the VSIX SHA-256 checksum matches the automatic-file-history-0.2.0.vsix entry.
   Compute it with `shasum -a 256 <file>` (macOS/Linux) or `Get-FileHash <file> -Algorithm SHA256`
   (Windows PowerShell). If verification fails, stop and tell me — do not install.
3. Install it by running:
   code --install-extension "<path to the downloaded .vsix>" --force
   If the `code` command is not found:
   - macOS: try "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
   - Windows: try "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
4. Verify the installation by running `code --list-extensions --show-versions` and confirming
   that "odetabadiagomez-art.automatic-file-history@0.2.0" appears in the output.
5. Delete the downloaded VSIX and checksum files.
6. Tell me the result, and remind me to:
   - reload the VS Code window (Ctrl/Cmd + Shift + P → "Developer: Reload Window");
   - click "Trust" if VS Code asks whether I trust the workspace (monitoring only runs in
     trusted local workspaces);
   - look for "History On" in the status bar at the bottom of VS Code;
   - find the "Automatic File History" and "Recently Changed Files" views in the Explorer
     sidebar;
   - include the hidden .file-history folder when zipping and sharing a project: it contains
     the saved timeline, including older content that may have been removed from current files;
   - existing v0.1.0 history is not migrated automatically: set
     "automaticFileHistory.storageLocation" to "extension" and reload to access it.

If any step fails, explain what went wrong and give me the manual fallback: download the VSIX
from the same URL with a browser, then in VS Code open the Extensions sidebar → "…" menu →
"Install from VSIX…" → pick the downloaded file → reload the window.
```

---

## 中文

### 这个扩展是做什么的？

**Automatic File History（自动文件历史）**会自动为你工作区中的文本文件创建本地快照。它记录**任何**
进程所做的修改——无论是你自己、**Copilot 及其他 AI 智能体**、命令行工具、构建脚本还是同步工具——
而不仅仅是编辑器保存时的修改。VS Code 内置的本地历史只在保存时记录快照，因此当智能体或脚本改写
文件时，之前的内容可能会悄无声息地丢失。本扩展监视的是磁盘本身，所以这些外部写入同样会被记录。

你可以用它：

- 在**资源管理器 ▸ Automatic File History** 中查看当前文件的所有历史版本；
- 将任意快照与当前文件或上一个快照进行差异对比；
- 恢复任意版本——恢复过程是安全的（先校验 SHA-256、先为当前状态创建快照、绝不会丢弃未保存的
  修改）；
- 从**资源管理器 ▸ Recently Changed Files** 中找回**已删除的文件**；
- 将任意快照导出到你选择的位置。

所有数据都保存在你自己的电脑上：**无需账号、不上云、无遥测、也不需要 Git 仓库**。快照存放在
项目中的隐藏 `.file-history` 文件夹内（默认被 Git 忽略），因此压缩并分享整个项目时，历史记录也能
随之携带。请确保压缩工具包含该隐藏文件夹；接收者也需要安装本扩展。历史记录可能含有当前文件中
已删除的旧内容，分享前请检查。类似密钥的文件（`.env`、`*.pem`、`*.key` 等）
会被刻意**排除**在记录之外。当你**信任**一个本地工作区后，监控会自动启动——请留意状态栏显示
`History On`。

它在 AI 辅助的课程作业中尤其有用：每当 Copilot 改写了你的代码，之前的版本始终一键可回。

### 如何用 Copilot 自动安装

1. 打开 VS Code，打开 Copilot 聊天（`Ctrl/Cmd + Shift + I`）。
2. 将 Copilot 聊天切换到 **Agent（智能体）** 模式（聊天输入框底部的模式选择器）。
3. 粘贴下面的提示词并按回车。当 VS Code 询问时，批准执行终端命令。

```text
请在这台电脑上按以下步骤安装 "Automatic File History" VS Code 扩展：

1. 从以下地址下载扩展安装包（VSIX）：
   https://github.com/odetabadiagomez-art/automatic-file-history/releases/download/v0.2.0/automatic-file-history-0.2.0.vsix
   保存到临时位置（例如系统临时文件夹）。使用 `curl -L -o <目标路径> <url>` 下载
   （macOS、Linux 和 Windows 10+ 均自带 curl）；如果没有 curl，改用 PowerShell：
   `Invoke-WebRequest -Uri <url> -OutFile <目标路径>`。
2. 从同一版本下载校验文件：
   https://github.com/odetabadiagomez-art/automatic-file-history/releases/download/v0.2.0/SHA256SUMS
   确认 VSIX 的 SHA-256 校验和与其中 automatic-file-history-0.2.0.vsix 对应的值完全一致。
   macOS/Linux 用 `shasum -a 256 <文件>` 计算，Windows PowerShell 用
   `Get-FileHash <文件> -Algorithm SHA256` 计算。如果校验失败，请停止并告诉我，
   不要安装。
3. 运行以下命令安装：
   code --install-extension "<下载的 .vsix 文件路径>" --force
   如果找不到 `code` 命令：
   - macOS：尝试 "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
   - Windows：尝试 "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd"
4. 运行 `code --list-extensions --show-versions`，确认输出中包含
   "odetabadiagomez-art.automatic-file-history@0.2.0"，以验证安装成功。
5. 删除已下载的 VSIX 和校验文件。
6. 告诉我结果，并提醒我：
   - 重新加载 VS Code 窗口（Ctrl/Cmd + Shift + P → "Developer: Reload Window"）；
   - 如果 VS Code 询问是否信任该工作区，请点击"信任"（监控只在受信任的本地工作区中运行）；
   - 在 VS Code 底部状态栏查看 "History On"；
   - 在资源管理器侧边栏找到 "Automatic File History" 和 "Recently Changed Files" 视图；
   - 压缩分享项目时包含隐藏的 .file-history 文件夹，分享前检查其中的旧内容；
   - v0.1.0 的旧历史不会自动迁移，如需查看，请将
     "automaticFileHistory.storageLocation" 设为 "extension" 并重新加载窗口。

如果任何步骤失败，请解释失败原因，并给出手动安装方法：用浏览器从同一地址下载 VSIX 文件，
然后在 VS Code 中打开扩展侧边栏 → "…" 菜单 → "Install from VSIX…（从 VSIX 安装）" →
选择下载的文件 → 重新加载窗口。
```
