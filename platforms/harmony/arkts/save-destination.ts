export interface SaveDestination {
  uri: string;
  copyName: string;
}

/** Public destinations must be new: existing files cannot be safely renamed. */
export function resolveSaveDestination(
  uri: string,
  exists: (path: string) => boolean,
): SaveDestination {
  if (!uri.startsWith("file://docs/storage/Users/") || !exists(decodeURIComponent(uri.slice(11)))) {
    return { uri, copyName: "" };
  }
  const separator = uri.lastIndexOf("/");
  const parent = uri.slice(0, separator);
  const name = decodeURIComponent(uri.slice(separator + 1));
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 1; index <= 1000; index++) {
    const copyName = `${stem} (${index})${extension}`;
    const destination = `${parent}/${encodeURIComponent(copyName)}`;
    if (!exists(decodeURIComponent(destination.slice(11)))) return { uri: destination, copyName };
  }
  throw new Error("无法找到可用的新文件名，请选择其他保存位置。");
}
