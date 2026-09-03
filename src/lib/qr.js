import QRCode from 'qrcode';
import { config } from '../config.js';
import { currentEvent } from './tenancy.js';

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/**
 * The address printed on the cards and shown on the slideshow.
 *
 * โดเมนของ **งานนี้** มาก่อน BASE_URL เสมอ — เครื่องเดียวรับหลายงาน และ QR
 * ที่พิมพ์ลงกระดาษวางบนโต๊ะแขกคือของที่แก้ทีหลังไม่ได้ · ถ้ายังยึด BASE_URL
 * ตัวเดียวเหมือนเดิม การ์ดของลูกค้ารายที่สองจะพาแขกไปงานของลูกค้ารายแรกทั้งงาน
 */
export function shareUrl(req) {
  const { host } = currentEvent();
  // งานที่ใช้โดเมนเดียวกับ BASE_URL ต้องได้ค่าเดิมทุกตัวอักษร (พอร์ต/พาธที่ตั้งไว้)
  if (config.baseUrl && (!host || hostOf(config.baseUrl) === host)) return config.baseUrl;
  if (host) return `${req?.protocol ?? (config.baseUrl.startsWith('http://') ? 'http' : 'https')}://${host}`;

  const proto = req?.protocol ?? 'http';
  return `${proto}://${req?.get?.('host') ?? `localhost:${config.port}`}`;
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
