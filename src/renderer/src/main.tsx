import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { documentFontPlatform } from "../../shared/document/font-policy";
import regularFontUrl from "../../shared/document/fonts/SourceHanSerifCN-Regular.otf?url";
import semiboldFontUrl from "../../shared/document/fonts/SourceHanSerifCN-SemiBold.otf?url";
import { createDocumentFontCss } from "../../shared/document/platform-fonts";
import { isMacPlatform } from "../../shared/platform";
import { App } from "./app/App";
import { AppErrorBoundary, installGlobalRendererFailureReporting } from "./app/app-error-boundary";
import { AgreementGate } from "./legal/agreement-gate";
import { installContentSearchActivity } from "./library/content-search-activity";
import { UsageStatisticsProvider } from "./settings/usage-statistics-settings";
import "./shared/button-feedback.css";
import "../../../resources/ui/workbench-ui.css";
import "../../../resources/ui/workbench-ui.js";

import { installAuthorizationKeyboardGuard } from "./settings/automation-authorization-dialog";
import { installExternalSurfaceMotion } from "./shared/external-surface-motion";

installAuthorizationKeyboardGuard();

const rootElement = document.getElementById("root");
if (isMacPlatform()) {
  document.documentElement.dataset.platform = "mac";
}
const fonts = document.createElement("style");
fonts.id = "document-fonts";
fonts.textContent = createDocumentFontCss(
  {
    regular: regularFontUrl,
    semibold: semiboldFontUrl,
  },
  documentFontPlatform(),
);
document.head.append(fonts);

if (!rootElement) {
  throw new Error("Application root element is missing");
}

installGlobalRendererFailureReporting();
installContentSearchActivity();
installExternalSurfaceMotion();

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <UsageStatisticsProvider>
        <AgreementGate>
          <App />
        </AgreementGate>
      </UsageStatisticsProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
