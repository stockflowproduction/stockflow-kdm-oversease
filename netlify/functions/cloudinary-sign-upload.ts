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

  if (!cloudName || !apiKey || !apiSecret) {
    return json(500, { error: 'Cloudinary environment variables are not configured.' });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${uploadFolder}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  return json(200, {
    timestamp,
    signature,
    apiKey,
    cloudName,
    uploadFolder
  });
};
