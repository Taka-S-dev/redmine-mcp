import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Excel が UTF-8 を正しく開くための BOM（U+FEFF）。
const UTF8_BOM = String.fromCharCode(0xfeff);

/** CSV セルのエスケープ（カンマ・引用符・改行を含むなら "" で囲む）。 */
export function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Excel フレンドリーな CSV 文字列を生成（UTF-8 BOM + CRLF）。 */
export function toCsv(rows: string[][]): string {
  const body = rows
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  return UTF8_BOM + body + "\r\n";
}

/** ファイル名をサニタイズ（パス区切り・禁止文字を除去、.csv を保証）。 */
export function safeFilename(
  name: string | undefined,
  defaultPrefix: string,
): string {
  if (!name || !name.trim()) {
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    return `${defaultPrefix}_${ts}.csv`;
  }
  let f = name.trim().replace(/[/\\:*?"<>|]/g, "_");
  if (!f.toLowerCase().endsWith(".csv")) f += ".csv";
  return f;
}

/**
 * 行データを CSV として exports/ ディレクトリに書き出す。
 * exports/ は存在しなければ作成する。
 */
export async function writeCsv(
  rows: string[][],
  filename: string | undefined,
  defaultPrefix: string,
): Promise<{ csvPath: string; relativePath: string; fileName: string }> {
  const fileName = safeFilename(filename, defaultPrefix);
  const exportsDir = resolve(process.cwd(), "exports");
  await mkdir(exportsDir, { recursive: true });
  const csvPath = resolve(exportsDir, fileName);
  await writeFile(csvPath, toCsv(rows), "utf8");
  return { csvPath, relativePath: `exports/${fileName}`, fileName };
}
