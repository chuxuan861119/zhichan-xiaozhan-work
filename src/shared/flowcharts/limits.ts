/** Fixed safety limits for untrusted flowchart source and frame messages. */
export const FLOWCHART_MAX_SOURCE_XML_BYTES = 20 * 1024 * 1024;
export const FLOWCHART_MAX_DECOMPRESSED_XML_BYTES = 32 * 1024 * 1024;
export const FLOWCHART_MAX_PAGES = 100;
export const FLOWCHART_MAX_OBJECTS = 50_000;
export const FLOWCHART_MAX_EMBEDDED_IMAGE_BYTES = 20 * 1024 * 1024;
export const FLOWCHART_MAX_FRAME_MESSAGE_BYTES = 40 * 1024 * 1024;
export const FLOWCHART_MAX_SVG_BYTES = 20 * 1024 * 1024;
export const FLOWCHART_MAX_SVG_NODES = 200_000;
