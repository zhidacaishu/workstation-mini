# Workstation Mini

English · [简体中文](README.zh-CN.md)

Workstation Mini is a local-first desktop app for research notes, tasks, and spaced repetition. Keep an experiment log, link it to related notes, turn a finding into a flashcard, and schedule the next experiment. Notes and card decks are Markdown files you can open in another editor. Review events are stored as JSON Lines, and the app rebuilds its SQLite search index from the vault.

The desktop interface is in Simplified Chinese. The Chinese labels below match the buttons and pages in the app.

## Install and open a vault

Download the installer and, optionally, `SHA256SUMS.txt` to verify it. Windows x64 uses the `-setup.exe` installer. Apple Silicon Macs use the `-mac-arm64.dmg` disk image. The Windows installer is unsigned. The Mac app uses an ad-hoc signature and has not been notarized by Apple. Install updates manually from [GitHub Releases](https://github.com/zhidacaishu/workstation-mini/releases/latest).

This README describes the current `main` branch. To check which changes are in your installer, use its release notes. Changes awaiting release are listed under **未发布** in the [changelog](CHANGELOG.md).

1. On first launch, create a vault (**创建新资料库**), open an existing one (**打开现有资料库**), or restore one (**从备份恢复**). Recovery accepts a Git repository or a local backup and verifies it before switching.
2. Open **新建** and enter a title. A new note normally goes in `notes/inbox/`. The app proposes a unique filename, which you can change before saving.
3. Add a task to the note, then open **计划** to find it in the list or on the calendar. Checking it off or changing its due date updates the original Markdown line.
4. Open **复习** to create your first flashcard. You can also select text on a note’s reading page and turn the selection into a card.

The question mark in the sidebar opens the built-in guide (**上手指南**). It includes a short tour, a first-use checklist, and a Git setup guide tailored to your vault.

## Notes, research, and review

| To do this | Use |
| --- | --- |
| Find a note or follow an idea | Open search with `Ctrl+K` or `⌘K`. Type `[[` in the editor to link another note. The reading view shows its outline and backlinks. |
| Record an experiment | Create a research project and record the dataset, parameters, seed, commit, result, and next step. The project board and Today page surface the next action. |
| Track a deadline | Write a Markdown task such as `- [ ] Run the ablation @2026-12-01`. Undated tasks appear under **计划 → 未安排**. Daily calendar notes live in `notes/calendar/YYYY-MM-DD.md`. |
| Add an image or equation | Paste or drop a PNG, JPEG, GIF, or WebP image up to 15 MB. The editor saves it in `attachments/` and inserts a link. Inline and display math render offline with bundled KaTeX. |
| Review a finding | Use a level-two heading for the front of a card and the text below for its back. Wrap a phrase in `{{double braces}}` to make a cloze. FSRS schedules the next review from your rating. |

For example, save the following as `cards/experiments.md` to make a card:

```markdown
## Why record the random seed?

It lets another run reproduce the same sequence of random choices.
```

During review, press **Space** to reveal the answer, **1–4** to rate it, or **Z** to undo the last rating. A card rated **忘了** returns at the end of the session. Editing a card’s front, moving it to another deck, or pausing it preserves its review identity.

## Files and local history

| Content | Location |
| --- | --- |
| Notes and research projects | `notes/` in the vault |
| Card decks and review events | `cards/*.md` and `reviews/YYYY-MM-DEVICE.jsonl` |
| Images, audio, and other linked media | `attachments/` and `audio/` |
| Note versions and editor drafts | `notes/.workstation-local/` |
| Deck history and Git conflict or abort snapshots | `.workstation-local/` at the vault root |
| Search index | One index per vault under `workstation-data/index/` in the app data directory |

Before overwriting an edited note, the app saves its previous contents in local history. If the history write fails, the original stays on disk and your new text stays in the editor. Check disk space and write access, then retry. Open **历史与草稿** to compare versions, restore a note or deck, or recover a draft. Local history captures individual saves, so it can contain intermediate versions between Git commits.

For each note, the latest 20 ordinary saves are kept. Older saves are reduced to one per local day within the past 60 days. Deletion and conflict snapshots have separate retention rules. Local history and drafts stay on the device. When Windows asks the app to close for shutdown, restart, or sign-out, you can save unsaved note, card, and settings edits, discard them, or return to editing.

## Optional Git sync

Use the **vault’s own Git working-tree root** as the vault directory. Linked worktrees are supported. In **上手指南 → Git**, the app checks your Git installation, repository, commit identity, and remote and shows the setup commands still needed. Automatic sync is off on a fresh installation. Enable it in **设置 → Git 同步**. Give each device a distinct name so each writes its own review log.

A full sync commits changes that Git tracks or would add, fetches remote changes, rebases if needed, and pushes. Review the vault’s `.gitignore` before enabling sync. With a local repository and no remote, the app can still make local commits. Configure credentials in your terminal if a background fetch needs authentication.

- **Push rules.** Full sync respects explicit Git push settings. For example, with `push.default=simple`, a local `main` tracking `origin/published` on the same remote stops at the push step and reports the two branch names. Review-only sync checks the destination and outgoing commits before sending review records. If the remote branch advances after that check, the push stops.
- **Conflicting edits.** In **设置 → Git 同步**, compare the two sides and choose the local version, the remote version, or a manually merged file. Before replacing a note or deck, the app saves the complete working copy and discarded text versions in local history. This includes edits made in the common-ancestor section of a three-way conflict. Other files are copied byte for byte to `.workstation-local/git-conflicts/`. A failed backup stops the overwrite. If the manual result still contains a conflict marker, the app shows its line number.
- **Recovery.** You can continue a merge or rebase from Settings, abort it, or resolve it with Git in the vault directory. Before an abort, the app saves pending note, deck, and review-log changes under `.workstation-local/git-abort/`. Open **资料库健康** to inspect the index, review logs, and Git status.

## Development and verification

Install Node.js **22.12.0 or later**, then run these commands from the repository root:

```sh
npm ci
npm run dev
```

| Command | What it runs |
| --- | --- |
| `npm test` | Core regression suite, including storage, indexing, Git sync, and vault recovery |
| `npm run test:desktop` | Electron interaction tests with temporary vaults |
| `npm run desktop:build` | Windows x64 NSIS installer |
| `npm run desktop:build:mac` | Apple Silicon macOS disk image |
| `npm run verify-mac-package` | Architecture, native binaries, resources, and signature checks for the packaged Mac app |

Pushes to `main` and pull requests run the Linux regression suite. For platform-specific checks, run the **CI** workflow manually and select Windows or macOS. A version tag matching `package.json` triggers the release workflow. It publishes installers and checksums after the Linux regressions and the Windows and macOS packaging and desktop tests pass.

For more on editor shortcuts, history retention, or the scope of the Mini edition, see the [Chinese user guide](README.zh-CN.md) and [feature scope](docs/MINI-SCOPE.md).
