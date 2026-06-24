# Stockflow WhatsApp Backend

This is a separate Node.js + Express + TypeScript backend for Stockflow WhatsApp integration.

Important boundaries for this phase:

- This backend does not use Firebase.
- This backend does not read Firestore.
- This backend does not verify Firebase Auth.
- This backend does not run on Vercel API routes.
- Frontend remains Vite/React/Firebase.
- Backend runs locally on port `3002`.

## Folder Structure

```text
backend/
  package.json
  tsconfig.json
  .env.example
  README.md
  src/
    index.ts
    config.ts
    errors.ts
    phone.ts
    invoiceImage.ts
    invoiceValidation.ts
    whatsapp.ts
    validation.ts
```

## Install

From the `backend` folder:

```bash
npm install
```

## Environment Setup

Create a `.env` file from `.env.example`.

Example:

```env
PORT=3002
NODE_ENV=development

WHATSAPP_ACCESS_TOKEN=your_meta_access_token_here
WHATSAPP_PHONE_NUMBER_ID=1130695046797961
WHATSAPP_WABA_ID=996876732799468
WHATSAPP_API_VERSION=v25.0

WHATSAPP_TEMPLATE_NAME=stockflow_sale_invoice
WHATSAPP_TEMPLATE_LANGUAGE=en
WHATSAPP_TEMPLATE_HAS_IMAGE_HEADER=true
```

## Run Locally

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm run start
```

The backend listens on `http://localhost:3002`.

## Test `GET /health`

Browser or curl:

```bash
curl http://localhost:3002/health
```

Expected response:

```json
{
  "ok": true,
  "service": "stockflow-whatsapp-backend",
  "port": 3002
}
```

## Test `POST /api/whatsapp/send-text-test`

### curl

```bash
curl -X POST http://localhost:3002/api/whatsapp/send-text-test \
  -H "Content-Type: application/json" \
  -d "{\"to\":\"9023950250\",\"message\":\"What can I help you today?\"}"
```

### Bruno / Postman

- Method: `POST`
- URL: `http://localhost:3002/api/whatsapp/send-text-test`
- Header: `Content-Type: application/json`
- Body:

```json
{
  "to": "9023950250",
  "message": "What can I help you today?"
}
```

Success response:

```json
{
  "ok": true,
  "message": "Sent on WhatsApp",
  "whatsappMessageId": "wamid..."
}
```

Failure response:

```json
{
  "ok": false,
  "code": "WHATSAPP_SEND_FAILED",
  "message": "Failed to send WhatsApp message."
}
```

## CORS

Development CORS currently allows:

- `http://localhost:3000`
- `http://localhost:5173`

Production should restrict origins more tightly before deployment.

## Test `POST /api/whatsapp/preview-invoice-image`

This route validates the invoice payload, generates the invoice image in memory, and returns `image/png`.

PowerShell:

```powershell
Invoke-WebRequest `
  -Uri "http://localhost:3002/api/whatsapp/preview-invoice-image" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{
    "to":"9023950250",
    "customerName":"Sample Customer",
    "storePhone":"+91 9000000000",
    "storeName":"GetBy International",
    "storeAddress":"Surat, Gujarat",
    "storeGstin":"",
    "invoiceNo":"INV-344",
    "invoiceDate":"22/06/2026",
    "invoiceAmount":600,
    "paymentMethod":"Credit",
    "creditDue":600,
    "items":[
      {
        "name":"HMD 2009 Quiet Cool 1000ml Square Humidifier",
        "qty":1,
        "rate":265,
        "amount":265
      }
    ],
    "subtotal":600,
    "discount":0,
    "tax":0,
    "total":600
  }' `
  -OutFile "invoice-preview.png"
```

## Test `POST /api/whatsapp/send-invoice`

This route:

1. validates the invoice payload
2. normalizes the recipient phone
3. generates the invoice PNG in memory
4. uploads the PNG to WhatsApp Media API
5. sends the WhatsApp template message using the configured template

PowerShell:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3002/api/whatsapp/send-invoice" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{
    "to":"9023950250",
    "customerName":"Sample Customer",
    "storePhone":"+91 9000000000",
    "storeName":"GetBy International",
    "storeAddress":"Surat, Gujarat",
    "storeGstin":"",
    "invoiceNo":"INV-344",
    "invoiceDate":"22/06/2026",
    "invoiceAmount":600,
    "paymentMethod":"Credit",
    "creditDue":600,
    "items":[
      {
        "name":"HMD 2009 Quiet Cool 1000ml Square Humidifier",
        "qty":1,
        "rate":265,
        "amount":265
      }
    ],
    "subtotal":600,
    "discount":0,
    "tax":0,
    "total":600
  }'
```

The preview route should work immediately after dependencies are installed.

The send-invoice route may still fail until the WhatsApp template is approved in Meta. That is expected.
