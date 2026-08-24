/**
 * Server-only sales briefing file I/O. Do not import from client components.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SALES_DEEP_BRIEFING_PATH } from "./sales-deep";

export function salesBriefingAbsolutePath(cwd = process.cwd()): string {
  return path.join(cwd, SALES_DEEP_BRIEFING_PATH);
}

export async function writeSalesBriefingFile(markdown: string): Promise<string> {
  const filePath = salesBriefingAbsolutePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, markdown, "utf8");
  return filePath;
}

export async function readSalesBriefingFile(): Promise<string | null> {
  try {
    const text = await readFile(salesBriefingAbsolutePath(), "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
