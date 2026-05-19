import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineApiError } from "../redmine/client.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";

const inputShape = {
  id: z.number().int().positive().describe("チケット ID（数値）。"),
  include: z
    .array(
      z.enum([
        "journals",
        "relations",
        "children",
        "attachments",
        "changesets",
        "watchers",
      ]),
    )
    .optional()
    .describe(
      "追加で取得する関連情報。" +
        "デフォルト: ['journals', 'relations', 'children', 'attachments']。" +
        "バグの原因分析では journals（コメント履歴）と relations（関連チケット）が特に重要。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "get_issue",
    {
      title: "Redmine チケット詳細取得",
      description:
        "Redmine のチケット 1 件の詳細を取得する。" +
        "コメント履歴（journals）・関連チケット（relations）・子チケット・添付ファイルを含む。" +
        "バグチケットの原因分析を行う際は、このツールで詳細を取得して description と journals を読み解くこと。" +
        "search_issues で見つけたチケットの深掘りに使う。" +
        "応答の url フィールドにブラウザで開けるリンクが含まれる。",
      inputSchema: inputShape,
    },
    async (args) => {
      const include = args.include ?? [
        "journals",
        "relations",
        "children",
        "attachments",
      ];
      try {
        const issue = await ctx.client.getIssue(args.id, include);
        return jsonResult({
          url: ctx.client.issueUrl(issue.id),
          ...issue,
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
