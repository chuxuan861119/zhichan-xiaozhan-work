// biome-ignore lint/complexity/useArrowFunction: this file is shipped as a classic-script IIFE.
(function (root) {
  // biome-ignore lint/suspicious/noRedundantUseStrict: classic scripts are not modules at runtime.
  "use strict";

  const domain = root.PatentCircuitDomain;
  if (!domain) throw new Error("PATENT_CIRCUIT_DOMAIN_REQUIRED");

  const finitePositive = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error("INVALID_CIRCUIT_SIZE");
    return number;
  };

  const scaleTemplateSize = (width, height) =>
    Object.freeze({
      width: finitePositive(width) * 0.6,
      height: finitePositive(height) * 0.6,
    });

  const serializeStyle = (values) =>
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join(";")};`;

  const markCircuitStyle = (style) => {
    const values = domain.readStyle(style);
    values.patentCircuit = "1";
    values.patentCircuitScale = "60";
    values.aspect = "fixed";
    return serializeStyle(values);
  };

  const transformTemplate = ({ style, width, height, source }) => {
    if (source !== "sidebar-template" || !domain.isCircuitStyle(style)) {
      return Object.freeze({ style, width, height });
    }
    const values = domain.readStyle(style);
    if (values.patentCircuitScale === "60") {
      return Object.freeze({ style: markCircuitStyle(style), width, height });
    }
    const size = scaleTemplateSize(width, height);
    return Object.freeze({ style: markCircuitStyle(style), ...size });
  };

  const constrainCellBounds = (original, proposed) => {
    const originalWidth = finitePositive(original.width);
    const originalHeight = finitePositive(original.height);
    const proposedWidth = finitePositive(proposed.width);
    return Object.freeze({
      width: proposedWidth,
      height: proposedWidth * (originalHeight / originalWidth),
    });
  };

  const constrainSelectionBounds = (original, proposed, containsCircuit) =>
    containsCircuit
      ? constrainCellBounds(original, proposed)
      : Object.freeze({ width: Number(proposed.width), height: Number(proposed.height) });

  const isCornerSizerIndex = (index) => index === 0 || index === 2 || index === 5 || index === 7;

  const cloneCell = (cell) => {
    if (cell && typeof cell.clone === "function") return cell.clone();
    return { ...cell, geometry: cell?.geometry ? { ...cell.geometry } : cell?.geometry };
  };

  const install = ({ editorUi }) => {
    const graph = editorUi.editor.graph;
    const model = graph.getModel();
    let editorMode = "flowchart";
    let disposed = false;
    const isCircuitCell = (cell) =>
      domain.isCircuitStyle(String(model.getStyle?.(cell) || cell?.style || ""));

    const originalResizeCells = graph.resizeCells;
    const wrappedResizeCells = function (cells, bounds) {
      const containsCircuit = cells.some(isCircuitCell);
      const constrained = bounds.map((bound, index) => {
        const cell = cells[index];
        const original = model.getGeometry?.(cell) || cell?.geometry;
        if (!original || (!containsCircuit && !isCircuitCell(cell))) return bound;
        const size =
          cells.length > 1
            ? constrainSelectionBounds(original, bound, containsCircuit)
            : constrainCellBounds(original, bound);
        return { ...bound, width: size.width, height: size.height };
      });
      return originalResizeCells.call(this, cells, constrained);
    };
    graph.resizeCells = wrappedResizeCells;

    const originalGetCellStyle = graph.getCellStyle;
    const wrappedGetCellStyle = function (cell) {
      const style = originalGetCellStyle.call(this, cell);
      return isCircuitCell(cell) ? { ...style, aspect: "fixed" } : style;
    };
    graph.getCellStyle = wrappedGetCellStyle;

    const sidebarPrototype = root.Sidebar?.prototype;
    const vertexHandlerPrototype = root.mxVertexHandler?.prototype;
    const originalCreateVertexTemplate = sidebarPrototype?.createVertexTemplate;
    const originalCreateVertexTemplateFromCells = sidebarPrototype?.createVertexTemplateFromCells;
    let wrappedCreateVertexTemplate = null;
    let wrappedCreateVertexTemplateFromCells = null;
    const originalIsSizerVisible = vertexHandlerPrototype?.isSizerVisible;
    let wrappedIsSizerVisible = null;

    if (vertexHandlerPrototype && typeof originalIsSizerVisible === "function") {
      wrappedIsSizerVisible = function (index) {
        const cell = this.state?.cell;
        if (cell && isCircuitCell(cell) && !isCornerSizerIndex(index)) return false;
        return originalIsSizerVisible.call(this, index);
      };
      vertexHandlerPrototype.isSizerVisible = wrappedIsSizerVisible;
    }

    if (sidebarPrototype && typeof originalCreateVertexTemplate === "function") {
      wrappedCreateVertexTemplate = function (style, width, height, ...rest) {
        const transformed = transformTemplate({
          style,
          width,
          height,
          source: editorMode === "circuit" ? "sidebar-template" : "flowchart-template",
        });
        return originalCreateVertexTemplate.call(
          this,
          transformed.style,
          transformed.width,
          transformed.height,
          ...rest,
        );
      };
      sidebarPrototype.createVertexTemplate = wrappedCreateVertexTemplate;
    }

    if (sidebarPrototype && typeof originalCreateVertexTemplateFromCells === "function") {
      wrappedCreateVertexTemplateFromCells = function (cells, width, height, ...rest) {
        const circuit = editorMode === "circuit" && cells.some(isCircuitCell);
        const clonedCells = circuit ? cells.map(cloneCell) : cells;
        let nextWidth = width;
        let nextHeight = height;
        if (circuit) {
          const representative = clonedCells.find(isCircuitCell);
          const representativeStyle = String(
            model.getStyle?.(representative) || representative?.style || "",
          );
          const transformed = transformTemplate({
            style: representativeStyle,
            width,
            height,
            source: "sidebar-template",
          });
          nextWidth = transformed.width;
          nextHeight = transformed.height;
          for (const cell of clonedCells) {
            if (!isCircuitCell(cell)) continue;
            if (typeof cell.setStyle === "function") cell.setStyle(markCircuitStyle(cell.style));
            else cell.style = markCircuitStyle(cell.style);
          }
        }
        return originalCreateVertexTemplateFromCells.call(
          this,
          clonedCells,
          nextWidth,
          nextHeight,
          ...rest,
        );
      };
      sidebarPrototype.createVertexTemplateFromCells = wrappedCreateVertexTemplateFromCells;
    }

    return Object.freeze({
      setEditorMode: (mode) => {
        editorMode = mode;
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (graph.resizeCells === wrappedResizeCells) graph.resizeCells = originalResizeCells;
        if (graph.getCellStyle === wrappedGetCellStyle) graph.getCellStyle = originalGetCellStyle;
        if (
          sidebarPrototype &&
          sidebarPrototype.createVertexTemplate === wrappedCreateVertexTemplate
        ) {
          sidebarPrototype.createVertexTemplate = originalCreateVertexTemplate;
        }
        if (
          sidebarPrototype &&
          sidebarPrototype.createVertexTemplateFromCells === wrappedCreateVertexTemplateFromCells
        ) {
          sidebarPrototype.createVertexTemplateFromCells = originalCreateVertexTemplateFromCells;
        }
        if (
          vertexHandlerPrototype &&
          vertexHandlerPrototype.isSizerVisible === wrappedIsSizerVisible
        ) {
          vertexHandlerPrototype.isSizerVisible = originalIsSizerVisible;
        }
      },
    });
  };

  root.PatentCircuitComponentPolicy = Object.freeze({
    scaleTemplateSize,
    transformTemplate,
    constrainCellBounds,
    constrainSelectionBounds,
    isCornerSizerIndex,
    install,
  });
})(globalThis);
