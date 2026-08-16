#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
await import(pathToFileURL(resolve(here, "../../../../scripts/dispatch-config.mjs")));
