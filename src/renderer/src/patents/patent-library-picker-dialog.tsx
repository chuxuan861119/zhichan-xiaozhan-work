import { useEffect, useMemo, useState } from "react";
import type { PatentApi } from "../../../shared/ipc/contract";
import type { LibraryPatentSummary } from "../../../shared/library/model";
import { StandardDialog } from "../shared/standard-dialog";
import type { PatentSession } from "./patent-reducer";

type PatentLibraryApi = Pick<PatentApi["patents"], "list">;

type PatentLibraryPickerDialogProps = Readonly<{
  sessions: readonly PatentSession[];
  patentApi?: PatentLibraryApi;
  onOpenPatent(patentId: string): Promise<PatentSession | null>;
  onSelectPatent(patentId: string): void;
  onCancel(): void;
}>;

function defaultPatentApi(): PatentLibraryApi {
  return window.patentApi.patents;
}

function displayName(patent: LibraryPatentSummary): string {
  return patent.name?.trim() || "未命名专利";
}

export function PatentLibraryPickerDialog({
  sessions,
  patentApi = defaultPatentApi(),
  onOpenPatent,
  onSelectPatent,
  onCancel,
}: PatentLibraryPickerDialogProps) {
  const [patents, setPatents] = useState<LibraryPatentSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPatentId, setSelectedPatentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void patentApi
      .list("active")
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setPatents(result.value);
          setError(null);
        } else {
          setError("无法读取专利库，请重试。");
        }
      })
      .catch(() => {
        if (active) setError("无法读取专利库，请重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [patentApi]);

  const filteredPatents = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized) return patents;
    return patents.filter((patent) =>
      displayName(patent).toLocaleLowerCase("zh-CN").includes(normalized),
    );
  }, [patents, query]);

  const confirmSelection = async () => {
    if (!selectedPatentId || opening) return;
    setOpening(true);
    setError(null);
    try {
      const existing = sessions.find((session) => session.patentId === selectedPatentId);
      if (existing) {
        onSelectPatent(existing.patentId);
        return;
      }
      const opened = await onOpenPatent(selectedPatentId);
      if (!opened) {
        setError("未能打开所选专利，当前文档未改变。");
        return;
      }
      onSelectPatent(opened.patentId);
    } catch {
      setError("未能打开所选专利，当前文档未改变。");
    } finally {
      setOpening(false);
    }
  };

  return (
    <StandardDialog
      open
      title="打开其他专利"
      subtitle="选择一个专利，将其加入已打开专利列表。"
      size="m"
      onCancel={onCancel}
      closeDisabled={opening}
      bodyClassName="patent-dialog-body patent-library-picker-dialog"
      footer={
        <>
          <button type="button" disabled={opening} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!selectedPatentId || loading || opening}
            onClick={() => void confirmSelection()}
          >
            {opening ? "正在打开……" : "打开所选专利"}
          </button>
        </>
      }
    >
      <label className="patent-library-picker-dialog__search">
        <span>搜索专利名称</span>
        <input
          type="search"
          aria-label="搜索专利名称"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div className="patent-library-picker-dialog__list" aria-live="polite">
        {loading ? <p>正在读取专利库……</p> : null}
        {!loading && filteredPatents.length === 0 ? <p>没有匹配的专利</p> : null}
        {!loading
          ? filteredPatents.map((patent) => (
              <button
                key={patent.patentId}
                type="button"
                aria-pressed={selectedPatentId === patent.patentId}
                disabled={patent.recoveryState !== "healthy"}
                title={
                  patent.recoveryState === "healthy" ? displayName(patent) : "该专利需要先恢复。"
                }
                onClick={() => setSelectedPatentId(patent.patentId)}
              >
                {displayName(patent)}
              </button>
            ))
          : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </StandardDialog>
  );
}
