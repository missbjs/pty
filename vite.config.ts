import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "pty.ts"),
      formats: ["es"],
      fileName: "pty",
    },
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      external: ["node-pty", "@xterm/headless", "strip-ansi", "ws", "crypto", "http", "fs", "path", "os", "tty", "stream", "events", "util", "child_process"],
    },
    rollupOptionsOutput: {
      banner: "#!/usr/bin/env node",
    },
  },
});
