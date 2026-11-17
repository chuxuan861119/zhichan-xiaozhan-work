// Normalize classification syntax only; preserve spaces and case in ordinary keywords.
function normalizeClassificationInput(input) {
    const text = String(input ?? '').trim();
    const compact = text.replace(/\s+/g, '').toUpperCase();
    return /^[A-H](?:\d{2}(?:[A-Z](?:\d+(?:\/\d+)?)?)?)?\*?$/.test(compact) ? compact : text;
}
function classificationRangeContains(parent, child) {
    const base = value => normalizeClassificationInput(value).replace(/\*/g, '').replace(/\/00$/, '');
    const range = base(parent);
    const code = base(child);
    if (range === code) return true;
    if (!code.startsWith(range)) return false;
    // A01B1 covers A01B1/02, but never A01B11/00.
    return !/^[A-H]\d{2}[A-Z]\d+$/.test(range) || code.charAt(range.length) === '/';
}

const IPC_INDEX_SCHEMA_VERSION = 2;
function createEmptyClassificationIndex() {
            return { sections: {}, classes: {}, subclasses: {}, mainGroups: {} };
        }

function buildClassificationIndexPayload() {
            const index = createEmptyClassificationIndex();
            const entries = Object.entries(ipcDictionary);
            for (const [code] of entries) {
                const type = getClassificationType(code);
                if (type === '部') { 
                    index.sections[code] = []; 
                } else if (type === '大类') {
                    const sectionCode = code.substring(0, 1);
                    if (!index.sections[sectionCode]) index.sections[sectionCode] = [];
                    index.sections[sectionCode].push(code);
                } else if (type === '小类') {
                    const classCode = code.substring(0, 3);
                    if (!index.classes[classCode]) index.classes[classCode] = [];
                    index.classes[classCode].push(code);
                } else if (type === '大组') {
                    const subclassCode = code.substring(0, 4);
                    if (!index.subclasses[subclassCode]) index.subclasses[subclassCode] = [];
                    index.subclasses[subclassCode].push(code);
                } else if (type === '小组') {
                    const mainGroupPrefix = code.substring(0, code.indexOf('/'));
                    const mainGroupCode = `${mainGroupPrefix}/00`;
                    if (!index.mainGroups[mainGroupCode]) index.mainGroups[mainGroupCode] = [];
                    index.mainGroups[mainGroupCode].push(code);
                }
            }
            Object.values(index.sections).forEach(sortClassificationCodes);
            Object.values(index.classes).forEach(sortClassificationCodes);
            Object.values(index.subclasses).forEach(sortClassificationCodes);
            Object.values(index.mainGroups).forEach(sortClassificationCodes);
            return {
                schemaVersion: IPC_INDEX_SCHEMA_VERSION,
                databaseVersion: window.ipcDatabaseVersion || '1',
                builtAt: Date.now(),
                index
            };
        }

function getClassificationType(code) {
            if (code.length === 1) return '部';
            if (code.length === 3) return '大类';
            if (code.length === 4 && /^[A-H]\d{2}[A-Z]$/.test(code)) return '小类';
            if (/^[A-H]\d{2}[A-Z]?\d+\/\d{2,}$/.test(code)) return code.endsWith('/00') ? '大组' : '小组';
            if (/^[A-H]\d{2}[A-Z]\d+$/.test(code)) {
                const possibleMainGroup = `${code}/00`;
                if (ipcDictionary[possibleMainGroup]) return '大组';
            }
            return '分类号';
        }

function isSubgroupCode(code) {
            const normalizedCode = String(code ?? '').trim().toUpperCase();
            return normalizedCode.includes('/') && !normalizedCode.endsWith('/00');
        }

function parseDeletedIpcTitle(title, code = '') {
            const rawTitle = String(title ?? '');
            const isDeleted = rawTitle.startsWith('[已删除]');
            const titleWithoutDeleted = isDeleted ? rawTitle.replace(/^\[已删除\]\s*/, '').trim() : rawTitle;
            const dotGroupMatch = isSubgroupCode(code) ? titleWithoutDeleted.match(/^([.·]+)\s*/) : null;
            const dotGroup = dotGroupMatch ? dotGroupMatch[1].replace(/\./g, '·') : '';
            const titleContent = dotGroupMatch ? titleWithoutDeleted.slice(dotGroupMatch[0].length).trim() : titleWithoutDeleted;
            const noteIndex = titleContent.indexOf('[注释]');
            const cleanTitle = noteIndex >= 0 ? titleContent.slice(0, noteIndex).trim() : titleContent;
            const noteText = noteIndex >= 0 ? titleContent.slice(noteIndex + 4).trim() : '';
            const searchableTitle = [cleanTitle, noteText].filter(Boolean).join(' ');
            const plainTextTitle = noteText ? `${cleanTitle}\n  ${noteText}` : cleanTitle;
            return { rawTitle, cleanTitle, noteText, searchableTitle, plainTextTitle, isDeleted, dotGroup };
        }

function parseIpcSortKey(code) {
            const normalizedCode = String(code ?? '').trim().toUpperCase();
            const match = normalizedCode.match(/^([A-H])(\d{2})([A-Z])(?:(\d{1,3})\/(\d{2,}))?$/);
            if (!match) return null;
            const [, section, classDigits, subclass, mainGroupDigits = '', subgroupDigits = ''] = match;
            const hasGroup = mainGroupDigits !== '';
            const hasSubgroup = hasGroup && subgroupDigits !== '00';
            return {
                normalizedCode,
                section,
                classNumber: Number(classDigits),
                subclass,
                hasGroup,
                mainGroupNumber: hasGroup ? Number(mainGroupDigits) : -1,
                subgroupDigits: hasGroup ? subgroupDigits : '',
                subgroupValue: hasGroup ? BigInt(subgroupDigits) : 0n,
                subgroupScale: hasGroup ? 10n ** BigInt(subgroupDigits.length) : 1n,
                depth: hasGroup ? (hasSubgroup ? 5 : 4) : 3
            };
        }

function compareIpcSubgroupDecimal(aKey, bKey) {
            const left = aKey.subgroupValue * bKey.subgroupScale;
            const right = bKey.subgroupValue * aKey.subgroupScale;
            if (left !== right) return left < right ? -1 : 1;
            if (aKey.subgroupDigits.length !== bKey.subgroupDigits.length) {
                return aKey.subgroupDigits.length - bKey.subgroupDigits.length;
            }
            return 0;
        }

function compareClassificationCodes(a, b) {
            const aText = String(a ?? '').trim();
            const bText = String(b ?? '').trim();
            const aKey = parseIpcSortKey(aText);
            const bKey = parseIpcSortKey(bText);
            if (!aKey || !bKey) {
                return aText.localeCompare(bText, 'zh-CN', { numeric: true, sensitivity: 'base' });
            }
            if (aKey.section !== bKey.section) return aKey.section.localeCompare(bKey.section, 'en');
            if (aKey.classNumber !== bKey.classNumber) return aKey.classNumber - bKey.classNumber;
            if (aKey.subclass !== bKey.subclass) return aKey.subclass.localeCompare(bKey.subclass, 'en');
            if (aKey.depth !== bKey.depth) return aKey.depth - bKey.depth;
            if (!aKey.hasGroup && !bKey.hasGroup) return 0;
            if (aKey.mainGroupNumber !== bKey.mainGroupNumber) return aKey.mainGroupNumber - bKey.mainGroupNumber;
            const subgroupCompare = compareIpcSubgroupDecimal(aKey, bKey);
            if (subgroupCompare !== 0) return subgroupCompare;
            return aKey.normalizedCode.localeCompare(bKey.normalizedCode, 'en', { numeric: true, sensitivity: 'base' });
        }

function sortClassificationCodes(items) {
            return items.sort((a, b) => compareClassificationCodes(a, b));
        }

function splitClassifications(classificationStr) {
            const classifications = [];
            let current = '';
            let bracketDepth = 0;
            for (let i = 0; i < classificationStr.length; i++) {
                const char = classificationStr[i];
                if (char === '(' || char === '（') { bracketDepth++; current += char; } 
                else if (char === ')' || char === '）') { bracketDepth--; current += char; } 
                else if ((char === ',' || char === '，') && bracketDepth === 0) {
                    if (current.trim()) classifications.push(current.trim());
                    current = '';
                } else { current += char; }
            }
            if (current.trim()) classifications.push(current.trim());
            return classifications;
        }

function parseClassificationWithExclusion(classification) {
            const result = { mainClass: '', exclusions: [] };
            const excludeMatch = classification.match(/(.+?)[(（]不含\s*(.+?)[)）]/);
            if (excludeMatch) {
                result.mainClass = excludeMatch[1].trim();
                result.exclusions = excludeMatch[2].split(/[,，、;；]/).map(s => s.trim()).filter(s => s);
            } else {
                result.mainClass = classification.replace(/\s*\(.*?\)\s*/g, '').trim();
            }
            return result;
        }

function getAllClassificationPrefixes(classification) {
            const prefixes = [classification];
            let baseClass = classification;
            if (baseClass.endsWith('*')) {
                baseClass = baseClass.slice(0, -1);
                prefixes.push(baseClass);
            }
            if (baseClass.endsWith('/00')) {
                const withoutSlash = baseClass.slice(0, -3);
                prefixes.push(withoutSlash);
            } else if (!baseClass.includes('/') && /^[A-H]\d{2}[A-Z]\d+$/.test(baseClass)) {
                const withSlash = `${baseClass}/00`;
                prefixes.push(withSlash);
            }
            if (baseClass.length >= 4 && /^[A-H]\d{2}[A-Z]/.test(baseClass)) prefixes.push(baseClass.slice(0, 4));
            if (baseClass.length >= 3) prefixes.push(baseClass.slice(0, 3));
            if (baseClass.length >= 1) prefixes.push(baseClass.slice(0, 1));
            return [...new Set(prefixes)];
        }

function isClassificationMatchWithExclusion(queryClass, dbClassification, queryPrefixes, exactMatch = false) {
    const { mainClass, exclusions } = parseClassificationWithExclusion(dbClassification);
    if (exclusions.some(exclusion => classificationRangeContains(exclusion, queryClass))) return false;
    return isClassificationMatch(queryClass, mainClass, queryPrefixes, exactMatch);
}

function isClassificationMatch(queryClass, dbClass, queryPrefixes, exactMatch = false) {
    const normalized = value => normalizeClassificationInput(value).replace(/\*/g, '').replace(/\/00$/, '');
    return splitClassifications(dbClass).some(single => exactMatch
        ? normalized(queryClass) === normalized(single)
        : classificationRangeContains(single, queryClass) || classificationRangeContains(queryClass, single));
}

function isClassificationFormat(input) { return /^[A-H]\d/i.test(input); }

function calculatePriorityResults(searchInput, exactMatch = false) {
            const allResults = [];
            const normalizedInput = normalizeClassificationInput(searchInput);
            const isClassification = isClassificationFormat(normalizedInput);
            
            if (isClassification) {
                const upperInput = normalizedInput.toUpperCase();
                const queryPrefixes = getAllClassificationPrefixes(upperInput.replace(/\*/g, ''));
                for (const [dbName, database] of Object.entries(priorityReviewDatabases)) {
                    database.forEach(item => {
                        const dbClassifications = splitClassifications(item.classification);
                        const matchingClassifications = [];
                        dbClassifications.forEach(dbClassification => {
                            if (isClassificationMatchWithExclusion(upperInput, dbClassification, queryPrefixes, exactMatch)) matchingClassifications.push(dbClassification);
                        });
                        if (matchingClassifications.length > 0) {
                            allResults.push({ ...item, database: dbName, matchingClassifications, isKeywordSearch: false });
                        }
                    });
                }
            } else {
                const searchLower = normalizedInput.toLowerCase();
                for (const [dbName, database] of Object.entries(priorityReviewDatabases)) {
                    database.forEach(item => {
                        const nameMatch = item.name.toLowerCase().includes(searchLower);
                        const keywordMatch = item.keyword && item.keyword.toLowerCase().includes(searchLower);
                        if (nameMatch || keywordMatch) {
                            const allClassifications = splitClassifications(item.classification);
                            allResults.push({ ...item, database: dbName, matchingClassifications: allClassifications, isKeywordSearch: true });
                        }
                    });
                }
            }
            const mergedResults = {};
            allResults.forEach(result => {
                const key = `${result.database}-${result.id}-${result.name}-${result.keyword}`;
                if (!mergedResults[key]) {
                    mergedResults[key] = { database: result.database, id: result.id, name: result.name, keyword: result.keyword, matchingClassifications: [], isKeywordSearch: result.isKeywordSearch };
                }
                result.matchingClassifications.forEach(cls => {
                    if (!mergedResults[key].matchingClassifications.includes(cls)) mergedResults[key].matchingClassifications.push(cls);
                });
            });
            return Object.values(mergedResults);
        }

function findCentersByCode(targetCode) {
            const centers = [];
            const targetLower = targetCode.toLowerCase();
            for (const [province, provinceCenters] of Object.entries(protectionCenterDatabase)) {
                for (const [centerName, centerData] of Object.entries(provinceCenters)) {
                    const ipcClassifications = centerData.ipc || [];
                    for (const code of ipcClassifications) {
                        if (code.toLowerCase() === targetLower || targetLower.startsWith(code.toLowerCase()) || code.toLowerCase().startsWith(targetLower)) {
                            centers.push({ province: province, name: centerName, isProvinceCenter: centerName.includes('省保护中心') });
                            break;
                        }
                    }
                }
            }
            const preferredRegion = getPreferredRegion();
            centers.sort((a, b) => {
                if (preferredRegion) {
                    if (a.province === preferredRegion && b.province !== preferredRegion) return -1;
                    if (a.province !== preferredRegion && b.province === preferredRegion) return 1;
                }
                if (a.isProvinceCenter && !b.isProvinceCenter) return -1;
                if (!a.isProvinceCenter && b.isProvinceCenter) return 1;
                return a.name.localeCompare(b.name);
            });
            return centers;
        }

function findRelatedMatches(query, isKeywordSearch = false, searchPattern = null) {
            const pattern = searchPattern || query;
            const relatedClasses = [];
            
            for (const [code, title] of Object.entries(ipcDictionary)) {
                const titleInfo = parseDeletedIpcTitle(title, code);
                let isMatch = false;
                if (isKeywordSearch) {
                    isMatch = code.startsWith(query) || code.includes(query) || titleInfo.searchableTitle.includes(query);
                } else {
                    const cleanPattern = pattern.replace(/\*/g, '');
                    if (code === pattern) isMatch = true;
                    else if (code.startsWith(cleanPattern)) {
                        if (classificationRangeContains(cleanPattern, code)) isMatch = true;
                    } else if (!query.includes('*') && code.includes(query)) isMatch = true;
                    else if (titleInfo.searchableTitle.includes(query)) isMatch = true;
                }
                if (isMatch) relatedClasses.push({ code, title, type: getClassificationType(code) });
            }
            
            const uniqueResults = [...new Map(relatedClasses.map(item => [item.code, item])).values()];
            uniqueResults.sort((a, b) => {
                const aExact = a.code === pattern;
                const bExact = b.code === pattern;
                if (aExact && !bExact) return -1;
                if (!aExact && bExact) return 1;
                const lengthDiff = a.code.length - b.code.length;
                if (lengthDiff !== 0) return lengthDiff;
                return compareClassificationCodes(a.code, b.code);
            });
            

return uniqueResults;
}


function findPreExamByKeyword(keyword) {
            const searchLower = keyword.toLowerCase();
            const results = [];
            const processedCodes = new Set();
            
            for (const [province, centers] of Object.entries(protectionCenterDatabase)) {
                for (const [centerName, centerData] of Object.entries(centers)) {
                    const ipcClassifications = centerData.ipc || [];
                    for (const code of ipcClassifications) {
                        const title = ipcDictionary[code] || '';
                        const titleLower = parseDeletedIpcTitle(title, code).searchableTitle.toLowerCase();
                        if (code.toLowerCase().includes(searchLower) || titleLower.includes(searchLower)) {
                            if (!processedCodes.has(code)) {
                                processedCodes.add(code);
                                const matchedCenters = findCentersByCode(code);
                                results.push({ code: code, title: title || '暂无描述', type: getClassificationType(code), centers: matchedCenters });
                            }
                        }
                    }
                }
            }
            
            // Subclass hits must not suppress matching groups elsewhere in the dictionary.
            for (const [code, title] of Object.entries(ipcDictionary)) {
                if (parseDeletedIpcTitle(title, code).searchableTitle.toLowerCase().includes(searchLower) && !processedCodes.has(code)) {
                    const matchedCenters = findCentersByCode(code);
                    if (matchedCenters.length > 0) {
                        processedCodes.add(code);
                        results.push({ code: code, title: title, type: getClassificationType(code), centers: matchedCenters });
                    }
                }
            }

            results.sort((a, b) => compareClassificationCodes(a.code, b.code));
            
            return results;
        }
