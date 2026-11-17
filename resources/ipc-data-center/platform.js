let viewRevision = 0;
let keywordRevision = 0;
let activeMainQueryRevision = null;
let requestSequence = 0;
let hostOrigin = null;
const pendingQueries = new Map();
const pendingHost = new Map();
initializeUI();
setDatabaseInitializationState(true);
syncMainContentOffset();
const queryWorker = new Worker('query-worker.js');
const sendHost = (message) => parent.postMessage({ source: 'ipc-data-center', ...message }, hostOrigin || '*');

function failQueries() {
  for (const request of pendingQueries.values()) { clearTimeout(request.timer); request.resolve(null); }
  pendingQueries.clear();
  isClassificationIndexBuilt = false;
  setDatabaseInitializationState(true);
  updateStatusDisplay('数据库不可用');
  const content = document.getElementById('contentArea');
  replaceIpcContent(content, () => { content.innerHTML = '<div class="text-center p-6">数据库加载失败，请重新加载。</div>'; });
  sendHost({ action: 'failed' });
}
queryWorker.onmessage = ({ data }) => {
  if (data.action === 'initialized') {
    Object.assign(window, data.data);
    hydrateClassificationIndex(data.payload);
    setDatabaseInitializationState(false);
    sendHost({ action: 'ready' });
    return;
  }
  if (data.action === 'failed') { failQueries(data.error); return; }
  const request = pendingQueries.get(data.id);
  if (!request) return;
  pendingQueries.delete(data.id);
  clearTimeout(request.timer);
  if (data.error) showToast('查询失败：' + data.error);
  request.resolve(data.error ? null : data.result);
};
queryWorker.onerror = () => failQueries('数据库加载失败');
function requestQuery(action, args, region) {
  const id = ++requestSequence;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingQueries.delete(id);
      showToast('查询超时，请重试');
      resolve(null);
    }, 30000);
    pendingQueries.set(id, { resolve, timer });
    queryWorker.postMessage({ id, action, args, region });
  });
}
async function requestMainQuery(...args) {
  const revision = viewRevision;
  updateContentArea('<div class="text-center p-6 text-gray-600">查询中...</div>');
  activeMainQueryRevision = revision;
  try { return await requestQuery(...args); }
  finally { if (activeMainQueryRevision === revision) activeMainQueryRevision = null; }
}
async function runPriorityQuery(input, exact) {
  const revision = ++viewRevision;
  const results = await requestMainQuery('priority', [input, exact]);
  if (revision !== viewRevision) return;
  if (results) displayPriorityReviewResults(input, results);
  else showQueryFailure(() => runPriorityQuery(input, exact));
}
function hostRequest(message) {
  if (!hostOrigin) return Promise.reject(new Error('工作台连接尚未就绪，请重试'));
  const id = ++requestSequence;
  return new Promise((resolve, reject) => {
    // A save dialog may stay open while the user chooses a destination.
    pendingHost.set(id, { resolve, reject });
    sendHost({ ...message, id });
  });
}
window.addEventListener('message', (event) => {
  if (event.source !== parent || !(event.origin === 'patent-app://app' || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(event.origin))) return;
  const data = event.data;
  if (!data || data.source !== 'ipc-data-host') return;
  if (data.action === 'init') { hostOrigin = event.origin; return; }
  if (data.action === 'show-help') {
    if (document.getElementById('helpModal').classList.contains('hidden')) toggleHelpModal();
    return;
  }
  const pending = pendingHost.get(data.id);
  if (!pending) return;
  pendingHost.delete(data.id);
  if (data.ok) pending.resolve(data);
  else pending.reject(new Error(data.error || '操作失败'));
});
async function copyText(text, successMessage = '已复制到剪贴板') {
  try { await hostRequest({ action: 'copy', text }); showToast(successMessage); }
  catch (error) { showToast('复制失败：' + error.message); }
}
function copyFullContentWithDatabase(database, id, name, keyword, classifications) {
  const classes = Array.isArray(classifications) ? classifications.join(', ') : classifications;
  return copyText(`【${database}】 ${id} ${name}\n分类号：${classes}\n关键词：${keyword || '无关键词概述'}`);
}
function fallbackCopy(text, successMessage) { return copyText(text, successMessage); }
let reportSaving = false;
async function confirmSaveImage(png) {
  if (reportSaving) return;
  reportSaving = true;
  try {
    const code = (window.currentPreExamData?.code || 'IPC').replace(/[<>:"/\\|?*]/g, '_');
    const result = await hostRequest({ action: 'save-report', report: { png, filename: `预审报告_${code}.png` } });
    if (result.canceled) showToast('已取消保存');
    else { showToast('报告图片已保存'); closeImagePreview(); }
  } catch (error) { showToast('保存失败：' + error.message); }
  finally { reportSaving = false; }
}
document.addEventListener('pointerdown', () => sendHost({ action: 'interact' }), true);
document.addEventListener('focusin', () => sendHost({ action: 'interact' }));
const toolModalStack = [];
let toolModalOverflow = '';
function openToolModal(modal, focus = true) {
  if (!toolModalStack.some(entry => entry.modal === modal)) {
    if (!toolModalStack.length) toolModalOverflow = document.body.style.overflow;
    toolModalStack.push({ modal, returnFocus: document.activeElement });
  }
  modal.classList.remove('hidden');
  modal.style.zIndex = String(80 + toolModalStack.findIndex(entry => entry.modal === modal));
  document.body.style.overflow = 'hidden';
  if (focus) { modal.tabIndex = -1; modal.focus({ preventScroll: true }); }
}
function closeToolModal(modal) {
  const index = toolModalStack.findIndex(entry => entry.modal === modal);
  const wasTop = index >= 0 && index === toolModalStack.length - 1;
  const entry = index < 0 ? null : toolModalStack.splice(index, 1)[0];
  modal.classList.add('hidden');
  document.body.style.overflow = toolModalStack.length ? 'hidden' : toolModalOverflow;
  if (wasTop && entry?.returnFocus?.isConnected) entry.returnFocus.focus({ preventScroll: true });
}

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault();
  if (event.key !== 'Escape' || event.isComposing) return;
  const closers = [
    ['preexamDataNoticeModal', closePreexamDataNotice],
    ['helpModal', toggleHelpModal],
    ['imagePreviewModal', closeImagePreview], ['preExamRestrictionModal', closePreExamRestrictionModal],
    ['keywordSearchModal', closeKeywordSearchModal], ['regionSettingsModal', closeRegionSettingsModal],
    ['classificationListModal', () => document.getElementById('classificationListModal').classList.add('hidden')],
    ['ipcDetailModal', closeIpcDetailModal], ['protectionCenterModal', closeProtectionCenterModal],
  ];
  const top = toolModalStack.at(-1)?.modal;
  const current = (top && closers.find(([id]) => id === top.id)) || closers.find(([id]) => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); });
  if (current) current[1]();
  else sendHost({ action: 'close' });
  event.preventDefault();
});
// Merely opening the center picker does not navigate away from the current query.
// showProtectionCenterContent invalidates pending results after a center is selected.
document.getElementById('classificationInput').addEventListener('input', () => {
  const interrupted = activeMainQueryRevision === viewRevision;
  viewRevision++;
  if (interrupted) {
    activeMainQueryRevision = null;
    updateStatusDisplay('等待查询');
    updateContentArea('<div class="text-center p-6 text-gray-600">输入已更改，请重新查询</div>');
    hideFloatingButtons();
  }
});
function syncMainContentOffset() {
  const controls = document.getElementById('topControlPanel');
  const main = document.querySelector('main');
  if (controls && main) {
    const bottom = controls.getBoundingClientRect().bottom;
    main.style.paddingTop = `${bottom + 16}px`;
    document.documentElement.style.setProperty('--ipc-controls-bottom', `${bottom}px`);
    syncDictionarySticky();
  }
}
new ResizeObserver(syncMainContentOffset).observe(document.getElementById('topControlPanel'));


function showQueryFailure(retry, containerId = 'contentArea') {
  const container = document.getElementById(containerId);
  const panel = document.createElement('div');
  panel.className = 'p-6 text-center';
  const message = document.createElement('p');
  message.textContent = '查询未完成，请重试。';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mt-3 rounded bg-blue-600 px-4 py-2 text-white';
  button.textContent = '重试查询';
  button.onclick = () => { button.disabled = true; message.textContent = '查询中…'; retry(); };
  panel.append(message, button);
  replaceIpcContent(container, () => container.replaceChildren(panel));
  if (containerId === 'contentArea') { updateStatusDisplay('查询未完成'); hideFloatingButtons(); }
}
