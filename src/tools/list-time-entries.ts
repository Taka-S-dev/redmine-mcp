import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineApiError } from "../redmine/client.js";
import {
  jsonResult,
  errorResult,
  selectProjects,
  type ToolContext,
} from "./context.js";
import { writeCsv } from "./csv.js";
import type { RedmineTimeEntry } from "../types.js";

const inputShape = {
  issue_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("特定チケットの工数だけを取得。"),
  parent_issue_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "親チケット ID。指定すると、その親の子チケット全件分の工数を集計する。" +
        "「親チケット #500 配下の作業工数は誰が何時間？」のような用途。" +
        "親自身のチケットに直接記録された工数は含めない（必要なら別途 issue_id で）。",
    ),
  project: z
    .string()
    .optional()
    .describe("プロジェクト名または identifier。"),
  user: z
    .string()
    .optional()
    .describe("ユーザー。'me'（自分）または数値ユーザー ID。"),
  activity: z
    .string()
    .optional()
    .describe(
      "作業分類名（例: '実装', 'テスト'）または数値 ID。describe_schema の activities で利用可能な値を確認できる。",
    ),
  spent_after: z
    .string()
    .optional()
    .describe("作業日がこの日付以降（YYYY-MM-DD）。"),
  spent_before: z
    .string()
    .optional()
    .describe("作業日がこの日付以前（YYYY-MM-DD）。"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("取得件数の上限。デフォルト 200、最大 1000。"),
  return_entries: z
    .boolean()
    .optional()
    .describe(
      "個別エントリを含めて返すか。デフォルト true。集計だけ欲しいときは false にするとトークン大幅節約。",
    ),
  export_csv: z
    .boolean()
    .optional()
    .describe(
      "true にすると工数エントリを CSV ファイルとして exports/ に保存する。" +
        "「工数を Excel/CSV で」と言われたとき用。応答には csv_path も含まれる。",
    ),
  filename: z
    .string()
    .optional()
    .describe(
      "export_csv=true のときの出力ファイル名。省略時は time_entries_<日時>.csv。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_time_entries",
    {
      title: "工数（時間エントリ）取得・集計",
      description:
        "Redmine の工数（time entries）を取得し、ユーザー別・チケット別・作業分類別に集計する。" +
        "親チケットの ID を渡すと、その子チケット全件の工数を一括集計（親子チケットでの工数管理に最適）。" +
        "ユーザー・期間・プロジェクト・作業分類で絞り込み可能。" +
        "出力には total_hours と by_user / by_issue / by_activity ロールアップが含まれる。" +
        "「親チケット #500 配下の総工数」「先月のカテゴリ別工数」「私の今月の稼働」等に使用する。",
      inputSchema: inputShape,
    },
    async (args) => {
      // メタ情報をロードしてから scope 解決へ
      await ctx.metadata.get();
      const params: Record<string, string | number | undefined> = {};

      // Project（スコープ解決 / 厳格モード）
      const projectSelection = selectProjects(args.project, ctx);
      if (projectSelection.kind === "error") {
        return errorResult(projectSelection.message);
      }

      // User
      if (args.user) {
        if (args.user === "me") {
          params.user_id = "me";
        } else if (/^\d+$/.test(args.user)) {
          params.user_id = args.user;
        } else {
          return errorResult(
            "user には 'me' または数値ユーザー ID を指定してください（ユーザー名解決は未対応）。",
          );
        }
      }

      // Activity
      if (args.activity) {
        if (/^\d+$/.test(args.activity)) {
          params.activity_id = args.activity;
        } else {
          const id = ctx.metadata.resolveActivityId(args.activity);
          if (!id) {
            const meta = await ctx.metadata.get();
            const available = meta.activitiesAvailable
              ? meta.activities.map((a) => a.name).join(", ")
              : "（取得失敗）";
            return errorResult(
              `Activity '${args.activity}' が見つかりません。利用可能: ${available}`,
            );
          }
          params.activity_id = id;
        }
      }

      // Date filters (spent_on)
      if (args.spent_after || args.spent_before) {
        const after = args.spent_after ?? "";
        const before = args.spent_before ?? "";
        if (after && before) {
          params.spent_on = `><${after}|${before}`;
        } else if (after) {
          params.spent_on = `>=${after}`;
        } else if (before) {
          params.spent_on = `<=${before}`;
        }
      }

      const limit = args.limit ?? 200;
      const returnEntries = args.return_entries ?? true;

      try {
        let allEntries: RedmineTimeEntry[] = [];

        if (args.parent_issue_id) {
          // 親チケットの子チケット ID を取得
          const children = await ctx.client.listIssues(
            { parent_id: args.parent_issue_id, status_id: "*" },
            500,
          );
          if (children.items.length === 0) {
            return jsonResult({
              parent_issue_id: args.parent_issue_id,
              child_count: 0,
              total_count: 0,
              total_hours: 0,
              by_user: {},
              by_issue: {},
              by_activity: {},
              entries: returnEntries ? [] : undefined,
              note: "親チケットに子チケットが見つかりませんでした。",
            });
          }

          // 各子チケットの工数を並列取得
          const perChild = await Promise.all(
            children.items.map((c) =>
              ctx.client.listTimeEntries(
                { ...params, issue_id: c.id },
                limit,
              ),
            ),
          );
          allEntries = perChild.flatMap((r) => r.items);
        } else if (args.issue_id) {
          const result = await ctx.client.listTimeEntries(
            { ...params, issue_id: args.issue_id },
            limit,
          );
          allEntries = result.items;
        } else if (projectSelection.kind === "single") {
          const result = await ctx.client.listTimeEntries(
            { ...params, project_id: projectSelection.identifier },
            limit,
          );
          allEntries = result.items;
        } else if (projectSelection.kind === "fanOut") {
          const perProject = await Promise.all(
            projectSelection.identifiers.map((pid) =>
              ctx.client.listTimeEntries(
                { ...params, project_id: pid },
                limit,
              ),
            ),
          );
          allEntries = perProject.flatMap((r) => r.items);
        } else {
          // unscoped
          const result = await ctx.client.listTimeEntries(params, limit);
          allEntries = result.items;
        }

        // ロールアップ
        const byUser: Record<string, number> = {};
        const byIssue: Record<string, number> = {};
        const byActivity: Record<string, number> = {};
        let totalHours = 0;

        for (const e of allEntries) {
          const userName = e.user?.name ?? "(unknown)";
          const issueKey = e.issue?.id ? String(e.issue.id) : "(no issue)";
          const activityName = e.activity?.name ?? "(unknown)";
          byUser[userName] = round2((byUser[userName] ?? 0) + e.hours);
          byIssue[issueKey] = round2((byIssue[issueKey] ?? 0) + e.hours);
          byActivity[activityName] = round2(
            (byActivity[activityName] ?? 0) + e.hours,
          );
          totalHours += e.hours;
        }
        totalHours = round2(totalHours);

        const baseUrl = ctx.client.baseUrl;
        const entries = returnEntries
          ? allEntries.map((e) => ({
              id: e.id,
              hours: e.hours,
              user: e.user?.name,
              issue_id: e.issue?.id ?? null,
              issue_url: e.issue?.id ? `${baseUrl}/issues/${e.issue.id}` : null,
              project: e.project?.name,
              activity: e.activity?.name,
              spent_on: e.spent_on,
              comments: e.comments,
            }))
          : undefined;

        // CSV エクスポート（任意）
        let csvInfo: { csv_path: string; relative_path: string } | undefined;
        if (args.export_csv) {
          const header = [
            "id",
            "spent_on",
            "hours",
            "user",
            "activity",
            "issue_id",
            "issue_url",
            "project",
            "comments",
          ];
          const rows = allEntries.map((e) => [
            String(e.id),
            e.spent_on ?? "",
            String(e.hours),
            e.user?.name ?? "",
            e.activity?.name ?? "",
            e.issue?.id != null ? String(e.issue.id) : "",
            e.issue?.id != null ? `${ctx.client.baseUrl}/issues/${e.issue.id}` : "",
            e.project?.name ?? "",
            e.comments ?? "",
          ]);
          const saved = await writeCsv(
            [header, ...rows],
            args.filename,
            "time_entries",
          );
          csvInfo = {
            csv_path: saved.csvPath,
            relative_path: saved.relativePath,
          };
        }

        return jsonResult({
          parent_issue_id: args.parent_issue_id,
          scope:
            projectSelection.kind === "fanOut"
              ? { fan_out: projectSelection.identifiers }
              : undefined,
          total_count: allEntries.length,
          total_hours: totalHours,
          by_user: byUser,
          by_issue: byIssue,
          by_activity: byActivity,
          entries,
          ...(csvInfo
            ? {
                csv_path: csvInfo.csv_path,
                relative_path: csvInfo.relative_path,
                csv_note:
                  "工数エントリを CSV 出力しました。Excel で開けます（UTF-8 BOM 付き）。",
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
