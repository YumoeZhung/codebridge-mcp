import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 1024 * 1024 * 8,
  });
  return stdout;
}

async function runGitSafe(args, cwd) {
  try {
    return (await runGit(args, cwd)).trim();
  } catch {
    return "";
  }
}

async function computeFileHash(filePath) {
  const data = await fs.readFile(filePath);
  return createHash("sha1").update(data).digest("hex");
}

function parsePorcelainLine(line) {
  if (!line.trim()) return null;
  const status = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const pathText = rawPath.includes(" -> ")
    ? rawPath.split(" -> ").at(-1)
    : rawPath;
  return { status, path: pathText };
}

export async function captureSnapshot(workspace) {
  const topLevel = await runGitSafe(
    ["rev-parse", "--show-toplevel"],
    workspace,
  );
  if (!topLevel) {
    return { supported: false, workspace, branch: "", head: "", changed: {} };
  }

  const statusOutput = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    workspace,
  );
  const branch = await runGitSafe(["branch", "--show-current"], workspace);
  const head = await runGitSafe(["rev-parse", "HEAD"], workspace);

  const entries = statusOutput
    .split("\n")
    .map(parsePorcelainLine)
    .filter(Boolean);

  const changed = {};
  for (const entry of entries) {
    const absolutePath = path.join(workspace, entry.path);
    const exists = await fs
      .stat(absolutePath)
      .then(() => true)
      .catch(() => false);
    changed[entry.path] = {
      status: entry.status,
      exists,
      hash: exists ? await computeFileHash(absolutePath) : null,
    };
  }

  return { supported: true, workspace, branch, head, changed };
}

function diffWorkingTree(before, after) {
  const allPaths = new Set([
    ...Object.keys(before.changed || {}),
    ...Object.keys(after.changed || {}),
  ]);

  const changedFiles = [];
  for (const filePath of allPaths) {
    const prev = before.changed[filePath] || null;
    const next = after.changed[filePath] || null;
    if (!prev && next) {
      changedFiles.push(filePath);
    } else if (prev && !next) {
      changedFiles.push(filePath);
    } else if (
      prev &&
      next &&
      (prev.status !== next.status ||
        prev.hash !== next.hash ||
        prev.exists !== next.exists)
    ) {
      changedFiles.push(filePath);
    }
  }
  return changedFiles;
}

function trimOutput(text, max = 8000) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

async function summarizeCommittedChanges(before, after) {
  if (!before.head || !after.head || before.head === after.head) return null;

  const changedFilesOutput = await runGitSafe(
    ["diff", "--name-only", before.head, after.head],
    after.workspace,
  );
  const changedFiles = changedFilesOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const statOutput = await runGitSafe(
    ["diff", "--stat", before.head, after.head],
    after.workspace,
  );
  const patchOutput = await runGitSafe(
    ["diff", before.head, after.head],
    after.workspace,
  );

  const lines = ["Changes in this round:"];
  if (before.branch !== after.branch) {
    lines.push(
      `- branch: ${before.branch || "(detached)"} -> ${after.branch || "(detached)"}`,
    );
  }
  lines.push(
    `- commit: ${before.head.slice(0, 7)} -> ${after.head.slice(0, 7)}`,
  );

  const fileLines = changedFiles.slice(0, 8).map((f) => `- ${f}`);
  const extra = changedFiles.length - fileLines.length;
  if (changedFiles.length) {
    lines.push(...fileLines);
    if (extra > 0) lines.push(`- and ${extra} more files`);
  } else {
    lines.push("- commits changed but net diff is empty");
  }
  if (statOutput) {
    lines.push("", trimOutput(statOutput, 1200));
  }

  return {
    supported: true,
    changedFiles,
    summary: lines.join("\n"),
    patch: trimOutput(patchOutput, 12000),
    branchChange:
      before.branch !== after.branch
        ? { before: before.branch || "(detached)", after: after.branch || "(detached)" }
        : null,
    commitChange: { before: before.head, after: after.head },
  };
}

export async function summarizeChanges(before, after) {
  if (!before?.supported || !after?.supported) {
    return {
      supported: false,
      changedFiles: [],
      summary: "Workspace is not a git repository.",
      patch: "",
    };
  }

  const committed = await summarizeCommittedChanges(before, after);
  if (committed) return committed;

  const changedFiles = diffWorkingTree(before, after);
  if (!changedFiles.length) {
    return {
      supported: true,
      changedFiles: [],
      summary: "No new commits or working tree changes detected.",
      patch: "",
    };
  }

  let statOutput = "";
  let patchOutput = "";
  try {
    statOutput = await runGit(
      ["diff", "--stat", "--", ...changedFiles],
      after.workspace,
    );
  } catch {}
  try {
    patchOutput = await runGit(
      ["diff", "--", ...changedFiles],
      after.workspace,
    );
  } catch {}

  const fileLines = changedFiles.slice(0, 8).map((f) => `- ${f}`);
  const extra = changedFiles.length - fileLines.length;
  if (extra > 0) fileLines.push(`- and ${extra} more files`);

  const lines = ["Changes in this round:", ...fileLines];
  if (statOutput.trim()) {
    lines.push("", trimOutput(statOutput.trim(), 1200));
  }

  return {
    supported: true,
    changedFiles,
    summary: lines.join("\n"),
    patch: trimOutput(patchOutput.trim(), 12000),
    branchChange: null,
    commitChange: { before: before.head, after: after.head },
  };
}

export async function currentDiff(workspace) {
  const snapshot = await captureSnapshot(workspace);
  if (!snapshot.supported) {
    return {
      supported: false,
      summary: "Not a git repository.",
      changedFiles: [],
      patch: "",
      branch: "",
      head: "",
    };
  }

  let statOutput = "";
  let patchOutput = "";
  try {
    statOutput = (
      await runGit(["diff", "--stat", "HEAD"], workspace)
    ).trim();
  } catch {}
  try {
    patchOutput = (await runGit(["diff", "HEAD"], workspace)).trim();
  } catch {}

  const changedFiles = Object.keys(snapshot.changed);
  const lines = [];
  if (changedFiles.length) {
    lines.push(
      "Uncommitted changes:",
      ...changedFiles.slice(0, 12).map((f) => `- ${f}`),
    );
    const extra = changedFiles.length - 12;
    if (extra > 0) lines.push(`- and ${extra} more files`);
    if (statOutput) lines.push("", trimOutput(statOutput, 1200));
  } else {
    lines.push("Working tree is clean.");
  }

  return {
    supported: true,
    summary: lines.join("\n"),
    changedFiles,
    patch: trimOutput(patchOutput, 12000),
    branch: snapshot.branch,
    head: snapshot.head,
  };
}
