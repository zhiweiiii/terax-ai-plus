import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  [resolve(root, "node_modules/knip/bin/knip.js"), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, KNIP_DISABLE_RAW_TRANSFER: "1" },
  },
);
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
