const { join } = require("node:path");
const { dependencyAllowPaths } = require("./dependency-resolution.cjs");

exports.rendererDevelopmentOptions = (root) => ({
  // Each checkout owns its cache even when node_modules is shared by symlink.
  cacheDir: join(root, "out", "node_modules", ".vite", "renderer"),
  resolve: { dedupe: ["react", "react-dom"] },
  // A worktree can have partial local dependencies plus resolved parent packages.
  server: {
    fs: { allow: dependencyAllowPaths(root) },
  },
  // Discover the lazy chemistry dependencies in the same optimization pass as React.
  // Keep Indigo’s relative Worker/WASM URLs in the original ESM package.
  // Their code still loads only when the structure editor is opened.
  optimizeDeps: {
    include: ["ketcher-react", "ketcher-core", "ketcher-standalone > @babel/runtime/regenerator"],
    exclude: ["ketcher-standalone"],
  },
});
