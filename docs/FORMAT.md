# CSV format

Format version **1** (`lf_format` = `1`). One file per account:
`scalable-broker_<timestamp>.csv` and `scalable-deposit_<timestamp>.csv`.

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
| `reference` | Trade details `transactionReference` when read, otherwise the transaction id |
| `description` | Transaction description (the security name for trades) |
| `assetType` | `Cash` for cash transactions and the overnight account, `Security` otherwise |
| `type` | See below |
| `isin` | `isin`, or `relatedIsin` for distributions |
| `shares` | `quantity` (`eltifQuantity` for ELTIF), sign as received |
| `price` | Trade details `averagePrice` |
| `amount` | `amount`, sign as received |
| `fee` | Sum of the trade fees (see above) |
| `tax` | Trade details `taxAmount` |
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

## Columns `lf_*`: verbatim values

| Column | Content |
|---|---|
| `lf_account` | `broker` or `deposit` (the overnight account) |
| `lf_account_index` | `1` for the broker; 1, 2… for each overnight account |
| `lf_id` | Transaction id in the web app (stable: use it to detect duplicates) |
| `lf_kind` | `type`, e.g. `SECURITY_TRANSACTION`, `CASH_TRANSACTION` |
| `lf_subtype` | `securityTransactionType`, `cashTransactionType` or `nonTradeSecurityTransactionType` |
| `lf_side` | `BUY` or `SELL` for trades |
| `lf_status` | Status as received, e.g. `SETTLED` |
| `lf_is_cancellation` | `true`, `false` or empty |
| `lf_timestamp_utc` | `lastEventDateTime` as received |
| `lf_amount` | `amount` |
| `lf_quantity` | `quantity` or `eltifQuantity` |
| `lf_price` | Trade details `averagePrice` |
| `lf_filled_shares` | Trade details `numberOfShares.filled` |
| `lf_total_amount` | Trade details `totalAmount` |
| `lf_market_valuation` | Trade details `tradeTransactionAmounts.marketValuation` |
| `lf_transaction_fee`, `lf_venue_fee`, `lf_crypto_spread_fee` | Trade details `tradeTransactionAmounts.*` |
| `lf_tax_amount` | Trade details `tradeTransactionAmounts.taxAmount` |
| `lf_fee`, `lf_transactional_fee`, `lf_taxes` | Trade details `fee`, `transactionalFee`, `taxes` |
| `lf_trading_venue` | Trade details `tradingVenue` |
| `lf_transaction_reference` | Trade details `transactionReference` |
| `lf_details` | `yes` (details read), `no` (not requested), `error` (could not be read), `n/a` (not a trade) |
| `lf_exporter` | Producer and version, e.g. `librefolio-exporter/0.1.0` |
| `lf_format` | Format version of this document |

When `lf_details` is `no` or `error`, empty fee and tax fields mean *unknown*, not zero.

## Scope and known gaps

- Every status is exported, cancelled and rejected orders included: consumers filter
  on `lf_status`.
- Account and person identifiers are never written; only transaction ids are.
- To confirm on real data: the sign conventions of `amount`, `shares`, fees and taxes;
  whether `lastEventDateTime` is the trade or the settlement time; the subtypes used
  for transfers between the broker and the overnight account.

## Versioning

`lf_format` changes only when the meaning or the order of existing columns changes.
New `lf_*` columns may be appended within the same version: consumers read columns by
name.
