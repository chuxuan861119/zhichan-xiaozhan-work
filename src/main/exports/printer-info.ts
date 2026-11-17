import type { PrinterDescriptor } from "../../shared/printing/model.js";

type ElectronPrinterInfoLike = {
  name: string;
  displayName?: string;
  description?: string;
};

function isPrinterInfoLike(value: unknown): value is ElectronPrinterInfoLike {
  return (
    typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
  );
}

export function toPrinterDescriptors(printers: readonly unknown[]): PrinterDescriptor[] {
  return printers
    .flatMap((printer) => {
      if (!isPrinterInfoLike(printer)) return [];
      const deviceName = printer.name.trim();
      if (!deviceName) return [];
      const displayName =
        typeof printer.displayName === "string"
          ? printer.displayName.trim() || deviceName
          : deviceName;
      const description =
        typeof printer.description === "string" ? printer.description.trim() || null : null;
      return [
        {
          deviceName,
          displayName,
          description,
          duplex: "unknown" as const,
          color: "unknown" as const,
          paperSize: "unknown" as const,
        },
      ];
    })
    .sort((left, right) =>
      left.displayName.localeCompare(right.displayName, "zh-Hans-CN", {
        numeric: true,
        sensitivity: "base",
      }),
    );
}
