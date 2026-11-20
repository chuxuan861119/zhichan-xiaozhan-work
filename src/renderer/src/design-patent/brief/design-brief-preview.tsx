import type { Ref } from "react";
import type { DesignPatent } from "../../../../shared/patent/design-patent";
import { renderDesignPatentBriefLines } from "../../../../shared/patent/design-patent";

export function DesignBriefPreview({
  productName,
  design,
  ref,
}: {
  productName: string | null;
  design: DesignPatent;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <section
      id="brief-generated-content"
      className="design-patent-workbench__brief-preview"
      aria-label="简要说明实时预览"
      ref={ref}
      tabIndex={-1}
    >
      <div className="design-patent-workbench__brief-preview-heading">
        <p>生成内容</p>
        <h2>简要说明正文</h2>
      </div>
      {renderDesignPatentBriefLines(productName, design)
        .map((line, index) => `${index + 1}. ${line}`)
        .map((line) => (
          <p key={line}>{line}</p>
        ))}
    </section>
  );
}
