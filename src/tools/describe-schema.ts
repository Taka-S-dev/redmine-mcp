import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, type ToolContext } from "./context.js";

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "describe_schema",
    {
      title: "Redmine スキーマ全体取得",
      description:
        "この Redmine インスタンスで利用可能な" +
        "プロジェクト・トラッカー・ステータス・カスタムフィールドを一括で返す。" +
        "セッション開始時に1回呼び出すと、以降の検索で何を指定できるかが分かる。" +
        "個別取得したい場合は list_projects / list_custom_fields を使う。",
      inputSchema: {},
    },
    async () => {
      const metadata = await ctx.metadata.get();
      const scope = ctx.metadata.projectScope;
      return jsonResult({
        fetched_at: metadata.fetchedAt,
        project_scope: scope
          ? {
              enabled: true,
              mode: "strict",
              identifiers: scope,
              note:
                "REDMINE_PROJECTS で設定されたプロジェクトのみが表示・問い合わせ対象。" +
                "スコープ外プロジェクトを指定するとツールはエラーを返す。" +
                "project 引数省略時は、スコープ内全プロジェクトに自動的に問い合わせる（fan-out）。",
            }
          : { enabled: false },
        projects: metadata.projects.map((p) => ({
          id: p.id,
          identifier: p.identifier,
          name: p.name,
        })),
        trackers: metadata.trackers.map((t) => ({
          id: t.id,
          name: t.name,
        })),
        statuses: metadata.statuses.map((s) => ({
          id: s.id,
          name: s.name,
          is_closed: s.is_closed,
        })),
        custom_fields: metadata.customFieldsAvailable
          ? metadata.customFields.map((cf) => ({
              id: cf.id,
              name: cf.name,
              field_format: cf.field_format,
              possible_values: cf.possible_values?.map((v) => v.value),
            }))
          : {
              available: false,
              reason: metadata.customFieldsError,
              note:
                "カスタムフィールド一覧は管理者権限が必要。" +
                "search_issues の custom_fields 指定は ID 解決ができないため使用不可。",
            },
        activities: metadata.activitiesAvailable
          ? metadata.activities.map((a) => ({
              id: a.id,
              name: a.name,
              is_default: a.is_default,
            }))
          : {
              available: false,
              reason: metadata.activitiesError,
              note: "Activity（工数の作業分類）一覧の取得に失敗。list_time_entries の activity 指定は名前解決できない。",
            },
      });
    },
  );
}
