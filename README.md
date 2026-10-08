# LibreFolio Exporter

Export your **Scalable Capital** transactions to CSV files for
[LibreFolio](https://github.com/Librefolio/LibreFolio): the **broker account** and the
**overnight account** (*conto deposito*, *Tagesgeld*), on every plan, FREE included.

- 🔒 Runs only in your browser: no server, no credentials, no data sent anywhere.
- 🧪 Early preview (0.x), installed by hand.
- 🤝 Not affiliated with, or endorsed by, Scalable Capital.

![The LibreFolio button on the Scalable pages](docs/images/button.png)

## 📥 Install

Chrome, Edge, Brave or another Chromium browser, version 120 or later.

1. **Download** `librefolio-exporter-<version>.zip` from the
   [latest release](https://github.com/Librefolio/librefolio-exporter/releases/latest).
2. **Unzip** it into a folder that will stay where it is, not one you clean up.
3. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on
   **Developer mode**, top right:

   ![Developer mode and the Load unpacked button](docs/images/install-developer-mode.png)

4. Click **Load unpacked** and choose the folder. The extension appears in the list:

   ![The extension in chrome://extensions](docs/images/install-extension-card.png)

   The ID changes from one computer to another: it depends on the folder.

> [!TIP]
> Install the extension only from this repository's releases. Each ZIP comes with a
> `.sha256` file to check it.

## 🚀 Use

1. Log in to Scalable Capital: the **LibreFolio** button appears in the bottom-right
   corner of every page.
2. Click it, choose the accounts and the period, and click **Export CSV**.
3. Choose the folder in Chrome's *Save as* window: the other file goes into the same
   folder.

<img src="docs/images/panel.png" alt="The panel after an export" width="400">

The first export reads the whole history. The next ones start from the last export
(**Since last**), so only new transactions are read.

You get one file per account, `scalable-broker_<date>_<time>.csv` and
`scalable-deposit_<date>_<time>.csv`, with the columns of Scalable's official export
([format](docs/FORMAT.md)). LibreFolio will import them through its Scalable plugin.

## 🔄 Update

The panel tells you when a new version exists. Download it, replace the content of the
folder, and click the reload button (⟳) of the extension in `chrome://extensions`.

## 🛡️ Privacy and risks

- 🔒 **Privacy**: your data stays in your browser and on your computer. The only other
  request is the update check to GitHub. Details in [PRIVACY.md](PRIVACY.md).
- ⚠️ **Risks**: the extension uses the web app's internal interface, which Scalable can
  change at any time, and Scalable's terms allow it to block access when it suspects
  that programs are being used. The extension is built for light use: read
  [docs/RISKS.md](docs/RISKS.md) before using it.

## 📚 More

- [How it works](docs/HOW-IT-WORKS.md): accounts, period, saving, update check,
  permissions, diagnostics.
- [CSV format](docs/FORMAT.md).
- [Development](docs/DEVELOPMENT.md): tests, structure, release.
- [Changelog](CHANGELOG.md).

## 🙏 Credits

The GraphQL operations follow those used by public projects, first of all
[Scalable-Capital-Transactions-Exporter](https://github.com/matthesvoss/Scalable-Capital-Transactions-Exporter)
by Matthes Voß (MIT). The account icons come from [Phosphor Icons](https://phosphoricons.com)
(MIT). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 📜 License

[GNU Affero General Public License v3.0](LICENSE), like LibreFolio.
