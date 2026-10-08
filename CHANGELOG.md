# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First preview, installed by hand.

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
  with the original values ([format version 1](docs/FORMAT.md)).
- One *Save as* window per export: the other file goes into the same folder, without a
  window when Chrome allows it (inside its download folder). The start of the file names
  can be changed. Files keep their names when another extension renames downloads.
- Accounts chosen with two tiles; a progress bar with the current step while exporting,
  and the details in one collapsed group of the browser console.
- A green list of the saved files at the end, with what each contains and the folder.
  An account counts as exported only once its file is saved.
- Period selection with the 1M, 3M, 1Y, All and "since last" buttons, the last one per
  account so that nothing is skipped; **To** defaults to today, and the form keeps its
  values across pages for the day. After the first export, only new transactions are read.
- Light-use safeguards: requests one at a time with pauses, back-off on rate limits,
  stop on errors, cancel button.
- Risk notice, accepted before the first export.
- Version and update check at the top of the panel: automatic when the panel opens
  (at most once a day) and on request with **Check for updates**.
