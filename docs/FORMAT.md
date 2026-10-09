# CSV format

Format version **1** (`lf_format` = `1`). One file per account:
`<prefix>-broker_<timestamp>.csv` and `<prefix>-deposit_<timestamp>.csv`, where the
prefix is `scalable` unless the user changes it. When both accounts are exported
together, the two files come in one ZIP, `<prefix>_<timestamp>.zip`, with the same names
inside.

## Conventions

| Aspect | Value |
|---|---|
| Encoding | UTF-8, no BOM |
| Line ending | LF; the file ends with a line ending |
| Delimiter | `;` |
| Quoting | `reference` and `description` are always quoted; other fields only when they contain `;`, `"` or a line break; `"` is doubled |
| Prime columns (1–14) | Decimal comma, no thousands separator; date `YYYY-MM-DD` and time `HH:MM:SS` in German local time (Europe/Berlin), like the official export |
| `lf_*` columns | Values copied from the web app: decimal point, no rounding, no thousands separator; timestamps as received |
| Missing value | Empty field |

Amounts are never rounded or recomputed. The only derived value is `fee`, the exact
decimal sum of `lf_transaction_fee`, `lf_venue_fee` and `lf_crypto_spread_fee`.

*Details* are read with one extra request per item, when the user keeps the option on:
the details of executed trades (broker) and of interest payments (overnight account).

## Columns 1–14: the official Scalable CSV layout

The header is the one of Scalable's own CSV export (PRIME):
`date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency`.
Tools that read that export can read these files. The labels are a **best-effort**
mapping from the web app's values, so a consumer that recognises the `lf_*` columns
must read those instead.

| Column | Source |
|---|---|
| `date`, `time` | `lastEventDateTime`, converted to Europe/Berlin |
| `status` | `SETTLED`, `FILLED`, `CONFIRMED` → `Executed`; `CANCELLED` → `Cancelled`; `EXPIRED` → `Expired`; `REJECTED` → `Rejected`; `CREATED`, `REQUESTED`, `PENDING`, `PARTIAL_FILLED`, `CANCEL_REQUESTED` → `Pending`; any other value as received |
| `reference` | `transactionReference` from the trade or interest details when read, otherwise the transaction id (account ids masked) |
| `description` | Transaction description as received (the security name for trades) |
| `assetType` | `Cash` for cash transactions and the overnight account, `Security` otherwise |
| `type` | See below |
| `isin` | `isin`, or `relatedIsin` for distributions |
| `shares` | Shares executed: trade details `numberOfShares.filled`, otherwise `quantity` (`eltifQuantity` for ELTIF); `0` for a cancelled, rejected or expired order, like the official export |
| `price` | Trade details `averagePrice` |
| `amount` | `amount`, sign as received; on the overnight account, negative for outflows (see below) |
| `fee` | Sum of the trade fees (see above); `0` when the details are read and give none, empty when they are not read |
| `tax` | Trade details `tradeTransactionAmounts.taxAmount`; for interest, `taxDetails.taxAmount`; `0` and empty as for `fee` |
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

## Columns `lf_*`: the web app's fields

The `lf_*` columns are the fields that the queries return, one column per field, values
as received. GraphQL answers only the fields a query asks for, so the queries decide what
a file carries:

- **Broker**: the queries are this extension's (`src/brokers/scalable/queries.js`): the
  transaction list, and the details of executed trades for what the list does not already
  give. A field is added or removed there, not with a filter.
- **Overnight account**: the queries are the web app's own, used as they are, so every
  field they return is written. When Scalable adds one, it arrives as a new column and the
  browser console reports its name (`new-fields`, never the values).
- Only GraphQL's `__typename` is left out, at any depth: it names the shape of the answer,
  not the transaction.

How fields become columns:

- Known fields have a short name and a fixed place (table below).
- Any other field is named after its path: `numberOfShares.total` would become
  `lf_number_of_shares_total`. Nested objects are walked; a list is written whole, as
  JSON. New columns come after the known ones, sorted by name, before `lf_details`,
  `lf_exporter` and `lf_format`, which always close the row.
- A field that the list and the details both give is written once, with the list value;
  when the details give a different value, it goes to a column of its own,
  `lf_details_<name>`.

| Column | Field | What it is for |
|---|---|---|
| `lf_account` | Not a field | `broker` or `deposit` (the overnight account) |
| `lf_account_index` | Not a field | `1` for the broker; 1, 2… for each overnight account |
| `lf_id` | `id` | The web app's transaction id: stable, the key to recognise a transaction already imported. Account ids inside it are masked (see Privacy) |
| `lf_kind` | `type` | `SECURITY_TRANSACTION`, `CASH_TRANSACTION`… |
| `lf_subtype` | `securityTransactionType`, `cashTransactionType` or `nonTradeSecurityTransactionType` | `SAVINGS_PLAN`, `SINGLE`, `DEPOSIT`, `INTEREST`…: decides the LibreFolio type |
| `lf_side` | `side` | `BUY` or `SELL` |
| `lf_status` | `status` | `SETTLED`…: which transactions count |
| `lf_is_cancellation` | `isCancellation` | A reversal |
| `lf_is_pending` | `isPending` (overnight details) | Not settled yet |
| `lf_timestamp_utc` | `lastEventDateTime` | The exact time, in UTC |
| `lf_description` | `description` | As received: the security name of a trade, the text of a transfer, names and IBANs included |
| `lf_isin` | `isin` | The security |
| `lf_related_isin` | `relatedIsin` | The security of a distribution |
| `lf_currency` | `currency` | |
| `lf_amount` | `amount` | The amount, as the web app gives it |
| `lf_quantity` | `quantity`, or `eltifQuantity` for ELTIF | The quantity |
| `lf_price` | Trade details `averagePrice` | Average execution price |
| `lf_filled_shares` | Trade details `numberOfShares.filled` | Shares executed |
| `lf_total_shares` | Trade details `numberOfShares.total` | Shares ordered: more than the executed ones when an order is filled only in part |
| `lf_total_amount` | Trade details `totalAmount` | Total of the trade, fees included |
| `lf_market_valuation` | Trade details `tradeTransactionAmounts.marketValuation` | Value of the shares, before fees |
| `lf_transaction_fee`, `lf_venue_fee`, `lf_crypto_spread_fee` | Trade details `tradeTransactionAmounts.*` | Each fee; empty when there is none |
| `lf_tax_amount` | Trade details `tradeTransactionAmounts.taxAmount`; for interest, `taxDetails.taxAmount` | Tax; on interest, the tax withheld |
| `lf_gross_amount` | Interest details `taxDetails.grossAmount` | Interest before tax |
| `lf_fee`, `lf_transactional_fee`, `lf_taxes` | Trade details `fee`, `transactionalFee`, `taxes` | Totals of the details; empty on every trade seen so far ❓ |
| `lf_trading_venue` | Trade details `tradingVenue` | Where the trade was executed, e.g. `SEIX` |
| `lf_transaction_reference` | `transactionReference` from the trade or interest details | Scalable's reference, as on its documents (`SCAL…`) |
| `lf_transaction_history` | Overnight details `transactionHistory` | Status changes with their times, as JSON |
| `lf_details` | Not a field | `yes` (details read), `no` (not requested), `error` (could not be read), `n/a` (neither an executed trade nor an interest payment) |
| `lf_exporter` | Not a field | Producer and version, e.g. `librefolio-exporter/0.1.0` |
| `lf_format` | Not a field | Format version of this document |

When `lf_details` is `no` or `error`, empty fee and tax fields mean *unknown*, not zero.

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

All values keep the sign the web app gives them. What real exports have shown so far:

| Account | Transaction | `lf_amount` | Other values |
|---|---|---|---|
| Broker | Buy (single or savings plan) | Negative: `-(market valuation + fees)`, equal to `lf_total_amount` | `lf_quantity` and `lf_price` positive |
| Broker | Cash `DEPOSIT`, `CASH_TRANSFER_IN` | Positive | |
| Broker | Cash `CASH_TRANSFER_OUT` (to the overnight account) | Negative | |
| Overnight | Every transaction | **Always positive**, whatever its direction | The direction is in `lf_subtype` |
| Overnight | Interest | Positive, **net** of the tax withheld | `lf_gross_amount` = `lf_amount` + `lf_tax_amount` |
| Overnight | `DEPOSIT`, `CASH_TRANSFER_IN` (from the broker) | Positive | |
| Overnight | `WITHDRAWAL`, `CASH_TRANSFER_OUT` (to the broker) | Positive | The Prime `amount` column makes them negative |

In the Prime columns of the overnight account, `amount` is negative for the subtypes
`WITHDRAWAL` and those ending in `_OUT`, like the official export; `lf_amount` keeps the
value as received.

## Scope and known gaps

- Every status is exported, cancelled and rejected orders included: consumers filter
  on `lf_status`.
- Person, portfolio and overnight-account ids are never written (see Privacy).
- To confirm on real data: sells, dividends, fees and taxes on the broker; whether
  `lastEventDateTime` is the trade or the settlement time.

## Compared with Scalable's own export

Checked against two real exports published on GitHub and the samples of the parsers
that read them (2026-10).

| Aspect | Scalable's export | This file |
|---|---|---|
| Columns | The 14 above | The same 14, then the `lf_*` columns |
| Accounts | Broker only | Broker and overnight account |
| `reference` | 15 letters and digits, the `transactionReference` | The same when the details are read (executed trades, interest); otherwise the web app's id |
| `shares` | Shares executed: `0` for a cancelled order | The same |
| `fee`, `tax` of trades | Always filled, `0` when none | The same when the details are read; empty when they are not: unknown |
| `fee` of cash rows | `0` in the samples ❓ | Empty |
| `price` of security transfers | Filled | Empty: their details are not read |
| File name | `YYYY_MM_DD_HH_MM_SS_ScalableCapital-Broker-Transactions.csv` | `<prefix>-broker_<timestamp>.csv`, `<prefix>-deposit_<timestamp>.csv` |
| Form | `;`, decimal comma, German local time, quoted `reference` and `description` | The same |

## Versioning

`lf_format` changes only when the meaning or the order of existing columns changes.
New `lf_*` columns may appear within the same version, new fields of the web app
included: consumers read columns by name.
