# WhatsApp Server Hardening Notes

## New endpoints
- `GET /metrics/:userId`
- `POST /send-ledger`
- `POST /logout/:userId`

## API key
If `WHATSAPP_API_KEY` is set, send `x-api-key` for:
- `POST /create-session`
- `GET /qr/:userId`
- `GET /status/:userId`
- `GET /metrics/:userId`
- `POST /send-invoice`
- `POST /send-ledger`
- `POST /logout/:userId`

## CORS
Set `ALLOWED_ORIGINS` as comma-separated origins.

## Metrics schema
Per `userId`:
- `connectedNumber`
- `totalInvoicesSent`
- `totalLedgersSent`
- `lastInvoiceSentAt`
- `lastLedgerSentAt`
- `lastError`
- `sessionStartedAt`
- `sessionReadyAt`
- `totalSendFailures`

Saved to `whatsapp-server/data/whatsapp-metrics.json`.

## Curl smoke tests
```bash
curl -s http://localhost:3100/healthz
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -X POST http://localhost:3100/create-session -H 'content-type: application/json' -d '{"userId":"store-1"}'
curl -s -H "x-api-key: $WHATSAPP_API_KEY" http://localhost:3100/status/store-1
curl -s -H "x-api-key: $WHATSAPP_API_KEY" http://localhost:3100/metrics/store-1
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -X POST http://localhost:3100/send-invoice -H 'content-type: application/json' -d '{"userId":"store-1","customerPhone":"9876543210","customerName":"Ruchit","invoiceNo":"INV-1","pdfUrl":"https://example.com/invoice.pdf"}'
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -X POST http://localhost:3100/send-ledger -H 'content-type: application/json' -d '{"userId":"store-1","customerPhone":"9876543210","customerName":"Ruchit","ledgerNo":"LED-1","pdfUrl":"https://example.com/ledger.pdf"}'
curl -s -H "x-api-key: $WHATSAPP_API_KEY" -X POST http://localhost:3100/logout/store-1
```
