# Request History

Every request you send in Apilix is automatically recorded in the **Request History** panel. The log captures the exact state of the request at send time — URL, method, headers, body, authentication, and scripts — so you can re-open and re-send any past request with a single click.

---

## Table of Contents

1. [Opening the History Panel](#opening-the-history-panel)
2. [What Gets Recorded](#what-gets-recorded)
3. [Browsing History](#browsing-history)
4. [Re-opening a Past Request](#re-opening-a-past-request)
5. [Saving Changes from a Snapshot](#saving-changes-from-a-snapshot)
6. [Searching and Filtering](#searching-and-filtering)
7. [Clearing History](#clearing-history)
8. [Persistence and Limits](#persistence-and-limits)
9. [Per-workspace Isolation](#per-workspace-isolation)

---

## Opening the History Panel

Click the **🕐 History** icon in the Activity Bar (left-hand icon strip). The sidebar switches to the Request History panel. Click any other Activity Bar icon to return to the collection tree.

> **Tip:** The History panel sits in the sidebar alongside the collection tree. The request editor and response viewer remain visible in the main area while you browse history.

---

## What Gets Recorded

Each history entry captures:

| Field | Description |
|---|---|
| **Method** | HTTP verb (`GET`, `POST`, etc.) |
| **URL** | The fully resolved URL that was sent (after variable substitution) |
| **Status code** | HTTP response code (`200`, `404`, `500`, etc.), or an error indicator if the request failed to connect |
| **Response time** | Time in milliseconds from request start to last byte |
| **Timestamp** | Date and time the request was sent |
| **Request snapshot** | Complete request state at send time: URL, headers, body, auth, query params, path params, pre-request script, and test script |
| **Error message** | If the request threw a network or timeout error, the message is shown inline |

> **Important:** The snapshot records the state of the request *as sent*, including any unsaved edits you had in the editor at the time. It is independent of the saved collection item.

---

## Browsing History

Entries are grouped by day and displayed newest first within each group.

```
Today
  POST  200  45 ms
  https://api.example.com/users

  GET   404  120 ms
  https://api.example.com/users/999

Yesterday
  DELETE  204  33 ms
  https://api.example.com/users/42

16 April 2026
  GET  200  89 ms
  https://api.example.com/products?category=tools
```

Each entry shows:
- **Method badge** — colour-coded by HTTP verb
- **Status badge** — colour-coded: green (2xx), sky (3xx), yellow (4xx), red (5xx / error)
- **Response time** — shown in milliseconds on the right
- **Full URL** — displayed below the badges, word-wrapped (no truncation)
- **Timestamp** — exact time in HH:MM:SS
- **Error message** — shown in red below the timestamp if the request errored

---

## Re-opening a Past Request

**Click anywhere on a history entry row.** Apilix opens the snapshot in a new tab in the request editor. The History panel stays active in the sidebar — you can keep browsing or clicking further entries without losing your place.

> Re-opening always creates a **new tab**, even if the same collection item is already open. This lets you compare the historical state against the current saved state side by side.

The snapshot tab is marked internally as a *history snapshot*. It behaves like any other request tab — you can edit fields, add headers, change the body, and resend — but the **Save** action works differently (see [Saving Changes from a Snapshot](#saving-changes-from-a-snapshot) below).

---

## Saving Changes from a Snapshot

When you press **Save** (toolbar button or `⌘S` / `Ctrl+S`) on a tab opened from history, Apilix shows the **Save History Snapshot** modal instead of saving immediately. This prevents accidental overwrites of your collection.

The modal offers two choices:

| Option | Effect |
|---|---|
| **Overwrite original request** | Replaces the request in its original collection with your current edits. The tab becomes a normal (non-snapshot) request tab linked to that collection item. |
| **Save as new request** | Adds a copy of the current edits as a new item at the root of the collection you choose. The tab is re-linked to the new item. The original collection item is not modified. |

**To save as a new request:**
1. Select **Save as new request**.
2. Choose a target collection from the dropdown.
3. Click **Save**.

After either save action the tab is no longer marked as a history snapshot — subsequent saves follow the normal flow.

> **Tip:** If you only want to resend the historical request without saving it to a collection, just use the **Send** button. You do not need to save a snapshot tab at all.

---

## Searching and Filtering

Use the controls at the top of the History panel to narrow the list:

| Control | Behaviour |
|---|---|
| **Search box** | Filters by URL substring (case-insensitive). Type any part of the URL, path, or query string. Click **×** to clear. |
| **Method dropdown** | Shows only entries for the selected HTTP method. Defaults to **ALL**. The list is built dynamically from the methods present in history. |

Search and filter work together — only entries matching both criteria are shown.

---

## Clearing History

Click **Clear** in the top-right of the History panel.

- The button shows a **confirmation state** for 3 seconds. Click again within that window to confirm.
- If you navigate away or wait 3 seconds, the confirmation resets and history is not cleared.

> Clearing history is permanent and cannot be undone.

---

## Persistence and Limits

- History is saved to disk automatically after each request (500 ms debounce).
- A maximum of **200 entries** are kept per workspace. When the limit is reached, the oldest entry is dropped.

**Storage locations:**

| Mode | Location |
|---|---|
| Desktop (Electron) | `<userData>/workspaces/<workspaceId>/request-history.json` |
| Browser / Web mode | `localStorage` key `apilix_request_history_<workspaceId>` |

---

## Per-workspace Isolation

Request history is scoped to the active workspace. Switching workspaces loads that workspace's history; the previous workspace's history is saved and restored the next time you switch back.

The following workspace operations reset history:

| Operation | Effect on history |
|---|---|
| Create new workspace | Starts with empty history |
| Switch to another workspace | Loads the target workspace's history |
| Duplicate workspace | Duplicate starts with empty history |
| Delete workspace | History file is permanently deleted |
