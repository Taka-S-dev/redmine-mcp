import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_custom_fields",
    {
      title: "カスタムフィールド一覧",
      description:
        "Redmine で定義されているカスタムフィールドの一覧を返す。" +
        "search_issues の custom_fields パラメータで使えるフィールド名と、" +
        "選択肢型のフィールドであれば possible_values（選択可能な値）も取得できる。" +
        "「カテゴリにはどんな選択肢があるか」を知りたいときなどに使用。",
      inputSchema: {},
    },
    async () => {
      const metadata = await ctx.metadata.get();
      if (!metadata.customFieldsAvailable) {
        return errorResult(
          `カスタムフィールド一覧の取得に失敗しています（Redmine 管理者権限が必要）: ${metadata.customFieldsError ?? "不明"}`,
        );
      }
      return jsonResult({
        count: metadata.customFields.length,
        fetched_at: metadata.fetchedAt,
        custom_fields: metadata.customFields.map((cf) => ({
          id: cf.id,
          name: cf.name,
          field_format: cf.field_format,
          customized_type: cf.customized_type,
          is_required: cf.is_required,
          is_filter: cf.is_filter,
          multiple: cf.multiple,
          possible_values: cf.possible_values?.map((v) => v.value),
          trackers: cf.trackers?.map((t) => t.name),
        })),
      });
    },
  );
}
