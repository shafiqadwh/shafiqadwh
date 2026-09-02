const { contextBridge, ipcRenderer } = require('electron');

/*
 * สะพานเดียวระหว่างหน้าจอกับกระบวนการหลัก
 *
 * เปิดเฉพาะที่หน้าจอต้องใช้จริง ไม่ได้ยื่น ipcRenderer ทั้งก้อนออกไป
 * หน้าจอบูธเปิดค้างทั้งงานโดยไม่มีใครดูแล — ยิ่งมันทำอะไรได้น้อย ยิ่งพังยาก
 *
 * `broadcast`/`onMessage` คือท่อระหว่างจอหน้ากับจอหลัง — ทั้งสองจอโหลดไฟล์นี้
 * ตัวเดียวกัน แต่คนละหน้าเว็บ (index.html กับ operator.html)
 */
contextBridge.exposeInMainWorld('booth', {
  setup: () => ipcRenderer.invoke('booth:setup'),
  compose: (payload) => ipcRenderer.invoke('booth:compose', payload),
  discard: (payload) => ipcRenderer.invoke('booth:discard', payload),
  deliver: (payload) => ipcRenderer.invoke('booth:deliver', payload),
  pending: () => ipcRenderer.invoke('booth:pending'),
  upload: () => ipcRenderer.invoke('booth:upload'),
  broadcast: (message) => ipcRenderer.send('booth:broadcast', message),
  onMessage: (handler) => {
    const listener = (event, message) => handler(message);
    ipcRenderer.on('booth:message', listener);
    return () => ipcRenderer.removeListener('booth:message', listener);
  },
});
