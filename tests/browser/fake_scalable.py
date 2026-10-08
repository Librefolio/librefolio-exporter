"""Fake Scalable web app for the real-browser test: one page and the GraphQL endpoint.

Usage: python3 fake_scalable.py <requests.jsonl> <cert.pem> <key.pem> <port>
"""
import json
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG, CERT, KEY, PORT = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])

PAGE = b"""<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Fake Scalable</title>
<script>sessionStorage.setItem('uniqueId', 'person-123456');</script></head>
<body><main><h1>Transazioni</h1><a href="/interest/overnight/sav-123456">Conto deposito</a></main></body></html>"""

RESPONSES = {
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
    "getSavingsProducts": {"data": {"account": {"savingsAccounts": [{"__typename": "OvernightSavingsAccount", "id": "sav-123456"}]}}},
    "OvernightTransactions": {"data": {"account": {"savingsAccount": {"totalAmount": 1000, "moreTransactions": {"cursor": None, "transactions": [
        {"id": "d1", "type": "CASH_TRANSACTION", "status": "SETTLED", "description": "Interest", "amount": 1.23, "currency": "EUR",
         "lastEventDateTime": "2026-09-30T23:00:00Z", "cashTransactionType": "INTEREST"}]}}}}},
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Set-Cookie", "session=fake-session; Path=/; Secure; HttpOnly; SameSite=Lax")
        self.end_headers()
        self.wfile.write(PAGE)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        operation = body.get("operationName")
        entry = {
            "path": self.path,
            "operation": operation,
            "cookie": "session=fake-session" in (self.headers.get("Cookie") or ""),
            "features": self.headers.get("x-scacap-features-enabled"),
            "origin": self.headers.get("Origin"),
        }
        with open(LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps(entry) + "\n")
        payload = RESPONSES.get(operation)
        data = json.dumps(payload if payload is not None else {"errors": [{"message": "unknown operation"}]}).encode()
        self.send_response(200 if payload is not None else 400)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(CERT, KEY)
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
