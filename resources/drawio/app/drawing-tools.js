// biome-ignore lint/complexity/useArrowFunction: classic script installed in the offline editor.
(function (root) {
  const remember = (entries, entry) =>
    [entry, ...entries.filter((item) => item.style !== entry.style)].slice(0, 12);
  const stepLabel = (text, index) =>
    `S${(index + 1) * 10}：${String(text).replace(/^S\d+\s*[:：]?\s*/i, "")}`;
  const install = ({ editorUi: ui, document: doc, window: win }) => {
    const graph = ui.editor.graph;
    const sidebar = ui.sidebar;
    const storageKey = "patent-drawing-tools-v1";
    let preferences = { expanded: {}, recent: [] };
    let mode = "flowchart";
    let updating = false;
    let pendingRecent = null;
    let applyingMode = false;
    const cleanup = [];
    try {
      const saved = JSON.parse(win.localStorage.getItem(storageKey) || "null");
      if (saved && typeof saved.expanded === "object" && Array.isArray(saved.recent)) {
        preferences = {
          expanded: saved.expanded || {},
          recent: saved.recent
            .filter(
              (item) =>
                item &&
                typeof item.style === "string" &&
                item.style.length < 2000 &&
                typeof item.label === "string" &&
                item.label.length < 100 &&
                Number.isFinite(item.width) &&
                item.width > 0 &&
                Number.isFinite(item.height) &&
                item.height > 0,
            )
            .slice(0, 12),
        };
      }
    } catch {
      console.warn("绘图工具偏好无法读取，本次使用默认布局。");
    }
    const save = () => {
      try {
        win.localStorage.setItem(storageKey, JSON.stringify(preferences));
      } catch {
        console.warn("绘图工具偏好无法保存，本次会话仍可正常绘图。");
      }
    };
    const style = doc.createElement("style");
    style.textContent =
      ".patent-drawing-tools{display:inline-flex;gap:4px;align-items:center;margin-left:8px}.patent-drawing-tools button{height:26px;padding:0 8px;border:1px solid #cbd5e1;border-radius:5px;background:#fff;color:#334155;font-size:12px;cursor:pointer}.patent-drawing-tools button:hover:not(:disabled){background:#eaf2ff;border-color:#93b4e8}.patent-drawing-tools button:focus-visible{outline:2px solid #2563eb;outline-offset:1px}.patent-drawing-tools button:disabled{opacity:.45;cursor:default}.patent-recent-empty{padding:8px 12px;font-size:12px;color:#64748b}";
    doc.head.appendChild(style);
    cleanup.push(() => style.remove());
    const toolbar = doc.querySelector(".geToolbarContainer");
    for (const item of toolbar?.querySelectorAll("[title]") || []) {
      if (/^(撤销|重做|Undo|Redo)(\s|\(|$)/.test(item.title)) item.style.display = "none";
    }
    const tools = doc.createElement("div");
    tools.className = "patent-drawing-tools";
    tools.setAttribute("role", "group");
    tools.setAttribute("aria-label", "专利绘图工具");
    const addButton = (label, description, action) => {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = description;
      button.onclick = action;
      tools.appendChild(button);
      return button;
    };
    const vertices = () =>
      graph.getSelectionCells().filter((cell) => graph.getModel().isVertex(cell));
    const mutate = (action) => {
      const model = graph.getModel();
      model.beginUpdate();
      try {
        action(model);
      } finally {
        model.endUpdate();
      }
    };
    const preset = addButton(
      "黑白线稿",
      "将所选对象统一为黑白线稿、宋体 14、线宽 1；保留形状与端子",
      () =>
        mutate(() => {
          const cells = graph.getSelectionCells();
          for (const [key, value] of Object.entries({
            strokeColor: "#000000",
            fillColor: "#ffffff",
            fontColor: "#000000",
            fontFamily: "SimSun",
            fontSize: "14",
            strokeWidth: "1",
            shadow: "0",
          }))
            graph.setCellStyles(key, value, cells);
        }),
    );
    const numbering = addButton(
      "步骤编号",
      "按从上到下、从左到右的顺序，为所选节点添加 S10、S20 等编号；可撤销",
      () =>
        mutate((model) => {
          vertices()
            .sort((a, b) => {
              const ga = model.getGeometry(a),
                gb = model.getGeometry(b);
              return ga.y - gb.y || ga.x - gb.x;
            })
            .forEach((cell, index) => {
              graph.cellLabelChanged(
                cell,
                stepLabel(graph.convertValueToString(cell), index),
                false,
              );
            });
        }),
    );
    const template = addButton(
      "基础流程",
      "在当前画布中插入“开始—处理—结束”模板，不覆盖已有内容；可撤销",
      () =>
        mutate(() => {
          const point = graph.getInsertPoint();
          const parent = graph.getDefaultParent();
          const cells = ["开始", "处理步骤", "结束"].map((label, index) =>
            graph.insertVertex(
              parent,
              null,
              label,
              point.x,
              point.y + index * 100,
              120,
              50,
              `rounded=${index === 1 ? 0 : 1};whiteSpace=wrap;html=0;strokeColor=#000000;fillColor=#ffffff;fontColor=#000000;fontFamily=SimSun;fontSize=14;`,
            ),
          );
          for (let index = 1; index < cells.length; index++)
            graph.insertEdge(
              parent,
              null,
              "",
              cells[index - 1],
              cells[index],
              "edgeStyle=orthogonalEdgeStyle;endArrow=block;strokeColor=#000000;",
            );
          graph.setSelectionCells(cells);
        }),
    );
    const updateSelection = () => {
      preset.disabled = graph.getSelectionCount() === 0;
      numbering.disabled = vertices().length === 0;
    };
    graph.getSelectionModel().addListener(root.mxEvent.CHANGE, updateSelection);
    cleanup.push(() => graph.getSelectionModel().removeListener(updateSelection));
    toolbar?.appendChild(tools);
    cleanup.push(() => tools.remove());
    updateSelection();

    const originalTemplate = sidebar.createVertexTemplateFromCells;
    sidebar.createVertexTemplateFromCells = function (cells, width, height, title, ...rest) {
      const element = originalTemplate.call(this, cells, width, height, title, ...rest);
      if (!updating && cells.length === 1 && graph.getModel().isVertex(cells[0])) {
        const item = {
          style: cells[0].style,
          width,
          height,
          label: typeof title === "string" ? title.slice(0, 100) : "图形",
        };
        element.addEventListener("pointerdown", () => {
          pendingRecent = item;
        });
      }
      return element;
    };
    cleanup.push(() => {
      sidebar.createVertexTemplateFromCells = originalTemplate;
    });
    let recentContainer = null;
    const renderRecent = () => {
      if (!recentContainer) return;
      updating = true;
      try {
        recentContainer.replaceChildren();
        const items = preferences.recent.filter((item) =>
          mode === "circuit"
            ? item.style.includes("mxgraph.electrical.")
            : !item.style.includes("mxgraph.electrical."),
        );
        if (!items.length) {
          const text = doc.createElement("div");
          text.className = "patent-recent-empty";
          text.textContent = "使用图库后，常用图形会显示在这里";
          recentContainer.appendChild(text);
        }
        for (const item of items)
          recentContainer.appendChild(
            sidebar.createVertexTemplate(item.style, item.width, item.height, "", item.label),
          );
      } finally {
        updating = false;
      }
    };
    recentContainer = sidebar.addPalette("patentRecent", "最近使用", true, () => {});
    const common = sidebar.addPalette("patentCommon", "常用图形", true, () => {});
    const release = () => {
      if (pendingRecent) {
        preferences.recent = remember(preferences.recent, pendingRecent);
        pendingRecent = null;
        save();
        win.setTimeout(renderRecent, 0);
      }
    };
    win.addEventListener("pointerup", release);
    cleanup.push(() => win.removeEventListener("pointerup", release));
    const watched = new Set();
    const applyMode = (nextMode) => {
      applyingMode = true;
      mode = nextMode;
      numbering.hidden = template.hidden = mode === "circuit";
      common.replaceChildren();
      const base =
        "whiteSpace=wrap;html=0;strokeColor=#000000;fillColor=#ffffff;fontColor=#000000;";
      const items =
        mode === "circuit"
          ? [
              ["电阻器", "shape=mxgraph.electrical.resistors.resistor_1;", 100, 20],
              ["电容器", "shape=mxgraph.electrical.capacitors.capacitor_1;", 100, 60],
              ["缓冲器", "shape=mxgraph.electrical.logic_gates.buffer2;", 100, 60],
            ]
          : [
              ["开始 / 结束", "rounded=1;", 100, 40],
              ["处理", "rounded=0;", 100, 50],
              ["判断", "shape=rhombus;", 80, 60],
              ["输入 / 输出", "shape=parallelogram;", 100, 50],
            ];
      for (const [label, shape, width, height] of items)
        common.appendChild(sidebar.createVertexTemplate(base + shape, width, height, "", label));
      const pairs = Object.entries(sidebar.palettes);
      for (const [id, pair] of pairs) {
        const title = pair[0],
          content = pair[1]?.querySelector(".geSidebar");
        if (!title || !content) continue;
        if (!watched.has(title)) {
          const rememberExpansion = () => {
            if (applyingMode) return;
            // Capture the intended state before draw.io starts its collapse animation.
            preferences.expanded[id] = content.style.display === "none";
            save();
          };
          title.addEventListener("click", rememberExpansion, true);
          cleanup.push(() => title.removeEventListener("click", rememberExpansion, true));
          watched.add(title);
        }
        if (title.style.display === "none") continue;
        const desired = preferences.expanded[id] ?? (id === "patentCommon" || id === "flowchart");
        if ((content.style.display !== "none") !== desired) title.click();
      }
      const top = sidebar.palettes.patentCommon[0].parentNode;
      const anchor = Array.from(top.children).find(
        (element) =>
          element.classList.contains("geTitle") &&
          element !== sidebar.palettes.patentCommon[0] &&
          element !== sidebar.palettes.patentRecent[0],
      );
      for (const id of ["patentCommon", "patentRecent"])
        for (const element of sidebar.palettes[id]) top.insertBefore(element, anchor);
      renderRecent();
      applyingMode = false;
    };
    return {
      applyMode,
      dispose: () =>
        cleanup.reverse().forEach((action) => {
          action();
        }),
    };
  };
  root.PatentDrawingTools = Object.freeze({ remember, stepLabel, install });
})(globalThis);
