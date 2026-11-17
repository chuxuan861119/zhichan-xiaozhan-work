// Only new imports: existing checkpoints, archives and exports keep their own limits.
export const MAX_CAD_IMPORT_BYTES = { dwg: 50 * 1024 * 1024, dxf: 100 * 1024 * 1024 } as const;
export const CAD_IMPORT_LIMIT_MESSAGE = `图纸超出当前支持范围：新导入文件上限为 DWG ${MAX_CAD_IMPORT_BYTES.dwg / 1024 / 1024} MiB、DXF ${MAX_CAD_IMPORT_BYTES.dxf / 1024 / 1024} MiB。请在 CAD 软件中拆分所需附图后导入。`;
