import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult, type ToolContext } from "./context.js";

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "list_projects",
    {
      title: "プロジェクト一覧",
      description:
        "Redmine のプロジェクト一覧を返す。" +
        "search_issues の project パラメータに渡せる name / identifier を確認するのに使う。",
      inputSchema: {},
    },
    async () => {
      const metadata = await ctx.metadata.get();
      return jsonResult({
        count: metadata.projects.length,
        fetched_at: metadata.fetchedAt,
        projects: metadata.projects.map((p) => ({
          id: p.id,
          identifier: p.identifier,
          name: p.name,
          parent: p.parent?.name,
          description: p.description?.slice(0, 200),
        })),
      });
    },
  );
}
