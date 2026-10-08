# Privacy

LibreFolio Exporter processes your financial data **only inside your browser**.

## What it reads

When you click **Export CSV**, the extension reads the transactions of the accounts you
selected from the Scalable Capital web app, the same way the web page does, using your
existing session. To address those requests it reads the identifiers the web app keeps
in the page: your person id, your portfolio id and the id of your overnight account,
from the page address, its links and the tab's storage.

For the overnight account it also reads, from the data of its **Transactions** page,
the query that the web app uses for the transaction list, with its variables (your
account ids, not your transactions); when that page is not open, it loads it once, as
the web app does when you click the tab. It never reads the content of other requests
the page makes.

It never reads or stores your password, two-factor codes or cookies. On the page, it
only adds its own button and panel.

## What it writes

- The CSV files, saved to your computer through the browser's downloads, in the
  folder you choose each time in Chrome's *Save as* window. A file too large for the
  browser's download interface is saved by the page into the download directory itself.
- In the extension's local storage (`chrome.storage.local`): whether you accepted the
  risk notice, the date of each account's last export, the start of the file names,
  the values of the export form for the current day (period,
  accounts, details option), the result of the last update check and, for at most three
  people, the ids of the portfolio and of the overnight accounts seen on the pages, so
  that an export works from any page after a browser restart. These are filed under a
  SHA-256 fingerprint of the person id, never under the person id itself.
- In the extension's **session** storage (`chrome.storage.session`), which lives in
  memory and is erased when the browser closes: your person id, portfolio id and
  overnight account ids, as seen on the pages of the web app, and the query of each
  overnight account's transaction list with its variables, so that each account can be
  exported from any page. Only the extension's background worker can read it, and it is
  used only for the same person.

Your transactions are never written to the extension's storage. The CSV files contain
the transactions as Scalable describes them, with their ids and references; your person
and portfolio ids are not written, but the id of an overnight-account transaction can
contain the id of that account (interest payments do).

To give its own files their names, the extension takes part in naming downloads
(Chrome's `downloads.onDeterminingFilename`): it answers only for the files it saves,
leaves every other download untouched and keeps nothing about them.

The diagnostics printed in the browser console stay on your computer and contain no
identifiers, amounts or descriptions: only operation names, request paths (with any
identifier-like part hidden), statuses, counts and signs.

## What it sends

- Requests to the Scalable Capital web app you are logged in to (same origin). They are
  the requests the web app itself would make to show you your transactions.
- The update check: an anonymous request to
  `https://api.github.com/repos/Librefolio/librefolio-exporter/releases/latest`, when
  you open the panel (at most once a day) and when you press **Check for updates**.
  It contains no personal or financial data; like any web request, it reveals your IP
  address to GitHub.

Nothing else. No analytics, no telemetry, no third-party servers.

## Contact

Questions and issues: https://github.com/Librefolio/librefolio-exporter/issues
