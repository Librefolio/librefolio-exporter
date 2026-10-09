# Scalable Capital: CSV files

One file per account: `<prefix>-broker_<timestamp>.csv` and
`<prefix>-deposit_<timestamp>.csv` (the overnight account, *conto deposito*), where the
prefix is `scalable` unless the user changes it. When both accounts are exported
together, the two files come in one ZIP, `<prefix>_<timestamp>.zip`, with the same names
inside.

Each file starts with the 14 columns of Scalable's own CSV export (PRIME), so tools that
read that export read these files too. Then come the `lf_*` columns, with what those 14
do not say. Every field is written once, and columns are read by name.

## Form

| Aspect | Value |
|---|---|
| Encoding | UTF-8, no BOM |
| Line ending | LF; the file ends with a line ending |
| Delimiter | `;` |
| Quoting | `reference` and `description` are always quoted; other fields only when they contain `;`, `"` or a line break; `"` is doubled |
| Columns 1–14 | Decimal comma, no thousands separator; date `YYYY-MM-DD` and time `HH:MM:SS` in German local time (Europe/Berlin), like the official export |
| `lf_*` columns | Values as the web app gives them: decimal point, no rounding |
| Missing value | Empty field |

Amounts are never rounded or recomputed. The only derived value is `fee`, the exact sum
of `lf_transaction_fee`, `lf_venue_fee` and `lf_crypto_spread_fee`. Some signs come from
the transaction rather than from the value: the value of a trade's shares takes the sign
of its `side`, and the overnight account's outflows become negative (see below).

The *details* of executed trades (broker) and of interest payments (overnight account)
are read with one extra request each, when the user keeps the option on. Without them,
`reference`, `fee` and `tax` of those rows stay empty: unknown, not zero; and a trade's
`amount` is the web app's, fees included. When some details cannot be read, the panel
says how many.

## Columns 1–14: Scalable's official layout

`date;time;status;reference;description;assetType;type;isin;shares;price;amount;fee;tax;currency`

| Column | Content |
|---|---|
| `date`, `time` | `lastEventDateTime`, in German local time |
| `status` | `status`: `SETTLED`, `FILLED`, `CONFIRMED` → `Executed`; `CANCELLED` → `Cancelled`; `EXPIRED` → `Expired`; `REJECTED` → `Rejected`; `CREATED`, `REQUESTED`, `PENDING`, `PARTIAL_FILLED`, `CANCEL_REQUESTED` → `Pending`; any other value as received |
| `reference` | `transactionReference`, from the details: `SCAL…` for trades, the reference on Scalable's documents; `INTEREST-PAY-…` for interest. Empty on the other rows |
| `description` | `description` as received: the security name of a trade, the text of a transfer, names and IBANs included |
| `assetType` | From `type`: `Cash` for cash transactions and the overnight account, `Security` otherwise |
| `type` | See below |
| `isin` | `isin`, or `relatedIsin` for distributions |
| `shares` | Shares executed: details `numberOfShares.filled`, otherwise `quantity` (`eltifQuantity` for ELTIF); `0` for a cancelled, rejected or expired order, like the official export |
| `price` | Details `averagePrice` |
| `amount` | For an executed trade whose details are read: details `tradeTransactionAmounts.marketValuation`, with the sign of the trade (negative for a buy): the value of the shares, fees and taxes apart, as in Scalable's own export. Otherwise `amount` as the web app gives it, fees included; on the overnight account, negative for outflows (see below) |
| `fee` | Sum of the fees in the details; `0` when they give none |
| `tax` | Details `tradeTransactionAmounts.taxAmount`; for interest, `taxDetails.taxAmount`, the tax withheld; `0` when they give none |
| `currency` | `currency` |

`type`, from the kind of transaction, its `side` and its subtype:

| Web app | `type` |
|---|---|
| Trade, `side` `BUY`, `securityTransactionType` `SAVINGS_PLAN` | `Savings plan` |
| Trade or ELTIF, `side` `BUY` | `Buy` |
| Trade or ELTIF, `side` `SELL` | `Sell` |
| Cash, `cashTransactionType` `DEPOSIT`, `CASH_TRANSFER_IN`, `POCKET_MONEY` | `Deposit` |
| Cash `WITHDRAWAL`, `CASH_TRANSFER_OUT` | `Withdrawal` |
| Cash `DISTRIBUTION`, `REINVESTMENT_DISTRIBUTION` | `Distribution` |
| Cash `INTEREST`, `INTEREST_PAYMENT` | `Interest` |
| Cash `FEE` | `Fee` |
| Cash `TAX`, `TAX_RETURN` | `Taxes` |
| Non-trade security transaction, `nonTradeSecurityTransactionType` with `TRANSFER` in it | `Security transfer` |
| Other non-trade security transaction | `Corporate action` |
| Anything else | The subtype, or the kind, as received |

## Columns `lf_*`

| Column | Field | What it is for |
|---|---|---|
| `lf_account` | — | `broker` or `deposit`: which account the file is, whatever its name |
| `lf_account_index` | — | 1, 2… for each overnight account. In the overnight account's file only: the broker has one portfolio |
| `lf_id` | `id` | The web app's transaction id, stable and unique: it tells apart two transactions that look the same (same day, amount and text) and recognises one already imported. Account ids inside it are masked (see Privacy) |
| `lf_subtype` | `securityTransactionType`, `cashTransactionType` or `nonTradeSecurityTransactionType` | The exact type: `type` says `Withdrawal` both for a transfer to the overnight account (`CASH_TRANSFER_OUT`) and for one to the bank (`WITHDRAWAL`) |
| `lf_is_cancellation` | `isCancellation` | `true` when the transaction reverses another one, already booked; empty otherwise. Without it, a reversal looks like any other transaction |
| `lf_ordered_shares` | Details `numberOfShares.total`, otherwise `quantity` | The shares ordered, only when not all were executed: an order cancelled, or filled in part |
| `lf_transaction_fee` | Details `tradeTransactionAmounts.transactionFee` | Scalable's order fee, a part of `fee` |
| `lf_venue_fee` | Details `tradeTransactionAmounts.venueFee` | The trading venue's fee, a part of `fee` |
| `lf_crypto_spread_fee` | Details `tradeTransactionAmounts.cryptoSpreadFee` | The crypto spread, a part of `fee` |
| `lf_trading_venue` | Details `tradingVenue` | Where the trade was executed, e.g. `SEIX` |

The last five are in the broker's file only.

## Signs, dates and amounts

| Account | Transaction | `amount` |
|---|---|---|
| Broker | Buy (single or savings plan) | Negative: the value of the shares; without the details, the value of the shares plus the fees |
| Broker | Sell | Positive: the value of the shares; without the details, as the web app gives it |
| Broker | Cash `DEPOSIT`, `CASH_TRANSFER_IN` | Positive |
| Broker | Cash `CASH_TRANSFER_OUT` (to the overnight account) | Negative |
| Overnight | Interest | Positive, net of the tax withheld: the gross interest is `amount` + `tax` |
| Overnight | `DEPOSIT`, `CASH_TRANSFER_IN` (from the broker) | Positive |
| Overnight | `WITHDRAWAL`, `CASH_TRANSFER_OUT` (to the broker) | Negative |

- The overnight account's web app gives every amount as positive: the file makes the
  outflows negative, as the broker does.
- A trade's `amount` is not rounded to the cent (for example `-3161,145`), as in
  Scalable's own export. Added up over a whole export, the `amount` of the executed rows,
  less the `fee` and `tax` of the broker's trades, gives the account's balance, up to
  such half cents (checked on real data).
- Cash movements come with a date and no time: the web app gives midnight UTC, written
  as `02:00:00` German summer time (`01:00:00` in winter).

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
security names, the transaction ids (masked as above) and references, and the
descriptions as received, names and IBANs of transfers included: LibreFolio shows them
with the imported transactions.

## Compared with Scalable's own export

Checked against two real exports published on GitHub and the samples of the parsers
that read them (2026-10).

| Aspect | Scalable's export | These files |
|---|---|---|
| Columns | The 14 above | The same 14, then the `lf_*` columns |
| Accounts | Broker only | Broker and overnight account |
| `reference` | On every row, 15 letters and digits (`SCAL…`) | `SCAL…` on executed trades and `INTEREST-PAY-…` on interest, whose details are read; empty on the other rows, whose id is in `lf_id` |
| `shares` | Shares executed: `0` for a cancelled order | The same |
| `amount` of trades | The value of the shares, fees and taxes apart | The same when the details are read; when they are not, the web app's amount, fees included |
| `fee`, `tax` of trades | Always filled, `0` when none | The same when the details are read; empty when they are not: unknown |
| `fee`, `tax` of cash rows | `fee` `0`, `tax` empty in the samples ❓ | Both empty; `tax` filled on interest |
| `price` of security transfers | Filled | Empty: their details are not read |
| Transaction id, exact type, reversals, parts of the fee, venue | Not there | `lf_*` columns |
| File name | `YYYY_MM_DD_HH_MM_SS_ScalableCapital-Broker-Transactions.csv` | `<prefix>-broker_<timestamp>.csv`, `<prefix>-deposit_<timestamp>.csv` |
| Form | `;`, decimal comma, German local time, quoted `reference` and `description` | The same |

## Scope and known gaps

- Every status is exported, cancelled and rejected orders included: consumers filter
  on `status`.
- To confirm on real data: sells, dividends, fees and taxes on the broker; whether
  `lastEventDateTime` is the trade or the settlement time; how a reversal looks
  (`lf_is_cancellation` has not been seen `true` yet).
- An order filled in part and then cancelled or expired would show `shares` `0`, since
  the details of such orders are not read ❓.

## Stability

Columns are read by name. A column never changes meaning: a different meaning gets a
new name. New columns may appear at the end of the row:

- a field that the web app adds is written as `lf_<path>`: `someObject.someValue`
  becomes `lf_some_object_some_value`, nested objects are walked and a list is written
  whole, as JSON. The browser console reports its name (`new-fields`, never the value);
- a field that the list and the details give with different values is written once
  more, as `lf_details_<name>`.

## Fields not written

The broker's queries are this extension's own and ask only for what the file carries.
The overnight account's queries are the web app's own, used as they are, so they also
return fields that serve only its pages and would repeat other columns:

| Field | Why it is not written |
|---|---|
| `isPending` | Repeats `status` |
| `taxDetails.grossAmount` | Equals `amount` + `tax` |
| `transactionHistory` | Repeats `status` and the date |

GraphQL's `__typename`, which names the shape of an answer, is never written either.
