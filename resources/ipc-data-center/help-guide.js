let helpPage = 0;
let helpReturnFocus = null;
let helpReturnOverflow = '';
const helpPageNames = ['开始查询', '看懂结果', '复制与报告', '窗口操作'];
function selectHelpPage(index) {
  helpPage = Math.max(0, Math.min(helpPageNames.length - 1, index));
  const scroll = document.querySelector('.guide-scroll');
  const old = scroll.querySelector('section:not([hidden])');
  window.workbenchUi.replaceContent(scroll, () => {
  document.querySelectorAll('.guide-tabs [role="tab"]').forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === helpPage));
    tab.tabIndex = i === helpPage ? 0 : -1;
    document.getElementById(`guide-page-${i}`).hidden = i !== helpPage;
  });
  }, old);
  scroll.scrollTop = 0;
  document.getElementById('guidePrevious').disabled = helpPage === 0;
  document.getElementById('guideNext').innerHTML = helpPage === 3 ? '开始使用 <i class="fa fa-check" aria-hidden="true"></i>' : '下一页 <i class="fa fa-angle-right" aria-hidden="true"></i>';
  document.getElementById('guideProgress').textContent = `${helpPage + 1} / 4 · ${helpPageNames[helpPage]}`;
}
function stepHelpPage(direction) {
  if (direction === 1 && helpPage === 3) { toggleHelpModal(); return; }
  selectHelpPage(helpPage + direction);
  document.getElementById(`guide-tab-${helpPage}`).focus();
}
function focusHelpGuide() {
  helpReturnFocus = document.activeElement;
  helpReturnOverflow = document.body.style.overflow;
  document.querySelector('.guide-close').focus({ preventScroll: true });
}
function restoreHelpGuideFocus() {
  document.body.style.overflow = helpReturnOverflow;
  if (helpReturnFocus?.isConnected && helpReturnFocus !== document.body) helpReturnFocus.focus({ preventScroll: true });
  else document.getElementById('classificationInput').focus({ preventScroll: true });
}
document.querySelector('.guide-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (helpPage + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
  selectHelpPage(next);
  document.getElementById(`guide-tab-${helpPage}`).focus();
});
document.getElementById('helpModal').addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll('button:not(:disabled), [tabindex="0"], summary')].filter(el => el.getClientRects().length);
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
