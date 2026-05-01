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

Type a command in the input bar at the bottom of the terminal pane and press **Enter** to send it to the shell.

| Key | Action |
|---|---|
| **Enter** | Send the typed command to the shell (a newline is appended automatically) |
| **Ctrl C** | Send an interrupt signal (`\x03`) to the running process |

> **Echo:** Because the terminal runs without a PTY, the shell does not echo typed characters back. Apilix echoes each submitted command as a `$`-prefixed system line so you can trace what was sent.

---

## Output display

Shell output (both stdout and stderr) is captured and rendered as lines in the output viewport. ANSI color/cursor escape sequences are stripped before display, so the output is readable plain text.

- **`stdout` / `stderr`** — rendered as white text on dark background.
- **System messages** — rendered in a dimmed slate color (e.g. session started/stopped notices, echoed commands, error messages from Apilix itself).

The viewport auto-scrolls to the latest line whenever new output arrives while the Terminal tab is active.

The number of lines retained is controlled by the **Scrollback limit** setting (default 2 000). Once the limit is reached, the oldest lines are trimmed automatically.

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
| **No PTY** | The shell runs as a plain `child_process` piped subprocess, not a full pseudo-terminal. Interactive programs (editors like `vim` / `nano`, `ssh` prompts, `less`, programs that rely on cursor movement or raw mode) will not render correctly. Use the terminal primarily for non-interactive commands. |
| **No terminal resize** | Window/pane resize events are not forwarded to the shell. `tput cols` / `tput lines` will report defaults. This is a known limitation pending a future upgrade to node-pty. |
| **Single session** | Only one terminal session can be active at a time per app instance. |
| **Electron only** | Not available in browser (web) mode. |
| **ANSI stripping** | Color and cursor-movement escape sequences are stripped. Output is plain text. |
