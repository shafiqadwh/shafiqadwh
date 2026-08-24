/* global window, document */
(function () {
  const grid = document.querySelector('.admin-grid:not(.admin-grid--trash)');
  const bar = document.getElementById('admin-bulkbar');
  if (!grid || !bar) return;

  const strings = window.I18N?.admin ?? {};
  function t(key, vars) {
    const template = typeof strings[key] === 'string' ? strings[key] : key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match);
  }

  const selectAll = document.getElementById('select-all');
  const countLabel = document.getElementById('admin-bulkbar-count');
  const deleteButton = document.getElementById('admin-bulkbar-delete');

  // นี่คือของเสริมล้วน ๆ — ตัวนับกับปุ่มเปิด/ปิด ไม่ใช่กลไกความปลอดภัย
  // ปุ่มลบจริงยังเป็น <button type="submit"> ธรรมดา และ confirm() ก่อนลบมาจาก
  // onsubmit ที่เขียนไว้ใน HTML แล้ว ทำงานได้เองแม้ไฟล์นี้โหลดไม่ทัน
  function checkboxes() {
    return Array.from(grid.querySelectorAll('.admin-item__select'));
  }

  function sync() {
    const boxes = checkboxes();
    const checked = boxes.filter((box) => box.checked).length;
    countLabel.textContent = t('selected_count', { n: checked });
    deleteButton.disabled = checked === 0;
    if (selectAll) {
      selectAll.checked = boxes.length > 0 && checked === boxes.length;
      selectAll.indeterminate = checked > 0 && checked < boxes.length;
    }
  }

  // ฟังที่กริดใบเดียว ไม่ใช่ทีละ checkbox — ใช้ได้กับทุกใบโดยไม่ต้องผูกใหม่ทีละใบ
  grid.addEventListener('change', (event) => {
    if (event.target.classList.contains('admin-item__select')) sync();
  });

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      checkboxes().forEach((box) => { box.checked = selectAll.checked; });
      sync();
    });
  }

  sync();
})();
