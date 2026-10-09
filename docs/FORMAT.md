# CSV format

Format version **1** (`lf_format` = `1`). One file per account:
`<prefix>-broker_<timestamp>.csv` and `<prefix>-deposit_<timestamp>.csv`, where the
prefix is `scalable` unless the user changes it. When both accounts are exported
together, the two files come in one ZIP, `<prefix>_<timestamp>.zip`, with the same names
inside.

Each field the web app returns is written **once**: in its column of Scalable's own
layout (columns 1–14) when one carries it, otherwise in an `lf_*` column. The table
[Where each field goes](#where-each-field-goes) lists them all. Both files have the 14
columns; the `lf_*` columns that only the broker fills are left out of the overnight
account's file.

## Conventions

| Aspect | Value |
|---|---|
| Encoding | UTF-8, no BOM |
| Line ending | LF; the file ends with a line ending |
| Delimiter | `;` |
| Quoting | `reference` and `description` are always quoted; other fields only when they contain `;`, `"` or a line break; `"` is doubled |
| Columns 1–14 | Decimal comma, no thousands separator; date `YYYY-MM-DD` and time `HH:MM:SS` in German local time (Europe/Berlin), like the official export |
| `lf_*` columns | Values copied from the web app: decimal point, no rounding, no thousands separator |
| Missing value | Empty field |

Amounts are never rounded or recomputed. The only derived value is `fee`, the exact
decimal sum of `lf_transaction_fee`, `lf_venue_fee` and `lf_crypto_spread_fee`.

*Details* are read with one extra request per item, when the user keeps the option on:
the details of executed trades (broker) and of interest payments (overnight account).

## Columns 1–14: the official Scalable CSV layout

The header is the one of Scalable's own CSV export (PRIME):
`date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency`.
Tools that read that export can read these files. `status` and `type` are Scalable's
labels, which merge some of the web app's values: the exact values are in `lf_status`
and `lf_subtype`.

| Column | Source |
|---|---|
| `date`, `time` | `lastEventDateTime`, converted to Europe/Berlin |
| `status` | `SETTLED`, `FILLED`, `CONFIRMED` → `Executed`; `CANCELLED` → `Cancelled`; `EXPIRED` → `Expired`; `REJECTED` → `Rejected`; `CREATED`, `REQUESTED`, `PENDING`, `PARTIAL_FILLED`, `CANCEL_REQUESTED` → `Pending`; any other value as received |
| `reference` | `transactionReference`, Scalable's reference: `SCAL…` for trades, the one on its documents; `INTEREST-PAY-…` for interest. It comes with the details of executed trades and of interest; empty on the other rows, and when the details are not read |
| `description` | `description` as received: the security name of a trade, the text of a transfer, names and IBANs included |
| `assetType` | `Cash` for cash transactions and the overnight account, `Security` otherwise |
| `type` | See below |
| `isin` | `isin`, or `relatedIsin` for distributions |
| `shares` | Shares executed: trade details `numberOfShares.filled`, otherwise `quantity` (`eltifQuantity` for ELTIF); `0` for a cancelled, rejected or expired order, like the official export |
| `price` | Trade details `averagePrice` |
| `amount` | `amount`; on the overnight account, negative for outflows (see below) |
| `fee` | Sum of the trade fees (see above); `0` when the details are read and give none, empty when they are not read |
| `tax` | Trade details `tradeTransactionAmounts.taxAmount`; for interest, `taxDetails.taxAmount`, the tax withheld; `0` and empty as for `fee` |
| `currency` | `currency` |

`type` mapping:

| Web app | `type` |
|---|---|
| Trade, side `BUY`, subtype `SAVINGS_PLAN` | `Savings plan` |
| Trade or ELTIF, side `BUY` | `Buy` |
| Trade or ELTIF, side `SELL` | `Sell` |
| Cash `DEPOSIT`, `CASH_TRANSFER_IN`, `POCKET_MONEY` | `Deposit` |
| Cash `WITHDRAWAL`, `CASH_TRANSFER_OUT` | `Withdrawal` |
| Cash `DISTRIBUTION`, `REINVESTMENT_DISTRIBUTION` | `Distribution` |
| Cash `INTEREST`, `INTEREST_PAYMENT` | `Interest` |
| Cash `FEE` | `Fee` |
| Cash `TAX`, `TAX_RETURN` | `Taxes` |
| Non-trade security transaction with `TRANSFER` in its subtype | `Security transfer` |
| Other non-trade security transaction | `Corporate action` |
| Anything else | The subtype, or the kind, as received |

## Columns `lf_*`: what columns 1–14 do not say

| Column | Field | What it is for |
|---|---|---|
| `lf_account` | Not a field | `broker` or `deposit` (the overnight account) |
| `lf_account_index` | Not a field | `1` for the broker; 1, 2… for each overnight account |
| `lf_id` | `id` | The web app's transaction id, stable and unique. It tells apart two transactions that look the same (same day, amount and text) and recognises one already imported. Account ids inside it are masked (see Privacy) |
| `lf_subtype` | `securityTransactionType`, `cashTransactionType` or `nonTradeSecurityTransactionType` | The exact type: `type` gives `Withdrawal` both for a transfer to the overnight account (`CASH_TRANSFER_OUT`) and for one to the bank (`WITHDRAWAL`) |
| `lf_status` | `status` | The exact status: `status` gives `Executed` both for `SETTLED` and for `FILLED` |
| `lf_is_cancellation` | `isCancellation` | `true` for a reversal |
| `lf_ordered_shares` | Trade details `numberOfShares.total`, otherwise `quantity` | The shares ordered, only when not all were executed: an order cancelled, or filled in part. Empty otherwise, where it would repeat `shares` |
| `lf_transaction_fee` | Trade details `tradeTransactionAmounts.transactionFee` | Scalable's order fee, a part of `fee`; empty when there is none |
| `lf_venue_fee` | Trade details `tradeTransactionAmounts.venueFee` | The trading venue's fee, a part of `fee` |
| `lf_crypto_spread_fee` | Trade details `tradeTransactionAmounts.cryptoSpreadFee` | The crypto spread, a part of `fee` |
| `lf_trading_venue` | Trade details `tradingVenue` | Where the trade was executed, e.g. `SEIX` |
| `lf_details` | Not a field | `yes` (details read), `no` (not requested), `error` (could not be read), `n/a` (neither an executed trade nor an interest payment) |
| `lf_exporter` | Not a field | Producer and version, e.g. `librefolio-exporter/1.0.0` |
| `lf_format` | Not a field | Format version of this document |

`lf_ordered_shares`, `lf_transaction_fee`, `lf_venue_fee`, `lf_crypto_spread_fee` and
`lf_trading_venue` are in the broker's file only.

When `lf_details` is `no` or `error`, empty fee and tax fields mean *unknown*, not zero.

## Where each field goes

GraphQL answers only the fields a query asks for, so the queries decide what a file
carries:

- **Broker**: the queries are this extension's (`src/brokers/scalable/queries.js`): the
  transaction list, and from the details of executed trades only what the list does not
  give. A field is added or removed there.
- **Overnight account**: the queries are the web app's own, used as they are.

| Field | Column | Note |
|---|---|---|
| `id` | `lf_id` | |
| `lastEventDateTime` | `date`, `time` | In German local time |
| `transactionReference` | `reference` | Trade and interest details |
| `description` | `description` | |
| `type` | `assetType`, `type` | `SECURITY_TRANSACTION`, `CASH_TRANSACTION`… |
| `securityTransactionType`, `cashTransactionType`, `nonTradeSecurityTransactionType` | `lf_subtype` | Also decide `type` |
| `side` | `type` | `BUY` → `Buy` or `Savings plan`; `SELL` → `Sell` |
| `status` | `lf_status` | Also decides `status` |
| `isCancellation` | `lf_is_cancellation` | |
| `isPending` | None | Interest details; it repeats `status` (`PENDING`) |
| `isin`, `relatedIsin` | `isin` | |
| `quantity`, `eltifQuantity` | `shares` | Without trade details; also `lf_ordered_shares` when not all were executed |
| `numberOfShares.filled` | `shares` | Trade details |
| `numberOfShares.total` | `lf_ordered_shares` | Trade details; only when not all were executed |
| `averagePrice` | `price` | Trade details |
| `amount` | `amount` | |
| `tradeTransactionAmounts.transactionFee` | `lf_transaction_fee` | Trade details; added into `fee` |
| `tradeTransactionAmounts.venueFee` | `lf_venue_fee` | Trade details; added into `fee` |
| `tradeTransactionAmounts.cryptoSpreadFee` | `lf_crypto_spread_fee` | Trade details; added into `fee` |
| `tradeTransactionAmounts.taxAmount` | `tax` | Trade details |
| `taxDetails.taxAmount` | `tax` | Interest details |
| `taxDetails.grossAmount` | None | Interest details; it equals `amount` + `tax` |
| `tradingVenue` | `lf_trading_venue` | Trade details |
| `transactionHistory` | None | Interest details; it repeats the status and the date |
| `currency` | `currency` | |

A field that is not in this table is new:

- it gets a column named after its path, `lf_<path>` (`someObject.someValue` becomes
  `lf_some_object_some_value`), after the `lf_*` columns above, sorted by name, before
  `lf_details`, `lf_exporter` and `lf_format`, which always close the row;
- nested objects are walked; a list is written whole, as JSON;
- the browser console reports its name (`new-fields`, never the value).

On the broker a new field arrives only when the queries ask for it; on the overnight
account, as soon as the web app's own query does.

A field that the list and the details both give is written once, with the list value;
when the details give a different value, it goes to a column of its own,
`lf_details_<name>`. GraphQL's `__typename` is never written, at any depth: it names the
shape of the answer, not the transaction.

## Privacy

What a file must never carry, if it ends up somewhere it should not:

- **Account ids.** The ids of the person (both the UUID of the broker and the short code
  of the interest app), of the portfolio and of each overnight account are never written:
  wherever a value contains one, as the overnight account's transaction ids do, it
  becomes `person-`, `portfolio-` or `account-` followed by an eight-character tag. The
  same id always gives the same tag, so transaction ids stay unique and stable, and the
  tag does not give the id back.
- Nothing in the file opens the account: no credentials, cookies or tokens are ever read.

What stays, because it is the purpose of the file: dates, amounts, quantities, ISINs and
security names, the web app's transaction ids (masked as above) and references, and the
descriptions as received, names and IBANs of transfers included: LibreFolio shows them
with the imported transactions.

## Signs and amounts seen on real data

| Account | Transaction | `amount` | Other values |
|---|---|---|---|
| Broker | Buy (single or savings plan) | Negative: the value of the shares plus the fees | `shares` and `price` positive |
| Broker | Cash `DEPOSIT`, `CASH_TRANSFER_IN` | Positive | |
| Broker | Cash `CASH_TRANSFER_OUT` (to the overnight account) | Negative | |
| Overnight | Interest | Positive, **net** of the tax withheld | Gross interest = `amount` + `tax` |
| Overnight | `DEPOSIT`, `CASH_TRANSFER_IN` (from the broker) | Positive | |
| Overnight | `WITHDRAWAL`, `CASH_TRANSFER_OUT` (to the broker) | Negative | |

The overnight account's web app gives every amount as positive, whatever its direction.
The file makes `amount` negative for `WITHDRAWAL` and the subtypes ending in `_OUT`, as
the broker does; the subtype stays in `lf_subtype`.

## Scope and known gaps

- Every status is exported, cancelled and rejected orders included: consumers filter
  on `lf_status`.
- Person, portfolio and overnight-account ids are never written (see Privacy).
- Cash movements (deposits, transfers, the overnight account) come with a date and no
  time: the web app gives midnight UTC, written as `02:00:00` German summer time
  (`01:00:00` in winter).
- To confirm on real data: sells, dividends, fees and taxes on the broker; whether
  `lastEventDateTime` is the trade or the settlement time; whether `quantity` of an
  order filled in part is the shares ordered or the shares executed (the details give
  both, so the file is right when they are read).

## Compared with Scalable's own export

Checked against two real exports published on GitHub and the samples of the parsers
that read them (2026-10).

| Aspect | Scalable's export | This file |
|---|---|---|
| Columns | The 14 above | The same 14, then the `lf_*` columns |
| Accounts | Broker only | Broker and overnight account |
| `reference` | On every row, 15 letters and digits (`SCAL…`) | `SCAL…` on executed trades and `INTEREST-PAY-…` on interest, whose details are read; empty on the other rows, whose id is in `lf_id` |
| `shares` | Shares executed: `0` for a cancelled order | The same |
| `fee`, `tax` of trades | Always filled, `0` when none | The same when the details are read; empty when they are not: unknown |
| `fee`, `tax` of cash rows | `fee` `0`, `tax` empty in the samples ❓ | Both empty; `tax` filled on interest |
| `price` of security transfers | Filled | Empty: their details are not read |
| Exact type and status, parts of `fee`, venue, transaction id | Not there | `lf_*` columns |
| File name | `YYYY_MM_DD_HH_MM_SS_ScalableCapital-Broker-Transactions.csv` | `<prefix>-broker_<timestamp>.csv`, `<prefix>-deposit_<timestamp>.csv` |
| Form | `;`, decimal comma, German local time, quoted `reference` and `description` | The same |

## Versioning

`lf_format` changes only when the meaning or the order of existing columns changes.
New `lf_*` columns may appear within the same version, new fields of the web app
included: consumers read columns by name.
