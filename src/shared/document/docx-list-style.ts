// A neutral Word paragraph style identifies unnumbered continuation paragraphs without
// guessing from indentation and accidentally absorbing ordinary body text into a list.
export const LIST_CONTINUATION_STYLE_ID = "PatentListContinuation";
export const DOCX_LIST_PARAGRAPH_STYLES = [
  { id: LIST_CONTINUATION_STYLE_ID, name: "列表续段", basedOn: "Normal" },
];
