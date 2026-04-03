const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const FormData = require('form-data');

const BASE = 'https://graph.facebook.com/v19.0';

function headers() {
  return { Authorization: `Bearer ${process.env.META_TOKEN}` };
}

async function sendText(telefone, texto) {
  const res = await axios.post(
    `${BASE}/${process.env.META_PHONE_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to: normalizePhone(telefone),
      type: 'text',
      text: { body: texto },
    },
    { headers: headers() }
  );
  return res.data;
}

async function uploadMedia(filePath, mimeType) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    contentType: mimeType,
    filename: path.basename(filePath),
  });
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);

  const res = await axios.post(
    `${BASE}/${process.env.META_PHONE_ID}/media`,
    form,
    { headers: { ...headers(), ...form.getHeaders() } }
  );
  return res.data.id;
}

async function sendFile(telefone, filePath, mimeType, caption) {
  const mediaId = await uploadMedia(filePath, mimeType);
  const type = resolveType(mimeType);

  const payload = {
    messaging_product: 'whatsapp',
    to: normalizePhone(telefone),
    type,
    [type]: {
      id: mediaId,
      ...(caption && type !== 'audio' ? { caption } : {}),
    },
  };

  const res = await axios.post(
    `${BASE}/${process.env.META_PHONE_ID}/messages`,
    payload,
    { headers: headers() }
  );
  return res.data;
}

function resolveType(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

function normalizePhone(telefone) {
  const digits = String(telefone).replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  return '55' + digits;
}

module.exports = { sendText, sendFile, uploadMedia };
