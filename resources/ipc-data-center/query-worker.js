// Database parsing, indexing and full-dictionary scans stay outside the editor thread.
self.window = self;
let preferredRegion = null;
function getPreferredRegion() { return preferredRegion; }
try {
  importScripts('js/db-ipc.js', 'js/db-preexam.js', 'js/db-priority.js', 'js/db-locarno.js', 'query-core.js');
  self.postMessage({ action: 'initialized', payload: buildClassificationIndexPayload(), data: {
    ipcDatabaseVersion, ipcDictionary, protectionCenterDatabase, priorityReviewDatabases,
    priorityReviewColorMap, locarnoDictionary,
  } });
} catch (error) {
  self.postMessage({ action: 'failed', error: error instanceof Error ? error.message : '数据库加载失败' });
}
self.onmessage = ({ data }) => {
  const { id, action, args, region } = data;
  preferredRegion = region || null;
  try {
    let result;
    if (action === 'related') result = findRelatedMatches(...args);
    else if (action === 'preexam') result = findPreExamByKeyword(...args);
    else if (action === 'priority') result = calculatePriorityResults(...args);
    else throw new Error('未知查询类型');
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : '查询失败' });
  }
};
