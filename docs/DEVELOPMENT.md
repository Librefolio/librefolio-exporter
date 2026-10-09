# 👩‍💻 Development

No dependencies and no build step: the repository folder is the extension.

```sh
npm test                 # unit tests and an end-to-end test of the content scripts (node:test)
npm run check            # manifest, locales, syntax and safety rules
npm run package          # dist/librefolio-exporter-<version>.zip (one librefolio-exporter folder) and its .sha256
sh tests/browser/run.sh  # real browser against a fake Scalable server (see below)
```

Load the repository folder with **Load unpacked** to try changes. After each edit, click
the extension's reload button, then reload the Scalable page: Chrome reads the content
scripts when the extension is loaded, and injects them only into pages loaded afterwards.
A page left open keeps the old script, cut off from the extension, and its panel asks
to reload the page.

## 🧪 Real-browser test

`tests/browser/run.sh` loads the extension into Microsoft Edge (or `BROWSER=` any
Chromium that still accepts `--load-extension`; Google Chrome 137+ does not), maps
`de.scalable.capital` to a local fake server and drives a full export over the DevTools
protocol. Use it for interface work, so that your real account only sees the requests
of real tests. With `SHOTS_DIR=<folder>` it also saves screenshots of the button and
the panel; with `EXTENSION_DIR=<folder>` it loads another copy of the extension, such as
the unzipped release ZIP.

A headless browser cannot show the *Save as* window: the test turns it off through a
hidden setting, `saveDialog: false` in `chrome.storage.local`, so that the export goes
straight into the download folder. The test reads the ZIP back with `tests/unzip.js`,
and checks it with the system `unzip -t` where installed.

## 🗂️ Structure

| Path | Content |
|---|---|
| `manifest.json` | Manifest V3 |
| `src/shared/` | Number and date helpers, CSV writer, ZIP writer (`zip.js`), file names and download payloads, version comparison, UI strings (en, it, fr, es) |
| `src/brokers/scalable/` | GraphQL queries, client, reader of the data embedded in the pages (`flight.js`), identifier discovery, CSV mapping, export orchestration |
| `src/content/` | Floating button and panel (`ui.js`), entry point (`main.js`), logo (`logo.js`, generated from `icons/icon-48.png` by `node scripts/build-logo.js`) |
| `src/background.js` | Downloads (one *Save as* window, the download folder learnt), identifiers seen on the pages, update check |
| `tests/` | `node:test` suites |
| `tests/browser/` | Real-browser test with a fake Scalable server |
| `docs/formats/` | The CSV format of each broker's files, one page per broker: `scalable.md` |
| `docs/images/` | Screenshots for the README: installation (by hand), button and panel (`SHOTS_DIR` of the real-browser test) |

Rules kept by `npm run check`: no HTML built from strings, no `eval`, no remote code,
no URL other than the broker's own origin and this repository on GitHub.

## 🏷️ Release

1. Set the same version in `manifest.json` and `package.json`, and give its chapter in
   `CHANGELOG.md` a date.
2. Optionally, try the ZIP itself: `npm run package`, unzip it, and run the real-browser
   test with `EXTENSION_DIR` pointing to the `librefolio-exporter` folder.
3. Push the tag `v<version>`: the release workflow checks that the tag matches the
   manifest, runs the tests, packages the ZIP and its SHA-256, and publishes them in a
   GitHub release.

The ZIP holds one folder, `librefolio-exporter`, the same at every version: Chrome knows
an unpacked extension by its folder, so an update unzipped in the same place keeps the
extension's ID and its settings.
