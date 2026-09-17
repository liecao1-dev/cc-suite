import fs from "node:fs";
import path from "node:path";

// Calibre's macOS bundle already supplies these tools, but its Poppler
// directory is not normally on PATH. Never grant the whole bundle or Bash.
export const CLAUDE_DOCUMENT_TOOLS = Object.freeze([
  "/Applications/calibre.app/Contents/utils.app/Contents/MacOS/pdftotext",
  "/Applications/calibre.app/Contents/utils.app/Contents/MacOS/pdftoppm",
  "/Applications/calibre.app/Contents/MacOS/ebook-convert",
]);

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function workspaceScratch(access) {
  let directory = access.executionCwd;
  for (const part of [".runtime", "claude-document-tools"]) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    const resolved = fs.realpathSync.native(directory);
    const relative = path.relative(access.workspaceRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Document tool scratch directory escapes workspace: ${directory}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Document tool scratch path is not a directory: ${directory}`);
    }
    directory = resolved;
  }
  return directory;
}

export function prepareClaudeDocumentTools(access, {
  env = process.env,
  toolPaths = CLAUDE_DOCUMENT_TOOLS,
} = {}) {
  const installed = toolPaths.filter(isExecutable);
  if (installed.length === 0) return { allow: [], env: { ...env }, instructions: "" };

  const scratch = workspaceScratch(access);
  const directories = [...new Set(installed.map((file) => path.dirname(file)))];
  const childEnv = {
    ...env,
    PATH: [...directories, ...(env.PATH ?? "").split(path.delimiter).filter(
      (directory) => directory && !directories.includes(directory),
    )].join(path.delimiter),
    TMPDIR: scratch,
  };
  if (installed.some((file) => path.basename(file) === "ebook-convert")) {
    childEnv.CALIBRE_CONFIG_DIRECTORY = path.join(scratch, "config");
    childEnv.CALIBRE_CACHE_DIRECTORY = path.join(scratch, "cache");
    childEnv.CALIBRE_TEMP_DIR = scratch;
  }

  return {
    allow: installed.map((file) => `Bash(${file} *)`),
    env: childEnv,
    instructions: [
      "The following installed document converters are pre-approved for direct Bash invocations inside the existing sandbox:",
      ...installed,
      "Use pdftotext for PDF text, pdftoppm for PDF rendering, and ebook-convert for EPUB/MOBI text conversion when available.",
      `Keep source files unchanged. Put conversion outputs and temporary files under ${scratch}.`,
    ].join("\n"),
  };
}
