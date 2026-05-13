// Local data adapter — reads from /local-data/ served by the Vite dev plugin.
// File IDs are relative paths (e.g. "tracks/hiking/activity_123.gpx").
// Used when VITE_LOCAL_MODE=true; must match the driveApi function signatures.

import type { DriveFile } from "./driveApi";

const BASE = "/local-data";

interface DirEntry {
  name: string;
  type: "file" | "directory";
}

async function listDir(relPath: string): Promise<DirEntry[]> {
  try {
    const res = await fetch(`${BASE}/${relPath}/`.replace(/\/+/g, "/"));
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function getRootFolderId(_token: string | null): Promise<string> {
  return "";
}

export async function findOrCreateFolder(
  _token: string | null,
  name: string,
  parentId: string,
): Promise<string> {
  return parentId ? `${parentId}/${name}` : name;
}

export async function listFolders(
  _token: string | null,
  parentId: string,
): Promise<DriveFile[]> {
  const entries = await listDir(parentId);
  return entries
    .filter((e) => e.type === "directory")
    .map((e) => ({
      id: parentId ? `${parentId}/${e.name}` : e.name,
      name: e.name,
      mimeType: "application/vnd.google-apps.folder",
    }));
}

export async function listFiles(
  _token: string | null,
  parentId: string,
  opts: { nameContains?: string; mimeType?: string } = {},
): Promise<DriveFile[]> {
  const entries = await listDir(parentId);
  return entries
    .filter((e) => e.type === "file")
    .filter((e) => !opts.nameContains || e.name.includes(opts.nameContains))
    .map((e) => ({
      id: parentId ? `${parentId}/${e.name}` : e.name,
      name: e.name,
      mimeType: e.name.endsWith(".gpx")
        ? "application/gpx+xml"
        : "application/json",
    }));
}

export async function readFileText(
  _token: string | null,
  fileId: string,
): Promise<string> {
  if (fileId.startsWith("__ls__:")) return readLocalStorageText(fileId);
  const res = await fetch(`${BASE}/${fileId}`.replace(/\/+/g, "/"));
  if (!res.ok) throw new Error(`Local file not found: ${fileId}`);
  return res.text();
}

export async function findFileByName(
  _token: string | null,
  name: string,
  parentId: string,
): Promise<DriveFile | null> {
  // For the tracks index, check localStorage first
  const lsKey = `local:${parentId}/${name}`;
  if (localStorage.getItem(lsKey)) {
    return { id: `__ls__:${lsKey}`, name, mimeType: "application/json" };
  }
  const files = await listFiles(null, parentId);
  return files.find((f) => f.name === name) ?? null;
}

export async function upsertJsonFile(
  _token: string | null,
  name: string,
  parentId: string,
  content: unknown,
): Promise<void> {
  localStorage.setItem(
    `local:${parentId}/${name}`,
    JSON.stringify(content, null, 2),
  );
}

// Special: read a file that was saved to localStorage by upsertJsonFile
export function readLocalStorageText(fileId: string): string {
  const key = fileId.replace(/^__ls__:/, "");
  return localStorage.getItem(key) ?? "{}";
}
