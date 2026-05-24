import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineApiError } from "../redmine/client.js";
import {
  jsonResult,
  errorResult,
  detectAttachmentKind,
  type AttachmentKind,
  type ToolContext,
} from "./context.js";

/**
 * download_attachment — Redmine の添付ファイルをローカルに保存し、
 * ファイルパスとメタ情報を返す。中身のパース（PDF/Excel 等）は行わない。
 *
 * 設計思想:
 *   このツールは「認証ヘッダ付きでファイルを取って disk に置く」だけに徹する。
 *   テキスト/PDF/画像は agent 自身の Read 機能で開けるケースが多く、その場合は
 *   ここで返した local_path を渡せば済む。バイナリ形式の中身パースが必要に
 *   なったら、本サーバに read_attachment ツールを別途追加する（拡張点）。
 *   そのときも client.downloadAttachment() を再利用して dynamic import で
 *   parser ライブラリを読み込むことで、デフォルト依存ゼロを保つ方針。
 */

const inputShape = {
  issue_id: z
    .number()
    .int()
    .positive()
    .describe("添付の所属するチケット ID（保存先パスの整理用）。"),
  attachment_id: z
    .number()
    .int()
    .positive()
    .describe(
      "添付ファイル ID。review_issue (include_attachments=true) の応答や " +
        "get_issue の attachments 配列から取得できる。",
    ),
  save_to: z
    .string()
    .optional()
    .describe(
      "保存先ディレクトリ（プロジェクトルートからの相対 or 絶対パス）。" +
        "省略時は exports/attachments/<issue_id>/。",
    ),
};

const KIND_HINTS: Record<AttachmentKind, string> = {
  text: "プレーンテキスト。agent の Read ツールでそのまま開ける。",
  pdf:
    "PDF。Claude Code の Read ツールは pages 指定でネイティブ対応。" +
    "それ以外のクライアントで読めない場合は専用パーサが必要" +
    "（このサーバには現状未搭載・将来の拡張点）。",
  excel:
    "Excel。多くの agent は直接読めない。中身を見るにはパーサ実装が必要" +
    "（未搭載・将来の拡張点）。CSV に変換すれば agent 側で読める場合あり。",
  image:
    "画像。マルチモーダル LLM（Sonnet 4.6 等）なら Read で開けば視覚的に読める。",
  binary: "形式不明 / バイナリ。中身解析は別途検討。",
};

function safeFilename(name: string): string {
  // パストラバーサル防止 + Windows/Unix で問題になる文字を除去
  const base = path.basename(name).replace(/[\x00-\x1f<>:"|?*]/g, "_");
  return base.trim() || "attachment";
}

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "download_attachment",
    {
      title: "添付ファイルのダウンロード",
      description:
        "Redmine の添付ファイルをローカル保存し、ファイルパスとメタ情報を返す。" +
        "中身のパースは行わない（agent の Read 機能で開くか、" +
        "将来追加されうる read_attachment ツールで処理する役割分担）。" +
        "デフォルト保存先は exports/attachments/<issue_id>/<filename>。" +
        "返却値の kind（text / pdf / excel / image / binary）を見て、" +
        "agent が読み方を判断できる。kind が pdf でかつ Claude Code 等の " +
        "PDF 対応クライアントなら local_path を Read ツールに渡すのが最も簡単。",
      inputSchema: inputShape,
    },
    async (args) => {
      try {
        const attachment = await ctx.client.getAttachment(args.attachment_id);
        const { bytes, contentType } = await ctx.client.downloadAttachment(
          attachment.content_url,
        );

        const baseDir = args.save_to
          ? path.resolve(args.save_to)
          : path.resolve("exports", "attachments", String(args.issue_id));
        await fs.mkdir(baseDir, { recursive: true });

        const filename = safeFilename(attachment.filename);
        const absolutePath = path.join(baseDir, filename);
        const relativePath = path.relative(process.cwd(), absolutePath);

        await fs.writeFile(absolutePath, bytes);

        const effectiveContentType =
          contentType || attachment.content_type || "application/octet-stream";
        const kind = detectAttachmentKind(effectiveContentType);

        return jsonResult({
          local_path: absolutePath,
          relative_path: relativePath,
          filename,
          content_type: effectiveContentType,
          size_bytes: bytes.length,
          kind,
          hint: KIND_HINTS[kind],
        });
      } catch (err) {
        if (err instanceof RedmineApiError) {
          return errorResult(err.message, err.body);
        }
        throw err;
      }
    },
  );
}
