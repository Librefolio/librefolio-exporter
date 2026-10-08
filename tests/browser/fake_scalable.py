"""Fake Scalable web app for the real-browser test: pages and two GraphQL endpoints.

As in the browser, the broker endpoint answers any broker query, while the interest app
answers only the queries of its own pages: the Transactions page of the overnight account
carries the recipe of its list (Next.js server data with an Apollo query reference), and
only that query, sent unchanged, gets the list.

Usage: python3 fake_scalable.py <requests.jsonl> <cert.pem> <key.pem> <port>
"""
import json
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG, CERT, KEY, PORT = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

BROKER_PATH = "/broker/api/data"
INTEREST_PATH = "/interest/api/graphql/"
TRANSACTIONS_PAGE = "/interest/overnight/sav-123456/transactions/"

RECIPE_QUERY = (
    "query Transactions($personId:ID!$input:SavingsAccountCashTransactionInput!$portfolioId:ID!)"
    "{account(id:$personId){id savingsAccount(id:$portfolioId){id ...TransactionsListContainer@unmask}}}"
    "fragment TransactionsListContainer on SavingsAccount{id moreTransactions(input:$input)"
    "{cursor total transactions{id currency type status isCancellation lastEventDateTime description amount cashTransactionType}}}"
)
RECIPE_VARIABLES = {"personId": "short-123456", "portfolioId": "sav-123456", "input": {"pageSize": 50}}

PAGE = b"""<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Fake Scalable</title>
<script>sessionStorage.setItem('uniqueId', 'person-123456');</script></head>
<body><main><h1>Transazioni</h1><a href="/interest/overnight/sav-123456">Conto deposito</a></main></body></html>"""


def transactions_page():
    reference = {"options": {"query": RECIPE_QUERY, "variables": RECIPE_VARIABLES}, "queryKey": "k", "stream": "$@7"}
    data = '0:{}\n5:["$","$L6",null,{"queryRef":{"$__apollo_queryRef":%s}}]\n' % json.dumps(reference)
    push = json.dumps([1, data]).replace("</", "<\\/")
    return ("<!doctype html><html><body><script>self.__next_f.push([0])</script>"
            "<script>self.__next_f.push(%s)</script></body></html>" % push).encode()


BROKER = {
    "moreTransactions": {"data": {"account": {"brokerPortfolio": {"moreTransactions": {"cursor": None, "transactions": [
        {"__typename": "BrokerSecurityTransactionSummary", "id": "t1", "type": "SECURITY_TRANSACTION", "status": "SETTLED",
         "lastEventDateTime": "2026-09-01T08:00:00Z", "description": "Some ETF", "securityTransactionType": "SAVINGS_PLAN",
         "side": "BUY", "quantity": 2.5, "amount": -250, "isin": "IE00TEST0001", "currency": "EUR"},
        {"__typename": "BrokerCashTransactionSummary", "id": "c1", "type": "CASH_TRANSACTION", "status": "SETTLED",
         "lastEventDateTime": "2026-08-31T08:00:00Z", "description": "Deposit; \"SEPA\"", "cashTransactionType": "DEPOSIT",
         "amount": 500, "currency": "EUR"},
    ]}}}}},
    "getTransactionDetails": {"data": {"account": {"brokerPortfolio": {"transactionDetails": {
        "transactionReference": "R1", "averagePrice": 100, "tradeTransactionAmounts": {"transactionFee": 0.99, "taxAmount": 0}}}}}},
}
DEPOSIT_LIST = {"data": {"account": {"savingsAccount": {"moreTransactions": {"cursor": None, "total": 2, "transactions": [
    {"id": "d1", "type": "CASH_TRANSACTION", "status": "SETTLED", "isCancellation": False, "description": "Interest", "amount": 1.23,
     "currency": "EUR", "lastEventDateTime": "2026-09-30T23:00:00Z", "cashTransactionType": "INTEREST"},
    {"id": "d2", "type": "CASH_TRANSACTION", "status": "SETTLED", "isCancellation": False, "description": "Withdrawal", "amount": 2.5,
     "currency": "EUR", "lastEventDateTime": "2026-09-29T10:00:00Z", "cashTransactionType": "WITHDRAWAL"},
]}}}}}
DEPOSIT_DETAILS = {"data": {"account": {"savingsAccount": {"transactionDetails": {
    "__typename": "SavingsAccountCashTransaction", "id": "d1", "isCancellation": False, "transactionReference": "RI-1",
    "taxDetails": {"grossAmount": 1.67, "taxAmount": 0.44}}}}}}
REFUSED = {"errors": [{"message": "Unauthorized access", "extensions": {"code": "UNAUTHENTICATED"}}],
           "data": {"account": {"savingsAccount": None}}}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def record(self, operation):
        entry = {
            "path": self.path,
            "operation": operation,
            "cookie": "session=fake-session" in (self.headers.get("Cookie") or ""),
            "features": self.headers.get("x-scacap-features-enabled"),
            "origin": self.headers.get("Origin"),
            "fetchSite": self.headers.get("Sec-Fetch-Site"),
        }
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps(entry) + "\n")

    def reply(self, status, content_type, data, cookie=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if cookie:
            self.send_header("Set-Cookie", "session=fake-session; Path=/; Secure; HttpOnly; SameSite=Lax")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == TRANSACTIONS_PAGE:
            self.record("GET")
            self.reply(200, "text/html; charset=utf-8", transactions_page())
            return
        self.reply(200, "text/html; charset=utf-8", PAGE, cookie=True)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        operation = body.get("operationName")
        self.record(operation)
        if self.path == BROKER_PATH:
            payload = BROKER.get(operation, REFUSED)
        elif self.path == INTEREST_PATH:
            if operation == "Transactions" and body.get("query") == RECIPE_QUERY.replace("@unmask", "") and body.get("variables") == RECIPE_VARIABLES:
                payload = DEPOSIT_LIST
            elif operation == "OvernightTransactionDetails" and (body.get("variables") or {}).get("personId") == "short-123456":
                payload = DEPOSIT_DETAILS
            else:
                payload = REFUSED
        else:
            self.reply(404, "text/plain", b"not found")
            return
        self.reply(200, "application/json", json.dumps(payload).encode())


server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(CERT, KEY)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
