document.documentElement.style.setProperty('--ipc-motion-duration', `${window.workbenchUi.panelDuration}ms`);
window.workbenchUi.observe({
  selector: '.modal-content,.help-guide,#preExamRestrictionModal,#imagePreviewModal,.ipc-toast,.ipc-tooltip,.share-checkbox,#shareReportBtn,#exactMatchBtn,#backToTopBtn,#shareMenuBottom',
  menuSelector: '[role="menu"]',
});
