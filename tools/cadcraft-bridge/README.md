# Cadcraft bridge

This adapter uses the **unmodified** Cadcraft engine, document, renderer and format crates from commit `00c7613f1af3c73f7157fa91d9fe2635c6f23c06`. It does not implement a second CAD model. Source archive integrity is checked by `scripts/build-cadcraft.ps1`; registry dependencies are pinned by `Cargo.lock`. Native DWG uses the upstream dependency `acadrust` exactly `0.6.3`, unmodified (MPL-2.0). Cadcraft itself is MIT OR Apache-2.0. No upstream brand assets are used.

## Build

Requires Rust with the Windows MSVC toolchain and linker. Run from repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-cadcraft.ps1
```

`-Mode test`, `native`, or `wasm` selects a stage. Downloads and build caches stay in `out-cadcraft-*`. Generated deliverables are `resources/cadcraft/cadcraft-codec.exe` and `resources/cadcraft/wasm/cadcraft.js` plus `.wasm` and declarations. These outputs are not source files and must not be committed. The build copies upstream notices into `resources/cadcraft/licenses`; the host distribution must include these and the third-party license/source notices.

The supplied build script is Windows-only. On macOS, the native crates can be built using `cargo build --locked --release --manifest-path tools/cadcraft-bridge/Cargo.toml --bin cadcraft-codec` after placing the verified source archive at the same relative location; package the target-native executable without `.exe` and its licenses. No macOS build or acceptance has been performed here. HarmonyOS native `acadrust` compatibility and packaging remain unverified; DWG conversion is unavailable in pure WASM upstream and must not be advertised there without a verified native codec.

## Browser API

Initialize the generated ES module with the explicit local `.wasm` URL/bytes, then create `new CadcraftSession()` (metric drawing). `.free()` releases the WASM session.

| Method | Result |
| --- | --- |
| `load_dxf(bytes: Uint8Array)` | Replace document only after successful parsing; resets session undo history. |
| `execute(command: string, paramsJson: string)` | JSON string containing the upstream result; errors throw. |
| `scene()` | JSON render/inspection state described below. |
| `commands()` | JSON upstream command catalog with `id`, `params`, `enabled`, `disabledReason`, etc. |
| `pick(x, y, aperture)` | Entity hexadecimal handle or undefined; actual upstream geometry hit test, world units. |
| `export_dxf()` | Editable DXF bytes, not a flattened rendering. |
| `export_svg()` | Upstream model-space vector rendition, including blocks, curves, text and hatches. |
| `register_font(name: string, bytes: Uint8Array)` | Validate and register TTF/OTF/TTC font bytes, then prefer it for missing-glyph fallback; max 32 MiB. |

The host owns filesystem dialogs, storage, annotation overlays, and DXF/DWG delivery. Do not route application file lifecycle through arbitrary engine file commands. No filesystem hooks are installed by this bridge. An engine error must not be presented as a successful save.

Native rendering can discover installed system fonts. WASM has no filesystem and the built-in stroke font does not contain Chinese glyphs: the host must explicitly supply a suitable font to `register_font` before rendering CJK text. This application already ships the licensed `src/shared/document/fonts/SourceHanSerifCN-Regular.otf`; use it in WASM as `register_font('Source Han Serif CN', bytes)` and pass the same host-controlled absolute path through the native `--font` option so rendering agrees across processes. Registered fonts and fallback preference are module-wide, not per drawing; registration does not embed fonts in DXF. The host must reload the font after a restart. Tests use the existing licensed font without adding any font asset.

### Commands

`commands()` is the authoritative catalog for the pinned engine, including parameter grammar. The bridge forwards native command execution and undo rather than translating geometry itself. Common forms:

```json
{"command":"line", "params":{"points":[[0,0],[20,10]]}}
{"command":"pline", "params":{"vertices":[[0,0],[10,0],[10,10]],"closed":true}}
{"command":"circle", "params":{"center":[5,5],"radius":3}}
{"command":"move", "params":{"handles":["100"],"delta":[2,3]}}
{"command":"erase", "params":{"handles":["100"]}}
{"command":"undo", "params":{}}
{"command":"redo", "params":{}}
```

Other engine commands include arc, rectang, polygon, ellipse, spline, trim, extend, offset, rotate, scale, mirror, copy, hatch, layers, blocks and dimensions. Consult each catalog entry for exact parameters and enabled status rather than guessing. Availability of a command in the engine does not mean the host has exposed or acceptance-tested a corresponding UI flow.

### Scene and coordinates

`scene()` returns `{entityCount, revision, selection, bounds, svgFrame, entities, primitives}`. Handles are **hexadecimal strings**, never JS floating-point integers. `bounds` is null for an empty scene or `{min:[x,y],max:[x,y]}`. Entities are `{handle,type,layer}`. Each primitive has `{handle,kind,points,color,aci7,lineweight}`; kinds are `polyline`, `triangles`, `mask`, `point`, `infinite`, `ray`. Points use CAD world units, positive Y upward. `triangles` and `mask` group points in threes. Infinite/ray points are base and unit direction, not two endpoints. `color` is `[r,g,b]`; `aci7` resolves to black on white (or white on a dark CAD canvas). Lineweight is millimetres. Blocks/text/hatches are tessellated by the upstream renderer and retain their parent entity handle for selection.

`svgFrame` is `{origin:[x0,y1],width,height}` in SVG **viewBox units**, not intrinsic image pixels. For a world point `(x,y)`, `svgX=x-x0`, `svgY=y1-y`. Inverse: `x=svgX+x0`, `y=y1-svgY`. This frame exactly follows `export_svg()`: nonempty render bounds, each dimension clamped to at least 1e-9, plus a margin of 2% of the largest dimension. Empty drawing uses width/height 1.04 and origin `[0,1]`. Export intrinsic width is 1600 px and height is rounded from the aspect ratio. For host annotation pixels, first normalize by the host-rendered SVG content width/height to viewBox units; do not treat intrinsic pixel coordinates as CAD units. Store the frame alongside any persisted annotation checkpoint, and preserve that frame when the CAD extents change.

## Native codec protocol

One invocation per conversion. Operations: `dwg-to-dxf`, `dxf-to-dwg`, `dxf-to-scene`, and `dxf-to-svg`. Input bytes on stdin, output bytes on stdout, human-readable errors on stderr, nonzero exit on failure. `dxf-to-scene` returns the same scene JSON as the WASM session. `dxf-to-svg --frame x0 y1 width height` optionally sets a fixed world frame: top-left origin `(x0,y1)`, positive width/height, SVG viewBox `0 0 width height`. The output transform is exactly `svgX=x-x0`, `svgY=y1-y`; there is no extra margin with an explicit frame. Missing/invalid/nonfinite frames fail, without fallback. No input/output file paths are accepted, no subprocess or shell invocation is used. Both input and output are bounded at **100 MiB**. DWG write uses the upstream drawing writer with its default version (new drawings: AC1032 / 2018). The host must write output atomically and only after successful exit; cancellation/timeout belongs to the host process lifecycle. Source DXF/DWG bytes should be retained by the host independently of render previews.

Roundtrip tests cover representative line/circle geometry, not every vendor DWG extension or all proprietary objects. Format support is limited by the pinned Cadcraft/acadrust versions. Do not promise lossless conversion of arbitrary DWG files based on these tests.

All operations optionally accept `--font <absolute-font-path>` (before or after `--frame`). This path must come from the trusted host's bundled-font location, never DXF data or arbitrary renderer input. The codec reads at most 32 MiB and validates the font before conversion; missing or invalid fonts fail explicitly.

## Isolated export composition

Scene entities also include `grips: [number, number][]` from the native entity's grip definition, in CAD coordinates and native grip-index order.

The host's `compileCadExport(project, scenesByCadAssetId)` returns `{sourceCadAssetId, commands, warnings}`. Load that source DXF when non-null; otherwise use a new metric session. Execute the plan only in a disposable export session, never the live editor. These bridge-private commands are deliberately absent from the interactive command catalog and do not add undo history:

- `bridge.prepare_export {}` creates a unique visible layer and a Source Han Serif CN text style for generated marks, independent of the source current layer/style.
- `bridge.transform_model {origin:[x,y],copies:[{scale,rotation,delta:[x,y]}]}` transforms/copies actual original model entities through the native geometry API. Scale must be positive; rotation is degrees counterclockwise. Original tables, blocks and entity types are retained.
- `bridge.add_primitives {primitives:[{kind,points,color,lineweight}]}` adds native entities atomically. Supported kinds are `polyline`, `triangles` (triples), `mask` (polygon), and `point`. Color is RGB bytes; lineweight is millimetres, 0–2.11. The batch is bounded at 100,000 primitives and 100,000 points per primitive. Invalid input leaves the drawing unchanged.

Whole, unclipped base drawings preserve original entities. Cropped fragments intersect local clip polygons, subtract holes, then apply fragment transforms. Cropped curves/text/hatches become editable polylines and filled SOLID triangles, not semantic original objects. Frozen nested details use their own CAD checkpoint and source scale. White backgrounds are ordered native WIPEOUT entities; circular clipping/masks use 256 sides with an explicit warning, while visible circle borders remain real circles. Labels, leaders, titles and ratios are added as editable entities. Unsupported primitive kinds, unavailable frozen sources and invalid/self-intersecting polygons fail explicitly. Renderer support and DWG vendor-extension limits still apply; this is not a promise of lossless arbitrary DWG conversion.

The compositor's real WASM/native DWG test runs on Windows when generated artifacts exist; on other platforms or a clean checkout it is explicitly skipped. Run the build script before that integration test. Pure geometry unit tests do not require generated artifacts.
