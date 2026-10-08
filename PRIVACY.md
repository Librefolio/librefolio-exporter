# Privacy

LibreFolio Exporter processes your financial data **only inside your browser**.

## What it reads

When you click **Export CSV**, the extension reads the transactions of the accounts you
selected from the Scalable Capital web app, the same way the web page does, using your
existing session. It also reads identifiers the web app keeps in the page (your person
and portfolio ids) to address those requests.

It never reads or stores your password, two-factor codes or cookies. On the page, it
only adds its own button and panel, and only reads the links and page data where the
web app keeps those identifiers.

## What it writes

- The CSV files, saved to your computer through the browser's download.
- In the extension's local storage (`chrome.storage.local`): whether you accepted the
  risk notice, the date of your last export, whether the update check is on, and the
  result of the last update check.

Your transactions and identifiers are never written to the extension's storage, and
account or person identifiers are never written to the CSV files.

The diagnostics printed in the browser console stay on your computer and contain no
identifiers, amounts or descriptions: only operation names, statuses, counts and signs.

## What it sends

- Requests to the Scalable Capital web app you are logged in to (same origin). They are
  the requests the web app itself would make to show you your transactions.
- If the update check is on (default), at most once a day: an anonymous request to
  `https://api.github.com/repos/Librefolio/librefolio-exporter/releases/latest`.
  It contains no personal or financial data; like any web request, it reveals your IP
  address to GitHub. Turn it off with the checkbox at the bottom of the panel.

Nothing else. No analytics, no telemetry, no third-party servers.

## Contact

Questions and issues: https://github.com/Librefolio/librefolio-exporter/issues
