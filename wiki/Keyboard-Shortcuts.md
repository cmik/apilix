# Keyboard Shortcuts

All global shortcuts use **⌘** (Cmd) on macOS and **Ctrl** on Windows/Linux. Shortcuts are active whenever focus is not inside a text input unless noted otherwise.

---

## Table of Contents

- [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Table of Contents](#table-of-contents)
  - [Global Shortcuts](#global-shortcuts)
  - [Request Builder Shortcuts](#request-builder-shortcuts)
  - [Tab Management](#tab-management)
  - [Sync Shortcuts](#sync-shortcuts)
  - [Modal and Panel Shortcuts](#modal-and-panel-shortcuts)
  - [Script Editor Shortcuts](#script-editor-shortcuts)
  - [Body Editor Shortcuts](#body-editor-shortcuts)
  - [Integrated Terminal Shortcuts](#integrated-terminal-shortcuts)

---

## Global Shortcuts

These shortcuts work from anywhere in the application.

| Shortcut | Action |
|---|---|
| **⌘ Enter** / **Ctrl Enter** | Send the current request |
| **⌘ S** / **Ctrl S** | Save the current request to its collection |
| **⌘ L** / **Ctrl L** | Focus the URL bar |
| **⌘ N** / **Ctrl N** | Create a new request (appends to the first collection, or creates one if none exists) |
| **⌘ W** / **Ctrl W** | Close the active tab |
| **⌘ Shift S** / **Ctrl Shift S** | Quick sync (Push/Pull) — only active when sync is configured and not currently busy |

> **⌘ Enter** and **⌘ S** only fire when the current view is the Request Builder. They have no effect in the Runner, Mock Server, or other views.

---

## Request Builder Shortcuts

These shortcuts are active when the Request Builder is in focus.

| Shortcut | Action |
|---|---|
| **⌘ Enter** / **Ctrl Enter** | Send the request |
| **⌘ S** / **Ctrl S** | Save changes to the collection item |
| **⌘ L** / **Ctrl L** | Focus / select all in the URL bar |

---

## Tab Management

| Shortcut | Action |
|---|---|
| **⌘ N** / **Ctrl N** | Open a new blank request tab |
| **⌘ W** / **Ctrl W** | Close the active tab |

> Closing a tab with unsaved changes will prompt a confirmation dialog.

---

## Sync Shortcuts

| Shortcut | Action | Condition |
|---|---|---|
| **⌘ Shift S** / **Ctrl Shift S** | Quick sync | Sync must be configured; ignored when a sync operation is already in progress |

---

## Modal and Panel Shortcuts

| Shortcut | Action |
|---|---|
| **Escape** | Close the currently open modal |

This applies to all modals: Import, Export, Settings, Cookie Manager, Workspace Manager, Conflict Merge, and Code Generation.

---

## Script Editor Shortcuts

The Pre-request and Test script editors use [Monaco Editor](https://microsoft.github.io/monaco-editor/) (the same engine as VS Code). All standard Monaco shortcuts apply.

| Shortcut | Action |
|---|---|
| **⌘ /** / **Ctrl /** | Toggle line comment |
| **⌘ D** / **Ctrl D** | Select next occurrence of current word |
| **⌘ Z** / **Ctrl Z** | Undo |
| **⌘ Shift Z** / **Ctrl Shift Z** | Redo |
| **⌘ F** / **Ctrl F** | Find |
| **⌘ H** / **Ctrl H** | Find and replace |
| **Alt ↑** / **Alt ↓** | Move line up / down |
| **Shift Alt ↑** / **Shift Alt ↓** | Copy line up / down |
| **⌘ Shift K** / **Ctrl Shift K** | Delete line |
| **Tab** | Indent / accept autocomplete suggestion |
| **Shift Tab** | Outdent |
| **Ctrl Space** | Trigger IntelliSense (autocomplete) |

> The `apx.*` API is registered with Monaco's type definitions, so autocomplete and inline documentation are available for all `apx.*` methods in script editors.

---

## Body Editor Shortcuts

The raw body editors (Raw, GraphQL query, XML) support an inline find bar and a find-and-replace bar.

| Shortcut | Action |
|---|---|
| **⌘ F** / **Ctrl F** | Open inline Find bar |
| **⌘ H** / **Ctrl H** | Open inline Find & Replace bar |
| **Enter** (in search input) | Jump to next match |
| **Shift Enter** (in search input) | Jump to previous match |
| **Escape** | Close the Find / Find & Replace bar |

> Pressing **⌘ F** or **⌘ H** again while the bar is already open in the same mode **closes** it. Switch between Find and Replace via the **Find / Replace** tabs inside the bar.

---

## Integrated Terminal Shortcuts

These shortcuts are active when the cursor is inside the terminal **input bar** at the bottom of the terminal pane.

| Shortcut | Action |
|---|---|
| **Enter** | Send the typed command to the shell |
| **Ctrl C** | Send an interrupt signal (`\x03`) to the running process |

> The terminal is only available in the **Electron desktop app**. See [Integrated Terminal](Integrated-Terminal.md) for full documentation.
