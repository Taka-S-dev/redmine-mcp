import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, type ToolContext } from "./context.js";

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "refresh_metadata",
    {
      title: "メタ情報の再取得",
      description:
        "プロジェクト・トラッカー・ステータス・カスタムフィールドのキャッシュを破棄して再取得する。" +
        "Redmine 側で新しいカスタムフィールドや選択肢を追加した直後に呼び出すと、" +
        "MCP サーバーを再起動せずに反映できる。",
      inputSchema: {},
    },
    async () => {
      const metadata = await ctx.metadata.refresh();
      return jsonResult({
        refreshed_at: metadata.fetchedAt,
        counts: {
          projects: metadata.projects.length,
          trackers: metadata.trackers.length,
          statuses: metadata.statuses.length,
          custom_fields: metadata.customFields.length,
          activities: metadata.activities.length,
        },
        custom_fields_available: metadata.customFieldsAvailable,
        custom_fields_source: metadata.customFieldsSource,
        custom_fields_error: metadata.customFieldsError,
        activities_available: metadata.activitiesAvailable,
        activities_error: metadata.activitiesError,
      });
    },
  );
}
