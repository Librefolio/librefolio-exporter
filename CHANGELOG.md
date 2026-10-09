# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-09

### 🐛 Fixed

- The `amount` of an executed trade whose details are read is now the value of the
  shares, as in Scalable's own export, with fees and taxes only in `fee` and `tax`:
  1.0.0 counted the fees in `amount` too. A file exported with 1.0.0 should be exported
  again, choosing its period: **Since last** reads only new transactions.

### ✨ Added

- The README links the LibreFolio import guide.

## [1.0.0] - 2026-10-09

First release, installed by hand.

### ✨ Added

- **LibreFolio** button, folded to the LibreFolio logo until the pointer is over it,
  on every page of the Scalable Capital web app where you are logged in, with an
  export panel in English, Italian, French and Spanish.
- Export of the broker account: every transaction, page by page, with the details of
  executed trades (price, fees, taxes) on request.
- Export of the overnight account (*conto deposito*, *Tagesgeld*), one or more, with
  the web app's own queries: the transaction list with the query that its Transactions
  page carries, 50 at a time; interest payments with their gross amount and the tax
  withheld, on request.
- Both accounts exported from any page: the portfolio, the overnight account and the
  query of its list seen on the pages are remembered until the browser closes.
- CSV files with the columns of Scalable's official export followed by `lf_*` columns
  with what those do not say: transaction id, exact type, reversals, the parts of the
  fee, the venue ([format](docs/formats/scalable.md)). Every field is written once, and
  each file leaves out the columns that only the other account fills. On the
  overnight account, whose queries are the web app's own, a field Scalable adds arrives
  as a new column.
- Privacy: the ids of the person and of the accounts never appear in the files, not even
  inside transaction ids.
- One *Save as* window per export, in any folder: the CSV file of the account, or one ZIP
  holding the CSV files of both accounts. The start of the file names can be changed,
  and the panel shows the names of the next export. Files keep their names when another
  extension renames downloads.
- Accounts chosen with two tiles. The two accounts are read side by side, each with its
  row of progress and current step, while the requests still go one at a time; the
  details are in one collapsed group of the browser console.
- At the end, each account's row keeps how many transactions were read, followed by
  the saved file and its folder; **Show folder** opens the folder. An account counts as
  exported only once the file is saved.
- Period selection with the 1M, 3M, 1Y, All and "since last" buttons, the last one per
  account so that nothing is skipped; **To** defaults to today, and the form keeps its
  values across pages for the day. After the first export, only new transactions are read.
- Light-use safeguards: requests one at a time with pauses, back-off on rate limits,
  stop on errors, cancel button.
- Risk notice, accepted before the first export.
- Pages left open while the extension is updated or reloaded ask to be reloaded, instead
  of running the old version cut off from the extension.
- The release ZIP holds a `librefolio-exporter` folder, the same at every version, so
  that an update unzipped in the same place keeps the extension and its settings.
- Version and update check at the top of the panel: automatic when the panel opens
  (at most once a day) and on request with **Check for updates**.
