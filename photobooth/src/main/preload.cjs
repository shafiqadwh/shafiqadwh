const { contextBridge, ipcRenderer } = require('electron');

/*
 * สะพานเดียวระหว่างหน้าจอกับกระบวนการหลัก
 *
 * เปิดเฉพาะสามอย่างที่หน้าจอต้องใช้จริง ไม่ได้ยื่น ipcRenderer ทั้งก้อนออกไป
 * หน้าจอบูธเปิดค้างทั้งงานโดยไม่มีใครดูแล — ยิ่งมันทำอะไรได้น้อย ยิ่งพังยาก
 */
contextBridge.exposeInMainWorld('booth', {
  setup: () => ipcRenderer.invoke('booth:setup'),
  compose: (payload) => ipcRenderer.invoke('booth:compose', payload),
  discard: (payload) => ipcRenderer.invoke('booth:discard', payload),
  print: (payload) => ipcRenderer.invoke('booth:print', payload),
});
