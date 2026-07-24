# Google Meet Roll Call Extractor & Auto-Attendance Radar (Silent Mode)

A powerful, 100% silent Chrome extension for Google Meet that extracts roll calls from chat, filters host messages, provides clean CSV and Excel exports, and alerts you via audio chime / push notifications — **without cluttering or showing anything on the webpage DOM!**

---

## ✨ Features

- **🤫 100% Silent On-Page Operation**:
  - Nothing is rendered on the Google Meet webpage (no floating toolbars, no pop-up modals, no toasts).
  - All controls, status counters, and options are accessed cleanly by clicking the **Extension Icon** in the Chrome toolbar.
- **🧩 Extension Toolbar Popup Menu (`popup.html`)**:
  - Real-time student & roll call count indicators.
  - 1-click **Copy All Roll Calls (`1,2,3,4...`)**.
  - 1-click **Export CSV (`.csv`)** and **Export Excel (`.xls`)** buttons.
  - Single 1-click toggle button for **Attendance Pattern Mode (30s Window)**:
    - **`🔢 Sequential Mode (52, 53, 54...)`**
    - **`🔀 Scrambled Mode (Random / Unordered)`**
  - Radar settings: target roll numbers, strike zone min/max, audio chime alert toggles.
- **🚨 Silent Radar Alerts**:
  - Web Audio API chime sound alerts so you never miss your turn.
  - Desktop push notifications (`Notification` API).
- **🛡️ Strict Container Radar**:
  - Blindfolds clock numbers and generic Google Meet UI text. Strictly monitors only Captions (`[aria-label="Captions"]`) and Chat messages (`aside`, `[aria-live="polite"]`).

---

## 📥 Installation

1. **Clone or Download** this repository folder.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select this directory.

---

## 🛠️ Usage

1. Join a **Google Meet**.
2. Click the **Extension Icon** in your Chrome toolbar to open the control menu:
   - **📋 Copy All Roll Calls**: Copies sorted `1,2,3,4...` roll call string directly to clipboard.
   - **📥 CSV**: Export complete attendance report as a `.csv` file.
   - **📊 XLS**: Export formatted attendance report as a Microsoft Excel `.xls` spreadsheet.
   - **🔢 SEQ / 🔀 SCR**: Toggle between Sequential and Scrambled pattern modes.
   - **⚙️ Settings**: Configure target roll number(s), strike zone, and alert sounds.
3. The page remains completely clean and untouched!

---

## 📄 Output Formats

- **Copied Roll Numbers**: `1,2,3,4,5,6,7,8,9,10...`
- **CSV & Excel Columns**: `Serial No.`, `Student Name`, `Roll Number`, `Notes`, `All Roll Numbers (Bulk)`
