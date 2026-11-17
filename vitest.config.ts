import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    // Tests spawn real PTYs and servers on fixed ports (3160-3169, 3190): run files one at a time
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
