# Apilix

> **Alternative Platform for Instant Live API eXecution**

Apilix is a lightweight, open-source API development and testing tool built for developers who want full control over their workflow — without cloud lock-in. It ships as a native **desktop app** (macOS, Windows, Linux) powered by Electron, or as a **self-hosted local web app** running on Node.js.

![Apilix Overview](images/overview.png)

---

## Why Apilix?

| | Apilix | Cloud-based tools |
|---|---|---|
| Data ownership | Your disk, your rules | Vendor cloud |
| Offline use | Full functionality | Limited or none |
| Team sync | Git, S3, HTTP, Team server | Proprietary cloud |
| Scripting API | `apx.*` + `pm.*` compatible | Vendor-specific |
| Mock server | Built-in, WebSocket-capable | Paid add-on |
| Open source | Yes (MIT) | Closed |

---

## Features at a Glance

| | Feature | | Feature |
|---|---|---|---|
| 🌐 | Full HTTP request builder | 🔐 | OAuth 2.0 (Code + PKCE, Client Credentials) |
| 📁 | Collections, folders & tabbed editing | 🔁 | Collection Runner with CSV data-driven testing |
| 🌍 | Environments & variable scopes | 🎭 | Built-in Mock Server with WebSocket support |
| ✍️ | Pre-request & test scripts (`pm.*` compatible) | 🔄 | Sync via Git, S3, HTTP, or Team server |
| 📥 | Import: Postman, OpenAPI, cURL, HAR, Hurl | 🌊 | Chrome CDP browser traffic capture |
| 📤 | Export: Postman, cURL, Hurl, Code Snippets | 🔍 | Response search, JSONPath/JMESPath tester |
| 🕸️ | GraphQL with schema introspection | 🏷️ | Network timeline, TLS chain, redirect chain |
| 🍪 | Cookie manager | 🕐 | Request History with snapshot re-open |
| ⚡ | Keyboard shortcuts & dark/light theme | | |

---

## Quick Start

### Desktop App

Download the installer for your platform from the [Releases](https://github.com/cmik/apilix/releases) page and run it — no additional dependencies required.

| Platform | Installer |
|---|---|
| macOS | `Apilix-x.x.x.dmg` |
| Windows | `Apilix-x.x.x-portable.exe` (portable, no installation required) |
| Linux | `Apilix-x.x.x.AppImage` |

### From Source (Web Mode)

**Prerequisites:** Node.js v20.19.0+ and npm v9+

```bash
# 1. Clone the repository
git clone https://github.com/cmik/apilix.git
cd apilix

# 2. Install all dependencies
./install.sh          # macOS / Linux
# — or on Windows PowerShell:
.\install.ps1

# 3. Start the app
./start.sh            # macOS / Linux
.\start.ps1           # Windows
```

The API server starts on **http://localhost:3001** and the UI opens at **http://localhost:5173**.

### From Source (Electron Desktop Mode)

```bash
npm run setup
npm run electron:dev
```

### Helper Scripts (macOS / Linux)

```bash
./install.sh   # Install all dependencies
./start.sh     # Start server + client
./stop.sh      # Stop both services
./restart.sh   # Restart both services
./status.sh    # Check health
```

> **Data storage:** On desktop, all collections and environments are stored locally:
> - **macOS:** `~/Library/Application Support/Apilix/`
> - **Windows:** `%APPDATA%\Apilix\`
> - **Linux:** `~/.config/Apilix/`

---

## Interface Overview

![Apilix Main Interface](images/main-interface.png)

The Apilix UI is divided into five main zones:

| Zone | Description |
|---|---|
| **Activity Bar** (far left) | Switch between Collections, Environments, Request History, Globals, Variables, Runner, Mock Server, and Browser Capture |
| **Sidebar** | Collection tree — browse, create, and organize collections, folders, and requests |
| **Tab Bar** | Open requests as tabs; each tab saves independently |
| **Request Builder** | Main editor — URL bar, method picker, Params / Headers / Body / Auth / Scripts / Settings tabs |
| **Response Viewer** | Response body, headers, cookies, network timeline, TLS certificate chain, and redirect chain |
| **Status Bar** | Bottom bar — active environment indicator, last response summary, console toggle with unread badge |

---

## Wiki Contents

### Getting Started
- [Getting Started](Getting-Started) — Installation, first request, interface walkthrough

### Core Concepts
- [Workspaces](Workspaces) — Create, switch, sync, and snapshot workspaces
- [Collections & Requests](Collections-and-Requests) — Organize and send HTTP requests
- [Variables & Environments](Variables-and-Environments) — `{{variable}}` scopes, environments, globals

### Authentication
- [Authentication](Authentication) — Bearer, Basic, API Key, and full OAuth 2.0

### Scripting & Testing
- [Scripting](Scripting) — Pre-request & test scripts, `apx.*` / `pm.*` API, assertions, snippets

### Advanced Workflows
- [Collection Runner](Collection-Runner) — Data-driven runs, pause/resume/stop, performance metrics
- [Mock Server](Mock-Server) — Routes, dynamic responses, WebSocket support, traffic inspector
- [Request History](Request-History) — Automatic per-workspace request log, day-grouped, snapshot re-open
- [Sync & Collaboration](Sync-and-Collaboration) — Git, S3, HTTP, Team server sync; conflict resolution

### Tools
- [Browser Capture](Browser-Capture) — Chrome CDP integration, live traffic capture
- [Import & Export](Import-and-Export) — Postman, OpenAPI, cURL, HAR, Hurl
- [Code Generation](Code-Generation) — Request code snippets in multiple languages

### Reference
- [Settings & Configuration](Settings-and-Configuration) — Theme, proxy, SSL, timeouts, CORS
- [Keyboard Shortcuts](Keyboard-Shortcuts) — Full shortcut reference table

---

## Architecture

Apilix is composed of three layers:

```
┌──────────────────────────────────────────────────────────────┐
│                    Electron Shell                             │
│  (native APIs: file system, safeStorage, CDP, S3 signing)    │
│                                                               │
│  ┌───────────────────────┐   ┌───────────────────────────┐   │
│  │   React / Vite UI     │◄──►  Express.js API Server    │   │
│  │   (client/src/)       │   │   (server/index.js)       │   │
│  │   port 5173           │   │   port 3001               │   │
│  └───────────────────────┘   └───────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

- **React + TypeScript + Tailwind CSS** — all UI
- **Express.js** — handles request execution (bypasses browser CORS), OAuth token exchange, mock server routing, and collection runner streaming via SSE
- **Electron** — wraps both in a desktop shell; exposes IPC for native capabilities (encrypted credential storage, direct Chrome launch, S3 presigned URL generation)

---

## Contributing

Contributions are welcome. Please open an issue or pull request on [GitHub](https://github.com/cmik/apilix).

---

## License

Apilix is released under the [MIT License](../blob/main/LICENSE).
