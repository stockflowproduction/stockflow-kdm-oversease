import crypto from 'crypto';

const methodNotAllowed = {
  statusCode: 405,
  body: JSON.stringify({ error: 'Method Not Allowed' })
};

const serverError = {
  statusCode: 500,
  body: JSON.stringify({ error: 'Cloudinary environment variables are not configured.' })
};

export default function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json(JSON.parse(methodNotAllowed.body));
    return;
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const uploadFolder = (process.env.CLOUDINARY_UPLOAD_FOLDER || 'stockflow/products').trim();
  const uploadPreset = (process.env.CLOUDINARY_UPLOAD_PRESET || '').trim();

  if (!cloudName || !apiKey || !apiSecret) {
    res.status(500).json(JSON.parse(serverError.body));
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const shouldDebug = req?.query?.invoiceSendDebug === '1' || req?.headers?.['x-invoice-send-debug'] === '1';
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

  res.status(200).json({
    timestamp,
    signature,
    apiKey,
    cloudName,
    uploadFolder,
    uploadPreset
  });
}
