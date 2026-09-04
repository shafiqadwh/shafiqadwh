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
  retake: (payload) => ipcRenderer.invoke('booth:retake', payload),
  deliver: (payload) => ipcRenderer.invoke('booth:deliver', payload),
  sale: () => ipcRenderer.invoke('booth:sale'),
  paid: (payload) => ipcRenderer.invoke('booth:paid', payload),
  pending: () => ipcRenderer.invoke('booth:pending'),
  // หน้าตั้งค่า · จอบูธใช้แค่ openSettings ที่เหลือเป็นของหน้าต่างตั้งค่าเอง
  openSettings: () => ipcRenderer.send('booth:open-settings'),
  closeSettings: () => ipcRenderer.send('booth:close-settings'),
  settings: () => ipcRenderer.invoke('booth:settings'),
  save: (patch) => ipcRenderer.invoke('booth:save', patch),
  checkPay: (payload) => ipcRenderer.invoke('booth:check-pay', payload),
  upload: () => ipcRenderer.invoke('booth:upload'),
  broadcast: (message) => ipcRenderer.send('booth:broadcast', message),
  onMessage: (handler) => {
    const listener = (event, message) => handler(message);
    ipcRenderer.on('booth:message', listener);
    return () => ipcRenderer.removeListener('booth:message', listener);
  },
});
