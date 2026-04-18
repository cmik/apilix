# Getting Started

This page walks you through installing Apilix, launching it for the first time, and sending your first HTTP request.

---

## Table of Contents

- [Getting Started](#getting-started)
  - [Table of Contents](#table-of-contents)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
    - [Desktop App (Electron)](#desktop-app-electron)
    - [Web Mode (from Source)](#web-mode-from-source)
    - [Electron Dev Mode (from Source)](#electron-dev-mode-from-source)
  - [Helper Scripts](#helper-scripts)
  - [First Launch](#first-launch)
  - [Interface Walkthrough](#interface-walkthrough)
  - [Your First Request](#your-first-request)
  - [Saving Your Request](#saving-your-request)
  - [Next Steps](#next-steps)

---

## Prerequisites

| Mode | Requirement |
|---|---|
| Desktop App | No prerequisites — download and run the installer |
| Web / Source | Node.js **v20.19.0+** and npm **v9+** |
| Electron Dev | Node.js **v20.19.0+** and npm **v9+** |

To verify your Node.js version:

```bash
node --version   # should print v20.19.0 or higher
npm --version    # should print 9.x.x or higher
```

---

## Installation

### Desktop App (Electron)

Download the installer for your platform from the [Releases](https://github.com/cmik/apilix/releases) page.

| Platform | File | Notes |
|---|---|---|
| macOS | `Apilix-x.x.x.dmg` | Mount the DMG and drag Apilix to Applications |
| Windows | `Apilix-x.x.x-portable.exe` | Portable — double-click to run, no installation required |
| Linux | `Apilix-x.x.x.AppImage` | `chmod +x` the file, then run it |

> **macOS Gatekeeper:** If macOS blocks the app on first launch, go to **System Settings → Privacy & Security** and click **Open Anyway**.

> **Linux AppImage:** Make the file executable before running:
> ```bash
> chmod +x Apilix-x.x.x.AppImage
> ./Apilix-x.x.x.AppImage
> ```

Your data (collections, environments, settings) is stored locally:

| Platform | Data path |
|---|---|
| macOS | `~/Library/Application Support/Apilix/` |
| Windows | `%APPDATA%\Apilix\` |
| Linux | `~/.config/Apilix/` |

---

### Web Mode (from Source)

Web mode runs Apilix as a local web app in your browser — no Electron required. Recommended for server environments or CI.

**Step 1 — Clone the repository:**

```bash
git clone https://github.com/cmik/apilix.git
cd apilix
```

**Step 2 — Install all dependencies:**

```bash
# macOS / Linux
./install.sh

# Windows (PowerShell)
.\install.ps1
```

> If PowerShell blocks unsigned scripts on Windows, run once:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

**Step 3 — Start the app:**

```bash
# macOS / Linux
./start.sh

# Windows (PowerShell)
.\start.ps1
```

| Service | URL |
|---|---|
| API server | http://localhost:3001 |
| UI (browser) | http://localhost:5173 |

Open **http://localhost:5173** in your browser. The app is now running.

> **Note:** In web mode, data is stored in `localStorage` (5 MB limit). For production use or larger datasets, switch to the desktop app where data is stored as JSON files on disk.

---

### Electron Dev Mode (from Source)

To run the full Electron desktop experience from source:

```bash
npm run setup          # install all dependencies
npm run electron:dev   # start server + client + Electron shell
```

---

## Helper Scripts

For quick day-to-day management when running from source on macOS / Linux:

| Script | Purpose |
|---|---|
| `./install.sh` | Install all dependencies (run once after cloning) |
| `./start.sh` | Start the API server and the UI client |
| `./stop.sh` | Stop both services |
| `./restart.sh` | Restart both services |
| `./status.sh` | Check whether the services are running and healthy |

Equivalent PowerShell scripts (`.ps1`) are provided for Windows.

---

## First Launch

When Apilix opens for the first time, a **default workspace** is created automatically. You will see the main interface with an empty collection tree on the left.

![Apilix first launch](images/getting-started-first-launch.png)

---

## Interface Walkthrough

![Apilix interface annotated](images/getting-started-interface-annotated.png)

| # | Zone | Description |
|---|---|---|
| 1 | **Activity Bar** | Far-left icon strip. Click icons to switch the main view: Collections, Environments, Request History, Collection Runner, Mock Server, Browser Capture. |
| 2 | **Workspace Switcher** | Dropdown at the top of the sidebar to create or switch workspaces. |
| 3 | **Sidebar** | Collection tree — shows all collections, folders, and requests. Right-click items for a context menu. |
| 4 | **Tab Bar** | Each open request gets its own tab. Tabs are independent — you can have multiple requests open simultaneously. An unsaved tab shows a dot indicator. |
| 5 | **Request Builder** | The main editing area. Contains the URL bar, method picker, and sub-tabs: **Params**, **Headers**, **Body**, **Auth**, **Pre-req**, **Tests**, **Settings**. |
| 6 | **Send Button** | Click to send the request. Keyboard shortcut: `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux). |
| 7 | **Response Viewer** | Displays the response body (with syntax highlighting), headers, cookies, network timeline, TLS certificate chain, and redirect chain. |
| 8 | **Status Bar** | Bottom bar — shows the active environment, the last response status/time/size, and a console toggle button with an unread-count badge. |

---

## Your First Request

Let's send a simple GET request to a public API.

**Step 1 — Create a collection:**

1. In the Sidebar, click **+ New Collection**.
2. Name it `My First Collection` and press Enter.

![Create collection](images/getting-started-new-collection.png)

**Step 2 — Add a request:**

1. Right-click the collection and choose **Add Request**, or click the `+` icon next to it.
2. A new tab opens with an untitled request.

**Step 3 — Configure the request:**

1. In the URL bar, type:
   ```
   https://jsonplaceholder.typicode.com/posts/1
   ```
2. Make sure the method is set to **GET** (it is by default).

![Configured GET request](images/getting-started-get-request.png)

**Step 4 — Send it:**

Press `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux), or click the **Send** button.

**Step 5 — Inspect the response:**

The Response Viewer will show:
- **Status:** `200 OK`
- **Time:** response duration in milliseconds
- **Size:** response body size
- **Body tab:** the JSON response with syntax highlighting
- **Headers tab:** all response headers
- **Timeline tab:** DNS / TCP / TLS / TTFB / Download waterfall

![Response with JSON body](images/getting-started-response.png)

You can click the **Timeline** tab to see a full network waterfall breakdown for this request.

---

## Saving Your Request

Press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) to save the request into the collection. The dot indicator on the tab disappears once saved.

You can also rename the request: double-click its name in the tab bar or in the collection tree.

![Saved request in collection tree](images/getting-started-saved-request.png)

---

## Next Steps

Now that you have sent your first request, explore the rest of the wiki:

| Topic | What you'll learn |
|---|---|
| [Workspaces](Workspaces) | Organize work into isolated workspaces, use snapshots, and sync to a remote |
| [Collections & Requests](Collections-and-Requests) | Build, organize, and manage requests at scale |
| [Variables & Environments](Variables-and-Environments) | Use `{{variable}}` placeholders and switch environments |
| [Authentication](Authentication) | Add Bearer tokens, Basic auth, API Keys, or full OAuth 2.0 |
| [Scripting](Scripting) | Write pre-request and test scripts using the `apx.*` / `pm.*` API |
| [Collection Runner](Collection-Runner) | Run all requests in a collection with CSV data-driven testing |
| [Mock Server](Mock-Server) | Spin up a local mock API without a real backend |
| [Keyboard Shortcuts](Keyboard-Shortcuts) | Speed up your workflow with keyboard shortcuts |
