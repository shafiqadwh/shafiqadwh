/** A pairing check never uploads an image or follows a redirect with the key. */
export async function checkConnection({ baseUrl, uploadKey } = {}, fetchImpl = fetch) {
  let url;
  try { url = new URL(String(baseUrl).trim()); } catch {
    throw new Error('กรอกที่อยู่เว็บ เช่น https://photos.example.com');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') {
    throw new Error('ใช้ที่อยู่เว็บของงาน ไม่ใส่ชื่อหน้า พารามิเตอร์ หรือรหัสผ่านในลิงก์');
  }
  if (typeof uploadKey !== 'string' || uploadKey.length < 16 || !/^[\x20-\x7e]+$/.test(uploadKey)) {
    throw new Error('กุญแจเชื่อมต่อต้องมีอย่างน้อย 16 ตัว และใช้ตัวอักษรภาษาอังกฤษ ตัวเลข หรือสัญลักษณ์');
  }
  let response;
  try {
    response = await fetchImpl(new URL('/api/booth/status', url), {
      headers: { 'x-booth-key': uploadKey }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('เชื่อมต่อไม่ได้ — ตรวจอินเทอร์เน็ตและที่อยู่เว็บ แล้วลองอีกครั้ง'); }
  if (response.status === 401) throw new Error('กุญแจไม่ตรงกับงานนี้ หรือเว็บยังไม่เปิดรับรูปจากบูธ');
  if (response.status === 404) throw new Error('เว็บยังไม่รองรับการตรวจเชื่อมต่อ — อัปเดตเว็บก่อน');
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok !== true || data.service !== 'wedding-share-booth' || data.protocol !== 1) {
    throw new Error('ปลายทางไม่ใช่เว็บแชร์รูปที่รองรับ');
  }
  return { ok: true };
}
