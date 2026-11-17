# Harmony offline CAD runtime

Reuses the existing ACadSharp reader (including the detail-reference patch) and ezdxf renderer. .NET WASM reads DWG and Pyodide runs the same bounded SVG/tile renderer in a disposable Node Worker. The original DWG remains owned by the main process. Ordinary drawings return SVG; large/huge drawings write bounded tiles into a caller-owned private temporary directory, then use the native path's validation, overview, container and cache code. Cancellation waits for the worker to terminate before removing intermediates. Conversion has the same 20-minute active-time ceiling as native conversion; system sleep is not charged in full. No external conversion service or machine is required.

The runtime manifest declares `readerAot: true`, `readerRemovalEvents: 1`, `drawingTiles: 1` and `progressProtocol: 1`, and pins both `render_svg.py` and `tiled_svg.py`. The reader uses the current shared reader source and AOT compilation, with trimming disabled to retain reflection metadata. The preparation script checks the compiled CAD entry-point exports and optimized-reader marker, and rejects older readers. Rebuild the runtime after either script or `worker.mjs` changes and update `platforms/harmony/cad-runtime-pins.json` from the verified inventory; an old assembled runtime does not inherit source edits. Preview PNGs returned by Sharp WASM must be copied out of `SharedArrayBuffer` before Electron IPC. A reduced preview allocation must retain display-space stroke scale and scale its minimum bitmap stroke down proportionally.

Mono's multicast delegate subscriptions copy the invocation array on each add. Hundreds of thousands of entities subscribe to the same layer/line-type/material removal events, causing quadratic allocation and repeated full garbage collection during document assembly. The isolated Harmony reader replaces only the table and dictionary removal-event storage with an amortized constant-time list. It preserves listener order, duplicates, grouped removal, invocation snapshots, exception propagation and dictionary clone isolation. Parsing, geometry, reference assignment, compatibility adapters and the native Windows/Mac reader remain unchanged. No listeners are omitted. `prepare-reader.mjs` validates exact pinned-source anchors and writes two patched copies into a new build directory; it never edits the vendor tree.

## Rebuild outside the repository

1. Use an isolated .NET SDK 8.0.425 with `wasm-tools` installed. Prepare the repository's verified, pinned vendor sources using `tools/drawing-converter/prepare_reader_source.py`, retaining the detail-reference adapter. Build the Harmony reader variant in a new directory:

   ```sh
   node tools/harmony-probe/cad-wasm/prepare-reader.mjs "$VENDOR" "$IMPORT_READER"
   "$DOTNET_SDK/dotnet" build "$IMPORT_READER/CadImportReader.csproj" -c Release \
     -p:WorkbenchRoot="$REPO" -p:VendorRoot="$VENDOR"
   ```

   Copy `reader/CadWasm.csproj` and `reader/main.mjs` to a separate new build directory. Supply `WorkbenchRoot` and `ReaderAssembly` explicitly; the latter must be the variant just built, not the native converter's assembly.

   ```sh
   "$DOTNET_SDK/dotnet" publish "$BUILD/CadWasm.csproj" -c Release \
     -p:RunAOTCompilation=true -p:WasmBuildNative=true -p:WorkbenchRoot="$REPO" \
     -p:ReaderAssembly="$IMPORT_READER/bin/Release/net8.0/ACadSharp.Local.dll"
   ```

2. Extract the official npm `pyodide@0.29.3` distribution into a local cache. Add the wheels listed in `python-files.json`. Pyodide wheels come from `https://cdn.jsdelivr.net/pyodide/v0.29.3/full/<file_name>`; ezdxf's pure Python wheel comes from the [PyPI 1.4.4 release](https://pypi.org/project/ezdxf/1.4.4/#files). The preparation script verifies every copied Python runtime/wheel checksum against the checked-in pins. It generates a local lock containing only the required package closure.

3. Assemble into a new directory; the script refuses to overwrite an existing output:

   ```sh
   node tools/harmony-probe/cad-wasm/prepare.mjs \
     "$BUILD/bin/Release/net8.0/publish/wwwroot/_framework" "$PYODIDE_CACHE" "$NEW_RUNTIME"
   ```

4. Pass `HARMONY_CAD_WASM_ROOT="$NEW_RUNTIME"` when running `prepare-workbench.mjs`. This copies the checked manifest and files into `resources/drawing-converter/wasm/` next to the app. Keep all `.wasm`, ICU data and JavaScript runtime files. Never substitute the Mac/Windows native converter or copy a user drawing into the interactive package.

Run `node --test tools/harmony-probe/cad-wasm/prepare-reader.test.mjs` for source-patch guards. Build `reader/tests/RemovalEvents.csproj` with the variant's `ReaderAssembly` and execute the resulting DLL with the same SDK to verify delegate semantics, actual layer removal, dictionary cloning and bounded allocation for 100,000 subscriptions. Put `BaseOutputPath` and `BaseIntermediateOutputPath` outside the source checkout for isolated validation.

Runtime workers require local resource access; they do not install packages or retrieve assets from a CDN during conversion. The font is an OFL fallback for CAD glyph outlines only. CAD text, special entities, hatches and external references still need visual comparison with the original drawing. This does not implement the separate document-SimSun proposal.

AOT uses the existing .NET `wasm-tools` workload and increases the offline runtime size. See [Microsoft's WebAssembly AOT documentation](https://learn.microsoft.com/en-us/aspnet/core/blazor/webassembly-build-tools-and-aot?view=aspnetcore-8.0). Compressed transport copies (`.br`/`.gz`), debug maps and PDBs are omitted from the assembled Node runtime; the complete required runtime inventory remains pinned.

Actual emulator checks and remaining release limitations are recorded in `docs/changes/harmony-dependency-probe/acceptance.md`. See `THIRD-PARTY.md` for component and distribution obligations.
