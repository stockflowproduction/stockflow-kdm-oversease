import crypto from 'crypto';

const json = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(body)
});

export const handler = async (event: { httpMethod?: string }) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const uploadFolder = (process.env.CLOUDINARY_UPLOAD_FOLDER || 'stockflow/products').trim();
  const uploadPreset = (process.env.CLOUDINARY_UPLOAD_PRESET || '').trim();

  if (!cloudName || !apiKey || !apiSecret) {
    return json(500, { error: 'Cloudinary environment variables are not configured.' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const shouldDebug = ((event as any)?.queryStringParameters?.invoiceSendDebug === '1') || (((event as any)?.headers || {})['x-invoice-send-debug'] === '1');
  const stringToSign = uploadPreset
    ? `folder=${uploadFolder}&timestamp=${timestamp}&upload_preset=${uploadPreset}`
    : `folder=${uploadFolder}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash('sha1')
    .update(`${stringToSign}${apiSecret}`)
    .digest('hex');
  if (shouldDebug) {
    console.log('[INVOICE_SEND_DEBUG]', JSON.stringify({ step: 'signature_signing_string', stringToSign }, null, 2));
  }

  return json(200, {
    timestamp,
    signature,
    apiKey,
    cloudName,
    uploadFolder,
    uploadPreset
  });
};
