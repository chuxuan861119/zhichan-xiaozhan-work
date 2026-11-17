import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const root = new URL("../../../resources/cadcraft/wasm/", import.meta.url);
const source = await readFile(new URL("cadcraft.js", root), "utf8");
const bridge = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
bridge.initSync({ module: await readFile(new URL("cadcraft_bg.wasm", root)) });
for (const pattern of ["ANSI31", "SOLID"])
  test(`exact interior TRIM pick removes only the cursor region of ${pattern}, previews and survives undo/reload`, () => {
    const s = new bridge.CadcraftSession();
    const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    const pick = (point) => run("bridge.pick_trim", {point, aperture:0.01});
    try {
      const a = run("rectang", {p1:[0,0],p2:[10,10]}).handle;
      const b = run("rectang", {p1:[20,0],p2:[30,10]}).handle;
      const h = run("hatch", {handles:[a,b],pattern,scale:100}).handle;
      run("line", {points:[[5,-1],[5,11]]});
      const before = s.scene();
      assert.equal(pick([2,5]), h, "sparse pattern gaps are part of the hatch region");
      const params = {handle:pick([2,5]),pick:[2,5],mode:"quick"};
      const preview = run("bridge.preview_modify", {command:"trim",params});
      assert.equal(s.scene(), before);
      run("trim", params);
      const after = JSON.parse(s.scene());
      assert.deepEqual(after.primitives, preview.primitives);
      assert.equal(pick([2,5]), null);
      assert.ok(pick([8,5]), "other side remains");
      assert.ok(pick([22,5]), "distant disconnected fill remains");
      const retained = pick([22,5]);
      const uncut = s.scene();
      assert.throws(() => run("trim", {handle:retained,pick:[22,5],mode:"quick"}));
      assert.equal(s.scene(), uncut, "uncut hatch must never fall back to whole-object erase");
      const saved = s.export_dxf();
      run("undo", {});
      assert.ok(pick([2,5]));
      s.load_dxf(saved);
      assert.equal(pick([2,5]), null);
      assert.ok(pick([8,5]));
      assert.ok(pick([22,5]));
    } finally { s.free(); }
  });

test("TRIM region picking ignores solid holes but preserves ordinary line picking", () => {
  const s = new bridge.CadcraftSession();
  const run = (c,p) => JSON.parse(s.execute(c,JSON.stringify(p)));
  try {
    run("rectang",{p1:[0,0],p2:[10,10]});
    run("rectang",{p1:[6,6],p2:[9,9]});
    const h = run("hatch",{points:[[1,1]],pattern:"SOLID"}).handles[0];
    assert.equal(run("bridge.pick_trim",{point:[7,7],aperture:0.01}),null);
    const l = run("line",{points:[[2,3],[4,3]]}).handles[0];
    assert.equal(run("bridge.pick_trim",{point:[3,3.005],aperture:0.01}),l);
    run("trim",{handle:l,pick:[3,3],mode:"quick"});
    assert.equal(run("bridge.pick_trim",{point:[3,3],aperture:0.01}),h);
  } finally { s.free(); }
});
for (const pattern of [null, "ANSI31", "SOLID"])
  for (const pick of [
    [5, 0],
    [10, 5],
    [5, 10],
    [0, 5],
  ])
    test(`rectangle trims one side with fill ${pattern} at ${pick}`, () => {
      const s = new bridge.CadcraftSession();
      const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
      try {
        const h = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
        if (pattern)
          run("hatch", { points: [[5, 5]], pattern, associative: true });
        const before = JSON.parse(s.scene());
        const params = { handle: h, pick, mode: "quick" };
        const preview = run("bridge.preview_modify", {
          command: "trim",
          params,
        });
        assert.deepEqual(JSON.parse(s.scene()), before);
        run("trim", params);
        const after = JSON.parse(s.scene());
        assert.deepEqual(after.primitives, preview.primitives);
        const polys = after.entities.filter((e) => e.type === "Polyline");
        assert.equal(polys.length, 1);
        assert.equal(polys[0].geometry.closed, false);
        assert.equal(polys[0].geometry.vertices.length, 4);
        const points = after.primitives
          .filter((p) => p.handle === polys[0].handle)
          .flatMap((p) => p.points);
        assert.equal(points.length, 4);
        for (let i = 1; i < points.length; i++) {
          const mid = points[i].map((v, j) => (v + points[i - 1][j]) / 2);
          assert.notDeepEqual(mid, pick, "picked side must be removed");
        }
        assert.equal(
          after.entities.filter((e) => e.type === "Hatch").length,
          pattern ? 1 : 0,
        );
        const bytes = s.export_dxf();
        run("undo", {});
        assert.deepEqual(JSON.parse(s.scene()).primitives, before.primitives);
        s.load_dxf(bytes);
        assert.equal(
          JSON.parse(s.scene()).entities.filter((e) => e.type === "Polyline")[0]
            .geometry.vertices.length,
          4,
        );
      } finally {
        s.free();
      }
    });
for (const pick of [
  [5, 0],
  [10, 5],
  [15, 10],
])
  test(`open joined polyline removes only selected segment at ${pick}`, () => {
    const s = new bridge.CadcraftSession();
    const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    try {
      const h = run("pline", {
        vertices: [
          [0, 0],
          [10, 0],
          [10, 10],
          [20, 10],
        ],
      }).handle;
      run("trim", { handle: h, pick, mode: "quick" });
      const ps = JSON.parse(s.scene()).entities.filter(
        (e) => e.type === "Polyline",
      );
      assert.equal(
        ps.reduce((n, e) => n + e.geometry.vertices.length - 1, 0),
        2,
      );
      assert.equal(ps.length, pick[0] === 10 ? 2 : 1);
    } finally {
      s.free();
    }
  });
test("closed bulged polyline keeps arc and widths when trimming its straight side", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("pline", {
      vertices: [
        { p: [0, 0], bulge: 1, startWidth: 2, endWidth: 4 },
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      closed: true,
      width: 3,
    }).handle;
    run("trim", { handle: h, pick: [5, 10], mode: "quick" });
    const p = JSON.parse(s.scene()).entities[0]?.geometry;
    assert.ok(p);
    assert.equal(p.vertices.length, 4);
    assert.equal(p.const_width, 3);
    const arc = p.vertices.find((v) => Math.abs(v.bulge) > 0.5);
    assert.ok(arc);
    assert.equal(arc.start_width, 2);
    assert.equal(arc.end_width, 4);
  } finally {
    s.free();
  }
});
test("polyline can explicitly serve as its own standard cutting boundary", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    run("trim", { handle: h, pick: [5, 0], edges: [h], mode: "standard" });
    assert.equal(
      JSON.parse(s.scene()).entities[0]?.geometry.vertices.length,
      4,
    );
  } finally {
    s.free();
  }
});
for (const selection of ["pick", "fence", "crossing"])
  test(`actual joined lines support single-side ${selection} trimming`, () => {
    const s = new bridge.CadcraftSession();
    const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    try {
      const pts = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ];
      const handles = pts
        .slice(1)
        .map((p, i) => run("line", { points: [pts[i], p] }).handles[0]);
      run("join", { handles });
      const h = JSON.parse(s.scene()).entities[0].handle;
      run("trim", {
        mode: "quick",
        ...(selection === "pick"
          ? { handle: h, pick: [5, 0] }
          : {
              [selection]: [
                [4, -1],
                [6, 1],
              ],
            }),
      });
      const ps = JSON.parse(s.scene()).entities.filter(
        (e) => e.type === "Polyline",
      );
      assert.equal(ps.length, 1);
      assert.equal(ps[0].geometry.vertices.length, 4);
    } finally {
      s.free();
    }
  });
test("quick polyline trim honors a nearer external intersection inside a side", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    run("line", {
      points: [
        [5, -1],
        [5, 1],
      ],
    });
    run("trim", { handle: h, pick: [2, 0], mode: "quick" });
    const p = JSON.parse(s.scene()).entities.find(
      (e) => e.type === "Polyline",
    ).geometry;
    assert.equal(p.vertices.length, 5);
    assert.deepEqual(p.vertices[0].p, { x: 5, y: 0 });
  } finally {
    s.free();
  }
});
test("a curved polyline side can be removed without deleting straight sides", () => {
  const s = new bridge.CadcraftSession();
  const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("pline", {
      vertices: [{ p: [0, 0], bulge: 1 }, [10, 0], [10, 10], [0, 10]],
      closed: true,
    }).handle;
    run("trim", { handle: h, pick: [5, -5], mode: "quick" });
    const p = JSON.parse(s.scene()).entities[0]?.geometry;
    assert.ok(p);
    assert.equal(p.vertices.length, 4);
    assert.ok(p.vertices.every((v) => Math.abs(v.bulge) < 1e-9));
  } finally {
    s.free();
  }
});
for (const vertices of [
  [
    [0, 0],
    [10, 0],
    [5, 8],
  ],
  [
    [0, 0],
    [10, 0],
    [12, 6],
    [5, 10],
    [-2, 6],
  ],
  [
    [0, 0],
    [10, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ],
])
  test(`closed polygon with ${vertices.length} vertices retains other sides`, () => {
    const s = new bridge.CadcraftSession();
    const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    try {
      const h = run("pline", { vertices, closed: true }).handle;
      run("trim", { handle: h, pick: [5, 0], mode: "quick" });
      const p = JSON.parse(s.scene()).entities[0]?.geometry;
      assert.ok(p);
      assert.equal(p.closed, false);
      const expected = [...vertices.slice(1), vertices[0]];
      assert.equal(p.vertices.length, expected.length);
      p.vertices.forEach((v, i) => {
        assert.ok(Math.hypot(v.p.x - expected[i][0], v.p.y - expected[i][1]) < 1e-9);
      });
    } finally {
      s.free();
    }
  });
test("standard trim does not remove an uncut region of a multi-region hatch", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const a = run("rectang", { p1: [0, 0], p2: [10, 10] }).handle;
    const b = run("rectang", { p1: [20, 0], p2: [30, 10] }).handle;
    const h = run("hatch", { handles: [a, b], pattern: "SOLID" }).handle;
    const edge = run("line", {
      points: [
        [25, -1],
        [25, 11],
      ],
    }).handles[0];
    const before = s.scene();
    assert.throws(() =>
      run("trim", { handle: h, pick: [5, 5], edges: [edge], mode: "standard" }),
    );
    assert.equal(s.scene(), before);
  } finally {
    s.free();
  }
});
test("a hatch made from a bulged circle is trimmed rather than erased in quick mode", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const c = run("circle", { center: [0, 0], radius: 10 }).handle;
    const h = run("hatch", { handles: [c], pattern: "SOLID" }).handles[0];
    const edge = run("line", {
      points: [
        [-11, 5],
        [11, 5],
      ],
    }).handles[0];
    run("trim", { handle: h, pick: [0, 8], edges: [edge], mode: "quick" });
    const after = JSON.parse(s.scene()),
      hs = new Set(
        after.entities.filter((e) => e.type === "Hatch").map((e) => e.handle),
      );
    assert.ok(hs.size > 0, "must retain the lower portion");
    assert.ok(
      after.primitives
        .filter((p) => hs.has(p.handle))
        .flatMap((p) => p.points)
        .every(([, y]) => y <= 5 + 1e-6),
    );
  } finally {
    s.free();
  }
});
test("joined polyline trimming preserves width and interpolates tapered segment widths", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("pline", {
      vertices: [{ p: [0, 0], startWidth: 2, endWidth: 6 }, [10, 0], [10, 10]],
      width: 3,
    }).handle;
    const edge = run("line", {
      points: [
        [5, -1],
        [5, 1],
      ],
    }).handles[0];
    run("trim", { handle: h, pick: [2, 0], edges: [edge], mode: "standard" });
    const p = JSON.parse(s.scene()).entities.find(
      (e) => e.handle !== edge,
    ).geometry;
    assert.equal(p.const_width, 3);
    assert.equal(p.vertices[0].start_width, 4);
    assert.equal(p.vertices[0].end_width, 6);
  } finally {
    s.free();
  }
});
test("hatch trimming around a circular cutting edge preserves the surrounding fill", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("rectang", { p1: [0, 0], p2: [10, 10] });
    const h = run("hatch", { points: [[1, 1]], pattern: "SOLID" }).handles[0];
    const edge = run("circle", { center: [5, 5], radius: 2 }).handle;
    run("trim", { handle: h, pick: [5, 5], edges: [edge], mode: "standard" });
    const after = JSON.parse(s.scene()),
      hs = new Set(
        after.entities.filter((e) => e.type === "Hatch").map((e) => e.handle),
      );
    let area = 0;
    for (const p of after.primitives.filter(
      (p) => hs.has(p.handle) && p.kind === "triangles",
    ))
      for (let i = 0; i + 2 < p.points.length; i += 3) {
        const [a, b, c] = p.points.slice(i, i + 3);
        area +=
          Math.abs(
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
          ) / 2;
      }
    assert.ok(Math.abs(area - (100 - Math.PI * 4)) < 0.005, `area ${area}`);
  } finally {
    s.free();
  }
});
for (const selection of ["fence", "crossing"])
  test(`solid hatch ${selection} can start inside the fill, not just on its outline`, () => {
    const s = new bridge.CadcraftSession(),
      run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    try {
      run("rectang", { p1: [0, 0], p2: [10, 10] });
      run("hatch", { points: [[2, 2]], pattern: "SOLID" });
      const edge = run("line", {
        points: [
          [5, -1],
          [5, 11],
        ],
      }).handles[0];
      run("trim", {
        [selection]: [
          [1, 2],
          [3, 4],
        ],
        edges: [edge],
        mode: "standard",
      });
      const after = JSON.parse(s.scene()),
        hs = new Set(
          after.entities.filter((e) => e.type === "Hatch").map((e) => e.handle),
        );
      assert.ok(hs.size);
      assert.ok(
        after.primitives
          .filter((p) => hs.has(p.handle))
          .flatMap((p) => p.points)
          .every(([x]) => x >= 5 - 1e-6),
      );
    } finally {
      s.free();
    }
  });
test("trimmed hatch keeps an untouched hole and rejects picks in that hole without mutation", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("rectang", { p1: [0, 0], p2: [10, 10] });
    run("rectang", { p1: [7, 3], p2: [9, 7] });
    const h = run("hatch", {
      points: [[1, 1]],
      pattern: "SOLID",
      associative: true,
    }).handles[0];
    const edge = run("line", {
      points: [
        [5, -1],
        [5, 11],
      ],
    }).handles[0];
    const before = s.scene();
    assert.throws(() =>
      run("trim", { handle: h, pick: [8, 5], mode: "quick" }),
    );
    assert.equal(s.scene(), before);
    run("trim", { handle: h, pick: [2, 5], edges: [edge], mode: "standard" });
    const after = JSON.parse(s.scene()),
      hs = new Set(
        after.entities.filter((e) => e.type === "Hatch").map((e) => e.handle),
      );
    let area = 0;
    for (const p of after.primitives.filter(
      (p) => hs.has(p.handle) && p.kind === "triangles",
    ))
      for (let i = 0; i + 2 < p.points.length; i += 3) {
        const [a, b, c] = p.points.slice(i, i + 3);
        area +=
          Math.abs(
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
          ) / 2;
      }
    assert.ok(Math.abs(area - 42) < 1e-5, `area ${area}`);
  } finally {
    s.free();
  }
});
test("closed joined lines trim across the first vertex without losing the other sides", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("pline", {
      vertices: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      closed: true,
    }).handle;
    const edge = run("line", {
      points: [
        [-1, -1],
        [11, 11],
      ],
    }).handles[0];
    run("trim", { handle: h, pick: [5, 0], edges: [edge], mode: "standard" });
    const remaining = JSON.parse(s.scene()).primitives.filter(
      (p) => p.handle !== edge,
    );
    assert.deepEqual(
      remaining.map((p) => p.points),
      [
        [
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    );
  } finally {
    s.free();
  }
});
for (const pattern of ["SOLID", "ANSI31"])
  test(`trim ${pattern} hatch keeps native fill and supports undo and DXF reload`, () => {
    const s = new bridge.CadcraftSession(),
      run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    try {
      run("rectang", { p1: [0, 0], p2: [10, 10] });
      const h = run("hatch", {
        points: [[5, 5]],
        pattern,
        scale: 1,
        associative: true,
      }).handles[0];
      const edge = run("line", {
        points: [
          [5, -1],
          [5, 11],
        ],
      }).handles[0];
      const params = {
        handle: h,
        pick: [2, 5],
        edges: [edge],
        mode: "standard",
      };
      const preview = run("bridge.preview_modify", { command: "trim", params });
      run("trim", params);
      const after = JSON.parse(s.scene());
      assert.deepEqual(after.primitives, preview.primitives);
      const fills = after.entities.filter((e) => e.type === "Hatch");
      assert.ok(fills.length > 0);
      const handles = new Set(fills.map((e) => e.handle));
      const points = after.primitives
        .filter((p) => handles.has(p.handle))
        .flatMap((p) => p.points);
      assert.ok(points.length > 0);
      assert.ok(points.every(([x]) => x >= 5 - 1e-6));
      const bytes = s.export_dxf();
      run("undo", {});
      assert.ok(JSON.parse(s.scene()).entities.some((e) => e.handle === h));
      s.load_dxf(bytes);
      assert.equal(
        JSON.parse(s.scene()).entities.filter((e) => e.type === "Hatch").length,
        fills.length,
      );
    } finally {
      s.free();
    }
  });
for (const selection of ["pick", "fence", "crossing"])
  test(`trim ${selection} previews, removes only the picked interval, undoes and reloads`, () => {
    const s = new bridge.CadcraftSession();
    const run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
    const line = (a, b) => run("line", { points: [a, b] }).handles[0];
    try {
      const h = line([0, 0], [10, 0]);
      const edges = [line([3, -5], [3, 5]), line([7, -5], [7, 5])];
      const before = JSON.parse(s.scene());
      const params = {
        mode: "standard",
        edges,
        ...(selection === "pick"
          ? { handle: h, pick: [5, 0] }
          : selection === "fence"
            ? {
                fence: [
                  [5, -1],
                  [5, 1],
                ],
              }
            : {
                crossing: [
                  [4, -1],
                  [6, 1],
                ],
              }),
      };
      const preview = run("bridge.preview_modify", { command: "trim", params });
      assert.equal(JSON.parse(s.scene()).entityCount, before.entityCount);
      run("trim", params);
      const after = JSON.parse(s.scene());
      assert.equal(after.entityCount, 4);
      assert.deepEqual(after.primitives, preview.primitives);
      const remaining = after.primitives.filter(
        (p) => !edges.includes(p.handle),
      );
      assert.deepEqual(
        remaining.map((p) => p.points),
        [
          [
            [0, 0],
            [3, 0],
          ],
          [
            [7, 0],
            [10, 0],
          ],
        ],
      );
      const bytes = s.export_dxf();
      run("undo", {});
      assert.equal(JSON.parse(s.scene()).entityCount, 3);
      s.load_dxf(bytes);
      assert.equal(JSON.parse(s.scene()).entityCount, 4);
    } finally {
      s.free();
    }
  });
test("quick erases an uncut object whereas standard leaves it intact", () => {
  const s = new bridge.CadcraftSession();
  try {
    const h = JSON.parse(
      s.execute(
        "line",
        JSON.stringify({
          points: [
            [0, 0],
            [10, 0],
          ],
        }),
      ),
    ).handles[0];
    assert.throws(() =>
      s.execute(
        "trim",
        JSON.stringify({ handle: h, pick: [5, 0], mode: "standard" }),
      ),
    );
    assert.equal(JSON.parse(s.scene()).entityCount, 1);
    s.execute(
      "trim",
      JSON.stringify({ handle: h, pick: [5, 0], mode: "quick" }),
    );
    assert.equal(JSON.parse(s.scene()).entityCount, 0);
  } finally {
    s.free();
  }
});
test("ambiguous crossing follows the rectangle clockwise from the first corner", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    run("pline", {
      vertices: [
        [-1, 9],
        [9, 9],
        [2, -1],
      ],
    });
    const edge = run("line", {
      points: [
        [5, 8],
        [5, 10],
      ],
    }).handles[0];
    run("trim", {
      crossing: [
        [0, 0],
        [10, 10],
      ],
      edges: [edge],
      mode: "standard",
    });
    const paths = JSON.parse(s.scene()).primitives.filter(
      (p) => p.handle !== edge,
    );
    assert.equal(
      Math.min(...paths.flatMap((p) => p.points.map((v) => v[0]))),
      2,
    );
  } finally {
    s.free();
  }
});
test("standard mode can use the natural extension of a boundary", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("line", {
      points: [
        [0, 0],
        [10, 0],
      ],
    }).handles[0];
    const edge = run("line", {
      points: [
        [5, 2],
        [5, 4],
      ],
    }).handles[0];
    const params = { handle: h, pick: [2, 0], edges: [edge], mode: "standard" };
    assert.throws(() => run("trim", params));
    run("trim", { ...params, edgeMode: "extend" });
    assert.deepEqual(
      JSON.parse(s.scene())
        .primitives.filter((p) => p.handle !== edge)
        .map((p) => p.points),
      [
        [
          [5, 0],
          [10, 0],
        ],
      ],
    );
  } finally {
    s.free();
  }
});
test("a circle is trimmed into a native arc, not a polyline approximation", () => {
  const s = new bridge.CadcraftSession(),
    run = (c, p) => JSON.parse(s.execute(c, JSON.stringify(p)));
  try {
    const h = run("circle", { center: [0, 0], radius: 5 }).handle;
    const edge = run("line", {
      points: [
        [-10, 0],
        [10, 0],
      ],
    }).handles[0];
    run("trim", { handle: h, pick: [0, 5], edges: [edge], mode: "standard" });
    assert.equal(
      JSON.parse(s.scene()).entities.find((e) => e.handle !== edge).type,
      "Arc",
    );
  } finally {
    s.free();
  }
});
