import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineApiError } from "../redmine/client.js";
import {
  jsonResult,
  errorResult,
  selectProjects,
  fetchIssuesForSelection,
  browserUrlFields,
  resolveCfFilterValue,
  localDateString,
  type ToolContext,
} from "./context.js";
import { writeCsv } from "./csv.js";
import type { RedmineIssue } from "../types.js";

const GROUP_KEYS = [
  "assignee",
  "author",
  "status",
  "tracker",
  "priority",
  "project",
] as const;
const METRICS = [
  "count",
  "sum_estimated_hours",
  "sum_spent_hours",
  "avg_done_ratio",
] as const;

const inputShape = {
  // フィルタ（search_issues と同じ）
  project: z.string().optional(),
  status: z
    .string()
    .optional()
    .describe(
      "'open' / 'closed' / 'all' またはステータス名。省略時は 'open'。",
    ),
  assigned_to: z.string().optional(),
  tracker: z.string().optional(),
  subject_contains: z.string().optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  updated_after: z.string().optional(),
  updated_before: z.string().optional(),
  due_after: z.string().optional(),
  due_before: z.string().optional(),
  overdue: z
    .boolean()
    .optional()
    .describe("期限切れチケットだけを集計対象にする。"),
  custom_fields: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "カスタムフィールドでの絞り込み。例: {'カテゴリ': 'ログイン'}。",
    ),
  custom_field_match: z
    .enum(["exact", "partial"])
    .optional()
    .describe(
      "custom_fields の値のマッチング方式。デフォルト 'exact'（完全一致）。" +
        "'partial' は部分一致。リスト型 CF は選択肢から入力文字列を含むものを 1 つ特定" +
        "（例: 'ログイン' → 'ログイン機能'）、文字列型 CF は通常の部分一致。",
    ),
  parent_id: z.number().int().positive().optional(),

  // 集計指定
  group_by: z
    .array(z.string())
    .min(1)
    .describe(
      "集計軸（複数指定可、クロス集計）。" +
        "標準キー: 'assignee', 'author', 'status', 'tracker', 'priority', 'project'。" +
        "カスタムフィールドは 'cf:カテゴリ' のように 'cf:<フィールド名>' 形式。",
    ),
  metrics: z
    .array(z.enum(METRICS))
    .optional()
    .describe(
      "計算するメトリクス。デフォルト ['count']。" +
        "選択肢: count（件数）、sum_estimated_hours（見積工数合計）、sum_spent_hours（実工数合計）、avg_done_ratio（進捗率平均）。",
    ),
  sort_by: z
    .string()
    .optional()
    .describe(
      "並び順の基準（メトリクス名）。例: 'count:desc', 'sum_spent_hours:desc'。デフォルトは 'count:desc'。",
    ),
  top: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("上位 N グループだけ返す。省略時は全グループ。"),
  fetch_limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "集計のために Redmine から取得する最大チケット数。デフォルト 500。" +
        "本数が多すぎる場合は条件を絞ること。",
    ),
  export_csv: z
    .boolean()
    .optional()
    .describe(
      "true にすると集計結果（groups）を CSV ファイルとして exports/ に保存する。" +
        "「集計結果を Excel/CSV で」と言われたとき用。応答には csv_path も含まれる。",
    ),
  filename: z
    .string()
    .optional()
    .describe(
      "export_csv=true のときの出力ファイル名。省略時は aggregate_<日時>.csv。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "aggregate_issues",
    {
      title: "Redmine チケット集計（クロス集計対応）",
      description:
        "Redmine のチケットを取得 → 指定の軸でグループ化し、件数や工数の合計を計算する。" +
        "search_issues で全件取得してから LLM 側で集計するより遥かにトークン効率が良い。" +
        "「担当者別の未完了件数」「カテゴリ × 優先度のクロス集計」「バグトラッカーの工数オーバー TOP5」等に使用する。" +
        "group_by は複数指定可（クロス集計）、metrics で件数/工数/進捗率を計算、top で上位だけ返す。" +
        "source.browser_url（or fan-out 時は browser_urls）に集計対象と同じフィルタ条件をブラウザで開ける URL が入る。" +
        "ユーザーが「集計内訳を視覚的に確認したい」「同僚に元データを共有したい」ときに提示するとよい。",
      inputSchema: inputShape,
    },
    async (args) => {
      const metadata = await ctx.metadata.get();
      const params: Record<string, string | number | undefined> = {};

      // group_by のバリデーション + cf キーの ID 解決準備
      const groupKeys = args.group_by;
      const cfNameToId: Record<string, number> = {};
      for (const key of groupKeys) {
        if ((GROUP_KEYS as readonly string[]).includes(key)) continue;
        if (key.startsWith("cf:")) {
          const cfName = key.slice(3);
          const cfId = ctx.metadata.resolveCustomFieldId(cfName);
          if (!cfId) {
            return errorResult(
              `カスタムフィールド '${cfName}' が見つかりません。利用可能: ` +
                (metadata.customFieldsAvailable
                  ? metadata.customFields.map((cf) => cf.name).join(", ")
                  : "（取得失敗）"),
            );
          }
          cfNameToId[cfName] = cfId;
          continue;
        }
        return errorResult(
          `group_by '${key}' は未対応。利用可能: ${[...GROUP_KEYS].join(", ")}, 'cf:<カスタムフィールド名>'`,
        );
      }

      // Project（スコープ解決 / 厳格モード）
      const projectSelection = selectProjects(args.project, ctx);
      if (projectSelection.kind === "error") {
        return errorResult(projectSelection.message);
      }
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
          return errorResult(`ステータス '${args.status}' が見つかりません。`);
        }
        params.status_id = sid;
      }
      if (args.assigned_to) {
        params.assigned_to_id = args.assigned_to === "me" ? "me" : args.assigned_to;
      }
      if (args.tracker) {
        const tid = ctx.metadata.resolveTrackerId(args.tracker);
        if (!tid) {
          return errorResult(`トラッカー '${args.tracker}' が見つかりません。`);
        }
        params.tracker_id = tid;
      }
      if (args.subject_contains) {
        params.subject = `~${args.subject_contains}`;
      }
      const setDateRange = (
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
      setDateRange("created_on", args.created_after, args.created_before);
      setDateRange("updated_on", args.updated_after, args.updated_before);
      setDateRange("due_date", args.due_after, dueBefore);
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
      if (args.parent_id !== undefined) {
        params.parent_id = args.parent_id;
      }

      const fetchLimit = args.fetch_limit ?? 500;
      const metrics = args.metrics ?? ["count"];

      try {
        const result = await fetchIssuesForSelection(
          ctx,
          projectSelection,
          params,
          fetchLimit,
        );
        const issues = result.items;

        // グルーピング
        const groups = new Map<
          string,
          {
            keys: Record<string, string>;
            count: number;
            sumEstimated: number;
            sumSpent: number;
            sumDone: number;
            estimatedSamples: number;
            spentSamples: number;
          }
        >();
        for (const issue of issues) {
          const keyValues: Record<string, string> = {};
          for (const key of groupKeys) {
            keyValues[key] = getGroupValue(issue, key, cfNameToId);
          }
          const compositeKey = groupKeys
            .map((k) => keyValues[k])
            .join(" || ");
          let g = groups.get(compositeKey);
          if (!g) {
            g = {
              keys: keyValues,
              count: 0,
              sumEstimated: 0,
              sumSpent: 0,
              sumDone: 0,
              estimatedSamples: 0,
              spentSamples: 0,
            };
            groups.set(compositeKey, g);
          }
          g.count += 1;
          if (typeof issue.estimated_hours === "number") {
            g.sumEstimated += issue.estimated_hours;
            g.estimatedSamples += 1;
          }
          if (typeof issue.spent_hours === "number") {
            g.sumSpent += issue.spent_hours;
            g.spentSamples += 1;
          }
          g.sumDone += issue.done_ratio ?? 0;
        }

        // メトリクス計算 + ソート
        const groupArray = [...groups.values()].map((g) => {
          const row: Record<string, string | number | null> = { ...g.keys };
          for (const m of metrics) {
            switch (m) {
              case "count":
                row.count = g.count;
                break;
              case "sum_estimated_hours":
                row.sum_estimated_hours = round2(g.sumEstimated);
                break;
              case "sum_spent_hours":
                row.sum_spent_hours = round2(g.sumSpent);
                break;
              case "avg_done_ratio":
                row.avg_done_ratio = g.count > 0 ? round2(g.sumDone / g.count) : 0;
                break;
            }
          }
          return row;
        });

        const sortBy = args.sort_by ?? "count:desc";
        const [sortKey, sortDir] = sortBy.split(":");
        const dir = sortDir === "asc" ? 1 : -1;
        groupArray.sort((a, b) => {
          const av = typeof a[sortKey] === "number" ? (a[sortKey] as number) : 0;
          const bv = typeof b[sortKey] === "number" ? (b[sortKey] as number) : 0;
          return (av - bv) * dir;
        });

        const top = args.top ? groupArray.slice(0, args.top) : groupArray;

        // CSV エクスポート（任意）
        let csvInfo: { csv_path: string; relative_path: string } | undefined;
        if (args.export_csv) {
          // ヘッダ: group_by キー（cf: 接頭辞は除去）+ メトリクス名
          const header = [
            ...groupKeys.map((k) =>
              k.startsWith("cf:") ? k.slice(3) : k,
            ),
            ...metrics,
          ];
          const rows = top.map((row) => [
            ...groupKeys.map((k) => String(row[k] ?? "")),
            ...metrics.map((m) => String(row[m] ?? "")),
          ]);
          const saved = await writeCsv(
            [header, ...rows],
            args.filename,
            "aggregate",
          );
          csvInfo = {
            csv_path: saved.csvPath,
            relative_path: saved.relativePath,
          };
        }

        return jsonResult({
          source: {
            total_matched: result.total_count,
            fetched: issues.length,
            truncated: result.total_count > issues.length,
            query: params,
            scope:
              projectSelection.kind === "fanOut"
                ? { fan_out: projectSelection.identifiers }
                : undefined,
            ...browserUrlFields(ctx.client.baseUrl, projectSelection, params),
          },
          group_by: groupKeys,
          metrics,
          sort_by: sortBy,
          group_count: groupArray.length,
          groups: top,
          ...(csvInfo
            ? {
                csv_path: csvInfo.csv_path,
                relative_path: csvInfo.relative_path,
                csv_note:
                  "集計結果を CSV 出力しました。Excel で開けます（UTF-8 BOM 付き）。",
              }
            : {}),
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

function getGroupValue(
  issue: RedmineIssue,
  key: string,
  cfNameToId: Record<string, number>,
): string {
  if (key === "assignee") return issue.assigned_to?.name ?? "(未割当)";
  if (key === "author") return issue.author?.name ?? "(不明)";
  if (key === "status") return issue.status?.name ?? "(不明)";
  if (key === "tracker") return issue.tracker?.name ?? "(不明)";
  if (key === "priority") return issue.priority?.name ?? "(不明)";
  if (key === "project") return issue.project?.name ?? "(不明)";
  if (key.startsWith("cf:")) {
    const cfName = key.slice(3);
    const cfId = cfNameToId[cfName];
    const cf = issue.custom_fields?.find((c) => c.id === cfId);
    const v = cf?.value;
    if (v === undefined || v === null || v === "") return "(未設定)";
    return Array.isArray(v) ? v.join(",") : String(v);
  }
  return "(unknown)";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
