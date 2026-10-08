# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

First preview, installed by hand.

### ✨ Added

- **LibreFolio** button on the Scalable Capital web app, with an export panel in
  English, Italian, French and Spanish.
- Export of the broker account: every transaction, page by page, with the details of
  executed trades (price, fees, taxes) on request.
- Export of the overnight account (*conto deposito*, *Tagesgeld*), one or more.
- CSV files with the columns of Scalable's official export followed by `lf_*` columns
  with the original values ([format version 1](docs/FORMAT.md)).
- Period selection; after the first export, only new transactions are read.
- Light-use safeguards: requests one at a time with pauses, back-off on rate limits,
  stop on errors, cancel button.
- Risk notice, accepted before the first export.
- Optional daily check for new releases on GitHub.
