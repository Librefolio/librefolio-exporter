# ⚙️ How it works

## 🧭 Finding the accounts

The extension finds your portfolio on the broker's pages and your overnight account in
the links and pages of the web app. It remembers them, also after a browser restart, so
that both accounts can be exported from any page. If the panel asks you to, open the
broker's **transactions** page or the overnight account's **Transactions** page once,
then export again.

The broker account is read with the same queries as the web page, page by page. The
details of each executed trade (price, fees, taxes) cost one request each and can be
turned off in the panel.

## 🐷 The overnight account

From the browser, Scalable's interest app answers only the queries that its own pages
send. Its **Transactions** page carries the exact query of its transaction list: the
extension reads it from that page, when it is open or was opened earlier in the browser
session, or else loads that page once, as the web app does when you click the tab, and
then sends the same query, 50 transactions at a time. Interest details (gross amount,
tax withheld) use the query the page sends when a transaction is opened.

If Scalable asks for a security check before showing that page, the panel asks you to
open it and to export from there.

## 📅 Period

The first export reads the whole history. The extension then remembers, for each
account, the date up to which it was exported: **From** defaults to the oldest of these
dates among the chosen accounts, so only new transactions are read and nothing is
skipped; LibreFolio recognises the transactions it already has. An account never
exported starts from the beginning. An account counts as exported once its file is
saved, or when it had nothing to export.

**To** defaults to today. The buttons **1M**, **3M**, **1Y** and **All** set the period
up to today, and **Since last** starts from the dates above. The form keeps its values
while you move between pages, for the current day.

## 💾 Saving

Under *Saving* you can change the start of the file names (`scalable` by default). At
the end, a green list shows each saved file, what it contains and its folder. An account
counts as exported only once its file is saved.

### 📂 With the folder picker (Chrome, Edge)

- When you click **Export CSV**, Chrome's folder picker opens at once: a page may open it
  only within a few seconds of a click, so the folder comes before the transactions are
  read. It opens in the last folder chosen; the first time, in Downloads.
- Chrome does not accept the home, Desktop, Documents and Downloads folders themselves,
  only folders inside them, such as `Downloads/LibreFolio`: it warns you and opens the
  picker again. This is a Chrome rule against giving a site a whole personal folder.
- Chrome then asks for permission to edit files in that folder, on behalf of the Scalable
  page: the extension runs inside the page, so Chrome names the page. The permission lasts
  until you close the last Scalable tab, and a folder icon in the address bar can remove
  it. The extension never stores the folder, so the page itself never gets it.
- Both files are written there. A name already taken gets a number, as with downloads:
  `… (1).csv`.
- If you close the picker or refuse the permission, nothing is read and nothing is
  written.

### 💾 With Chrome's *Save as* window (Brave, or when the picker cannot open)

Brave turns the folder picker off (`brave://flags/#file-system-access-api` turns it on):
the files then go through the browser's downloads, at the end of the export.

- Chrome's *Save as* window opens once per export, for the first file.
- The other file goes into the same folder without a window when that folder is
  Chrome's download folder or one of its subfolders: Chrome lets extensions save without
  a window only there.
- Chrome does not tell extensions where its download folder is. The first time, the
  extension saves the second file there, sees where it lands and, if needed, moves it
  next to the first one; then it remembers the folder. When you save outside it, the
  extension checks at most once a week whether Chrome's setting has changed.
- Outside the download folder, or when Chrome is set to *Ask where to save each file*,
  Chrome opens its window for the second file too: choose the same folder. Chrome starts
  that window in its download folder, as it does for every file named by an extension.
  A file saved through a window is never moved.
- A file larger than about 2 MB is saved by the page itself, into the download folder.
- Files keep their names even when another extension renames downloads.

If you close a *Save as* window, that file is not saved and its account does not count
as exported.

## 🔄 Update check

The top of the panel shows the version of the extension and whether a newer one exists.
When you open the panel, the extension asks GitHub for the latest release of this
repository (`api.github.com`), at most once a day; **Check for updates** asks again
right away. GitHub answers at most 60 such requests per hour from the same IP address:
on a network shared by many people, such as an office network, the check can fail; it
works again later.

## 🔑 Permissions

| Permission | Why |
|---|---|
| Access to `*.scalable.capital` (content script) | Show the button and read your transactions from the web app. The login (`secure.scalable.capital`) and MCP hosts are excluded. |
| `storage` | Remember your settings, the date of each account's last export, the update-check result, the portfolio and overnight accounts seen on the pages and the location of the download folder; until the browser closes, the query of the overnight account's list. |
| `downloads` | Save the CSV files when the folder picker is not available: the first with Chrome's *Save as* window, the other next to it. To find the download folder, the extension looks at where its own files land, and removes a file of its own that landed in the wrong folder. It also gives its own files their names when another extension renames downloads. It leaves other downloads untouched. The folder picker itself needs no permission: Chrome asks you at each export. |

No other host and no other permission. At install time Chrome warns that the extension
can read and change data on `scalable.capital` sites and manage your downloads: that is
the access above.

## 🩺 Diagnostics

Open the browser console on the Scalable page (Cmd+Option+J on macOS, Ctrl+Shift+J
elsewhere) and filter on `LibreFolio Exporter`. Each export is one collapsed group: open
it to see the details. It lists where the identifiers were found (not the identifiers),
where the query of the overnight account's list came from (the page, the session memory
or a download of the page), every request (operation, path, HTTP status, duration), how
each file was saved and, at the end, the structure of the export: kinds, statuses, signs
and counts. It never prints identifiers, amounts, descriptions or folders, so you can
paste it into an issue.

When something fails, the panel also shows a *technical details* line: include it in
bug reports.
