import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECT_MARKER = path.join(".cc-suite", "project.json");

function nearestManagedProject(cwd) {
  let current = path.resolve(cwd);
  while (true) {
    const marker = path.join(current, PROJECT_MARKER);
    try {
      const parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
      if (parsed?.managedBy === "cc-suite" && parsed?.schema === 1) return current;
    } catch {
      // Missing, unreadable, or user-owned marker: keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveWorkspaceRoot(cwd) {
  // A managed marker wins over Git. This keeps non-Git projects scoped and,
  // importantly, prevents a directory under a broad parent repository (for
  // example $HOME) from storing cc-suite state outside the project boundary.
  const managed = nearestManagedProject(cwd);
  if (managed) return managed;

  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return cwd;
}
