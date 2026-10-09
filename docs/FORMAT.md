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
| `description` | Transaction description (the security name for trades), IBANs shortened |
| `assetType` | `Cash` for cash transactions and the overnight account, `Security` otherwise |
| `type` | See below |
| `isin` | `isin`, or `relatedIsin` for distributions |
| `shares` | Shares executed: trade details `numberOfShares.filled`, otherwise `quantity` (`eltifQuantity` for ELTIF); `0` for a cancelled, rejected or expired order, like the official export |
| `price` | Trade details `averagePrice` |
| `amount` | `amount`, sign as received; on the overnight account, negative for outflows (see below) |
| `fee` | Sum of the trade fees (see above) |
| `tax` | Trade details `tradeTransactionAmounts.taxAmount`; for interest, `taxDetails.taxAmount` |
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

Every field of a transaction, from the list and from its details when they are read,
is written as an `lf_*` column, **except the excluded fields** below. A field that
Scalable adds to a response therefore reaches the CSV by itself; the browser console
reports its name (`new-fields`, never the values), so that it can be named and
documented.

- **Known fields** have a short name and a fixed place (table below).
- **Any other field** is named after its path: `numberOfShares.total` would become
  `lf_number_of_shares_total`. Nested objects are walked; a list is written whole, as
  JSON. New columns come after the known ones, sorted by name, before `lf_details`,
  `lf_exporter` and `lf_format`, which always close the row.
- A field present both in the list and in the details is written once, with the list
  value; when the details give a different value, it goes to a column of its own,
  `lf_details_<name>`, so nothing is lost.
- GraphQL returns only the fields a query asks for. The overnight account's list is read
  with the web app's own query, so new fields there arrive by themselves; the broker's
  queries are this extension's, and a new broker field arrives only once a new version
  asks for it.

| Column | Field |
|---|---|
| `lf_account` | `broker` or `deposit` (the overnight account): not a field |
| `lf_account_index` | `1` for the broker; 1, 2… for each overnight account: not a field |
| `lf_id` | `id`, the transaction id in the web app (stable: use it to detect duplicates); account ids inside it are masked (see Privacy) |
| `lf_kind` | `type`, e.g. `SECURITY_TRANSACTION`, `CASH_TRANSACTION` |
| `lf_subtype` | `securityTransactionType`, `cashTransactionType` or `nonTradeSecurityTransactionType` |
| `lf_side` | `side`: `BUY` or `SELL` for trades |
| `lf_status` | `status` as received, e.g. `SETTLED` |
| `lf_is_cancellation` | `isCancellation`: `true`, `false` or empty |
| `lf_timestamp_utc` | `lastEventDateTime` as received |
| `lf_amount` | `amount` |
| `lf_quantity` | `quantity`, or `eltifQuantity` for ELTIF: the quantity ordered |
| `lf_price` | Trade details `averagePrice` |
| `lf_filled_shares` | Trade details `numberOfShares.filled` |
| `lf_total_shares` | Trade details `numberOfShares.total` |
| `lf_total_amount` | Trade details `totalAmount` |
| `lf_market_valuation` | Trade details `tradeTransactionAmounts.marketValuation` |
| `lf_transaction_fee`, `lf_venue_fee`, `lf_crypto_spread_fee` | Trade details `tradeTransactionAmounts.*` |
| `lf_tax_amount` | Trade details `tradeTransactionAmounts.taxAmount`; for interest, `taxDetails.taxAmount` (the tax withheld) |
| `lf_gross_amount` | Interest details `taxDetails.grossAmount`, the interest before tax |
| `lf_fee`, `lf_transactional_fee`, `lf_taxes` | Trade details `fee`, `transactionalFee`, `taxes` |
| `lf_trading_venue` | Trade details `tradingVenue` |
| `lf_transaction_reference` | `transactionReference` from the trade or interest details |
| `lf_details` | `yes` (details read), `no` (not requested), `error` (could not be read), `n/a` (neither an executed trade nor an interest payment) |
| `lf_exporter` | Producer and version, e.g. `librefolio-exporter/0.1.0` |
| `lf_format` | Format version of this document |

When `lf_details` is `no` or `error`, empty fee and tax fields mean *unknown*, not zero.

### Excluded fields

| Field | Why it is left out |
|---|---|
| `__typename` (at any depth) | GraphQL type name, internal to the web app |
| `currency` | In the Prime column `currency` |
| `description` | In the Prime column `description` |
| `isin` | In the Prime column `isin` |
| `relatedIsin` | In the Prime column `isin` (distributions) |
| `security.isin` | In the Prime column `isin` |
| `security.name` | In the Prime column `description` |
| `security.id` | Internal id of the security; the ISIN identifies it |
| `isPending` | Repeats the status |
| `transactionHistory` | The web app's log of status changes; the date and the status have their columns |

The list is `EXCLUDED_FIELDS` in `src/brokers/scalable/mapping.js`; a test keeps it and
this table in step.

## Privacy

What a file must never carry, if it ends up somewhere it should not:

- **Account ids.** The ids of the person (both the UUID of the broker and the short code
  of the interest app), of the portfolio and of each overnight account are never written:
  wherever a value contains one, as the overnight account's transaction ids do, it
  becomes `person-`, `portfolio-` or `account-` followed by an eight-character tag. The
  same id always gives the same tag, so transaction ids stay unique and stable, and the
  tag does not give the id back.
- **IBANs** in descriptions are shortened as on a bank statement: `IT60…3456`.
- Nothing in the file opens the account: no credentials, cookies or tokens are ever read.

What stays, because it is the purpose of the file: dates, amounts, quantities, ISINs and
security names, the web app's transaction ids (masked as above) and references, and the
descriptions, which for transfers from other banks may contain a name.

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
| `fee`, `tax` of trades | Always filled, `0` when none | Filled when the details are read; empty means unknown |
| `fee` of cash rows | `0` in the samples ❓ | Empty |
| `price` of security transfers | Filled | Empty: their details are not read |
| File name | `YYYY_MM_DD_HH_MM_SS_ScalableCapital-Broker-Transactions.csv` | `<prefix>-broker_<timestamp>.csv`, `<prefix>-deposit_<timestamp>.csv` |
| Form | `;`, decimal comma, German local time, quoted `reference` and `description` | The same |

## Versioning

`lf_format` changes only when the meaning or the order of existing columns changes.
New `lf_*` columns may appear within the same version, new fields of the web app
included: consumers read columns by name.
