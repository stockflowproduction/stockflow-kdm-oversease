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

  if (!cloudName || !apiKey || !apiSecret) {
    res.status(500).json(JSON.parse(serverError.body));
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${uploadFolder}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  res.status(200).json({
    timestamp,
    signature,
    apiKey,
    cloudName,
    uploadFolder
  });
}
