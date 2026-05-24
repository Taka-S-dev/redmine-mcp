import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineApiError } from "../redmine/client.js";
import {
  jsonResult,
  errorResult,
  selectProjects,
  fetchIssuesForSelection,
  sortIssuesBySpec,
  resolveCfFilterValue,
  localDateString,
  type ToolContext,
} from "./context.js";
import { writeCsv } from "./csv.js";
import { CSV_COLUMN_ALIASES } from "./field-aliases.js";
import type { RedmineIssue } from "../types.js";

const STANDARD_COLUMNS = [
  "id",
  "url",
  "subject",
  "project",
  "tracker",
  "status",
  "priority",
  "parent_id",
  "assigned_to",
  "author",
  "done_ratio",
  "estimated_hours",
  "spent_hours",
  "start_date",
  "due_date",
  "created_on",
  "updated_on",
  "closed_on",
  "description",
] as const;

const DEFAULT_COLUMNS = [
  "id",
  "url",
  "subject",
  "tracker",
  "status",
  "priority",
  "assigned_to",
  "done_ratio",
  "start_date",
  "due_date",
  "updated_on",
];

/**
 * 列名を正規化する。受付ける形：
 *   - 英字キー（大小文字無視、空白除去）→ そのまま小文字英字キーに
 *   - 日本語別名 → 対応する英字キーに
 *   - `cf:<名前>` / `CF:<名前>` → `cf:<名前>` に統一
 *   - それ以外 → null（=不明な列）
 */
function resolveColumn(name: string): string | null {
  const trimmed = name.trim();
  if (/^cf:/i.test(trimmed)) {
    return "cf:" + trimmed.slice(3);
  }
  const lowered = trimmed.toLowerCase();
  if ((STANDARD_COLUMNS as readonly string[]).includes(lowered)) {
    return lowered;
  }
  return (CSV_COLUMN_ALIASES as Record<string, string>)[trimmed] ?? null;
}

const inputShape = {
  // --- 絞り込み（search_issues と同じ） ---
  project: z.string().optional().describe("プロジェクト名または identifier。"),
  status: z
    .string()
    .optional()
    .describe("'open' / 'closed' / 'all' またはステータス名。省略時 'open'。"),
  assigned_to: z
    .string()
    .optional()
    .describe("担当者。'me' / 'none'（未割当）/ 数値 ID。"),
  tracker: z.string().optional().describe("トラッカー名。"),
  subject_contains: z.string().optional().describe("件名の部分一致。"),
  description_contains: z.string().optional().describe("本文の部分一致。"),
  notes_contains: z.string().optional().describe("コメントの部分一致。"),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  updated_after: z.string().optional(),
  updated_before: z.string().optional(),
  due_after: z.string().optional(),
  due_before: z.string().optional(),
  overdue: z.boolean().optional().describe("期限切れ未完了のみ。"),
  custom_fields: z
    .record(z.string(), z.string())
    .optional()
    .describe("カスタムフィールドでの絞り込み。例: {'カテゴリ': 'ログイン'}。"),
  custom_field_match: z
    .enum(["exact", "partial"])
    .optional()
    .describe(
      "CF 値のマッチング。'exact'（既定）/ 'partial'。" +
        "partial はリスト型 CF なら選択肢から入力文字列を含むものを 1 つ特定" +
        "（例: 'ログイン' → 'ログイン機能'）、文字列型 CF なら通常の部分一致。",
    ),
  parent_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("親チケット ID。配下の子チケットだけを対象にする。"),
  sort: z
    .string()
    .optional()
    .describe("並び順。例: 'due_date:asc', 'updated_on:desc'。"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe("出力する最大件数。デフォルト 1000、最大 5000。"),

  // --- 出力オプション ---
  fields: z
    .array(z.string())
    .optional()
    .describe(
      "CSV に出力する列。省略時は標準的な列セット。" +
        `標準列（英字）: ${STANDARD_COLUMNS.join(", ")}。` +
        "日本語別名も可（件名 / 担当者 / 期日 / 状態 / 優先度 / 進捗率 / 起票者 / 開始日 / 予定工数 / 実績 / 更新日 / カテゴリ等）。" +
        "カスタムフィールドは 'cf:<フィールド名>'（例: 'cf:カテゴリ'）。" +
        "指定した順序で列が並ぶ。CSV のヘッダーには指定した名前そのまま（『件名』と書けば『件名』が見出しになる）。",
    ),
  filename: z
    .string()
    .optional()
    .describe(
      "出力ファイル名。省略時は issues_<日時>.csv が自動生成される。" +
        "exports/ ディレクトリに保存される。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "export_issues_csv",
    {
      title: "Redmine チケットを CSV エクスポート",
      description:
        "Redmine のチケットを検索し、結果を CSV ファイルとして exports/ ディレクトリに保存する。" +
        "search_issues と同じ条件で絞り込み可能。出力する列（fields）を自由に選べる。" +
        "CSV はサーバー側で生成するため、LLM が行データを生成する必要がなく高速。" +
        "Excel で文字化けしないよう UTF-8 BOM 付き・CRLF 改行で出力する。" +
        "「○○のチケットを CSV にして」「Excel で開ける一覧を出して」のような依頼に使う。" +
        "応答にはファイルパスと件数のみ返るので、トークン消費も小さい。",
      inputSchema: inputShape,
    },
    async (args) => {
      const metadata = await ctx.metadata.get();
      const params: Record<string, string | number | undefined> = {};

      // Project（スコープ解決）
      const projectSelection = selectProjects(args.project, ctx);
      if (projectSelection.kind === "error") {
        return errorResult(projectSelection.message);
      }

      // overdue
      let dueBefore = args.due_before;
      if (args.overdue) {
        if (args.status && args.status !== "open") {
          return errorResult(
            "overdue=true は status='open' とのみ併用可能です。",
          );
        }
        const today = localDateString();
        dueBefore = dueBefore && dueBefore < today ? dueBefore : today;
      }

      // status
      if (
        args.status === undefined ||
        args.status === "open" ||
        args.overdue
      ) {
        params.status_id = "open";
      } else if (args.status === "closed") {
        params.status_id = "closed";
      } else if (args.status === "all" || args.status === "*") {
        params.status_id = "*";
      } else {
        const sid = ctx.metadata.resolveStatusId(args.status);
        if (!sid) {
          return errorResult(
            `ステータス '${args.status}' が見つかりません。利用可能: ${metadata.statuses
              .map((s) => s.name)
              .join(", ")}`,
          );
        }
        params.status_id = sid;
      }

      // assigned_to
      if (args.assigned_to) {
        if (args.assigned_to === "me") params.assigned_to_id = "me";
        else if (args.assigned_to === "none") params.assigned_to_id = "!*";
        else params.assigned_to_id = args.assigned_to;
      }

      // tracker
      if (args.tracker) {
        const tid = ctx.metadata.resolveTrackerId(args.tracker);
        if (!tid) {
          return errorResult(
            `トラッカー '${args.tracker}' が見つかりません。利用可能: ${metadata.trackers
              .map((t) => t.name)
              .join(", ")}`,
          );
        }
        params.tracker_id = tid;
      }

      // text 部分一致
      if (args.subject_contains) params.subject = `~${args.subject_contains}`;
      if (args.description_contains)
        params.description = `~${args.description_contains}`;
      if (args.notes_contains) params.notes = `~${args.notes_contains}`;

      // 日付範囲
      const setRange = (
        key: "created_on" | "updated_on" | "due_date",
        after?: string,
        before?: string,
      ) => {
        const a = after ?? "";
        const b = before ?? "";
        if (a && b) params[key] = `><${a}|${b}`;
        else if (a) params[key] = `>=${a}`;
        else if (b) params[key] = `<=${b}`;
      };
      setRange("created_on", args.created_after, args.created_before);
      setRange("updated_on", args.updated_after, args.updated_before);
      setRange("due_date", args.due_after, dueBefore);

      // custom fields
      if (args.custom_fields) {
        const partial = args.custom_field_match === "partial";
        for (const [name, value] of Object.entries(args.custom_fields)) {
          const cfId = ctx.metadata.resolveCustomFieldId(name);
          if (!cfId) {
            return errorResult(
              `カスタムフィールド '${name}' が見つかりません（フィルタ用）。`,
            );
          }
          const cfDef = metadata.customFields.find((c) => c.id === cfId);
          const resolved = resolveCfFilterValue(cfDef, value, partial);
          if (!resolved.ok) {
            return errorResult(resolved.error);
          }
          params[`cf_${cfId}`] = resolved.value;
        }
      }

      if (args.parent_id !== undefined) params.parent_id = args.parent_id;

      const sortSpec = args.sort ?? "updated_on:desc";
      params.sort = sortSpec;
      const limit = args.limit ?? 1000;

      // 列の決定（日本語別名・大小文字違いも resolveColumn が吸収）
      const columns =
        args.fields && args.fields.length > 0 ? args.fields : DEFAULT_COLUMNS;
      const resolvedColumns = columns.map((c) => ({
        display: c,
        canonical: resolveColumn(c),
      }));
      const invalid = resolvedColumns
        .filter((r) => r.canonical === null)
        .map((r) => r.display);
      if (invalid.length > 0) {
        const aliasList = Object.keys(CSV_COLUMN_ALIASES).join(" / ");
        return errorResult(
          `不明な列指定: ${invalid.join(", ")}。` +
            `標準列（英字）: ${STANDARD_COLUMNS.join(", ")}。` +
            `日本語別名: ${aliasList}。` +
            `カスタムフィールドは 'cf:<名前>' 形式。`,
        );
      }

      try {
        const result = await fetchIssuesForSelection(
          ctx,
          projectSelection,
          params,
          limit,
        );
        let issues = result.items;
        if (projectSelection.kind === "fanOut") {
          issues = sortIssuesBySpec(issues, sortSpec).slice(0, limit);
        }

        const baseUrl = ctx.client.baseUrl;
        // ヘッダーはユーザー指定そのまま（『件名』と書けば『件名』が見出し）、
        // データ抽出は正規化済みの canonical キーで行う
        const headerRow = resolvedColumns.map((r) => r.display);
        const dataRows = issues.map((issue) =>
          resolvedColumns.map((r) =>
            columnValue(issue, r.canonical as string, baseUrl),
          ),
        );

        const saved = await writeCsv(
          [headerRow, ...dataRows],
          args.filename,
          "issues",
        );

        return jsonResult({
          saved: true,
          csv_path: saved.csvPath,
          relative_path: saved.relativePath,
          row_count: issues.length,
          total_matched: result.total_count,
          truncated: result.total_count > issues.length,
          columns,
          preview: dataRows.slice(0, 3),
          note: `${issues.length} 件を CSV 出力しました。Excel で開けます（UTF-8 BOM 付き）。`,
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

function columnValue(
  issue: RedmineIssue,
  col: string,
  baseUrl: string,
): string {
  switch (col) {
    case "id":
      return String(issue.id);
    case "url":
      return `${baseUrl}/issues/${issue.id}`;
    case "subject":
      return issue.subject ?? "";
    case "project":
      return issue.project?.name ?? "";
    case "tracker":
      return issue.tracker?.name ?? "";
    case "status":
      return issue.status?.name ?? "";
    case "priority":
      return issue.priority?.name ?? "";
    case "parent_id":
      return issue.parent?.id != null ? String(issue.parent.id) : "";
    case "assigned_to":
      return issue.assigned_to?.name ?? "";
    case "author":
      return issue.author?.name ?? "";
    case "done_ratio":
      return issue.done_ratio != null ? String(issue.done_ratio) : "";
    case "estimated_hours":
      return issue.estimated_hours != null
        ? String(issue.estimated_hours)
        : "";
    case "spent_hours":
      return issue.spent_hours != null ? String(issue.spent_hours) : "";
    case "start_date":
      return issue.start_date ?? "";
    case "due_date":
      return issue.due_date ?? "";
    case "created_on":
      return issue.created_on ?? "";
    case "updated_on":
      return issue.updated_on ?? "";
    case "closed_on":
      return issue.closed_on ?? "";
    case "description":
      return issue.description ?? "";
    default: {
      if (col.startsWith("cf:")) {
        const cfName = col.slice(3).trim().toLowerCase();
        const cf = issue.custom_fields?.find(
          (c) => c.name.toLowerCase() === cfName,
        );
        const v = cf?.value;
        if (v == null) return "";
        return Array.isArray(v) ? v.join("; ") : String(v);
      }
      return "";
    }
  }
}
