import { confirmAppAction } from "../shared/app-dialog";

export type EditorAssistanceSettingsProps = {
  referenceMarkLocatorEnabled: boolean;
  onReferenceMarkLocatorEnabledChange(enabled: boolean): void;
  onOpenCustomDualView?(): void;
  onOpenInventionContentSettings?(): void;
};

export function EditorAssistanceSettings({
  referenceMarkLocatorEnabled,
  onReferenceMarkLocatorEnabledChange,
  onOpenCustomDualView,
  onOpenInventionContentSettings,
}: EditorAssistanceSettingsProps) {
  return (
    <section className="editor-assistance-settings settings-page" aria-label="编辑辅助设置">
      <div className="preference-group">
        <h4>定位辅助</h4>
        <div className="editor-assistance-settings__item">
          <div className="editor-assistance-settings__copy">
            <h4>零部件定位</h4>
            <p>
              在权利要求书、说明书和说明书摘要中，以浅灰色圆角块标记已登记的附图标记关键词；双击关键词可定位三书中的全部出现位置。
              关键词缩小字号仅用于显示，复制与导出仍使用原字号。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="零部件定位"
            aria-checked={referenceMarkLocatorEnabled}
            className="editor-assistance-settings__switch"
            onClick={() => onReferenceMarkLocatorEnabledChange(!referenceMarkLocatorEnabled)}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="preference-group">
        <h4>写作选项</h4>
        <div className="preference-card">
          {onOpenCustomDualView ? (
            <div className="preference-row">
              <span className="preference-copy">
                自定义同屏双显<small>保存常用的双文档搭配</small>
              </span>
              <button
                className="settings-action-button"
                type="button"
                aria-label="自定义同屏双显"
                onClick={onOpenCustomDualView}
              >
                设置
              </button>
            </div>
          ) : null}
          {onOpenInventionContentSettings ? (
            <div className="preference-row">
              <span className="preference-copy">
                发明内容设置<small>调整权利要求复用到说明书的写作规则</small>
              </span>
              <button
                className="settings-action-button"
                type="button"
                aria-label="发明内容设置"
                onClick={onOpenInventionContentSettings}
              >
                设置
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="preference-footer">
        <button
          className="settings-action-button"
          type="button"
          onClick={() =>
            void (async () => {
              if (
                await confirmAppAction(
                  "恢复零部件定位默认开启？不会修改正文、附图标记或自定义同屏双显方案。",
                )
              )
                onReferenceMarkLocatorEnabledChange(true);
            })()
          }
        >
          恢复编辑辅助默认设置
        </button>
      </div>
    </section>
  );
}
