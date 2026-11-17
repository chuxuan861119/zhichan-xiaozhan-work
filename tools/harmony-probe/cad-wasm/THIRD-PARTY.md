# Offline CAD experiment components

- .NET runtime 8.0.31: MIT and included third-party notices, https://github.com/dotnet/runtime/tree/v8.0.31
- ACadSharp and CSUtilities: MIT; source revisions and local detail-reference patch are defined by `tools/drawing-converter/reader-source` and `prepare_reader_source.py`. The same reader code is compiled for WASM.
- Pyodide 0.29.3: MPL-2.0, https://github.com/pyodide/pyodide/tree/0.29.3. The runtime JavaScript/WASM is unmodified. Corresponding source and build instructions must remain available for distribution.
- CPython: PSF license; bundled Python standard library retains its license.
- ezdxf 1.4.4: MIT; NumPy 2.2.5: BSD-3-Clause; Pillow 11.3.0: MIT-CMU and bundled library licenses; fontTools 4.56.0: MIT; pyparsing 3.2.1: MIT; typing_extensions 4.15.0: PSF-2.0. Their wheels retain `.dist-info` license notices. Pyodide package source/build recipes: https://github.com/pyodide/pyodide/tree/0.29.3/packages
- Source Han Serif CN: SIL OFL 1.1, included alongside the font. Used only as CAD glyph fallback in this experiment; does not rewrite document font names.

This directory supports a local experimental Harmony build. Formal release requires the existing third-party license audit to include this dependency tree and source-material delivery; passing the emulator test does not complete that release audit.
