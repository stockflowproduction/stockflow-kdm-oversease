# WhatsApp Server Status API (Recommended)

## GET /metrics/:userId
Returns consolidated WhatsApp connection + send counters.

```json
{
  "success": true,
  "userId": "abc123",
  "connected": true,
  "connectedNumber": "+91XXXXXXXXXX",
  "totalInvoicesSent": 0,
  "totalLedgersSent": 0,
  "lastInvoiceSentAt": null,
  "lastLedgerSentAt": null,
  "lastError": null,
  "sessionStartedAt": null,
  "uptime": 0,
  "memory": {}
}
```

## POST /send-ledger
Accepts customer ledger share payload.

```json
{
  "userId": "abc123",
  "customerPhone": "+91XXXXXXXXXX",
  "customerName": "Customer Name",
  "ledgerNo": "LEDGER-001",
  "pdfUrl": "https://..."
}
```

## Frontend fallback behavior
When `/metrics/:userId` is unavailable, frontend should safely fall back to:
- `GET /status/:userId`
- `GET /healthz`

All missing metric fields should render as `0` or `Not available`.
