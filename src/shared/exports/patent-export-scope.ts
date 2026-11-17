import type { CanonicalDocument } from "../document/model.js";
import type { CanonicalPatent, PatentBook } from "../patent/model.js";

export function officialPatentBooks(patent: CanonicalPatent): readonly PatentBook[] {
  return patent.books;
}

export function auxiliaryExportDocument(
  patent: CanonicalPatent,
  auxiliaryDocumentId: string,
): CanonicalDocument {
  const auxiliary = patent.auxiliaryDocuments.find(
    (document) => document.auxiliaryDocumentId === auxiliaryDocumentId,
  );
  if (!auxiliary) throw new Error("其他文档不存在，无法导出。");
  return {
    ...structuredClone(auxiliary.document),
    title: auxiliary.title,
    patentType: patent.patentType,
    assets: structuredClone(patent.assets),
  };
}
