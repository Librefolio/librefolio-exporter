# LibreFolio Exporter

A browser extension that exports your broker transactions to CSV files that
[LibreFolio](https://github.com/Librefolio/LibreFolio) can import.

It currently supports **Scalable Capital**, for both the **broker account** and the
**overnight account** (*conto deposito*, *Tagesgeld*), on every plan, FREE included.
It runs only in your browser: no server, no credentials, no data sent anywhere.

> **Status: early preview (0.x).** It is installed by hand from the GitHub releases.
> It is built on the web app's internal interface, which Scalable can change at any time.
> Not affiliated with, or endorsed by, Scalable Capital.

## What it does

- When you open the Scalable web app, a **LibreFolio** button appears in the
  bottom-right corner.
- You choose the accounts and the period, and click **Export CSV**.
- The extension reads your transactions the same way the web page does (same
  origin, your existing session) and downloads one CSV file per account:
  `scalable-broker_<timestamp>.csv` and `scalable-deposit_<timestamp>.csv`.
- The files use the columns of Scalable's official CSV export, followed by
  `lf_*` columns with the original values: see [docs/FORMAT.md](docs/FORMAT.md).
  LibreFolio will import them through its Scalable plugin.

## Install (manual)

Chrome, Edge, Brave and other Chromium browsers, version 120 or later:

1. Download `librefolio-exporter-<version>.zip` from the
   [latest release](https://github.com/Librefolio/librefolio-exporter/releases/latest)
   and check it against the `.sha256` file published next to it.
2. Unzip it into a folder that will **stay where it is** (not a folder you clean up).
3. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on
   **Developer mode**.
4. Click **Load unpacked** and select the folder.

Only install the extension from this repository's releases.

**Update**: download the new release, replace the content of the folder and click the
reload button of the extension in `chrome://extensions`. The extension tells you when
a new version is available (see [Update check](#update-check)).

## Use

1. Log in to Scalable Capital in the browser.
2. To export the broker account, open the broker's **transactions** page: the
   extension reads the portfolio from that page.
3. Click **LibreFolio**, accept the notice the first time, choose the accounts and
   the period, and click **Export CSV**.

The first export reads the whole history. Afterwards, **From** defaults to the date of
the last export, so only new transactions are read; LibreFolio recognises the
transactions it already has. The browser may ask permission to download two files.

## Risks

Scalable's client terms allow it to block access to the client area for security
reasons. From the Italian client documentation in force since 1 September 2026,
*Termini e Condizioni Generali*, §4.5 (the English version is in the same document):

> «Suspicion of unauthorised or abusive access arise, in particular, if attempts to log
> on to the Platform fail repeatedly, if the login credentials check repeatedly yields a
> negative result and/or if there are plausible indications of the use of computer
> programs to access the Platform.»

The terms do not say what counts as such an indication. This extension is built for
**light use**, so that the risk stays low:

- it only runs when you click, inside your own logged-in browser;
- it never touches your credentials, cookies or two-factor codes;
- requests go one at a time, with a random pause of 0.3–0.7 seconds between them, and
  it backs off when Scalable answers "too many requests";
- trade details (fees and taxes) cost one request per trade and can be turned off;
- after the first export, only new transactions are read.

The risk grows with **intensive use**, for example exporting your whole history many
times a day. If Scalable blocks your access, contact its support. Use the extension at
your own risk.

Scalable also offers an official interface, *Agentic Investing* (CLI and MCP),
activated from Profile › Security on the web.

## Privacy

Everything happens in your browser. The extension reads your transactions from
Scalable and writes them to files on your computer, and nothing else. The only other
request is the optional daily update check to GitHub, which sends no personal data.
Details in [PRIVACY.md](PRIVACY.md).

## Update check

Once a day, when you open the panel, the extension asks GitHub for the latest
release of this repository (`api.github.com`) and shows a notice when a newer version
exists. Turn it off with the checkbox at the bottom of the panel.

## Permissions

| Permission | Why |
|---|---|
| Access to `*.scalable.capital` (content script) | Show the button and read your transactions from the web app. The login (`secure.scalable.capital`) and MCP hosts are excluded. |
| `storage` | Remember your settings, the date of the last export and the update-check result. |

No other host and no other permission. Chrome warns at install time that the extension
can read and change data on `scalable.capital` sites: that is the access above.

## Diagnostics

Open the browser console on the Scalable page (Cmd+Option+J on macOS, Ctrl+Shift+J
elsewhere) and filter on `LibreFolio Exporter`. During an export it lists where the
identifiers were found (not the identifiers), every request (operation, HTTP status,
duration), the fallbacks used for the overnight account and, at the end, a table with
the structure of the export: kinds, statuses, signs and counts. It never prints
identifiers, amounts or descriptions, so you can paste it into an issue.

When something fails, the panel also shows a *technical details* line: include it in
bug reports.

## Development

No dependencies and no build step: the repository folder is the extension.

```sh
npm test               # unit tests and an end-to-end test of the content scripts (node:test)
npm run check          # manifest, locales, syntax and safety rules
npm run package        # dist/librefolio-exporter-<version>.zip and its .sha256
sh tests/browser/run.sh  # real browser against a fake Scalable server (see below)
```

`tests/browser/run.sh` loads the extension into Microsoft Edge (or `BROWSER=` any
Chromium that still accepts `--load-extension`; Google Chrome 137+ does not), maps
`de.scalable.capital` to a local fake server and drives a full export over the DevTools
protocol. Use it for interface work, so that your real account only sees the requests
of real tests.

Load the repository folder with **Load unpacked** to try changes, then click the
extension's reload button after each edit.

| Path | Content |
|---|---|
| `manifest.json` | Manifest V3 |
| `src/shared/` | Number and date helpers, CSV writer, version comparison, UI strings (en, it, fr, es) |
| `src/brokers/scalable/` | GraphQL queries, client, identifier discovery, CSV mapping, export orchestration |
| `src/content/` | Floating button and panel (`ui.js`), entry point (`main.js`) |
| `src/background.js` | Update check |
| `tests/` | `node:test` suites |
| `tests/browser/` | Real-browser smoke test with a fake Scalable server |

Rules kept by `npm run check`: no HTML built from strings, no `eval`, no remote code,
no URL other than the broker's own origin and this repository on GitHub.

### Release

1. Set the same version in `manifest.json` and `package.json`, and add it to
   `CHANGELOG.md`.
2. Push the tag `v<version>`: the release workflow tests, packages and publishes the
   ZIP and its SHA-256.

## Credits

The GraphQL operations follow those used by public projects, first of all
[Scalable-Capital-Transactions-Exporter](https://github.com/matthesvoss/Scalable-Capital-Transactions-Exporter)
by Matthes Voß (MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[GNU Affero General Public License v3.0](LICENSE), like LibreFolio.
