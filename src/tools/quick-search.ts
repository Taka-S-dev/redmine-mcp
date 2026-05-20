import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineApiError } from "../redmine/client.js";
import { jsonResult, errorResult, type ToolContext } from "./context.js";
import type { RedmineSearchResult } from "../types.js";

const inputShape = {
  query: z
    .string()
    .min(1)
    .describe(
      "検索キーワード。スペース区切りで複数語を指定でき、件名・本文・コメントを横断して" +
        "単語単位でマッチする。曖昧な指示（『ログイン関連』『決済のエラー』など）に強い。",
    ),
  project: z
    .string()
    .optional()
    .describe(
      "プロジェクト名または identifier。指定するとそのプロジェクト配下に限定。" +
        "省略時はスコープ設定があればスコープ内、なければ全体を検索。",
    ),
  open_only: z
    .boolean()
    .optional()
    .describe("true で未完了チケットのみに絞る。デフォルト false（全件対象）。"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("取得件数の上限。デフォルト 50。"),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "quick_search",
    {
      title: "Redmine 全文検索（曖昧キーワード検索）",
      description:
        "Redmine の全文検索 API を使い、キーワードで件名・本文・コメントを横断検索する。" +
        "スペース区切りの複数語を単語単位でマッチするため、" +
        "『ログイン関連のチケット』『決済まわりのエラー』のような曖昧な指示に強い。" +
        "条件を厳密に指定したい場合（ステータス・担当者・期間で絞る等）は search_issues を使うこと。" +
        "結果は概要のみなので、詳細が必要なら get_issue で深掘りする。",
      inputSchema: inputShape,
    },
    async (args) => {
      // メタ情報をロード（スコープ解決のため）
      await ctx.metadata.get();
      const limit = args.limit ?? 50;

      // プロジェクト解決
      let projectIdentifiers: (string | undefined)[] = [undefined];
      if (args.project) {
        const id = ctx.metadata.resolveProjectIdentifier(args.project);
        if (!id) {
          const scope = ctx.client.projectScope;
          return errorResult(
            scope
              ? `プロジェクト '${args.project}' はスコープ外、または存在しません。利用可能: ${scope.join(", ")}`
              : `プロジェクト '${args.project}' が見つかりません。`,
          );
        }
        projectIdentifiers = [id];
      } else {
        // スコープ設定時は各プロジェクトを検索してマージ
        const effective = ctx.metadata.getEffectiveScope();
        if (effective && effective.length > 0) {
          projectIdentifiers = effective;
        }
      }

      try {
        const seen = new Set<number>();
        const merged: RedmineSearchResult[] = [];
        let totalCount = 0;

        for (const projectIdentifier of projectIdentifiers) {
          const result = await ctx.client.search(args.query, {
            projectIdentifier,
            openIssuesOnly: args.open_only,
            maxItems: limit,
          });
          totalCount += result.total_count;
          for (const r of result.items) {
            if (seen.has(r.id)) continue;
            seen.add(r.id);
            merged.push(r);
          }
        }

        const trimmed = merged.slice(0, limit).map((r) => ({
          id: r.id,
          title: r.title,
          url: r.url,
          snippet: r.description?.slice(0, 200),
          datetime: r.datetime,
        }));

        return jsonResult({
          query: args.query,
          total_count: totalCount,
          returned: trimmed.length,
          results: trimmed,
          hint:
            totalCount === 0
              ? "0 件ヒットしました。キーワードを減らす（1 語にする）、別の言い回しにする、" +
                "または漢字・カタカナ表記を変えて再検索してみてください。" +
                "ステータスや担当者など条件が明確なら search_issues も検討。"
              : "結果は全文検索の概要。チケット詳細は get_issue、条件で厳密に絞るなら search_issues を使う。",
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
