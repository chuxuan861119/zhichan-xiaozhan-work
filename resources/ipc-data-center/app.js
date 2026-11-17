// Adapted from the user-provided IPC data center; matching and rendering rules retained.
// ==================== 层级索引和缓存 ====================
		// ==================== UI立即初始化（与数据加载分离） ====================
		function initializeUI() {
		    const classificationInput = document.getElementById('classificationInput');
		    const queryIPCBtn = document.getElementById('queryIPCBtn');
		    const preExamBtn = document.getElementById('preExamBtn');
		    const priorityBtn = document.getElementById('priorityBtn');
		    const dictionaryBtn = document.getElementById('dictionaryBtn');
		    const protectionBtn = document.getElementById('protectionBtn');
		    const clearBtn = document.getElementById('clearBtn');
		    const exactMatchBtn = document.getElementById('exactMatchBtn');
		    const allButtons = [queryIPCBtn, preExamBtn, priorityBtn, dictionaryBtn, protectionBtn];
		    
		    function resetButtonStyles() {
		        allButtons.forEach(btn => {
		            btn.classList.remove('bg-gradient-to-r', 'from-[#2046B5]', 'to-[#3572E5]', 'text-white');
		            btn.classList.add('bg-white', 'text-[#2046B5]');
		        });
		    }
		    
		    function setButtonActive(button) {
		        resetButtonStyles();
		        button.classList.remove('bg-white', 'text-[#2046B5]');
		        button.classList.add('bg-gradient-to-r', 'from-[#2046B5]', 'to-[#3572E5]', 'text-white');
		    }
		    
		    queryIPCBtn.addEventListener('click', function() { setButtonActive(this); queryIPC(classificationInput.value.trim()); });
		    
		    preExamBtn.addEventListener('click', function() { 
                if (showPreexamDataNoticeOnce(() => this.click())) return;
		        if (isShareMode) {
		            isShareMode = false;
		            selectedProvince = null;
		            hideShareMenu();
		            window.currentPreExamData = null;
		        }
		        setButtonActive(this); 
		        queryPreExam(classificationInput.value.trim()); 
		    });
		    
		    priorityBtn.addEventListener('click', function() {
		        if (isShareMode) {
		            isShareMode = false;
		            selectedProvince = null;
		            hideShareMenu();
		            window.currentPreExamData = null;
		        }
		        setButtonActive(this);
		        const searchInput = normalizeClassificationInput(classificationInput.value);
		        if (!searchInput) { showToast('请输入分类号或关键词'); return; }
		        
		        isExactMatchMode = false;
		        updateExactMatchButtonState();
		        updateStatusDisplay('优先审查查询');
		        updateContentArea(`<div class="text-center py-8"><i class="fa fa-spinner fa-spin text-4xl text-[#2046B5] mb-3"></i><p class="text-sm text-gray-600">查询中...</p></div>`);
		        runPriorityQuery(searchInput, false);
		        
		    });
		    
		    if (exactMatchBtn) {
		        exactMatchBtn.addEventListener('click', function() {
		            isExactMatchMode = !isExactMatchMode;
		            updateExactMatchButtonState();
		            if (currentSearchClassification) {
		                updateStatusDisplay('优先审查查询');
		                updateContentArea(`<div class="text-center py-8"><i class="fa fa-spinner fa-spin text-4xl text-[#2046B5] mb-3"></i><p class="text-sm text-gray-600">${isExactMatchMode ? '精准检索模式' : '全层级检索模式'}</p></div>`);
		                runPriorityQuery(currentSearchClassification, isExactMatchMode);
		                showToast(isExactMatchMode ? '已切换到精准检索模式' : '已切换到全层级检索模式');
		            }
		        });
		    }
		    
		    dictionaryBtn.addEventListener('click', function() {
 viewRevision++;
		        setButtonActive(this);
		        updateStatusDisplay('词典模式');
		        const sections = [
		            { code: 'A', title: '人类生活必需' }, { code: 'B', title: '作业；运输' }, { code: 'C', title: '化学；冶金' },
		            { code: 'D', title: '纺织；造纸' }, { code: 'E', title: '固定建筑物' }, { code: 'F', title: '机械工程' },
		            { code: 'G', title: '物理' }, { code: 'H', title: '电学' }
		        ];
		        let content = `<div class="space-y-4"><div class="text-center mb-4"><h3 class="text-lg font-bold text-[#2046B5]">IPC 分类号词典</h3><p class="text-sm text-gray-600">点击分类号展开查看下级分类</p></div><div class="space-y-3" id="dictionaryContent">`;
		        sections.forEach(section => {
		            content += `<div class="bg-white rounded-lg shadow-sm overflow-hidden"><div class="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-50" onclick="toggleDictionaryLevel('section', '${section.code}', this)"><div class="flex items-center"><h4 class="font-semibold text-[#2046B5]">${section.code}部</h4><span class="ml-2 bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded-full">部</span></div><div class="flex items-center"><span class="text-xs text-gray-500 mr-2">${section.title}</span><i class="fa fa-chevron-down text-gray-400 transition-transform duration-300"></i></div></div><div id="section-${section.code}-content" class="hidden border-t"></div></div>`;
		        });
		        content += `</div></div>`;
		        updateContentArea(content);
		        showFloatingButtons(false);
		    });
		    
		    protectionBtn.addEventListener('click', function() { setButtonActive(this); openProtectionCenterModal(); });
		    
		    clearBtn.addEventListener('click', function() {
 viewRevision++;
		        resetButtonStyles();
		        classificationInput.value = '';
		        updateStatusDisplay('知产小栈');
		        if (isShareMode) {
		            isShareMode = false;
		            selectedProvince = null;
		            hideShareMenu();
		        }
		        window.currentPreExamData = null;
		        const shareReportBtn = document.getElementById('shareReportBtn');
		        if (shareReportBtn) shareReportBtn.classList.add('hidden');
		        const emptyContent = `<div class="ipc-home flex flex-col items-center justify-center py-10 text-center"><div class="w-20 h-20 mb-5 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center shadow-sm border border-blue-100"><i class="fa fa-search text-3xl text-[#2046B5] opacity-80"></i></div><h3 class="text-base font-semibold text-gray-800 mb-3">开始查询专利分类号</h3><div class="bg-gradient-to-r from-gray-50 to-blue-50 rounded-xl p-4 mb-4 border border-blue-100/50 w-full max-w-sm"><div class="flex items-center justify-center space-x-2 mb-2"><span class="text-sm text-gray-600">输入分类号</span><span class="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full font-medium">如 B01D</span></div><div class="flex items-center justify-center space-x-2"><span class="text-sm text-gray-600">或关键词</span><span class="px-2 py-0.5 bg-green-100 text-green-700 text-xs rounded-full font-medium">如 人工智能</span></div></div><div class="flex items-center justify-center space-x-3 mb-3"><div class="flex flex-col items-center space-y-1"><div class="w-10 h-10 rounded-full bg-[#2046B5]/10 flex items-center justify-center border border-[#2046B5]/20"><i class="fa fa-search text-[#2046B5] text-sm"></i></div><span class="text-[10px] text-gray-500">查询IPC</span></div><div class="w-8 h-px bg-gray-200"></div><div class="flex flex-col items-center space-y-1"><div class="w-10 h-10 rounded-full bg-[#2046B5]/10 flex items-center justify-center border border-[#2046B5]/20"><i class="fa fa-shield text-[#2046B5] text-sm"></i></div><span class="text-[10px] text-gray-500">预审</span></div><div class="w-8 h-px bg-gray-200"></div><div class="flex flex-col items-center space-y-1"><div class="w-10 h-10 rounded-full bg-[#2046B5]/10 flex items-center justify-center border border-[#2046B5]/20"><i class="fa fa-star text-[#2046B5] text-sm"></i></div><span class="text-[10px] text-gray-500">优先审查</span></div></div><p class="text-xs text-gray-400 mt-1">点击上方按钮进行不同类型的搜索</p></div>`;
		        updateContentArea(emptyContent);
		        hideFloatingButtons();
		        isExactMatchMode = false;
		        currentPriorityResults = [];
		        currentSearchClassification = '';
		        isKeywordSearch = false;
		        queryCache.clear();
		        expandCache.clear();
		    });
		    
		    classificationInput.addEventListener('keypress', function(e) {
		        if (e.key === 'Enter') {
		            const classification = classificationInput.value.trim();
		            if (classification) { setButtonActive(queryIPCBtn); queryIPC(classification); }
		        }
		    });
		    
		    classificationInput.addEventListener('input', function() {
		        if (this.value.trim()) updateStatusDisplay('待查询');
		        else updateStatusDisplay('知产小栈');
		    });
		}

        let classificationIndex = createEmptyClassificationIndex();
        let isClassificationIndexBuilt = false;
        let isClassificationIndexBuilding = false;
        let defaultContentAreaHTML = '';
        const queryCache = new Map();
        const expandCache = new Map();

        function resetClassificationIndex() {
            classificationIndex = createEmptyClassificationIndex();
            isClassificationIndexBuilt = false;
        }

        function hydrateClassificationIndex(payload) {
            const source = payload && payload.index ? payload.index : payload;
            classificationIndex = {
                sections: source && source.sections ? source.sections : {},
                classes: source && source.classes ? source.classes : {},
                subclasses: source && source.subclasses ? source.subclasses : {},
                mainGroups: source && source.mainGroups ? source.mainGroups : {}
            };
            isClassificationIndexBuilt = true;
        }

        function setDatabaseInitializationState(isInitializing) {
            const classificationInput = document.getElementById('classificationInput');
            const contentArea = document.getElementById('contentArea');
            const buttonIds = ['queryIPCBtn', 'preExamBtn', 'priorityBtn', 'dictionaryBtn', 'protectionBtn', 'clearBtn', 'exactMatchBtn'];
            if (classificationInput) classificationInput.disabled = isInitializing;
            buttonIds.forEach(id => {
                const button = document.getElementById(id);
                if (button) button.disabled = isInitializing;
            });
            if (isInitializing) {
                if (contentArea && !defaultContentAreaHTML) defaultContentAreaHTML = contentArea.innerHTML;
                updateStatusDisplay('正在初始化数据库');
                if (contentArea) {
                    contentArea.innerHTML = `<div class="ipc-home flex flex-col items-center justify-center py-10 text-center"><div class="w-20 h-20 mb-5 rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center shadow-sm border border-blue-100"><i class="fa fa-database text-3xl text-[#2046B5] animate-pulse"></i></div><h3 class="text-base font-semibold text-gray-800 mb-3">正在初始化数据库</h3><p class="text-sm text-gray-500">首次安装或数据库更新时会自动建立索引，请稍候...</p></div>`;
                }
                return;
            }
            if (contentArea && defaultContentAreaHTML) {
                contentArea.innerHTML = defaultContentAreaHTML;
            }
            updateStatusDisplay('知产小栈');
        }

        function ensureClassificationIndexReady() {
            if (isClassificationIndexBuilt) return true;
            if (isClassificationIndexBuilding) return false;
            if (Object.keys(ipcDictionary).length === 0) return false;
            return false;
        }

        // ==================== 全局变量 ====================
        let currentPriorityResults = [];
        let currentSearchClassification = '';
        let isExactMatchMode = false;
        let isKeywordSearch = false;
        
        let currentIpcCode = '';
        let currentIpcType = '';
        let currentModalView = 'ipc';
        let originalModalCode = '';
        let isShareMode = false;
        let selectedProvince = null;
        const PREFERRED_REGION_KEY = 'preferredProtectionRegion';

        const PREEXAM_NOTICE_KEY = 'preexamDataNoticeAcknowledged-v1';
        let preexamNoticeAcknowledged = false;
        let resumeAfterPreexamNotice = null;

        function showPreexamDataNoticeOnce(resume) {
            if (preexamNoticeAcknowledged) return false;
            try {
                if (localStorage.getItem(PREEXAM_NOTICE_KEY) === '1') return false;
            } catch (_) {}
            const modal = document.getElementById('preexamDataNoticeModal');
            if (!modal.classList.contains('hidden')) return true;
            resumeAfterPreexamNotice = resume;
            document.getElementById('acknowledgePreexamDataNotice').onclick = closePreexamDataNotice;
            modal.onclick = event => { if (event.target === modal) closePreexamDataNotice(); };
            modal.onkeydown = event => {
                if (event.key === 'Tab') {
                    event.preventDefault();
                    document.getElementById('acknowledgePreexamDataNotice').focus();
                }
            };
            openToolModal(modal);
            document.getElementById('acknowledgePreexamDataNotice').focus({ preventScroll: true });
            return true;
        }

        function closePreexamDataNotice() {
            const modal = document.getElementById('preexamDataNoticeModal');
            if (modal.classList.contains('hidden')) return;
            preexamNoticeAcknowledged = true;
            try { localStorage.setItem(PREEXAM_NOTICE_KEY, '1'); } catch (_) {}
            const resume = resumeAfterPreexamNotice;
            resumeAfterPreexamNotice = null;
            closeToolModal(modal);
            if (resume) resume();
        }

        // ==================== 通用工具函数 ====================

        function showTooltip(id, text, event) {
            if (event) event.stopPropagation();
            const existingTooltip = document.getElementById('classification-tooltip');
            if (existingTooltip) existingTooltip.remove();
            const tooltip = document.createElement('div');
            tooltip.id = 'classification-tooltip';
            tooltip.className = 'ipc-tooltip fixed bg-gray-800 text-white text-[11px] p-2 rounded shadow-lg z-50 max-w-[300px] leading-tight';
            tooltip.textContent = text;
            document.body.appendChild(tooltip);
            const anchor = event?.currentTarget || event?.target;
            const rect = anchor.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            tooltip.style.left = `${rect.left + rect.width / 2 - tooltipRect.width / 2 + window.scrollX}px`;
            tooltip.style.top = `${rect.top + rect.height / 2 - tooltipRect.height / 2 + window.scrollY}px`;
            const hideHandler = (e) => {
                if (!tooltip.isConnected) { document.removeEventListener('click', hideHandler); return; }
                if (!tooltip.contains(e.target) && !(anchor && anchor.contains(e.target))) {
                    tooltip.remove();
                    document.removeEventListener('click', hideHandler);
                }
            };
            document.addEventListener('click', hideHandler);
        }

        function escapeHTML(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function escapeJSString(value) {
            return String(value ?? '')
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/\r/g, '\\r')
                .replace(/\n/g, '\\n')
                .replace(/<\//g, '<\\/');
        }

        function showToast(message) {
            const existingToast = document.querySelector('.fixed.top-4.left-1\\/2');
            if (existingToast) existingToast.remove();
            const toast = document.createElement('div');
            toast.className = 'ipc-toast fixed top-4 left-1/2 transform -translate-x-1/2 bg-gray-800 text-white px-4 py-2 rounded-lg shadow-lg z-50 flex items-center text-sm transition-opacity duration-300';
            toast.innerHTML = `<i class="fa fa-info-circle mr-2"></i><span>${escapeHTML(message)}</span>`;
            document.body.appendChild(toast);
            setTimeout(() => {
                toast.remove();
            }, 2000);
        }

        function replaceIpcContent(element, update) {
            if (element.closest(".hidden,[hidden]")) update();
            else window.workbenchUi.replaceContent(element, update, element);
        }

        function updateStatusDisplay(text) {

            const statusDisplay = document.getElementById('statusDisplay');
            if (statusDisplay.textContent === text) return;
            replaceIpcContent(statusDisplay, () => {
                statusDisplay.textContent = text;
                if (text === '知产小栈') {
                    statusDisplay.className = 'text-xs text-[#2046B5] font-semibold bg-blue-50/50 px-2 py-1 rounded-md whitespace-nowrap min-w-[80px] text-center transition-all duration-300 flex items-center justify-center';
                } else if (text.includes('查询') || text.includes('思考')) {
                    statusDisplay.className = 'text-xs text-amber-600 font-semibold bg-amber-50 px-2 py-1 rounded-md whitespace-nowrap min-w-[80px] text-center transition-all duration-300 flex items-center justify-center';
                    statusDisplay.innerHTML = `<span>${escapeHTML(text)}</span><span class="ml-1 flex space-x-0.5"><span class="w-1 h-1 bg-amber-600 rounded-full animate-bounce"></span><span class="w-1 h-1 bg-amber-600 rounded-full animate-bounce" style="animation-delay: 0.1s"></span><span class="w-1 h-1 bg-amber-600 rounded-full animate-bounce" style="animation-delay: 0.2s"></span></span>`;
                } else if (text.includes('关键词')) {
                    statusDisplay.className = 'text-xs text-green-600 font-semibold bg-green-50 px-2 py-1 rounded-md whitespace-nowrap min-w-[80px] text-center transition-all duration-300 flex items-center justify-center';
                } else {
                    statusDisplay.className = 'text-xs text-gray-600 font-semibold bg-gray-100 px-2 py-1 rounded-md whitespace-nowrap min-w-[80px] text-center transition-all duration-300 flex items-center justify-center';
                }
            });
        }

        function updateContentArea(content) {
            isShareMode = false;
            selectedProvince = null;
            window.currentPreExamData = null;
            hideShareMenu();
            document.getElementById('shareReportBtn')?.classList.add('hidden');
            const contentArea = document.getElementById('contentArea');
            window.workbenchUi.replaceContent(contentArea, () => {
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = content;
                contentArea.replaceChildren(tempDiv.firstElementChild);
            });
            window.scrollTo(0, 0);
        }

        // ==================== 悬浮按钮控制 ====================
        function showFloatingButtons(showExactMatch = false) {
            const floatingButtons = document.getElementById('floatingButtons');
            const exactMatchBtn = document.getElementById('exactMatchBtn');
            const backToTopBtn = document.getElementById('backToTopBtn');
            const shareReportBtn = document.getElementById('shareReportBtn');

            if (floatingButtons) floatingButtons.classList.remove('hidden');
            if (backToTopBtn) backToTopBtn.classList.remove('hidden');
            if (exactMatchBtn) exactMatchBtn.classList.toggle('hidden', !showExactMatch);
            if (shareReportBtn && !showExactMatch) shareReportBtn.classList.add('hidden');

        }

        function hideFloatingButtons() {
            const floatingButtons = document.getElementById('floatingButtons');

            if (floatingButtons) floatingButtons.classList.add('hidden');

        }

        function updateExactMatchButtonState() {
            const btn = document.getElementById('exactMatchBtn');
            if (!btn) return;
            replaceIpcContent(btn, () => {
                if (isExactMatchMode) {
                    btn.classList.add('from-green-500', 'to-emerald-500');
                    btn.classList.remove('from-[#2046B5]', 'to-[#3572E5]');
                    btn.innerHTML = '<i class="fa fa-check mr-1"></i>检索全部';
                } else {
                    btn.classList.remove('from-green-500', 'to-emerald-500');
                    btn.classList.add('from-[#2046B5]', 'to-[#3572E5]');
                    btn.innerHTML = '<i class="fa fa-bullseye mr-1"></i>精准检索';
                }
            });
        }

        function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

        // ==================== 帮助模态框 ====================
        function toggleHelpModal() {
            const modal = document.getElementById('helpModal');
            if (modal.classList.contains('hidden')) {
                
                modal.classList.remove('hidden');
                focusHelpGuide();
                openToolModal(modal, false);
            } else {
                closeToolModal(modal);
                restoreHelpGuideFocus();
            }
        }

        // ==================== IPC 详情弹窗 ====================
        function openIpcDetailModal(code) {
            const modal = document.getElementById('ipcDetailModal');
            openToolModal(modal);
            
            let normalizedCode = code.toUpperCase().trim();
            if (!normalizedCode.includes('/') && /^[A-H]\d{2}[A-Z]?\d+$/.test(normalizedCode)) {
                const possibleMainGroup = `${normalizedCode}/00`;
                if (ipcDictionary[possibleMainGroup]) normalizedCode = possibleMainGroup;
            }
            
            currentIpcCode = normalizedCode;
            originalModalCode = code;
            currentIpcType = getClassificationType(currentIpcCode);
            currentModalView = 'ipc';
            
            updateModalHeader();
            generateModalContent();
        }

        function updateModalHeader() {
            const headerContainer = document.querySelector('#ipcDetailModal .bg-gradient-to-r.flex.items-center.justify-between');
            if (!headerContainer) return;
            
            const showBackBtn = currentModalView === 'ipc' && currentIpcType !== '部';
            const activeClass = 'bg-white text-[#2046B5] font-semibold shadow-sm';
            const inactiveClass = 'bg-transparent text-white hover:bg-white/10';
            const ipcBtnClass = currentModalView === 'ipc' ? activeClass : inactiveClass;
            const preExamBtnClass = currentModalView === 'preExam' ? activeClass : inactiveClass;
            const backBtnVisibleClass = showBackBtn ? 'visible opacity-100' : 'invisible opacity-0 pointer-events-none';
            
            replaceIpcContent(headerContainer, () => { headerContainer.innerHTML = `
                <div class="flex items-center w-7 sm:w-8 flex-shrink-0">
                    <button id="ipcBackBtn" onclick="goToParentClassification()" 
                        class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white text-[#2046B5] flex items-center justify-center shadow-md transition-all duration-300 hover:scale-110 active:scale-95 ${backBtnVisibleClass}">
                        <i class="fa fa-arrow-up text-xs sm:text-sm"></i>
                    </button>
                </div>
                <div class="flex-1 flex justify-center px-1 sm:px-2">
                    <div class="bg-white/20 backdrop-blur-sm rounded-full p-1 shadow-xl ring-1 ring-white/20 flex items-center gap-0.5 sm:gap-1">
                        <button id="ipcDetailTabBtn" onclick="switchIpcModalView('ipc')" class="px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-[10px] sm:text-xs min-w-[60px] sm:min-w-[80px] transition-all duration-300 ease-out ${ipcBtnClass}">分类号详情</button>
                        <button id="preExamTabBtn" onclick="switchIpcModalView('preExam')" class="px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-[10px] sm:text-xs min-w-[60px] sm:min-w-[80px] transition-all duration-300 ease-out ${preExamBtnClass}">预审详情</button>
                    </div>
                </div>
                <div class="w-7 sm:w-8 flex justify-end flex-shrink-0">
                    <button onclick="closeIpcDetailModal()" class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-white text-[#2046B5] flex items-center justify-center shadow-md transition-all duration-300 hover:scale-110 active:scale-95">
                        <i class="fa fa-times text-xs sm:text-sm"></i>
                    </button>
                </div>
            `; });
        }

        function switchIpcModalView(viewType) {
            if (currentModalView === viewType) return;
            if (viewType === 'preExam' && showPreexamDataNoticeOnce(() => switchIpcModalView(viewType))) return;
            if (viewType === 'preExam') {
                const type = getClassificationType(currentIpcCode);
                if (type === '部' || type === '大类') {
                    showPreExamRestrictionModal(type);
                    return;
                }
            }
            currentModalView = viewType;
            updateModalHeader();
            generateModalContent();
        }

        function showPreExamRestrictionModal(currentType) {
            const existingModal = document.getElementById('preExamRestrictionModal');
            if (existingModal) { closeToolModal(existingModal); existingModal.remove(); }
            
            const modal = document.createElement('div');
            modal.id = 'preExamRestrictionModal';
            modal.className = 'fixed inset-0 bg-black/40 backdrop-blur-sm z-[60] flex items-center justify-center animate-fade-in';
            
            const isSection = currentType === '部';
            const icon = isSection ? 'fa-sitemap' : 'fa-layer-group';
            const typeName = isSection ? '部' : '大类';
            const exampleCode = isSection ? 'G' : 'G01';
            
            modal.innerHTML = `
                <div class="bg-white rounded-2xl shadow-2xl max-w-[320px] w-[85%] mx-4 overflow-hidden transform scale-100 animate-scale-in">
                    <div class="h-1.5 bg-gradient-to-r from-amber-400 to-orange-500"></div>
                    <div class="p-6 text-center">
                        <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-amber-100 to-orange-100 flex items-center justify-center shadow-inner">
                            <i class="fa ${icon} text-2xl text-orange-600"></i>
                        </div>
                        <h3 class="text-lg font-bold text-gray-800 mb-2">预审分类号限制</h3>
                        <p class="text-sm text-gray-600 leading-relaxed mb-4">当前分类号为<span class="font-semibold text-orange-600 mx-1">${typeName}级别</span>，不支持预审查询</p>
                        <div class="bg-blue-50 rounded-xl p-3 mb-4 border border-blue-100">
                            <div class="flex items-center justify-center space-x-2 mb-1">
                                <i class="fa fa-lightbulb-o text-blue-500 text-sm"></i>
                                <span class="text-xs font-semibold text-blue-700">查询示例</span>
                            </div>
                            <div class="flex items-center justify-center space-x-2">
                                <span class="text-xs text-gray-500 line-through decoration-gray-400">${exampleCode}</span>
                                <i class="fa fa-arrow-right text-gray-400 text-xs"></i>
                                <span class="text-base font-bold text-[#2046B5] bg-white px-2 py-0.5 rounded shadow-sm">G01N</span>
                            </div>
                            <p class="text-xs text-gray-500 mt-1.5">请使用<span class="font-medium text-gray-700">小类分类号</span>查询预审</p>
                        </div>
                        <div class="inline-flex items-center px-3 py-1 rounded-full bg-amber-50 border border-amber-200 text-xs text-amber-700">
                            <i class="fa fa-info-circle mr-1.5"></i>如：B01D、G01N、A01B
                        </div>
                    </div>
                    <div class="px-4 pb-4">
                        <button onclick="closePreExamRestrictionModal()" class="w-full bg-gradient-to-r from-[#2046B5] to-[#3572E5] text-white py-2.5 rounded-xl font-medium text-sm shadow-lg shadow-blue-500/30 hover:shadow-xl hover:scale-[1.02] transition-all duration-200">我知道了</button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            openToolModal(modal);
            modal.addEventListener('click', (e) => { if (e.target === modal) closePreExamRestrictionModal(); });
        }

        function closePreExamRestrictionModal() {
            const modal = document.getElementById('preExamRestrictionModal');
            if (modal) {
                closeToolModal(modal);
                modal.remove();
            }
        }

        function generateModalContent() {
            if (currentModalView === 'ipc') {
                generateIpcDetailContent(currentIpcCode);
            } else if (currentModalView === 'preExam') {
                generatePreExamDetailContent();
            }
        }

        function generatePreExamDetailContent() {
            const content = document.getElementById('ipcDetailContent');
            let targetCode = currentIpcCode;
            let displayNote = '';
            
            if (currentIpcType === '大组' || currentIpcType === '小组') {
                const subclassCode = targetCode.substring(0, 4);
                if (ipcDictionary[subclassCode]) {
                    targetCode = subclassCode;
                    displayNote = `<div class="mb-3 bg-blue-50 border border-blue-200 rounded-lg p-2 text-xs text-blue-700 flex items-start"><i class="fa fa-info-circle mr-2 mt-0.5"></i><div><p class="font-medium">已自动切换至上级小类</p><p class="text-blue-600 mt-0.5">当前显示 ${subclassCode} 的预审情况（原分类号：${originalModalCode}）</p></div></div>`;
                } else {
                    replaceIpcContent(content, () => { content.innerHTML = `<div class="text-center text-gray-500 py-8"><i class="fa fa-exclamation-circle text-3xl mb-2 opacity-50"></i><p class="text-sm">未找到上级小类 ${escapeHTML(subclassCode)} 的信息</p></div>`; });
                    return;
                }
            }
            
            const preExamHTML = generatePreExamHTMLForModal(targetCode, '小类');
            replaceIpcContent(content, () => { content.innerHTML = displayNote + preExamHTML; });
        }

        function generatePreExamHTMLForModal(code, type) {
            const preferredRegion = getPreferredRegion();
            const allCenters = [];
            
            for (const [province, centers] of Object.entries(protectionCenterDatabase)) {
                for (const [centerName, centerData] of Object.entries(centers)) {
                    const ipcClassifications = centerData.ipc || [];
                    let isMatch = false;
                    for (const centerClass of ipcClassifications) {
                        if (code === centerClass || code.startsWith(centerClass) || centerClass.startsWith(code)) {
                            isMatch = true;
                            break;
                        }
                    }
                    allCenters.push({ 
                        province, 
                        name: centerName, 
                        shortName: centerName.replace(/省|市|自治区|回族|壮族|维吾尔/g, '').replace('保护中心', ''),
                        isMatch, 
                        isProvinceCenter: centerName.includes('省保护中心')
                    });
                }
            }
            
            allCenters.sort((a, b) => {
                let score = 0;
                if (preferredRegion) {
                    if (a.province === preferredRegion) score -= 100;
                    if (b.province === preferredRegion) score += 100;
                }
                if (a.isProvinceCenter) score -= 10;
                if (b.isProvinceCenter) score += 10;
                return score;
            });
            
            const centersByProvince = {};
            allCenters.forEach(center => {
                if (!centersByProvince[center.province]) centersByProvince[center.province] = { matched: [], unmatched: [] };
                if (center.isMatch) centersByProvince[center.province].matched.push(center);
                else centersByProvince[center.province].unmatched.push(center);
            });
            
            const codeTitleInfo = parseDeletedIpcTitle(ipcDictionary[code] || '', code);
            let html = `<div class="space-y-3">`;
            html += `<div class="border-b border-gray-200 pb-2 mb-3 space-y-2">
                <div class="flex items-center gap-2 flex-wrap">
                    <h3 class="text-base font-bold text-[#2046B5]">${code}</h3>
                    ${renderDotGroupBadge(codeTitleInfo.dotGroup)}
                    ${renderClassificationTypeBadge(type)}
                    ${renderDeletedIpcBadge(codeTitleInfo.isDeleted)}
                </div>
                <div class="w-full">${renderIpcTitleContent(codeTitleInfo, 'text-xs text-gray-600', 'text-[10px] text-gray-500 italic')}</div>
            </div>`;
            
            const totalMatched = allCenters.filter(c => c.isMatch).length;
            const totalUnmatched = allCenters.filter(c => !c.isMatch).length;
            
            if (totalMatched > 0 || totalUnmatched > 0) {
                html += `<div class="flex items-center justify-between text-xs text-gray-500 mb-3 px-1">
                    <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-green-500"></span> 符合 ${totalMatched}</span>
                    <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-gray-400"></span> 不符合 ${totalUnmatched}</span>
                </div>`;
            }
            
            if (Object.keys(centersByProvince).length > 0) {
                html += `<div class="space-y-3 max-h-[55vh] overflow-y-auto no-scrollbar pb-2">`;
                for (const province in centersByProvince) {
                    const provinceData = centersByProvince[province];
                    const isPreferred = province === preferredRegion;
                    html += `<div class="${isPreferred ? 'bg-blue-50/30 border-l-4 border-l-[#2046B5] border-y border-r border-gray-200' : 'bg-gray-50/50 border border-gray-200'} rounded-lg p-2.5">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-1.5 overflow-hidden">
                                <span class="text-xs font-bold ${isPreferred ? 'text-[#2046B5]' : 'text-gray-600'} truncate">${province}</span>
                                ${isPreferred ? '<span class="flex-shrink-0 text-[9px] bg-[#2046B5] text-white px-1.5 py-0.5 rounded-full whitespace-nowrap">默认</span>' : ''}
                            </div>
                            <span class="text-[10px] text-gray-400 flex-shrink-0">${provinceData.matched.length}符合/${provinceData.unmatched.length}不符合</span>
                        </div>`;
                    
                    if (provinceData.matched.length > 0) {
                        html += `<div class="grid grid-cols-3 gap-1.5 mb-2">`;
                        provinceData.matched.forEach(center => {
                            const displayName = center.shortName || center.name.replace('保护中心', '');
                            html += `<div class="bg-green-50 border border-green-400 rounded-md py-1.5 px-1 text-center shadow-sm overflow-hidden" title="${center.name}">
                                <span class="text-[10px] font-bold text-green-800 truncate block leading-tight">${displayName}${center.isProvinceCenter ? '<span class="bg-green-200 text-green-800 text-[8px] px-1 rounded ml-0.5 font-bold">省</span>' : ''}</span>
                            </div>`;
                        });
                        html += `</div>`;
                    }
                    
                    if (provinceData.unmatched.length > 0) {
                        html += `<div class="grid grid-cols-3 gap-1.5">`;
                        provinceData.unmatched.forEach(center => {
                            const displayName = center.shortName || center.name.replace('保护中心', '');
                            html += `<div class="bg-gray-100 border border-gray-300 rounded-md py-1.5 px-1 text-center overflow-hidden" title="${center.name}（不符合）">
                                <span class="text-[10px] font-medium text-gray-600 truncate block leading-tight">${displayName}${center.isProvinceCenter ? '<span class="text-gray-400 text-[9px] ml-0.5">·省</span>' : ''}</span>
                            </div>`;
                        });
                        html += `</div>`;
                    }
                    html += `</div>`;
                }
                html += `</div>`;
            } else {
                html += `<div class="text-center py-8 text-gray-400 text-xs bg-gray-50 rounded-lg">暂无保护中心数据</div>`;
            }
            html += `</div>`;
            return html;
        }

        function closeIpcDetailModal() {
            const modal = document.getElementById('ipcDetailModal');
            closeToolModal(modal);
            currentModalView = 'ipc';
            originalModalCode = '';
        }

        function generateIpcDetailContent(code) {
            const content = document.getElementById('ipcDetailContent');
            const query = code.toUpperCase().trim();
            let normalizedQuery = query;
            if (!query.includes('/') && /^[A-H]\d{2}[A-Z]?\d+$/.test(query)) {
                const possibleMainGroup = `${query}/00`;
                if (ipcDictionary[possibleMainGroup]) normalizedQuery = possibleMainGroup;
            }
            if (ipcDictionary[normalizedQuery]) {
                const type = getClassificationType(normalizedQuery);
                let detailContent = '';
                const getItems = (key) => getIndexedItems(key, normalizedQuery);
                if (type === '部') detailContent = renderDetailSection(normalizedQuery, getItems('sections'), '大类');
                else if (type === '大类') detailContent = renderDetailSection(normalizedQuery, getItems('classes'), '小类');
                else if (type === '小类') detailContent = renderDetailSection(normalizedQuery, getItems('subclasses'), '大组');
                else if (type === '大组') detailContent = renderDetailSection(normalizedQuery, getItems('mainGroups'), '小组');
                else detailContent = renderDetailDefault(normalizedQuery, type);
                replaceIpcContent(content, () => { content.innerHTML = detailContent; });
            } else {
                replaceIpcContent(content, () => { content.innerHTML = `<div class="text-center text-gray-500 py-8"><i class="fa fa-exclamation-circle text-3xl mb-2 opacity-50"></i><p class="text-sm">未找到分类号 ${escapeHTML(code)} 的详细信息</p></div>`; });
            }
        }

        function renderDetailSection(code, items, childType) {
            const titleInfo = parseDeletedIpcTitle(ipcDictionary[code], code);
            return `<div class="space-y-3 text-xs"><div class="border-b pb-2"><div class="flex items-center justify-between gap-2"><div class="flex items-center gap-2 flex-wrap"><h4 class="text-base font-bold text-[#2046B5]">${code}</h4>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(getClassificationType(code))}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div></div>${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-1', 'text-[11px] text-gray-500 italic')}</div><div><h5 class="text-sm font-semibold text-gray-700 mb-2">下属${childType} (${items.length})</h5><div class="space-y-1.5 max-h-[400px] overflow-y-auto">${items.map(item => {
                const itemTitleInfo = parseDeletedIpcTitle(item.title, item.code);
                return `<div class="bg-blue-50 rounded p-2 cursor-pointer hover:bg-blue-100" onclick="openIpcDetailModal('${item.code}')"><div class="flex items-start gap-2"><div class="flex items-center gap-2 flex-wrap min-w-0 flex-1"><span class="font-semibold text-[#2046B5]">${item.code}</span>${renderDotGroupBadge(itemTitleInfo.dotGroup)}<span class="bg-blue-100 text-blue-800 text-[9px] px-1 py-0.25 rounded">${childType}</span>${renderDeletedIpcBadge(itemTitleInfo.isDeleted)}</div></div><div class="mt-1">${renderIpcTitleContent(itemTitleInfo, 'text-gray-600', 'text-[11px] text-gray-500 italic')}</div></div>`;
            }).join('')}</div></div></div>`;
        }

        function renderDetailDefault(code, type) {
            const titleInfo = parseDeletedIpcTitle(ipcDictionary[code], code);
            return `<div class="space-y-3 text-xs"><div class="border-b pb-2"><div class="flex items-center justify-between gap-2"><div class="flex items-center gap-2 flex-wrap"><h4 class="text-base font-bold text-[#2046B5]">${code}</h4>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(type)}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div></div>${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-1', 'text-[11px] text-gray-500 italic')}</div></div>`;
        }

        function getParentClassification(code, type) {
            if (type === '部') return null;
            if (type === '大类') return code.substring(0, 1);
            if (type === '小类') return code.substring(0, 3);
            if (type === '大组') return code.substring(0, 4);
            if (type === '小组') return `${code.substring(0, code.indexOf('/'))}/00`;
            return null;
        }

        function goToParentClassification() {
            if (currentModalView !== 'ipc') return;
            const parentCode = getParentClassification(currentIpcCode, currentIpcType);
            if (parentCode && ipcDictionary[parentCode]) {
                currentModalView = 'ipc';
                openIpcDetailModal(parentCode);
            }
        }

        // ==================== 保护中心功能 ====================
        function openProtectionCenterModal() {
            if (showPreexamDataNoticeOnce(openProtectionCenterModal)) return;
            const modal = document.getElementById('protectionCenterModal');
            openToolModal(modal);
            generateProtectionCenterList();
        }

        function closeProtectionCenterModal() {
            const modal = document.getElementById('protectionCenterModal');
            closeToolModal(modal);
        }

        function openRegionSettingsModal() {
            const modal = document.getElementById('regionSettingsModal');
            openToolModal(modal);
            generateRegionSettingsList();
        }

        function closeRegionSettingsModal() {
            const modal = document.getElementById('regionSettingsModal');
            closeToolModal(modal);
            generateProtectionCenterList();
        }

        function getPreferredRegion() { 
            try { return localStorage.getItem(PREFERRED_REGION_KEY); } catch (e) { return null; } 
        }

        function setPreferredRegion(region) { 
            try { localStorage.setItem(PREFERRED_REGION_KEY, region); } catch (e) {} 
            showToast(`已设置 ${region} 为默认地区`); 
            closeRegionSettingsModal(); 
        }

        function generateRegionSettingsList() {
            const content = document.getElementById('regionSettingsContent');
            const preferredRegion = getPreferredRegion();
            const regions = Object.keys(protectionCenterDatabase);
            let html = '<div class="space-y-2">';
            regions.forEach(region => {
                const isSelected = region === preferredRegion;
                const bgClass = isSelected ? 'bg-[#2046B5] text-white border-[#2046B5]' : 'bg-white text-gray-800 border-gray-200 hover:bg-blue-50 hover:border-blue-300';
                const iconClass = isSelected ? 'fa-check-circle text-white' : 'fa-circle-o text-gray-400';
                html += `<div class="border rounded-lg px-4 py-3 cursor-pointer transition-colors flex items-center justify-between ${bgClass}" onclick="setPreferredRegion('${region}')"><h5 class="font-medium">${region}</h5><i class="fa ${iconClass}"></i></div>`;
            });
            html += '</div>';
            replaceIpcContent(content, () => { content.innerHTML = html; });
        }

        function generateProtectionCenterList() {
            const content = document.getElementById('protectionCenterContent');
            const preferredRegion = getPreferredRegion();
            let regions = Object.keys(protectionCenterDatabase);
            if (preferredRegion && regions.includes(preferredRegion)) {
                regions = regions.sort((a, b) => (a === preferredRegion ? -1 : b === preferredRegion ? 1 : 0));
            }
            let html = '';
            for (const province of regions) {
                const centers = protectionCenterDatabase[province];
                const centerNames = Object.keys(centers);
                const centerCount = centerNames.length;
                const isPreferred = province === preferredRegion;
                const headerBg = isPreferred ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200';
                const headerText = isPreferred ? 'text-[#2046B5]' : 'text-gray-800';
                const preferredTag = isPreferred ? '<span class="text-[8px] bg-[#2046B5] text-white px-1 py-0.25 rounded ml-1.5">默认</span>' : '';
                const isMunicipality = ['北京', '天津', '上海', '重庆'].includes(province);
                if (!isMunicipality || centerCount > 1) {
                    html += `<div class="mb-4 last:mb-0"><div class="flex items-center justify-between ${headerBg} rounded-lg px-4 py-3 cursor-pointer hover:bg-gray-100 transition-colors border" onclick="toggleProvince('${province}')" id="province-${province}-header"><h4 class="font-medium ${headerText} flex items-center">${province}${preferredTag}</h4><div class="flex items-center"><span class="text-xs text-gray-500 mr-2">${centerCount} 个保护中心</span><i class="fa fa-chevron-down text-gray-500 transition-transform duration-300" id="province-${province}-icon"></i></div></div><div class="ml-2 mt-1 space-y-1 hidden" id="province-${province}-content">`;
                    centerNames.forEach(centerName => {
                        html += `<div class="bg-white border border-gray-200 rounded-lg px-4 py-2.5 cursor-pointer hover:bg-blue-50 hover:border-blue-300 transition-colors" onclick="showProtectionCenterContent('${province}', '${centerName.replace(/'/g, "\\'")}')"><div class="flex items-center justify-between"><h5 class="font-medium text-gray-800">${centerName}</h5><i class="fa fa-angle-right text-gray-400"></i></div></div>`;
                    });
                    html += `</div></div>`;
                } else {
                    const centerName = centerNames[0];
                    html += `<div class="mb-4 last:mb-0"><div class="bg-white border border-gray-200 rounded-lg px-4 py-3 cursor-pointer hover:bg-blue-50 hover:border-blue-300 transition-colors ${isPreferred ? 'ring-2 ring-[#2046B5] ring-opacity-50' : ''}" onclick="showProtectionCenterContent('${province}', '${centerName.replace(/'/g, "\\'")}')"><div class="flex items-center justify-between"><h4 class="font-medium ${headerText} flex items-center">${centerName}${preferredTag}</h4><i class="fa fa-angle-right text-gray-400"></i></div></div></div>`;
                }
            }
            replaceIpcContent(content, () => { content.innerHTML = html; });
        }

        function toggleProvince(province) {
            const content = document.getElementById(`province-${province}-content`);
            const icon = document.getElementById(`province-${province}-icon`);
            if ((content.dataset.workbenchExpanded === 'false' || (content.dataset.workbenchExpanded === undefined && content.classList.contains('hidden')))) {
                window.workbenchUi.collapse(content, true);
                icon.style.transform = 'rotate(180deg)';
            } else {
                window.workbenchUi.collapse(content, false);
                icon.style.transform = 'rotate(0deg)';
            }
        }

        function showProtectionCenterContent(province, centerName) {
            viewRevision++;
            closeProtectionCenterModal();
            updateStatusDisplay(centerName);
            const centerData = protectionCenterDatabase[province][centerName];
            const ipcClassifications = centerData.ipc;
            let content = `<div class="space-y-4"><div id="protectionCenterInfo" class="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-3 sticky top-4 z-10 shadow-sm"><div class="flex items-center justify-between mb-2"><h3 class="font-semibold text-blue-800 text-sm">${centerName}</h3><span class="bg-blue-200 text-blue-800 text-xs px-2 py-0.5 rounded-full">${province}</span></div><div class="text-[12px] text-blue-700 mb-2"><span id="classificationTypeText">IPC 分类号数量：</span><span class="font-semibold" id="classificationCount">${ipcClassifications.length}</span></div><div class="flex justify-center space-x-2"><button id="ipcButton" class="px-3 py-1 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 transition-colors flex-1 max-w-[120px]" onclick="switchClassificationType('ipc', '${province}', '${centerName}')">IPC 分类号</button><button id="locarnoButton" class="px-3 py-1 bg-gray-200 text-gray-700 text-xs rounded-md hover:bg-gray-300 transition-colors flex-1 max-w-[120px]" onclick="switchClassificationType('locarno', '${province}', '${centerName}')">洛迦诺分类号</button></div></div><div class="bg-white border border-gray-200 rounded-lg p-4"><h4 class="font-semibold text-gray-700 mb-3 flex items-center"><i class="fa fa-list-ul mr-2 text-gray-500"></i> <span id="classificationTitle">IPC 分类号列表</span></h4><div id="classificationList">${generateClassificationList(ipcClassifications, 'ipc', centerName)}</div></div></div>`;
            updateContentArea(content);
            showFloatingButtons(false);
        }

        function generateClassificationList(classifications, type, sourceLabel = '') {
            const sortedClassifications = Array.isArray(classifications)
                ? [...classifications].sort((a, b) => compareClassificationCodes(a, b))
                : [];
            return sortedClassifications.map(cls => {
                const dict = type === 'ipc' ? ipcDictionary : locarnoDictionary;
                const className = dict[cls] || '暂无详细信息';
                let displayText = className, noteText = '';
                if (className.includes('注：')) {
                    const noteIndex = className.indexOf('注：');
                    displayText = className.substring(0, noteIndex).trim();
                    noteText = className.substring(noteIndex).trim();
                }
                
                // 洛迦诺分类号(type='locarno')：仅显示蓝色文字，无点击交互
                if (type === 'locarno') {
                    return `<div class="border-b border-gray-100 pb-3 mb-3 last:border-0 last:pb-0 last:mb-0"><div class="flex items-center justify-between mb-1"><span class="font-medium text-[#2046B5]">${cls}</span></div><p class="text-sm text-gray-600">${displayText}</p>${noteText ? `<p class="text-xs text-gray-400 mt-1 italic">${noteText}</p>` : ''}</div>`;
                } 
                // IPC分类号(type='ipc')：点击触发动画飞入搜索框
                else {
                    return `<div class="border-b border-gray-100 pb-3 mb-3 last:border-0 last:pb-0 last:mb-0"><div class="flex items-center justify-between mb-1"><div class="flex items-center"><span class="font-medium text-[#2046B5] cursor-pointer hover:text-[#3572E5] hover:underline transition-colors" onclick="animateCodeToInput('${cls}', event)" title="点击填入搜索框">${cls}</span></div></div><p class="text-sm text-gray-600">${displayText}</p>${noteText ? `<p class="text-xs text-gray-400 mt-1 italic">${noteText}</p>` : ''}</div>`;
                }
            }).join('');
        }

        function switchClassificationType(type, province, centerName) {
            const centerData = protectionCenterDatabase[province][centerName];
            const classifications = centerData[type];
            const list = document.getElementById('classificationList');
            window.workbenchUi.replaceContent(list, () => { list.innerHTML = generateClassificationList(classifications, type, centerName); });
            document.getElementById('classificationCount').textContent = classifications.length;
            document.getElementById('classificationTypeText').textContent = type === 'ipc' ? 'IPC 分类号数量：' : '洛迦诺分类号数量：';
            document.getElementById('classificationTitle').textContent = type === 'ipc' ? 'IPC 分类号列表' : '洛迦诺分类号列表';
            const ipcButton = document.getElementById('ipcButton');
            const locarnoButton = document.getElementById('locarnoButton');
            if (type === 'ipc') {
                ipcButton.classList.remove('bg-gray-200', 'text-gray-700'); ipcButton.classList.add('bg-blue-600', 'text-white');
                locarnoButton.classList.remove('bg-blue-600', 'text-white'); locarnoButton.classList.add('bg-gray-200', 'text-gray-700');
            } else {
                locarnoButton.classList.remove('bg-gray-200', 'text-gray-700'); locarnoButton.classList.add('bg-blue-600', 'text-white');
                ipcButton.classList.remove('bg-blue-600', 'text-white'); ipcButton.classList.add('bg-gray-200', 'text-gray-700');
            }
        }

        // ==================== IPC 查询功能 ====================

        function getHierarchyInfo(code) {
            const info = {};
            if (code.length >= 1) info.sectionCode = code.substring(0, 1);
            if (code.length >= 3) info.classCode = code.substring(0, 3);
            if (code.length >= 4) info.subclassCode = code.substring(0, 4);
            if (code.includes('/')) info.mainGroupCode = `${code.substring(0, code.indexOf('/'))}/00`;
            info.sectionTitle = ipcDictionary[info.sectionCode] || '';
            info.classTitle = ipcDictionary[info.classCode] || '';
            info.subclassTitle = ipcDictionary[info.subclassCode] || '';
            info.mainGroupTitle = ipcDictionary[info.mainGroupCode] || '';
            return info;
        }

        function renderDeletedIpcBadge(isDeleted, className = '') {
            if (!isDeleted) return '';
            return `<span class="bg-amber-100 text-amber-700 text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap${className ? ` ${className}` : ''}">此分类号已在新版删除</span>`;
        }

        function renderClassificationTypeBadge(type, className = '') {
            return `<span class="bg-blue-100 text-blue-800 text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap${className ? ` ${className}` : ''}">${escapeHTML(type)}</span>`;
        }

        function renderDotGroupBadge(dotGroup, className = '') {
            if (!dotGroup) return '';
            return `<span class="bg-slate-100 text-slate-700 text-[12px] font-semibold leading-none px-1.5 py-0.5 rounded-full whitespace-nowrap${className ? ` ${className}` : ''}">${escapeHTML(dotGroup)}</span>`;
        }

        function sortClassificationItems(items) {
            return items.sort((a, b) => compareClassificationCodes(a.code, b.code));
        }

        function getIndexedCodes(bucket, parentCode) {
            if (!classificationIndex[bucket]) return [];
            return [...(classificationIndex[bucket][parentCode] || [])];
        }

        function getIndexedItems(bucket, parentCode) {
            return getIndexedCodes(bucket, parentCode).map(code => ({
                code,
                title: ipcDictionary[code] || ''
            }));
        }

        function renderIpcTitleContent(titleInfo, mainClass = 'text-sm text-gray-700', noteClass = 'text-xs text-gray-500 italic') {
            const mainTitle = escapeHTML(titleInfo.cleanTitle || '');
            const noteHtml = titleInfo.noteText ? `<p class="${noteClass}">[注释] ${escapeHTML(titleInfo.noteText)}</p>` : '';
            return `<div class="space-y-1"><p class="${mainClass}">${mainTitle}</p>${noteHtml}</div>`;
        }

        function renderHighlightedIpcTitleContent(titleInfo, keyword, mainClass = 'text-sm text-gray-700', noteClass = 'text-xs text-gray-500 italic') {
            const mainTitle = highlightText(titleInfo.cleanTitle || '', keyword);
            const noteHtml = titleInfo.noteText ? `<p class="${noteClass}">[注释] ${highlightText(titleInfo.noteText, keyword)}</p>` : '';
            return `<div class="space-y-1"><p class="${mainClass}">${mainTitle}</p>${noteHtml}</div>`;
        }

        function renderHierarchyTitlePreview(titleInfo, className = 'text-[11px] text-gray-600') {
            const previewText = titleInfo.noteText ? `${titleInfo.cleanTitle} [注释] ${titleInfo.noteText}` : titleInfo.cleanTitle;
            return `<p class="${className} truncate whitespace-nowrap overflow-hidden">${escapeHTML(previewText)}</p>`;
        }

        function generateHierarchyHTML(hierarchy, currentCode) {
            let html = '<div class="bg-gray-50 rounded-lg p-2.5"><div class="space-y-1.5">';
            const addLevel = (code, title, type) => {
                if (!code || code === currentCode) return;
                const titleInfo = parseDeletedIpcTitle(title, code);
                const safeTooltipTitle = escapeJSString(titleInfo.plainTextTitle);
                html += `<div class="group"><div class="flex items-center"><div class="flex items-center gap-1.5 min-w-[40px]"><h5 class="font-medium text-[#2046B5] cursor-pointer hover:underline text-[11px]" onclick="document.getElementById('classificationInput').value='${code}'; queryIPC('${code}')">${code}</h5>${renderDotGroupBadge(titleInfo.dotGroup, 'flex-shrink-0')}</div><div class="flex-1 ml-4 relative min-w-0"><div class="flex items-center gap-1.5"><div class="flex-1 min-w-0 pr-2 cursor-pointer hover:text-blue-600" onclick="showTooltip('${type}-${currentCode}', '${safeTooltipTitle}', event)">${renderHierarchyTitlePreview(titleInfo)}</div>${renderDeletedIpcBadge(titleInfo.isDeleted, 'flex-shrink-0')}</div></div></div></div>`;
            };
            addLevel(hierarchy.sectionCode, hierarchy.sectionTitle, 'section');
            if (hierarchy.classCode && hierarchy.classCode !== hierarchy.sectionCode) addLevel(hierarchy.classCode, hierarchy.classTitle, 'class');
            if (hierarchy.subclassCode && hierarchy.subclassCode !== hierarchy.classCode) addLevel(hierarchy.subclassCode, hierarchy.subclassTitle, 'subclass');
            if (hierarchy.mainGroupCode && hierarchy.mainGroupCode !== currentCode) addLevel(hierarchy.mainGroupCode, hierarchy.mainGroupTitle, 'maingroup');
            html += '</div></div>';
            return html;
        }

        function getSubgroups(mainGroupCode) {
            return sortClassificationItems(getIndexedItems('mainGroups', mainGroupCode));
        }

        function generateSubgroupsHTML(subgroups) {
            if (subgroups.length === 0) return '<div class="bg-white rounded-lg p-3 text-center text-gray-500 text-sm">暂无下属小组</div>';
            return `<div class="space-y-2">${subgroups.map(subgroup => {
                const titleInfo = parseDeletedIpcTitle(subgroup.title, subgroup.code);
                return `<div class="bg-blue-50 rounded-lg p-3 cursor-pointer hover:bg-blue-100 transition-colors" onclick="document.getElementById('classificationInput').value='${subgroup.code}'; queryIPC('${subgroup.code}')"><div class="flex items-center gap-2 flex-wrap mb-1"><h4 class="font-semibold text-[#2046B5]">${subgroup.code}</h4>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge('小组', 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>${renderIpcTitleContent(titleInfo, 'text-sm text-gray-700', 'text-xs text-gray-500 italic')}</div>`;
            }).join('')}</div>`;
        }

        function queryIPC(classification) {
 viewRevision++;
            if (!ensureClassificationIndexReady()) {
                showToast('正在初始化数据库，请稍候');
                return;
            }
            if (isShareMode) {
                isShareMode = false;
                selectedProvince = null;
                hideShareMenu();
                window.currentPreExamData = null;
            }
            if (!classification) { showToast('请输入分类号'); return; }
            updateStatusDisplay('思考中...');
            const query = normalizeClassificationInput(classification);
            const isKeywordSearch = /^[\u4e00-\u9fa5]+$/.test(query);
            let normalizedQuery = query;
            let searchPattern = query;
            
            if (!query.includes('/') && !query.includes('*') && /^[A-H]\d{2}[A-Z]\d+$/.test(query)) {
                const possibleMainGroup = `${query}/00`;
                if (ipcDictionary[possibleMainGroup]) {
                    normalizedQuery = possibleMainGroup;
                    searchPattern = possibleMainGroup;
                }
            }
            
            if (query.includes('*')) {
                searchPattern = query.replace(/\*/g, '');
                if (!searchPattern.includes('/') && /^[A-H]\d{2}[A-Z]\d+$/.test(searchPattern)) {
                    const possibleMainGroup = `${searchPattern}/00`;
                    if (ipcDictionary[possibleMainGroup]) normalizedQuery = possibleMainGroup;
                }
            }
            
            const cacheKey = `${normalizedQuery}-${isKeywordSearch}`;
            if (queryCache.has(cacheKey) && !isKeywordSearch) {
                const cached = queryCache.get(cacheKey);
                updateStatusDisplay('IPC 检索');
                updateContentArea(cached.content);
                showFloatingButtons(false);
                return;
            }
            
            if (ipcDictionary[normalizedQuery] && !isKeywordSearch) {
                const type = getClassificationType(normalizedQuery);
                const content = displayExactMatch(normalizedQuery, type, ipcDictionary[normalizedQuery]);
                queryCache.set(cacheKey, { content, timestamp: Date.now() });
                updateStatusDisplay('IPC 检索');
                updateContentArea(content);
                showFloatingButtons(false);
            } else {
                displayRelatedMatches(query, isKeywordSearch, searchPattern);
            }
			// 放在这两个函数最后（updateContentArea 之后）
			
        }

        async function displayRelatedMatches(query, isKeywordSearch = false, searchPattern = null) {
  const revision = viewRevision;
  const pattern = searchPattern || query;
  const uniqueResults = await requestMainQuery('related', [query, isKeywordSearch, searchPattern]);
  if (revision !== viewRevision) return;
  if (!uniqueResults) { showQueryFailure(() => displayRelatedMatches(query, isKeywordSearch, searchPattern)); return; }
            if (uniqueResults.length > 0) {
                const displayResults = uniqueResults.slice(0, 50);
                const hasMore = uniqueResults.length > 50;
                const safePatternText = escapeHTML(pattern);
                updateStatusDisplay('IPC 关键词模式');
                
                let content = `<div class="space-y-4">
                    <div class="text-center mb-4"><h3 class="text-lg font-bold text-[#2046B5]">查询结果</h3><p class="text-sm text-gray-600">找到 ${uniqueResults.length} 个相关分类号${query.includes('*') ? '（通配符匹配）' : ''}${isKeywordSearch ? `，关键词：${safePatternText}` : ''}</p></div>
                    <div class="space-y-3">
                        ${displayResults.map(cls => {
                            const isExact = cls.code === pattern;
                            const highlightClass = isExact ? 'ring-2 ring-[#2046B5] ring-opacity-50 bg-blue-50' : 'bg-gray-50';
                            const safeCodeText = escapeHTML(cls.code);
                            const safeCodeJs = escapeJSString(cls.code);
                            const titleInfo = parseDeletedIpcTitle(cls.title, cls.code);
                            const renderedTitle = isKeywordSearch
                                ? renderHighlightedIpcTitleContent(titleInfo, query, 'text-sm text-gray-700 break-words whitespace-normal', 'text-xs text-gray-500 italic break-words whitespace-normal')
                                : renderIpcTitleContent(titleInfo, 'text-sm text-gray-700 break-words whitespace-normal', 'text-xs text-gray-500 italic break-words whitespace-normal');
                            return `<div class="${highlightClass} rounded-lg p-3 cursor-pointer hover:bg-gray-100 transition-colors" onclick="document.getElementById('classificationInput').value='${safeCodeJs}'; queryIPC('${safeCodeJs}')">
                                <div class="flex items-center gap-2 flex-wrap"><h4 class="font-semibold ${isExact ? 'text-[#2046B5] text-lg' : 'text-gray-700'}">${safeCodeText}</h4>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(`${cls.type}${isExact ? '（精确）' : ''}`, 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>
                                <div class="mt-1">${renderedTitle}</div>
                            </div>`;
                        }).join('')}
                        ${hasMore ? `<div class="text-center py-2 text-xs text-gray-400">还有 ${uniqueResults.length - 50} 个结果，请输入更精确的关键词</div>` : ''}
                    </div>
                </div>`;
                updateContentArea(content);
            } else {
                updateStatusDisplay('未找到');
                updateContentArea(`<div class="text-center text-gray-500 py-8"><i class="fa fa-exclamation-circle text-4xl mb-3 opacity-50"></i><p class="text-sm">未找到 ${escapeHTML(query)} 相关信息</p><p class="text-xs mt-2 text-gray-400">请检查输入是否正确，或尝试使用通配符如 G01N1*</p></div>`);
            }
            showFloatingButtons(false);
        }

        function displayExactMatch(code, type, title) {
            let content = '';
            const hierarchy = getHierarchyInfo(code);
            if (type === '部') content = generateSectionContent(code, title, sortClassificationItems(getIndexedItems('sections', code)), hierarchy);
            else if (type === '大类') content = generateClassContent(code, title, sortClassificationItems(getIndexedItems('classes', code)), hierarchy);
            else if (type === '小类') content = generateSubclassContent(code, title, sortClassificationItems(getIndexedItems('subclasses', code)), hierarchy);
            else if (type === '大组') content = generateMainGroupContent(code, title, getSubgroups(code), hierarchy);
            else if (type === '小组') content = generateSubgroupContent(code, title, hierarchy);
            else content = generateDefaultContent(code, title);
            updateStatusDisplay('IPC 检索');
            updateContentArea(content);
            return content;
        }

        function generateSectionContent(code, title, classes) {
            const titleInfo = parseDeletedIpcTitle(title, code);
            return `<div class="space-y-4 min-h-full">
                <div class="border-b pb-3">
                    <div class="flex items-center gap-2 flex-wrap"><h3 class="text-lg font-bold text-[#2046B5]">${code}</h3>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(getClassificationType(code), 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>
                    ${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-2 text-sm', 'text-xs text-gray-500 italic')}
                </div>
                <div>
                    <h4 class="text-sm font-semibold text-gray-700 mb-2">下属大类 (${classes.length})</h4>
                    <div class="space-y-2">
                        ${classes.map(cls => {
                            const clsTitleInfo = parseDeletedIpcTitle(cls.title, cls.code);
                            return `<div class="bg-blue-50 rounded-lg p-3 cursor-pointer hover:bg-blue-100 transition-colors" onclick="toggleSubclasses('${cls.code}', this)">
                            <div class="flex items-center justify-between gap-2">
                                <div class="flex items-center gap-2 flex-wrap"><h4 class="font-semibold text-[#2046B5]">${cls.code}</h4>${renderDotGroupBadge(clsTitleInfo.dotGroup)}${renderClassificationTypeBadge('大类', 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(clsTitleInfo.isDeleted)}</div>
                                <i class="fa fa-chevron-down text-blue-600"></i>
                            </div>
                            ${renderIpcTitleContent(clsTitleInfo, 'text-sm text-gray-700 mt-1', 'text-xs text-gray-500 italic')}
                            <div id="subclasses-${cls.code}" class="mt-3 hidden"></div>
                        </div>`;
                        }).join('')}
                    </div>
                </div>
            </div>`;
        }

        function generateClassContent(code, title, subclasses, hierarchy) {
            const titleInfo = parseDeletedIpcTitle(title, code);
            return `<div class="space-y-4 min-h-full">
                <div class="border-b pb-3">
                    <div class="flex items-center gap-2 flex-wrap"><h3 class="text-lg font-bold text-[#2046B5]">${code}</h3>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(getClassificationType(code), 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>
                    ${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-2 text-sm', 'text-xs text-gray-500 italic')}
                </div>
                ${generateHierarchyHTML(hierarchy, code)}
                <div>
                    <h4 class="text-sm font-semibold text-gray-700 mb-2">下属小类 (${subclasses.length})</h4>
                    <div class="space-y-2">
                        ${subclasses.map(subcls => {
                            const subclsTitleInfo = parseDeletedIpcTitle(subcls.title, subcls.code);
                            return `<div class="bg-blue-50 rounded-lg p-3 cursor-pointer hover:bg-blue-100 transition-colors" onclick="document.getElementById('classificationInput').value='${subcls.code}'; queryIPC('${subcls.code}')">
                            <div class="flex items-center gap-2 flex-wrap mb-1"><h4 class="font-semibold text-[#2046B5]">${subcls.code}</h4>${renderDotGroupBadge(subclsTitleInfo.dotGroup)}${renderClassificationTypeBadge('小类', 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(subclsTitleInfo.isDeleted)}</div>
                            ${renderIpcTitleContent(subclsTitleInfo, 'text-sm text-gray-700', 'text-xs text-gray-500 italic')}
                        </div>`;
                        }).join('')}
                    </div>
                </div>
            </div>`;
        }

        function generateSubclassContent(code, title, mainGroups, hierarchy) {
            const titleInfo = parseDeletedIpcTitle(title, code);
            return `<div class="space-y-4 min-h-full">
                <div class="border-b pb-3">
                    <div class="flex items-center gap-2 flex-wrap"><h3 class="text-lg font-bold text-[#2046B5]">${code}</h3>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(getClassificationType(code), 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>
                    ${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-2 text-sm', 'text-xs text-gray-500 italic')}
                </div>
                ${generateHierarchyHTML(hierarchy, code)}
                <div>
                    <h4 class="text-sm font-semibold text-gray-700 mb-2">下属大组 (${mainGroups.length})</h4>
                    <div class="space-y-2">
                        ${mainGroups.map(mg => { 
                            const mgTitleInfo = parseDeletedIpcTitle(mg.title, mg.code);
                            const subgroups = getSubgroups(mg.code); 
                            const hasSubgroups = subgroups.length > 0; 
                            return `<div class="bg-blue-50 rounded-lg p-3 cursor-pointer hover:bg-blue-100 transition-colors" onclick="${hasSubgroups ? `toggleSubgroups('${mg.code}', this)` : ''}">
                                <div class="flex items-center justify-between gap-2">
                                    <div class="flex items-center gap-2 flex-wrap"><h4 class="font-semibold text-[#2046B5]">${mg.code}</h4>${renderDotGroupBadge(mgTitleInfo.dotGroup)}${renderClassificationTypeBadge('大组', 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(mgTitleInfo.isDeleted)}</div>
                                    ${hasSubgroups ? `<i class="fa fa-chevron-down text-blue-600"></i>` : ''}
                                </div>
                                ${renderIpcTitleContent(mgTitleInfo, 'text-sm text-gray-700 mt-1', 'text-xs text-gray-500 italic')}
                                <div id="subgroups-${mg.code}" class="mt-3 hidden"></div>
                            </div>`; 
                        }).join('')}
                    </div>
                </div>
            </div>`;
        }

        function generateMainGroupContent(code, title, subgroups, hierarchy) {
            const titleInfo = parseDeletedIpcTitle(title, code);
            return `<div class="space-y-4 min-h-full">
                <div class="border-b pb-3">
                    <div class="flex items-center gap-2 flex-wrap"><h3 class="text-lg font-bold text-[#2046B5]">${code}</h3>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(getClassificationType(code), 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>
                    ${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-2 text-sm', 'text-xs text-gray-500 italic')}
                </div>
                ${generateHierarchyHTML(hierarchy, code)}
                <div>
                    <h4 class="text-sm font-semibold text-gray-700 mb-2">下属小组 (${subgroups.length})</h4>
                    <div>${generateSubgroupsHTML(subgroups)}</div>
                </div>
            </div>`;
        }

        function generateSubgroupContent(code, title, hierarchy) {
            const titleInfo = parseDeletedIpcTitle(title, code);
            return `<div class="space-y-4 min-h-full">
                <div class="border-b pb-3">
                    <div class="flex items-center gap-2 flex-wrap"><h3 class="text-lg font-bold text-[#2046B5]">${code}</h3>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(getClassificationType(code), 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>
                    ${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-2 text-sm', 'text-xs text-gray-500 italic')}
                </div>
                ${generateHierarchyHTML(hierarchy, code)}
            </div>`;
        }

        function generateDefaultContent(code, title) {
            const titleInfo = parseDeletedIpcTitle(title, code);
            return `<div class="space-y-4"><div class="border-b pb-3"><div class="flex items-center gap-2 flex-wrap"><h3 class="text-lg font-bold text-[#2046B5]">${code}</h3>${renderDotGroupBadge(titleInfo.dotGroup)}${renderClassificationTypeBadge(getClassificationType(code), 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(titleInfo.isDeleted)}</div>${renderIpcTitleContent(titleInfo, 'text-gray-700 font-medium mt-2 text-sm', 'text-xs text-gray-500 italic')}</div><div><h4 class="text-sm font-semibold text-gray-700 mb-2">相关分类号</h4><div class="flex flex-wrap gap-2">${getRelatedClasses(code).map(cls => `<span class="bg-blue-50 text-[#2046B5] px-3 py-1 rounded-full text-xs font-medium cursor-pointer hover:bg-blue-100" onclick="document.getElementById('classificationInput').value='${cls.code}'; queryIPC('${cls.code}')">${cls.code}</span>`).join('')}</div></div></div>`;
        }

        function getRelatedClasses(code) {
            const related = [];
            const prefix = code.substring(0, 1);
            for (const [key, value] of Object.entries(ipcDictionary)) {
                if (key.startsWith(prefix) && key !== code && key.length <= 4) related.push({ code: key, title: value });
            }
            return related.slice(0, 8);
        }

        function toggleSubclasses(classCode, element) {
            const subclassesContainer = document.getElementById(`subclasses-${classCode}`);
            const icon = element.querySelector('i');
            if (!subclassesContainer) return;
            if ((subclassesContainer.dataset.workbenchExpanded === 'false' || (subclassesContainer.dataset.workbenchExpanded === undefined && subclassesContainer.classList.contains('hidden')))) {
                if (expandCache.has(`subclasses-${classCode}`)) {
                    subclassesContainer.innerHTML = expandCache.get(`subclasses-${classCode}`);
                } else {
                    const subclasses = sortClassificationItems(getIndexedItems('classes', classCode));
                        const content = subclasses.length > 0 ? `<div class="bg-white rounded-lg p-3 space-y-2">${subclasses.map(subclass => {
                            const subclassTitleInfo = parseDeletedIpcTitle(subclass.title, subclass.code);
                            return `<div class="p-2 hover:bg-gray-50 rounded cursor-pointer" onclick="event.stopPropagation(); document.getElementById('classificationInput').value='${subclass.code}'; queryIPC('${subclass.code}')"><div class="flex items-center gap-2 flex-wrap mb-1"><h5 class="font-medium text-[#2046B5]">${subclass.code}</h5>${renderDotGroupBadge(subclassTitleInfo.dotGroup)}${renderClassificationTypeBadge('小类', 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(subclassTitleInfo.isDeleted)}</div>${renderIpcTitleContent(subclassTitleInfo, 'text-xs text-gray-600', 'text-[11px] text-gray-500 italic')}</div>`;
                        }).join('')}</div>` : `<div class="bg-white rounded-lg p-3 text-center text-gray-500 text-sm">暂无下属小类</div>`;
                    subclassesContainer.innerHTML = content;
                    expandCache.set(`subclasses-${classCode}`, content);
                }
                window.workbenchUi.collapse(subclassesContainer, true);
            } else {
                window.workbenchUi.collapse(subclassesContainer, false);
            }
        }

        function toggleSubgroups(mainGroupCode, element) {
            const subgroupsContainer = document.getElementById(`subgroups-${mainGroupCode}`);
            const icon = element.querySelector('i');
            if (!subgroupsContainer) return;
            if ((subgroupsContainer.dataset.workbenchExpanded === 'false' || (subgroupsContainer.dataset.workbenchExpanded === undefined && subgroupsContainer.classList.contains('hidden')))) {
                if (expandCache.has(`subgroups-${mainGroupCode}`)) {
                    subgroupsContainer.innerHTML = expandCache.get(`subgroups-${mainGroupCode}`);
                } else {
                    const subgroups = getSubgroups(mainGroupCode);
                    if (subgroups.length > 0) {
                        const content = `<div class="bg-white rounded-lg p-3 space-y-2">${subgroups.map(subgroup => {
                            const subgroupTitleInfo = parseDeletedIpcTitle(subgroup.title, subgroup.code);
                            return `<div class="p-2 hover:bg-gray-50 rounded cursor-pointer" onclick="event.stopPropagation(); document.getElementById('classificationInput').value='${subgroup.code}'; queryIPC('${subgroup.code}')"><div class="flex items-center gap-2 flex-wrap mb-1"><h5 class="font-medium text-[#2046B5]">${subgroup.code}</h5>${renderDotGroupBadge(subgroupTitleInfo.dotGroup)}${renderClassificationTypeBadge('小组', 'text-[11px] px-1.5 py-0.5')}${renderDeletedIpcBadge(subgroupTitleInfo.isDeleted)}</div>${renderIpcTitleContent(subgroupTitleInfo, 'text-xs text-gray-600', 'text-[11px] text-gray-500 italic')}</div>`;
                        }).join('')}</div>`;
                        subgroupsContainer.innerHTML = content;
                        expandCache.set(`subgroups-${mainGroupCode}`, content);
                    } else { icon.style.display = 'none'; }
                }
                window.workbenchUi.collapse(subgroupsContainer, true);
            } else {
                window.workbenchUi.collapse(subgroupsContainer, false);
            }
        }

        // ==================== 预审查询功能 ====================
        function queryPreExam(classification) {
 viewRevision++;
            
            if (!ensureClassificationIndexReady()) {
                showToast('正在初始化数据库，请稍候');
                return;
            }
            if (!classification) { showToast('请输入分类号或关键词'); return; }
            if (isShareMode) {
                isShareMode = false;
                selectedProvince = null;
                hideShareMenu();
                window.currentPreExamData = null;
            }
            updateStatusDisplay('预审查询中...');
            classification = normalizeClassificationInput(classification);
            let query = classification;
            const isKeywordSearch = /^[\u4e00-\u9fa5]/.test(classification) || 
                                   (!/^[A-H](?:\d{2}[A-Z]?\d*(\/\d+)?)?$/i.test(query) && query.length > 0);
            
            if (isKeywordSearch) {
                searchPreExamByKeyword(classification.trim());
                return;
            }
            
            let normalizedQuery = query;
            if (!query.includes('/') && /^[A-H]\d{2}[A-Z]\d+$/.test(query)) {
                const possibleMainGroup = `${query}/00`;
                if (ipcDictionary[possibleMainGroup]) normalizedQuery = possibleMainGroup;
            }
            
            let searchCode = query;
            let displayType = '';
            let isGroupLevel = false;
            let originalCode = query;
            
            if (/^[A-H]$/.test(query)) {
                showPreExamRestrictionModal('部');
                updateStatusDisplay('预审查询');
                showFloatingButtons(false);
                return;
            } else if (/^[A-H]\d{2}$/.test(query)) {
                showPreExamRestrictionModal('大类');
                updateStatusDisplay('预审查询');
                showFloatingButtons(false);
                return;
            } else if (/^[A-H]\d{2}[A-Z]$/.test(query)) {
                displayType = '小类';
                if (!ipcDictionary[query]) {
                    updateContentArea(`<div class="space-y-4"><div class="text-center py-8"><div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-50 flex items-center justify-center"><i class="fa fa-search text-2xl text-gray-400"></i></div><p class="text-gray-500">未找到该分类号的信息</p><p class="text-xs text-gray-400 mt-2">请检查小类代码是否正确</p></div></div>`);
                    updateStatusDisplay('预审查询');
                    showFloatingButtons(false);
                    return;
                }
            } else if (/^[A-H]\d{2}[A-Z]\d+\/\d+$/.test(normalizedQuery) || /^[A-H]\d{2}[A-Z]\d+$/.test(query)) {
                const subclassCode = query.substring(0, 4);
                if (!ipcDictionary[normalizedQuery]) {
                    window.currentPreExamData = null;
                    const fallback = ipcDictionary[subclassCode]
                        ? `<button type="button" onclick="queryPreExam('${subclassCode}')" class="mt-3 rounded bg-blue-600 px-4 py-2 text-white">按 ${subclassCode} 查询</button>` : '';
                    updateContentArea(`<div class="p-6 text-center"><p>内置词典未收录分类号 ${escapeHTML(query)}，请检查输入。</p>${fallback}</div>`);
                    updateStatusDisplay('分类号未收录');
                    showFloatingButtons(false);
                    return;
                }
                isGroupLevel = true;
                if (!/^[A-H]\d{2}[A-Z]$/.test(subclassCode)) {
                    updateContentArea(`<div class="space-y-4"><div class="text-center py-10"><div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center shadow-inner"><i class="fa fa-exclamation-circle text-2xl text-orange-500"></i></div><h3 class="text-base font-semibold text-gray-800 mb-1">格式不正确</h3><p class="text-sm text-gray-500 mb-4">无法识别有效的分类号层级</p><div class="inline-flex items-center px-4 py-2 rounded-full bg-blue-50 border border-blue-100 text-sm text-[#2046B5] font-medium"><i class="fa fa-check-circle mr-2"></i>正确示例：B01D、G01N、A01B</div></div></div>`);
                    updateStatusDisplay('预审查询');
                    showFloatingButtons(false);
                    return;
                }
                searchCode = subclassCode;
                displayType = '小类';
                originalCode = normalizedQuery;
            } else {
                updateContentArea(`<div class="space-y-4"><div class="text-center py-10"><div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gradient-to-br from-orange-50 to-amber-50 flex items-center justify-center shadow-inner"><i class="fa fa-keyboard-o text-2xl text-orange-500"></i></div><h3 class="text-base font-semibold text-gray-800 mb-1">格式不正确</h3><p class="text-sm text-gray-500 mb-4">预审查询仅支持小类、大组或小组分类号</p><div class="inline-flex items-center px-4 py-2 rounded-full bg-blue-50 border border-blue-100 text-sm text-[#2046B5] font-medium"><i class="fa fa-check-circle mr-2"></i>正确示例：B01D、G01N1/00、G01N1/02</div></div></div>`);
                updateStatusDisplay('预审查询');
                showFloatingButtons(false);
                return;
            }
            
            const targetCode = searchCode;
            const type = '小类';
            const preferredRegion = getPreferredRegion();
            const allCenters = [];
            
            for (const [province, centers] of Object.entries(protectionCenterDatabase)) {
                for (const [centerName, centerData] of Object.entries(centers)) {
                    const ipcClassifications = centerData.ipc || [];
                    let isMatch = false;
                    for (const centerClass of ipcClassifications) {
                        if (targetCode === centerClass || targetCode.startsWith(centerClass) || centerClass.startsWith(targetCode)) {
                            isMatch = true;
                            break;
                        }
                    }
                    allCenters.push({ 
                        province, 
                        name: centerName, 
                        shortName: centerName.replace(/省|市|自治区|回族|壮族|维吾尔/g, '').replace('保护中心', ''),
                        isMatch, 
                        isProvinceCenter: centerName.includes('省保护中心')
                    });
                }
            }
            
            allCenters.sort((a, b) => {
                let score = 0;
                if (preferredRegion) {
                    if (a.province === preferredRegion) score -= 100;
                    if (b.province === preferredRegion) score += 100;
                }
                if (a.isProvinceCenter) score -= 10;
                if (b.isProvinceCenter) score += 10;
                return score;
            });
            
            const centersByProvince = {};
            allCenters.forEach(center => {
                if (!centersByProvince[center.province]) centersByProvince[center.province] = { matched: [], unmatched: [] };
                if (center.isMatch) centersByProvince[center.province].matched.push(center);
                else centersByProvince[center.province].unmatched.push(center);
            });
            
            let content = `<div class="space-y-4 pb-4" id="preExamResultContainer">`;
            const targetTitleInfo = parseDeletedIpcTitle(ipcDictionary[targetCode] || '暂无描述', targetCode);
            content += `<div class="border-b pb-3"><div class="flex items-center justify-between mb-2"><div class="flex-1"><div class="flex items-center gap-2 mb-1 flex-wrap"><h3 class="text-lg font-bold text-[#2046B5]">${targetCode}</h3>${renderDotGroupBadge(targetTitleInfo.dotGroup)}<span class="bg-blue-100 text-blue-800 text-[11px] px-1.5 py-0.5 rounded-full">${type}</span>${renderDeletedIpcBadge(targetTitleInfo.isDeleted)}</div>${renderIpcTitleContent(targetTitleInfo, 'text-gray-700 font-medium text-sm leading-snug', 'text-xs text-gray-500 italic')}</div></div></div>`;
            
            if (isGroupLevel) {
                content += `<div class="mb-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700 flex items-start shadow-sm"><div class="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center mr-2 flex-shrink-0 mt-0.5"><i class="fa fa-info text-blue-600 text-[10px]"></i></div><div><p class="font-semibold mb-0.5">已自动切换至上级小类</p><p class="text-blue-600">输入 <span class="font-mono font-bold bg-white px-1 py-0.5 rounded border border-blue-200">${originalCode}</span> 的预审情况，已按上级小类 <span class="font-mono font-bold bg-white px-1 py-0.5 rounded border border-blue-200">${targetCode}</span> 查询</p></div></div>`;
            }
            
            if (Object.keys(centersByProvince).length > 0) {
                content += `<div class="space-y-3" id="provinceList">`;
                for (const province in centersByProvince) {
                    const provinceData = centersByProvince[province];
                    const isPreferred = province === preferredRegion;
                    content += `<div class="province-card bg-white rounded-lg border ${isPreferred ? 'ring-2 ring-[#2046B5] ring-opacity-30' : 'border-gray-200'} overflow-hidden transition-all duration-200 relative" data-province="${province}">
                        <div class="share-checkbox absolute top-3 right-3 w-6 h-6 rounded-full border-2 border-gray-300 bg-white flex items-center justify-center transition-all duration-200 z-10 hidden shadow-sm" onclick="selectProvince('${province}', event)">
                            <i class="fa fa-check text-white text-xs opacity-0 transition-opacity duration-200"></i>
                        </div>
                        <div class="selection-overlay absolute inset-0 bg-[#2046B5]/5 opacity-0 transition-opacity duration-200 pointer-events-none"></div>
                        <div class="px-4 py-2 border-b ${isPreferred ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'}">
                            <div class="flex items-center justify-between">
                                <h5 class="text-sm font-semibold ${isPreferred ? 'text-[#2046B5]' : 'text-gray-600'} flex items-center">${province}${isPreferred ? '<span class="flex-shrink-0 text-[9px] bg-[#2046B5] text-white px-1.5 py-0.5 rounded-full whitespace-nowrap ml-1">默认</span>' : ''}</h5>
                                <span class="text-[10px] text-gray-400">${provinceData.matched.length}符合/${provinceData.unmatched.length}不符合</span>
                            </div>
                        </div>
                        <div class="p-3">
                            <div class="grid grid-cols-2 gap-3">
                                <div class="min-w-0">
                                    <h6 class="text-xs font-semibold text-green-700 mb-1.5 text-center"><i class="fa fa-check-circle mr-1"></i>符合</h6>
                                    <div class="space-y-1">
                                        ${provinceData.matched.length > 0 ? provinceData.matched.map(center => `<div class="relative flex items-center rounded border border-green-100 bg-green-50 px-2 py-1.5 pr-9 text-xs" data-preexam-match-center="${escapeHTML(center.name)}" data-preexam-code="${escapeHTML(targetCode)}" title="${escapeHTML(center.name)}"><div class="bg-green-100 p-0.5 rounded-full mr-1.5 flex-shrink-0"><i class="fa fa-check text-green-600 text-[10px]"></i></div><h6 class="font-medium text-gray-800 truncate flex-1">${escapeHTML(center.name)}</h6></div>`).join('') : '<p class="text-xs text-gray-400 text-center py-2">无</p>'}
                                    </div>
                                </div>
                                <div class="min-w-0">
                                    <h6 class="text-xs font-semibold text-gray-600 mb-1.5 text-center"><i class="fa fa-times-circle mr-1"></i>不符合</h6>
                                    <div class="space-y-1">
                                        ${provinceData.unmatched.length > 0 ? provinceData.unmatched.map(center => `<div class="flex items-center px-2 py-1.5 rounded text-xs bg-gray-50 border border-gray-100" title="${center.name}"><div class="bg-gray-100 p-0.5 rounded-full mr-1.5 flex-shrink-0"><i class="fa fa-times text-gray-400 text-[10px]"></i></div><h6 class="font-medium text-gray-600 truncate flex-1">${center.name}</h6></div>`).join('') : '<p class="text-xs text-gray-400 text-center py-2">无</p>'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>`;
                }
                content += `</div>`;
            } else {
                content += `<div class="text-center py-6"><i class="fa fa-search text-4xl text-gray-300 mb-3"></i><p class="text-gray-500">未找到保护中心信息</p></div>`;
            }
            content += `</div>`;
            
            updateContentArea(content);
            updateStatusDisplay('预审查询');
            showFloatingButtons(false);

            const shareReportBtn = document.getElementById('shareReportBtn');
            if (shareReportBtn) shareReportBtn.classList.remove('hidden');
            
            window.currentPreExamData = {
                code: targetCode,
                originalCode: isGroupLevel ? originalCode : null,
                title: targetTitleInfo.plainTextTitle || '暂无描述',
                type: type,
                centersByProvince: centersByProvince,
                queryTime: new Date().toLocaleDateString('zh-CN'),
                isConverted: isGroupLevel
            };
        }

        async function searchPreExamByKeyword(keyword) {
  const revision = viewRevision;
  const results = await requestMainQuery('preexam', [keyword], getPreferredRegion());
  if (revision !== viewRevision) return;
  if (results) displayPreExamKeywordResults(keyword, results);
  else showQueryFailure(() => searchPreExamByKeyword(keyword));
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

        function displayPreExamKeywordResults(keyword, results) {
            updateStatusDisplay('预审关键词模式');
            const preferredRegion = getPreferredRegion();
            const regionColorMap = {
                '北京': { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', icon: 'text-red-500' },
                '上海': { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', icon: 'text-blue-500' },
                '广东': { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', icon: 'text-orange-500' },
                '山东': { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', icon: 'text-blue-500' }
            };
            
            let content = '';
            if (results.length === 0) {
                content = `<div class="space-y-4"><div class="text-center py-10"><div class="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-50 flex items-center justify-center"><i class="fa fa-search text-2xl text-gray-400"></i></div><h3 class="text-base font-semibold text-gray-700 mb-2">未找到匹配结果</h3><p class="text-sm text-gray-500">关键词"${escapeHTML(keyword)}"未匹配到相关预审分类号</p><div class="mt-4 inline-flex items-center px-3 py-1.5 rounded-full bg-blue-50 text-xs text-[#2046B5]"><i class="fa fa-info-circle mr-1.5"></i>可尝试输入：节能、通信、机械等</div></div></div>`;
            } else {
                content = `<div class="space-y-3">
                    <div class="ipc-preexam-keyword-summary bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-3 border border-blue-200 flex items-center justify-between sticky top-0 z-10 shadow-sm">
                        <div class="flex items-center"><i class="fa fa-keyboard-o text-[#2046B5] mr-2"></i><span class="text-sm font-medium text-gray-700">关键词：${escapeHTML(keyword)}</span></div>
                        <span class="bg-white text-[#2046B5] px-2 py-1 rounded-full text-xs font-semibold shadow-sm">${results.length}个分类号</span>
                    </div>
                    <div class="space-y-2.5">
                        ${results.map(item => {
                            const itemTitleInfo = parseDeletedIpcTitle(item.title, item.code);
                            const highlightedTitle = renderHighlightedIpcTitleContent(itemTitleInfo, keyword, 'text-sm text-gray-700 leading-relaxed', 'text-xs text-gray-500 italic');
                            const highlightedCode = highlightText(item.code, keyword);
                            const safeCodeJs = escapeJSString(item.code);
                            const safeTypeText = escapeHTML(item.type);
                            const sortedCenters = item.centers.sort((a, b) => {
                                if (preferredRegion) {
                                    if (a.province === preferredRegion && b.province !== preferredRegion) return -1;
                                    if (a.province !== preferredRegion && b.province === preferredRegion) return 1;
                                }
                                if (a.isProvinceCenter && !b.isProvinceCenter) return -1;
                                if (!a.isProvinceCenter && b.isProvinceCenter) return 1;
                                return 0;
                            });
                            
                            let typeColor = 'bg-gray-100 text-gray-800';
                            if (item.type === '小类') typeColor = 'bg-blue-100 text-blue-800';
                            else if (item.type === '大类') typeColor = 'bg-green-100 text-green-800';
                            else if (item.type === '大组') typeColor = 'bg-orange-100 text-orange-800';
                            else if (item.type === '小组') typeColor = 'bg-red-100 text-red-800';
                            
                            return `<div class="bg-white rounded-xl border border-gray-200 p-3.5 shadow-sm hover:shadow-md transition-shadow duration-200">
                                <div class="flex items-center justify-between mb-2">
                                    <div class="flex items-center gap-2 flex-wrap">
                                        <span class="font-bold text-[#2046B5] text-base cursor-pointer hover:underline" onclick="document.getElementById('classificationInput').value='${safeCodeJs}'; queryIPC('${safeCodeJs}')">${highlightedCode}</span>
                                        ${renderDotGroupBadge(itemTitleInfo.dotGroup)}
                                        <span class="${typeColor} text-[10px] px-2 py-0.5 rounded-full font-medium">${safeTypeText}</span>
                                        ${renderDeletedIpcBadge(itemTitleInfo.isDeleted)}
                                    </div>
                                    <span class="text-[10px] text-gray-400 flex items-center"><i class="fa fa-shield mr-1"></i>${sortedCenters.length}个中心</span>
                                </div>
                                <div class="mb-3">${highlightedTitle}</div>
                                <div class="flex flex-wrap gap-1.5">
                                    ${sortedCenters.map(center => {
                                        const colors = regionColorMap[center.province] || { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-700', icon: 'text-gray-500' };
                                        const isPreferred = preferredRegion && center.province === preferredRegion;
                                        const finalColors = isPreferred ? { bg: 'bg-[#2046B5]/10', border: 'border-[#2046B5]/30', text: 'text-[#2046B5]', icon: 'text-[#2046B5]' } : colors;
                                        return `<span class="inline-flex items-center px-2 py-1 rounded-lg ${finalColors.bg} border ${finalColors.border} ${finalColors.text} text-[10px] hover:opacity-80 transition-opacity cursor-default" title="${escapeHTML(`${center.province}·${center.name}`)}"><i class="fa fa-check-circle ${finalColors.icon} mr-1 text-[8px]"></i><span class="truncate max-w-[70px]">${escapeHTML(center.name.replace('保护中心', ''))}</span>${center.isProvinceCenter ? `<span class="ml-0.5 px-0.5 rounded ${isPreferred ? 'bg-white text-[#2046B5]' : 'bg-gray-100 text-gray-700'} text-[8px] opacity-80">省</span>` : ''}${isPreferred ? `<span class="ml-0.5 w-1 h-1 rounded-full bg-[#2046B5]"></span>` : ''}</span>`;
                                    }).join('')}
                                </div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }
            updateContentArea(content);
            showFloatingButtons(false);
        }

        function highlightText(text, keyword) {
            const sourceText = String(text ?? '');
            const rawKeyword = String(keyword ?? '');
            if (!rawKeyword || !sourceText) return escapeHTML(sourceText);
            const escapedKeyword = rawKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(${escapedKeyword})`, 'gi');
            return sourceText.split(regex).map(part => {
                if (part && part.toLowerCase() === rawKeyword.toLowerCase()) {
                    return `<span class="bg-yellow-200 text-red-600 font-bold px-0.5 rounded">${escapeHTML(part)}</span>`;
                }
                return escapeHTML(part);
            }).join('');
        }

        function buildClassificationTagHTML(cls) {
            const { mainClass, exclusions } = parseClassificationWithExclusion(cls);
            let tagColor = 'bg-gray-100 text-gray-700';
            const cleanClass = mainClass.replace('*', '');
            if (/^[A-H]\d{2}$/.test(cleanClass)) tagColor = 'bg-blue-100 text-blue-800';
            else if (/^[A-H]\d{2}[A-Z]$/.test(cleanClass)) tagColor = 'bg-green-100 text-green-800';
            else if (mainClass.includes('/') && !mainClass.endsWith('/00')) tagColor = 'bg-red-100 text-red-800';
            else if (mainClass.includes('/00') || /^[A-H]\d{2}[A-Z]\d+$/.test(cleanClass)) tagColor = 'bg-orange-100 text-orange-800';
            else if (mainClass.includes('*')) tagColor = 'bg-yellow-100 text-yellow-800';

            let displayClass = `<span class="${tagColor} text-xs px-2 py-1 rounded-full cursor-pointer hover:opacity-80" onclick="openIpcDetailModal('${escapeJSString(mainClass.replace(/\*/g, ''))}')">${escapeHTML(mainClass)}</span>`;
            
            if (exclusions.length > 0) {
                displayClass += `<span class="text-[10px] text-gray-500 ml-1">（不含${exclusions.map(item => escapeHTML(item)).join('、')}）</span>`;
            }
            return `<div class="flex items-center">${displayClass}</div>`;
        }

        function renderPriorityReviewCard(result, keyword) {
            const dbColors = priorityReviewColorMap[result.database] || { bg: 'bg-white', text: 'text-gray-800', border: 'border-gray-200' };
            const safeDatabaseText = escapeHTML(result.database);
            const safeDatabaseJs = escapeJSString(result.database);
            const safeIdText = escapeHTML(result.id);
            const safeIdJs = escapeJSString(result.id);
            const safeNameText = escapeHTML(result.name);
            const safeNameJs = escapeJSString(result.name);
            const safeKeywordJs = escapeJSString(result.keyword || '');
            const highlightedName = highlightText(result.name, keyword);
            const highlightedKeyword = highlightText(result.keyword || '无关键词概述', keyword);
            const keywordClick = result.keyword ? `showKeywordSearchModal('${safeKeywordJs}')` : '';
            const keywordClass = result.keyword ? 'text-[#2046B5] cursor-pointer hover:underline' : 'text-gray-700';
            const classificationsJs = result.matchingClassifications.map(cls => `'${escapeJSString(cls)}'`).join(', ');

            return `<div class="bg-white rounded-lg p-4 shadow-sm border ${dbColors.border}" oncontextmenu="copyFullContentWithDatabase('${safeDatabaseJs}', '${safeIdJs}', '${safeNameJs}', '${safeKeywordJs}', [${classificationsJs}]); return false;" title="长按复制全部内容"><div class="flex items-center gap-2 mb-3"><span class="${dbColors.bg} ${dbColors.text} text-xs font-semibold px-3 py-1 rounded-full whitespace-nowrap">${safeDatabaseText}</span><span class="text-xs text-gray-500 font-medium bg-gray-100 px-2 py-0.5 rounded whitespace-nowrap">${safeIdText}</span><span class="text-sm text-gray-700 font-medium truncate cursor-pointer hover:text-[#2046B5]" onclick="showNameTooltip(event, '${safeNameJs}')" title="点击查看全称：${safeNameText}">${highlightedName}</span></div><div class="flex flex-wrap gap-1.5 mb-3">${result.matchingClassifications.map(buildClassificationTagHTML).join('')}</div><div><p class="text-sm text-gray-800 leading-relaxed"><span class="font-medium text-gray-600">名称：</span>${highlightedName}</p><p class="text-sm text-gray-800 leading-relaxed mt-2"><span class="font-medium text-gray-600">关键词：</span><span class="${keywordClass}" ${result.keyword ? `onclick="${keywordClick}"` : ''}>${highlightedKeyword}</span></p></div></div>`;
        }

        // ==================== 优先审查功能 ====================

        function displayPriorityReviewResults(searchInput, results) {
 isKeywordSearch = !isClassificationFormat(searchInput);
            updateStatusDisplay('优审查询');
            currentPriorityResults = results;
            currentSearchClassification = searchInput;
            showFloatingButtons(!isKeywordSearch);
            updateExactMatchButtonState();
            const shareReportBtn = document.getElementById('shareReportBtn');
            if (shareReportBtn) shareReportBtn.classList.add('hidden');

            let content = '';
            if (results.length === 0) {
                content = `<div class="space-y-4"><div class="text-center py-6"><i class="fa fa-search text-4xl text-gray-300 mb-3"></i><p class="text-gray-500">未找到相关优先审查信息</p></div></div>`;
            } else {
                const databaseStats = {};
                results.forEach(result => { if (!databaseStats[result.database]) databaseStats[result.database] = 0; databaseStats[result.database]++; });
                content = `<div class="space-y-4"><div class="space-y-3"><div class="bg-gradient-to-r from-amber-50 to-orange-50 rounded-lg p-3 border border-amber-200 shadow-sm"><h4 class="text-sm font-semibold text-amber-700 mb-2 flex items-center"><i class="fa fa-pie-chart mr-1.5 text-amber-500"></i>匹配统计</h4><div class="flex flex-wrap gap-2">${Object.entries(databaseStats).map(([dbName, count]) => { const colors = priorityReviewColorMap[dbName] || { bg: 'bg-gray-100', text: 'text-gray-800' }; return `<span class="${colors.bg} ${colors.text} text-xs px-3 py-1 rounded-full font-medium">${escapeHTML(dbName)}：${count}项</span>`; }).join('')}</div></div><div class="space-y-3">`;
                results.forEach(result => {
                    content += renderPriorityReviewCard(result, searchInput);
                });
                content += `</div></div></div>`;
            }
            updateContentArea(content);
        }

        function showNameTooltip(event, text) {
            event.stopPropagation();
            const existingTooltip = document.getElementById('name-tooltip');
            if (existingTooltip) existingTooltip.remove();
            const tooltip = document.createElement('div');
            tooltip.id = 'name-tooltip';
            tooltip.className = 'ipc-tooltip fixed bg-gray-800 text-white text-xs p-2 rounded shadow-lg z-50 max-w-[300px] leading-tight break-words';
            tooltip.textContent = text;
            document.body.appendChild(tooltip);
            const rect = event.target.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            let left = rect.left;
            let top = rect.bottom + 5;
            if (left + tooltipRect.width > window.innerWidth) left = window.innerWidth - tooltipRect.width - 10;
            if (top + tooltipRect.height > window.innerHeight) top = rect.top - tooltipRect.height - 5;
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
            const hideHandler = (e) => {
                if (!tooltip.isConnected) { document.removeEventListener('click', hideHandler); return; }
                if (!tooltip.contains(e.target)) { tooltip.remove(); document.removeEventListener('click', hideHandler); }
            };
            document.addEventListener('click', hideHandler);
        }

        async function showKeywordSearchModal(keyword) {
            const modal = document.getElementById('keywordSearchModal');
            openToolModal(modal);
            document.getElementById('keywordSearchContent').textContent = '查询中…';
            const revision = ++keywordRevision;
            const results = await requestQuery('priority', [keyword, false]);
            if (revision !== keywordRevision || modal.classList.contains('hidden')) return;
            if (results) displayKeywordSearchResults(keyword, results);
            else showQueryFailure(() => showKeywordSearchModal(keyword), 'keywordSearchContent');
        }

        function closeKeywordSearchModal() {
 keywordRevision++;
            const modal = document.getElementById('keywordSearchModal');
            closeToolModal(modal);
        }

        function displayKeywordSearchResults(keyword, results) {
            const content = document.getElementById('keywordSearchContent');
            if (results.length === 0) {
                replaceIpcContent(content, () => { content.innerHTML = `<div class="text-center text-gray-500 py-8"><i class="fa fa-search text-4xl mb-3 opacity-50"></i><p class="text-sm">未找到关键词"${escapeHTML(keyword)}"相关结果</p></div>`; });
                return;
            }
            let html = `<div class="space-y-3">`;
            results.forEach(result => {
                html += renderPriorityReviewCard(result, keyword);
            });
            html += `</div>`;
            replaceIpcContent(content, () => { content.innerHTML = html; });
        }

        // ==================== 分类号词典功能 ====================
        function toggleDictionaryLevel(level, code, element, event) {
            if (event) event.stopPropagation();
            const contentDiv = document.getElementById(`${level}-${code}-content`);
            const icon = element.querySelector('i');
            if ((contentDiv.dataset.workbenchExpanded === 'false' || (contentDiv.dataset.workbenchExpanded === undefined && contentDiv.classList.contains('hidden')))) {
                contentDiv.innerHTML = getNextLevelContent(level, code);
                window.workbenchUi.collapse(contentDiv, true);
                icon.classList.add('rotate-180');
            } else {
                window.workbenchUi.collapse(contentDiv, false);
                icon.classList.remove('rotate-180');
            }
            element.classList.toggle('dictionary-parent', !(contentDiv.dataset.workbenchExpanded === 'false' || (contentDiv.dataset.workbenchExpanded === undefined && contentDiv.classList.contains('hidden'))));
            syncDictionarySticky();
        }
        function syncDictionarySticky() {
            const root = document.getElementById('dictionaryContent');
            if (!root) return;
            const base = document.getElementById('topControlPanel').getBoundingClientRect().bottom;
            root.classList.remove('dictionary-compact');
            const headers = [...root.querySelectorAll('.dictionary-parent')].filter(header => header.getClientRects().length);
            const ancestorsOf = header => {
                const ancestors = [];
                for (let parent = header.parentElement.parentElement; parent && parent !== root; parent = parent.parentElement) {
                    const ancestor = parent.firstElementChild;
                    if (ancestor?.classList.contains('dictionary-parent')) ancestors.push(ancestor);
                }
                return ancestors;
            };
            const available = document.getElementById('ipcBottomToolbar').getBoundingClientRect().top - base;
            root.classList.toggle('dictionary-compact', headers.some(header =>
                [header, ...ancestorsOf(header)].reduce((height, item) => height + item.getBoundingClientRect().height, 0) > available - 80));
            for (const header of headers) {
                if (!header.title) header.title = header.textContent.trim();
                let top = base;
                let depth = 0;
                for (let parent = header.parentElement.parentElement; parent && parent !== root; parent = parent.parentElement) {
                    const ancestor = parent.firstElementChild;
                    if (ancestor?.classList.contains('dictionary-parent')) {
                        top += ancestor.getBoundingClientRect().height;
                        depth++;
                    }
                }
                header.style.top = top + 'px';
                header.style.zIndex = String(24 - depth);
            }
        }
        window.addEventListener('resize', syncDictionarySticky);
        function animateCodeFlightToTarget(event, targetElement, onComplete) {
            if (typeof onComplete === 'function') onComplete(targetElement);
            if (window.workbenchUi.prefersReducedMotion() || !event || !targetElement || typeof targetElement.getBoundingClientRect !== 'function') {
                return;
            }
            const duration = window.workbenchUi.panelDuration;
            const startX = event.clientX;
            const startY = event.clientY;
            const rect = targetElement.getBoundingClientRect();
            const endX = rect.left + 20;
            const endY = rect.top + rect.height / 2;

            const core = document.createElement('div');
            core.style.cssText = `
                position: fixed;
                left: ${startX - 8}px;
                top: ${startY - 8}px;
                width: 16px;
                height: 16px;
                background: radial-gradient(circle at 30% 30%, #FFFFFF 0%, #60A5FA 30%, #2046B5 70%);
                border-radius: 50%;
                box-shadow:
                    0 0 10px 2px rgba(255, 255, 255, 0.8),
                    0 0 30px 8px rgba(96, 165, 250, 0.8),
                    0 0 50px 15px rgba(32, 70, 181, 0.6),
                    0 0 80px 25px rgba(32, 70, 181, 0.3);
                z-index: 9999;
                pointer-events: none;
                transition: all ${duration}ms ease-in-out;
            `;
            document.body.appendChild(core);

            const trails = [];
            for (let i = 0; i < 3; i++) {
                const trail = document.createElement('div');
                const size = 12 - i * 3;
                const opacity = 0.6 - i * 0.15;
                trail.style.cssText = `
                    position: fixed;
                    left: ${startX - size / 2}px;
                    top: ${startY - size / 2}px;
                    width: ${size}px;
                    height: ${size}px;
                    background: rgba(96, 165, 250, ${opacity});
                    border-radius: 50%;
                    box-shadow: 0 0 ${10 + i * 5}px ${3 + i * 2}px rgba(96, 165, 250, ${opacity});
                    z-index: ${9998 - i};
                    pointer-events: none;
                    transition: all ${duration}ms ease-in-out;
                `;
                document.body.appendChild(trail);
                trails.push(trail);
            }

            const beam = document.createElement('div');
            const angle = Math.atan2(endY - startY, endX - startX) * 180 / Math.PI;
            const distance = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
            beam.style.cssText = `
                position: fixed;
                left: ${startX}px;
                top: ${startY - 2}px;
                width: 0px;
                height: 4px;
                background: linear-gradient(90deg,
                    rgba(96, 165, 250, 0) 0%,
                    rgba(96, 165, 250, 0.8) 50%,
                    rgba(255, 255, 255, 1) 100%);
                border-radius: 2px;
                box-shadow: 0 0 10px rgba(96, 165, 250, 0.8);
                transform: rotate(${angle}deg);
                transform-origin: left center;
                z-index: 9997;
                pointer-events: none;
                transition: width ${duration}ms ease-in-out, opacity ${duration}ms ease-in-out;
            `;
            document.body.appendChild(beam);

            requestAnimationFrame(() => {
                core.style.left = `${endX - 8}px`;
                core.style.top = `${endY - 8}px`;
                core.style.opacity = '0';
                core.style.transform = 'scale(0.2)';
                core.style.boxShadow = `
                    0 0 20px 5px rgba(255, 255, 255, 0.9),
                    0 0 50px 15px rgba(96, 165, 250, 0.9),
                    0 0 80px 30px rgba(32, 70, 181, 0.7),
                    0 0 120px 40px rgba(32, 70, 181, 0.4)
                `;
                trails.forEach((trail, i) => {
                    trail.style.left = `${endX - (6 - i * 1.5)}px`;
                    trail.style.top = `${endY - (6 - i * 1.5)}px`;
                    trail.style.opacity = '0';
                    trail.style.transform = 'scale(0.1)';
                });
                beam.style.width = `${distance}px`;
                beam.style.opacity = '0';
            });

            setTimeout(() => {
                if (core.parentNode) core.parentNode.removeChild(core);
                trails.forEach(t => { if (t.parentNode) t.parentNode.removeChild(t); });
                if (beam.parentNode) beam.parentNode.removeChild(beam);
            }, duration + 20);
        }

        // 分类号飞入搜索框动画（光效）
        function animateCodeToInput(code, event) {
            const input = document.getElementById('classificationInput');
            if (!input) return;
            animateCodeFlightToTarget(event, input, (target) => {
                target.value = code;
                if (window.workbenchUi.prefersReducedMotion() || !target.animate) return;
                const style = getComputedStyle(target);
                target.animate([
                    { boxShadow: 'inset 0 0 0 2px rgb(32 70 181 / 30%), 0 0 0 6px rgb(32 70 181 / 20%)', borderColor: '#2046B5' },
                    { boxShadow: style.boxShadow, borderColor: style.borderColor },
                ], { duration: window.workbenchUi.panelDuration, easing: 'ease-in-out' });
            });
        }

        function getNextLevelContent(level, code) {
            let items = [];
            let nextLevel = '';
            if (level === 'section') {
                nextLevel = 'class';
                for (const [key, value] of Object.entries(ipcDictionary)) {
                    if (key.startsWith(code) && key.length === 3) items.push({ code: key, title: value, type: '大类' });
                }
            } else if (level === 'class') {
                nextLevel = 'subclass';
                for (const [key, value] of Object.entries(ipcDictionary)) {
                    if (key.startsWith(code) && key.length === 4 && /^[A-H]\d{2}[A-Z]$/.test(key)) items.push({ code: key, title: value, type: '小类' });
                }
            } else if (level === 'subclass') {
                nextLevel = 'maingroup';
                for (const [key, value] of Object.entries(ipcDictionary)) {
                    if (key.startsWith(code) && /^[A-H]\d{2}[A-Z]?\d+\/00$/.test(key)) items.push({ code: key, title: value, type: '大组' });
                }
            } else if (level === 'maingroup') {
                items = getSubgroups(code).map(item => ({
                    ...item,
                    type: '小组'
                }));
            }
            if (items.length === 0) return `<div class="p-4 text-center text-gray-500"><p class="text-sm">暂无下属分类</p></div>`;
            sortClassificationItems(items);
            const colorMap = {
                '大类': { text: 'text-[#3572E5]', bg: 'bg-green-100 text-green-800' },
                '小类': { text: 'text-[#4A90E2]', bg: 'bg-blue-100 text-blue-800' },
                '大组': { text: 'text-[#5C6BC0]', bg: 'bg-purple-100 text-purple-800' },
                '小组': { text: 'text-[#64B5F6]', bg: 'bg-cyan-100 text-cyan-800' }
            };
            return `<div class="divide-y">${items.map(item => {
                const itemType = item.type || '大类';
                const colors = colorMap[itemType] || { text: 'text-[#2046B5]', bg: 'bg-blue-100 text-blue-800' };
                let hasChildren = itemType !== '小组';
                if (itemType === '大组') hasChildren = getSubgroups(item.code).length > 0;
                
                // 【关键修改】所有下级分类（大类/小类/大组/小组）统一逻辑：
                // 1. 点击蓝色分类号：填入搜索框（不展开）
                // 2. 点击其他区域（标题、箭头）：展开/收起下级
                const expandHandler = hasChildren ? `onclick="toggleDictionaryLevel('${nextLevel}', '${item.code}', this, event)"` : '';
                const codeClickHandler = `onclick="animateCodeToInput('${item.code}', event); event.stopPropagation();"`;        
                const itemTitleInfo = parseDeletedIpcTitle(item.title, item.code);

                return `<div class="bg-gray-50"><div class="p-3 cursor-pointer hover:bg-gray-100" ${expandHandler}><div class="flex items-center mb-1 gap-1.5"><div class="flex items-center gap-1.5 flex-wrap min-w-0"><h5 class="font-medium ${colors.text} cursor-pointer hover:underline" ${codeClickHandler}>${item.code}</h5>${renderDotGroupBadge(itemTitleInfo.dotGroup)}<span class="${colors.bg} text-xs px-2 py-0.5 rounded-full">${itemType}</span>${renderDeletedIpcBadge(itemTitleInfo.isDeleted)}</div></div><div class="flex items-start justify-between gap-2"><div class="flex-1 min-w-0">${renderIpcTitleContent(itemTitleInfo, 'text-xs text-gray-600', 'text-[11px] text-gray-500 italic')}</div>${hasChildren ? `<i class="fa fa-chevron-down text-gray-400 mt-0.5"></i>` : ''}</div></div>${hasChildren ? `<div id="${nextLevel}-${item.code}-content" class="hidden border-t"></div>` : ''}</div>`;
            }).join('')}</div>`;
        }

        // ==================== 预审结果分享功能 ====================
        function toggleShareMode() {
            isShareMode = !isShareMode;
            const container = document.getElementById('preExamResultContainer');
            if (!container) return;
            const checkboxes = container.querySelectorAll('.share-checkbox');
            if (isShareMode) {
                checkboxes.forEach(cb => cb.classList.remove('hidden'));
                showToast('请选择要分享的地区（单选）');
                renderShareMenu();
                container.classList.add('pb-32');
                container.classList.remove('pb-4');
                setTimeout(() => { document.addEventListener('click', handleClickOutsideShare); }, 0);
            } else {
                checkboxes.forEach(cb => {
                    cb.classList.add('hidden');
                    cb.classList.remove('border-[#2046B5]', 'bg-[#2046B5]');
                    cb.querySelector('i').classList.add('opacity-0');
                });
                container.querySelectorAll('.province-card').forEach(card => {
                    card.classList.remove('ring-2', 'ring-[#2046B5]', 'bg-blue-50/30');
                    card.querySelector('.selection-overlay').classList.add('opacity-0');
                });
                selectedProvince = null;
                hideShareMenu();
                container.classList.remove('pb-32');
                container.classList.add('pb-4');
                document.removeEventListener('click', handleClickOutsideShare);
            }
        }

        function handleClickOutsideShare(event) {
            const shareMenu = document.getElementById('shareMenuBottom');
            const shareBtn = document.getElementById('shareReportBtn');
            if (shareMenu && shareMenu.contains(event.target)) return;
            if (shareBtn && shareBtn.contains(event.target)) return;
            if (event.target.closest('.share-checkbox')) return;
            if (isShareMode) toggleShareMode();
        }

        function selectProvince(province, event) {
            if (event && event.stopPropagation) event.stopPropagation();
            if (!isShareMode) return;
            const container = document.getElementById('preExamResultContainer');
            if (!container) return;
            const cards = container.querySelectorAll('.province-card');
            cards.forEach(card => {
                const checkbox = card.querySelector('.share-checkbox');
                if (!checkbox) return;
                const checkIcon = checkbox.querySelector('i');
                if (card.dataset.province === province) {
                    checkbox.classList.remove('border-gray-300', 'bg-white');
                    checkbox.classList.add('border-[#2046B5]', 'bg-[#2046B5]');
                    if (checkIcon) checkIcon.classList.remove('opacity-0');
                    selectedProvince = province;
                } else {
                    checkbox.classList.remove('border-[#2046B5]', 'bg-[#2046B5]');
                    checkbox.classList.add('border-gray-300', 'bg-white');
                    if (checkIcon) checkIcon.classList.add('opacity-0');
                }
            });
            updateShareMenuState();
        }

        function renderShareMenu() {
            const existingMenu = document.getElementById('shareMenuBottom');
            if (existingMenu) {
                const button = existingMenu.querySelector('#saveImageBtn');
                button.disabled = true;
                button.classList.remove('opacity-100', 'scale-105');
                button.classList.add('opacity-50');
                const hint = existingMenu.querySelector('#shareHint');
                hint.className = 'text-center mt-1.5 text-xs text-amber-600 bg-amber-50 py-1 rounded-lg';
                hint.innerHTML = '<i class="fa fa-info-circle mr-1"></i>请先选择要分享的地区（单选）';
                existingMenu.classList.remove('hidden');
                return;
            }
            const menu = document.createElement('div');
            menu.id = 'shareMenuBottom';
            menu.className = 'fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-2xl z-[55] pb-safe';
            menu.style.paddingBottom = 'env(safe-area-inset-bottom, 20px)';
            menu.innerHTML = `
                <div class="px-4 py-1.5">
                    <div class="flex items-center justify-between mb-1">
                        <span class="text-sm font-semibold text-gray-700">分享预审信息</span>
                        <button onclick="toggleShareMode()" class="text-gray-400 hover:text-gray-600 p-1 -mr-1"><i class="fa fa-times text-base"></i></button>
                    </div>
                    <div class="flex gap-3 justify-center py-1">
                        <button id="saveImageBtn" onclick="prepareSaveImage()" disabled class="flex flex-col items-center gap-1 opacity-50 transition-all duration-200">
                            <div class="w-11 h-11 rounded-full bg-gradient-to-r from-[#2046B5] to-[#3572E5] text-white flex items-center justify-center shadow-lg"><i class="fa fa-image text-base"></i></div>
                            <span class="text-xs text-gray-600 font-medium">保存图片</span>
                        </button>
                    </div>
                    <div id="shareHint" class="text-center mt-1.5 text-xs text-amber-600 bg-amber-50 py-1 rounded-lg"><i class="fa fa-info-circle mr-1"></i>请先选择要分享的地区（单选）</div>
                </div>
            `;
            document.body.appendChild(menu);
        }

        function hideShareMenu() {
            const menu = document.getElementById('shareMenuBottom');
            if (menu) menu.classList.add('hidden');
            const container = document.getElementById('preExamResultContainer');
            if (container && !isShareMode) {
                container.classList.remove('pb-32');
                container.classList.add('pb-4');
            }
        }

        function updateShareMenuState() {
            const btn = document.getElementById('saveImageBtn');
            const hint = document.getElementById('shareHint');
            if (selectedProvince && btn) {
                btn.disabled = false;
                btn.classList.remove('opacity-50');
                btn.classList.add('opacity-100', 'scale-105');
                if (hint) replaceIpcContent(hint, () => {
                    hint.innerHTML = `<i class="fa fa-check-circle text-green-500 mr-1"></i>已选择：${escapeHTML(selectedProvince)}，点击下方按钮生成报告`;
                    hint.className = 'text-center mt-1.5 text-xs text-green-600 bg-green-50 py-1 rounded-lg';
                });
            }
        }

        function prepareSaveImage() {
            if (!selectedProvince || !window.currentPreExamData) {
                showToast('请先选择地区');
                return;
            }
            showToast('正在生成报告图片...');
            generateReportImage(selectedProvince, window.currentPreExamData).then(imageData => {
                showImagePreview(imageData);
            }).catch(err => {
                console.error('生成图片失败:', err);
                showToast('生成图片失败，请重试');
            });
        }

        async function generateReportImage(province, data) {
            const scale = 1;
            const width = 1500;
            const pixelWidth = width * scale;
            
            function calculateTextLines(ctx, text, maxWidth) {
                const chars = text.split('');
                let line = '';
                let lines = [];
                for (let i = 0; i < chars.length; i++) {
                    const testLine = line + chars[i];
                    const metrics = ctx.measureText(testLine);
                    if (metrics.width > maxWidth && i > 0) {
                        lines.push(line);
                        line = chars[i];
                    } else {
                        line = testLine;
                    }
                }
                if (line) lines.push(line);
                return lines;
            }
            
            const measureCanvas = document.createElement('canvas');
            const mCtx = measureCanvas.getContext('2d');
            mCtx.scale(scale, scale);
            const contentSidePadding = 400;
            mCtx.font = '40px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const titleText = data.title || '暂无描述';
            const titleLines = calculateTextLines(mCtx, titleText, width - contentSidePadding);
            const titleLineHeight = 64;
            const titleHeight = Math.max(titleLineHeight * 2, titleLines.length * titleLineHeight);
            
            const provinceData = data.centersByProvince[province];
            const headerHeight = 85;
            const rowHeight = 95;
            const colPadding = 70;
            let centersHeight = 350;
            if (provinceData) {
                const maxRows = Math.max(provinceData.matched.length, provinceData.unmatched.length);
                if (maxRows > 0) centersHeight = headerHeight + (maxRows * rowHeight) + colPadding;
            }
            
            let totalHeight = 0;
            totalHeight += 80;
            totalHeight += 12;
            totalHeight += 60;
            totalHeight += 310;
            totalHeight += titleHeight;
            totalHeight += 60;
            if (data.isConverted && data.originalCode) totalHeight += 100;
            totalHeight += 85;
            totalHeight += 130;
            totalHeight += 50;
            totalHeight += centersHeight;
            totalHeight += 90;
            totalHeight += 80;
            const pixelHeight = Math.max(totalHeight, 1400) * scale;
            
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(0, 0, pixelWidth, pixelHeight);
            ctx.scale(scale, scale);
            
            function roundRect(x, y, w, h, r, fill, stroke) {
                const radius = typeof r === 'object' ? r : { tl: r, tr: r, br: r, bl: r };
                ctx.beginPath();
                ctx.moveTo(x + radius.tl, y);
                ctx.lineTo(x + w - radius.tr, y);
                ctx.quadraticCurveTo(x + w, y, x + w, y + radius.tr);
                ctx.lineTo(x + w, y + h - radius.br);
                ctx.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h);
                ctx.lineTo(x + radius.bl, y + h);
                ctx.quadraticCurveTo(x, y + h, x, y + h - radius.bl);
                ctx.lineTo(x, y + radius.tl);
                ctx.quadraticCurveTo(x, y, x + radius.tl, y);
                ctx.closePath();
                if (fill) { ctx.fillStyle = fill; ctx.fill(); }
                if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
            }
            
            function drawWrappedText(text, x, y, maxWidth, lineHeight, maxLines = 50) {
                const chars = text.split('');
                let line = '';
                let lines = [];
                for (let i = 0; i < chars.length; i++) {
                    const testLine = line + chars[i];
                    const metrics = ctx.measureText(testLine);
                    if (metrics.width > maxWidth && i > 0) {
                        lines.push(line);
                        line = chars[i];
                        if (lines.length >= maxLines - 1) {
                            if (i < chars.length - 1) line += '...';
                            break;
                        }
                    } else {
                        line = testLine;
                    }
                }
                if (lines.length < maxLines && line) lines.push(line);
                lines.forEach((l, index) => { ctx.fillText(l, x, y + index * lineHeight); });
                return lines.length * lineHeight;
            }
            
            let currentY = 80;
            const gradient = ctx.createLinearGradient(0, 0, width, 0);
            gradient.addColorStop(0, '#2046B5');
            gradient.addColorStop(1, '#3572E5');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, width, 12);
            currentY += 60;
            
            const cardStartY = currentY;
            const cardContentStart = currentY;
            ctx.fillStyle = '#2046B5';
            ctx.font = 'bold 56px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('专利预审查询报告', width / 2, cardContentStart + 70);
            ctx.fillStyle = '#1e3a8a';
            ctx.font = 'bold 90px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(data.code, width / 2, cardContentStart + 175);
            ctx.fillStyle = '#4b5563';
            ctx.font = '40px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const actualTitleHeight = drawWrappedText(data.title || '暂无描述', width / 2, cardContentStart + 280, width - contentSidePadding, 64, 50);
            const cardEndY = cardContentStart + 280 + actualTitleHeight + 40;
            roundRect(80, cardStartY - 30, width - 160, cardEndY - cardStartY + 30, 24, '#ffffff', '#e2e8f0');
            ctx.fillStyle = '#2046B5';
            ctx.font = 'bold 56px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('专利预审查询报告', width / 2, cardContentStart + 70);
            ctx.fillStyle = '#1e3a8a';
            ctx.font = 'bold 90px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(data.code, width / 2, cardContentStart + 175);
            ctx.fillStyle = '#4b5563';
            ctx.font = '40px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            drawWrappedText(data.title || '暂无描述', width / 2, cardContentStart + 280, width - contentSidePadding, 64, 50);
            currentY = cardEndY + 50;
            
            if (data.isConverted && data.originalCode) {
                roundRect(80, currentY, width - 160, 80, 14, '#eff6ff', '#3b82f6');
                ctx.fillStyle = '#1d4ed8';
                ctx.font = '32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(`提示：${data.originalCode} 已转至上级小类 ${data.code} 查询`, 105, currentY + 52);
                currentY += 100;
            }
            
            ctx.textAlign = 'left';
            ctx.fillStyle = '#6b7280';
            ctx.font = '36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.fillText(`查询地区：${province}`, 90, currentY);
            ctx.textAlign = 'right';
            ctx.fillText(`查询日期：${data.queryTime}`, width - 90, currentY);
            currentY += 85;
            
            const totalMatched = provinceData ? provinceData.matched.length : 0;
            const totalUnmatched = provinceData ? provinceData.unmatched.length : 0;
            roundRect(80, currentY, width - 160, 105, 16, '#ffffff', '#e5e7eb');
            ctx.fillStyle = '#166534';
            ctx.font = 'bold 38px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText(`✓ 符合 ${totalMatched} 个中心`, 115, currentY + 68);
            ctx.fillStyle = '#6b7280';
            ctx.textAlign = 'right';
            ctx.fillText(`✗ 不符合 ${totalUnmatched} 个`, width - 115, currentY + 68);
            currentY += 130;
            currentY += 50;
            
            if (provinceData) {
                const colWidth = (width - 180) / 2;
                const colGap = 20;
                const leftX = 90;
                const rightX = leftX + colWidth + colGap;
                const startY = currentY;
                const maxRows = Math.max(provinceData.matched.length, provinceData.unmatched.length);
                const colContentHeight = maxRows > 0 ? headerHeight + (maxRows * rowHeight) + colPadding : 350;
                
                roundRect(leftX, startY, colWidth, colContentHeight, 20, '#f0fdf4', '#86efac');
                ctx.fillStyle = '#166534';
                roundRect(leftX, startY, colWidth, headerHeight, { tl: 20, tr: 20, bl: 0, br: 0 }, '#166534');
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`✓ 符合预审资格`, leftX + colWidth / 2, startY + 56);
                ctx.textAlign = 'left';
                let itemY = startY + headerHeight + 35;
                if (provinceData.matched.length > 0) {
                    provinceData.matched.forEach((center, index) => {
                        if (index % 2 === 0) { ctx.fillStyle = '#dcfce7'; ctx.fillRect(leftX + 15, itemY - 10, colWidth - 30, rowHeight); }
                        ctx.fillStyle = '#166534';
                        ctx.font = '36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                        let displayName = center.name;
                        if (displayName.length > 20) displayName = displayName.substring(0, 18) + '..';
                        ctx.fillText(displayName, leftX + 40, itemY + 50);
                        if (center.isProvinceCenter) {
                            ctx.fillStyle = '#22c55e';
                            roundRect(leftX + colWidth - 110, itemY + 8, 75, 45, 10, '#dcfce7');
                            ctx.fillStyle = '#166534';
                            ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                            ctx.textAlign = 'center';
                            ctx.fillText('省', leftX + colWidth - 72, itemY + 40);
                            ctx.textAlign = 'left';
                        }
                        itemY += rowHeight;
                    });
                } else {
                    ctx.fillStyle = '#9ca3af';
                    ctx.font = '32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('暂无', leftX + colWidth / 2, itemY + 55);
                    ctx.textAlign = 'left';
                }
                
                roundRect(rightX, startY, colWidth, colContentHeight, 20, '#f9fafb', '#e5e7eb');
                ctx.fillStyle = '#6b7280';
                roundRect(rightX, startY, colWidth, headerHeight, { tl: 20, tr: 20, bl: 0, br: 0 }, '#6b7280');
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(`✗ 不符合资格`, rightX + colWidth / 2, startY + 56);
                ctx.textAlign = 'left';
                itemY = startY + headerHeight + 35;
                if (provinceData.unmatched.length > 0) {
                    provinceData.unmatched.forEach((center, index) => {
                        if (index % 2 === 0) { ctx.fillStyle = '#f3f4f6'; ctx.fillRect(rightX + 15, itemY - 10, colWidth - 30, rowHeight); }
                        ctx.fillStyle = '#6b7280';
                        ctx.font = '36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                        let displayName = center.name;
                        if (displayName.length > 20) displayName = displayName.substring(0, 18) + '..';
                        ctx.fillText(displayName, rightX + 40, itemY + 50);
                        if (center.isProvinceCenter) {
                            ctx.fillStyle = '#9ca3af';
                            roundRect(rightX + colWidth - 110, itemY + 8, 75, 45, 10, '#e5e7eb');
                            ctx.fillStyle = '#6b7280';
                            ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                            ctx.textAlign = 'center';
                            ctx.fillText('省', rightX + colWidth - 72, itemY + 40);
                            ctx.textAlign = 'left';
                        }
                        itemY += rowHeight;
                    });
                } else {
                    ctx.fillStyle = '#9ca3af';
                    ctx.font = '32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('暂无', rightX + colWidth / 2, itemY + 55);
                    ctx.textAlign = 'left';
                }
                currentY = startY + colContentHeight + 70;
            }
            
            ctx.fillStyle = '#94a3b8';
            ctx.font = '32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('— 知产小栈 · 专利预审查询报告 —', width / 2, currentY);
            
            return canvas.toDataURL('image/png', 0.95);
        }

        function showImagePreview(imageData) {
            const existingModal = document.getElementById('imagePreviewModal');
            if (existingModal) { closeToolModal(existingModal); existingModal.remove(); }
            const modal = document.createElement('div');
            modal.id = 'imagePreviewModal';
            modal.className = 'fixed inset-0 bg-black/85 backdrop-blur-sm z-[60] flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-white rounded-2xl w-full max-w-[1400px] max-h-[90vh] flex flex-col overflow-hidden shadow-2xl animate-scale-in">
                    <div class="px-4 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50 flex-shrink-0">
                        <div class="flex items-center gap-2">
                            <i class="fa fa-image text-[#2046B5]"></i>
                            <span class="font-semibold text-gray-800 text-sm">预览报告（可上下滑动查看长图）</span>
                        </div>
                        <button onclick="closeImagePreview()" class="w-8 h-8 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center hover:bg-gray-300">
                            <i class="fa fa-times text-sm"></i>
                        </button>
                    </div>
                    <div class="flex-1 overflow-y-auto p-4 bg-gray-100 flex items-start justify-center">
                        <img src="${imageData}" alt="预审查询报告" class="w-full max-w-full object-contain rounded-lg shadow-lg">
                    </div>
                    <div class="px-4 py-4 border-t border-gray-100 bg-white flex-shrink-0">
                        <div class="flex gap-3">
                            <button onclick="closeImagePreview()" class="flex-1 py-3 rounded-xl border border-gray-300 text-gray-700 font-medium text-sm hover:bg-gray-50">取消</button>
                            <button onclick="confirmSaveImage('${imageData}')" class="flex-1 py-3 rounded-xl bg-gradient-to-r from-[#2046B5] to-[#3572E5] text-white font-medium text-sm shadow-lg shadow-blue-500/30"><i class="fa fa-download mr-1"></i>保存报告图片</button>
                        </div>
                        <p class="text-[10px] text-gray-400 text-center mt-2">图片宽度1500px，高度根据内容自适应，可保存为 PNG 文件</p>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            openToolModal(modal);
        }

        function closeImagePreview() {
            const modal = document.getElementById('imagePreviewModal');
            if (modal) {
                closeToolModal(modal);
                modal.remove();
            }
        }

            // ==================== 页面初始化 ====================

		
