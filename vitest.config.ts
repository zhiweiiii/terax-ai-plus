import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig(async (configEnv) =>
	mergeConfig(
		await viteConfig(configEnv),
		defineConfig({
			test: {
				include: ["src/**/*.test.{ts,tsx}"],
				exclude: [
					"rebased/**",
					"**/node_modules/**",
					"**/dist/**",
					"**/cypress/**",
					"**/.{idea,git,cache,output,temp}/**",
					"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
				],
			},
		}),
	),
);
