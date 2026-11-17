import { toPrinterDescriptors } from "./printer-info.js";

test("sanitizes Electron printer info before exposing it to the renderer", () => {
  const printers = [
    {
      name: "z-printer",
      displayName: "Zebra Printer",
      description: "Office queue",
      options: {
        "printer-make-and-model": "raw driver detail",
        Duplex: "DuplexNoTumble",
      },
    },
    {
      name: "",
      displayName: "Missing device name",
      description: "ignored",
      options: { color: true },
    },
    {
      name: "a-printer",
      displayName: "Alpha Printer",
      description: undefined,
      options: { secretDriverField: "must not leak" },
    },
  ];

  expect(toPrinterDescriptors(printers)).toEqual([
    {
      deviceName: "a-printer",
      displayName: "Alpha Printer",
      description: null,
      duplex: "unknown",
      color: "unknown",
      paperSize: "unknown",
    },
    {
      deviceName: "z-printer",
      displayName: "Zebra Printer",
      description: "Office queue",
      duplex: "unknown",
      color: "unknown",
      paperSize: "unknown",
    },
  ]);
});
