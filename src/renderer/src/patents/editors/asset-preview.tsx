import { useEffect, useState } from "react";
import { useImageRotation } from "../../editor/image/use-image-rotation";
import { FlowchartImagePreview } from "../../flowcharts/flowchart-image-preview";

type AssetPreviewProps = {
  sessionId: string;
  assetId: string;
  alt: string;
  rotationDeg?: 0 | 90 | 180 | 270;
  onLoad?(aspectRatio: number): void;
  outputWidthMm?: number | undefined;
  getPreview?: typeof window.patentApi.assets.getPreview;
};

type PreviewState =
  | { status: "loading"; url: null }
  | { status: "loaded"; url: string }
  | { status: "failed"; url: null };

export function AssetPreview({
  sessionId,
  assetId,
  alt,
  rotationDeg,
  onLoad,
  getPreview,
  outputWidthMm,
}: AssetPreviewProps) {
  const [preview, setPreview] = useState<PreviewState>({ status: "loading", url: null });
  const [aspectRatio, setAspectRatio] = useState(1);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const displayRotation = useImageRotation(rotationDeg ?? 0, assetId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadGeneration intentionally retriggers a failed preview request.
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setPreview({ status: "loading", url: null });

    const loadPreview = async () => {
      try {
        const result = await (getPreview ?? window.patentApi.assets.getPreview)(sessionId, assetId);
        if (!active) return;
        if (!result.ok) {
          setPreview({ status: "failed", url: null });
          return;
        }
        const previewBytes = Uint8Array.from(result.value);
        objectUrl = URL.createObjectURL(
          new Blob([previewBytes.buffer as ArrayBuffer], { type: "image/png" }),
        );
        setPreview({ status: "loaded", url: objectUrl });
      } catch {
        if (active) setPreview({ status: "failed", url: null });
      }
    };

    void loadPreview();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId, getPreview, reloadGeneration, sessionId]);

  if (preview.status === "loaded") {
    if (outputWidthMm !== undefined) {
      return (
        <FlowchartImagePreview
          src={preview.url}
          alt={alt}
          outputWidthMm={outputWidthMm}
          rotationDeg={rotationDeg ?? 0}
          fitOnLoad
          onLoad={() => onLoad?.(1)}
          onError={() => setPreview({ status: "failed", url: null })}
        />
      );
    }
    const quarterTurned = rotationDeg === 90 || rotationDeg === 270;
    return (
      <img
        src={preview.url}
        alt={alt}
        style={{
          display: "block",
          width: quarterTurned ? `${aspectRatio * 100}%` : "100%",
          ...(rotationDeg === undefined
            ? {}
            : { height: quarterTurned ? `${100 / aspectRatio}%` : "100%" }),
          ...(rotationDeg === undefined
            ? {}
            : { transform: `translate(-50%, -50%) rotate(${displayRotation}deg)` }),
        }}
        onLoad={(event) => {
          const nextAspectRatio =
            event.currentTarget.naturalWidth / event.currentTarget.naturalHeight;
          setAspectRatio(nextAspectRatio);
          onLoad?.(nextAspectRatio);
        }}
      />
    );
  }
  if (preview.status === "failed") {
    return (
      <span role="status">
        图片预览不可用
        <button
          type="button"
          aria-label={`重试加载${alt}`}
          onClick={() => setReloadGeneration((current) => current + 1)}
        >
          重试
        </button>
      </span>
    );
  }
  return <span role="status">正在载入图片…</span>;
}
