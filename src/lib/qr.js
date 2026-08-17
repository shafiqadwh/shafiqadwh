import QRCode from 'qrcode';
import { config } from '../config.js';

/** The address printed on the cards and shown on the slideshow. */
export function shareUrl(req) {
  if (config.baseUrl) return config.baseUrl;
  const proto = req?.protocol ?? 'http';
  const host = req?.get?.('host') ?? `localhost:${config.port}`;
  return `${proto}://${host}`;
}

export async function qrDataUrl(url, { width = 512, margin = 1 } = {}) {
  return QRCode.toDataURL(url, {
    width,
    margin,
    errorCorrectionLevel: 'M',
    color: { dark: '#1f1a17', light: '#ffffff' },
  });
}

export async function qrPngBuffer(url, { width = 1024 } = {}) {
  return QRCode.toBuffer(url, {
    type: 'png',
    width,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}
