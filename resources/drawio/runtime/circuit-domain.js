// biome-ignore lint/complexity/useArrowFunction: this file is shipped as a classic-script IIFE.
(function (root) {
  // biome-ignore lint/suspicious/noRedundantUseStrict: classic scripts are not modules at runtime.
  "use strict";

  const CIRCUIT_MARKER = "patentCircuit";

  const readStyle = (style) => {
    const result = {};
    for (const entry of String(style || "").split(";")) {
      if (!entry) continue;
      const separator = entry.indexOf("=");
      if (separator < 0) result[entry] = "1";
      else result[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return result;
  };

  const isCircuitStyle = (style) => {
    const values = readStyle(style);
    return (
      values[CIRCUIT_MARKER] === "1" || String(values.shape || "").startsWith("mxgraph.electrical.")
    );
  };

  const terminalKey = (cellId, portId) => `${String(cellId)}::${String(portId)}`;
  const stableCompareId = (left, right) =>
    String(left).localeCompare(String(right), "en", { numeric: true });

  const finite = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("INVALID_CIRCUIT_GEOMETRY");
    return number;
  };

  const normalizeRect = (rect) => {
    const normalized = {
      x: finite(rect?.x),
      y: finite(rect?.y),
      width: finite(rect?.width),
      height: finite(rect?.height),
    };
    if (normalized.width < 0 || normalized.height < 0) {
      throw new Error("INVALID_CIRCUIT_GEOMETRY");
    }
    return Object.freeze(normalized);
  };

  const inflateRect = (rect, amount) => {
    const normalized = normalizeRect(rect);
    const margin = finite(amount);
    if (margin < 0) throw new Error("INVALID_CIRCUIT_GEOMETRY");
    return Object.freeze({
      x: normalized.x - margin,
      y: normalized.y - margin,
      width: normalized.width + margin * 2,
      height: normalized.height + margin * 2,
    });
  };

  const rectsOverlap = (left, right) => {
    const a = normalizeRect(left);
    const b = normalizeRect(right);
    return (
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
  };

  const pointKey = (point) => `${finite(point?.x)},${finite(point?.y)}`;

  const directionForPort = (port) => {
    const x = finite(port?.x);
    const y = finite(port?.y);
    if (port.id === "left" || x === 0) return "left";
    if (port.id === "right" || x === 1) return "right";
    if (port.id === "top" || y === 0) return "top";
    if (port.id === "bottom" || y === 1) return "bottom";
    return "auto";
  };

  const classifyRole = ({ style, value, incoming, outgoing }) => {
    const values = readStyle(style);
    const haystack = `${String(values.shape || "")} ${String(value || "")}`.toLowerCase();
    if (/(?:ground|earth|gnd|接地)/u.test(haystack)) return "ground";
    if (/(?:power|vcc|vdd|battery|voltage_source|dc_source|电源)/u.test(haystack)) {
      return "power";
    }
    if (
      /(?:output|load|lamp|motor|speaker|输出|负载|灯)/u.test(haystack) ||
      (Number(incoming) > 0 && Number(outgoing) === 0)
    ) {
      return "output";
    }
    if (
      /(?:input|generator|signal_source|switch|输入|信号源)/u.test(haystack) ||
      (Number(incoming) === 0 && Number(outgoing) > 0)
    ) {
      return "input";
    }
    if (/(?:resistor|capacitor|inductor|diode|电阻|电容|电感|二极管)/u.test(haystack)) {
      return "passive";
    }
    return "generic";
  };

  root.PatentCircuitDomain = Object.freeze({
    CIRCUIT_MARKER,
    readStyle,
    isCircuitStyle,
    terminalKey,
    classifyRole,
    stableCompareId,
    normalizeRect,
    inflateRect,
    rectsOverlap,
    pointKey,
    directionForPort,
  });
})(globalThis);
