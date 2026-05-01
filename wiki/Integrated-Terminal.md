# Integrated Terminal

The **Integrated Terminal** embeds a command-line shell directly inside Apilix, so you can run scripts, start local services, or inspect files without leaving the application. It lives in the bottom panel alongside the Console — click the **Terminal** tab to switch modes.

> **Availability:** The Integrated Terminal is only available in the **desktop (Electron) app**. In browser/web mode the Terminal tab is shown but grayed out with an explanatory message.

---

## Table of Contents

- [Opening the terminal](#opening-the-terminal)
- [Starting and stopping a session](#starting-and-stopping-a-session)
- [Sending input](#sending-input)
- [Output display](#output-display)
- [Status bar indicator](#status-bar-indicator)
- [Settings](#settings)
- [Limitations](#limitations)

---

## Opening the terminal

The bottom panel has two tabs: **Console** and **Terminal**.

1. Click the **Terminal** tab in the bottom panel header.  
   — or —  
   Click the pulsing **green dot** in the status bar (visible when a session is active) to jump directly to the Terminal view.

If the bottom panel is collapsed, clicking either of the above expands it automatically.

---

## Starting and stopping a session

### Start

Click the green **Start** button in the terminal toolbar. Apilix:

1. Spawns your configured shell (or the system default — see [Settings](#settings)).
2. Sets the working directory to your home directory by default.
3. Displays a system line showing the shell path and working directory:

```
Shell: /bin/zsh  CWD: /Users/you
```

### Stop

Click the red **Stop** button to terminate the running shell. The button shows **Stopping…** while the process is being killed and is disabled during that time to prevent a double-stop race. When the shell exits naturally (e.g. you type `exit`), the session ends automatically with an exit code line.

---

## Sending input

Type directly in the terminal surface and press **Enter** to send the command to the shell.

| Key | Action |
|---|---|
| **Enter** | Send the typed command to the shell |
| **Ctrl C** | Interrupt the foreground process |

Because the terminal uses a real PTY, normal shell editing and history/navigation keys work as expected (for example arrow keys, backspace, tab completion where supported by your shell).

---

## Output display

Terminal output is rendered by an xterm-compatible emulator, so ANSI color/cursor escape sequences are displayed correctly.

- Colored output, cursor movement, and full-screen terminal programs are supported.
- Scrollback is handled by the terminal emulator and controlled by the **Scrollback limit** setting (default `2000`).

---

## Status bar indicator

When a terminal session is active, a pulsing **green dot** appears in the bottom status bar. Clicking it switches the bottom panel to the **Terminal** tab and brings the session into view.

---

## Settings

Open **Settings → Terminal** (⚙️ gear icon or **⌘,** / **Ctrl+,**) to configure the terminal.

| Setting | Default | Description |
|---|---|---|
| **Shell path** | System default | Absolute path to the shell executable (e.g. `/bin/zsh`, `/bin/bash`, `/usr/local/bin/fish`, `C:\Windows\System32\cmd.exe`). Leave blank to use `$SHELL` on macOS/Linux or `%COMSPEC%` on Windows. The path must be an absolute path to an existing file — invalid values fall back to the system default. |
| **Font size (px)** | `13` | Font size for the terminal output and input areas. Range: 8–24. |
| **Scrollback limit (lines)** | `2000` | Maximum number of output lines to keep in memory. Older lines are discarded once the limit is reached. Range: 100–10 000. |

---

## Limitations

| Limitation | Detail |
|---|---|
| **Native module dependency** | The terminal backend relies on `node-pty`, which is a native addon. If you're building from source, run `npm run rebuild:native` after install (or after Electron version upgrades). |
| **Single session** | Only one terminal session can be active at a time per app instance. |
| **Electron only** | Not available in browser (web) mode. |
