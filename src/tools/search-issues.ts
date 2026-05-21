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
import type { RedmineIssue } from "../types.js";

const inputShape = {
  project: z
    .string()
    .optional()
    .describe(
      "プロジェクト名または identifier。例: 'webapp' または 'Web アプリ'。省略すると全プロジェクト対象。",
    ),
  status: z
    .string()
    .optional()
    .describe(
      "ステータス。特殊値: 'open'（未完了すべて）, 'closed'（完了すべて）, 'all'（全件）。" +
        "個別ステータス名も可（例: '進行中', '新規'）。省略時は 'open'。",
    ),
  assigned_to: z
    .string()
    .optional()
    .describe(
      "担当者。'me'（自分）、ユーザー名、または数値 ID。'none' で未割当。",
    ),
  tracker: z
    .string()
    .optional()
    .describe("トラッカー名。例: 'バグ', '機能', 'サポート'。"),
  subject_contains: z
    .string()
    .optional()
    .describe(
      "件名で絞り込み（部分一致）。" +
        "Redmine の標準フィールド subject に対応。" +
        "ユーザーが「件名」「題名」「タイトル」「サマリ」と言ったらこれ。",
    ),
  description_contains: z
    .string()
    .optional()
    .describe(
      "説明文（チケット本文）で絞り込み（部分一致）。" +
        "Redmine の標準フィールド description に対応。" +
        "ユーザーが「説明」「内容」「本文」「詳細」「概要」「中身」と言ったら基本これ" +
        "（会社の Redmine では GUI 上のラベルが「内容」等にカスタマイズされていることがある）。" +
        "ただし describe_schema のカスタムフィールド一覧に同名のフィールドがある場合は、" +
        "そちらは custom_fields で指定すること。" +
        "「本文に『決定事項』と書かれているチケット」のような検索に使う。",
    ),
  notes_contains: z
    .string()
    .optional()
    .describe(
      "コメント（注記・履歴のコメント）で絞り込み（部分一致）。" +
        "Redmine の journals に対応。" +
        "ユーザーが「コメント」「注記」「やりとり」「履歴のコメント」と言ったらこれ。" +
        "「『再現しません』とコメントされたチケット」のような検索に使う。",
    ),
  created_after: z
    .string()
    .optional()
    .describe("作成日がこの日付以降（YYYY-MM-DD）。"),
  created_before: z
    .string()
    .optional()
    .describe("作成日がこの日付以前（YYYY-MM-DD）。"),
  updated_after: z
    .string()
    .optional()
    .describe("更新日がこの日付以降（YYYY-MM-DD）。"),
  updated_before: z
    .string()
    .optional()
    .describe("更新日がこの日付以前（YYYY-MM-DD）。"),
  custom_fields: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "カスタムフィールドの絞り込み。フィールド名（日本語可）→ 値 のマップ。" +
        "例: {'カテゴリ': 'ログイン', '緊急度': '高'}。" +
        "list_custom_fields または describe_schema で利用可能なフィールドを確認できる。",
    ),
  custom_field_match: z
    .enum(["exact", "partial"])
    .optional()
    .describe(
      "custom_fields の値のマッチング方式。デフォルト 'exact'（完全一致）。" +
        "'partial' は部分一致。リスト型 CF（選択肢あり）では、選択肢の中から" +
        "入力文字列を含むものを 1 つ特定して使う（例: 'ログイン' → 'ログイン機能'）。" +
        "複数候補にマッチ／該当なしの場合は候補を提示するエラーになるので、絞り直すこと。" +
        "文字列・テキスト型 CF では通常の部分一致になる。",
    ),
  due_after: z
    .string()
    .optional()
    .describe("期日がこの日付以降（YYYY-MM-DD）。"),
  due_before: z
    .string()
    .optional()
    .describe("期日がこの日付以前（YYYY-MM-DD）。"),
  overdue: z
    .boolean()
    .optional()
    .describe(
      "期限切れ（due_date < 今日 かつ 未完了）のチケットだけ返す。" +
        "true 指定時は status を自動で 'open' に強制、due_before を今日に設定する。" +
        "他のフィルタ（project, tracker, custom_fields 等）と併用可。",
    ),
  parent_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "親チケットの ID。指定すると、その親チケットの子チケットだけを返す。" +
        "バグチケット配下の修正タスクを列挙する用途。",
    ),
  sort: z
    .string()
    .optional()
    .describe(
      "並び順。例: 'updated_on:desc', 'priority:desc', 'spent_hours:desc', 'due_date:asc'。" +
        "複合可: 'priority:desc,due_date:asc'。デフォルト 'updated_on:desc'。",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("取得件数の上限。デフォルト 50、最大 500。"),
  count_only: z
    .boolean()
    .optional()
    .describe(
      "true にすると issues 配列を返さず total_count とクエリ情報だけ返す。" +
        "「件数だけ知りたい」「ヒット数を見て条件を絞り込みたい」とき用。トークン大幅節約。",
    ),
};

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "search_issues",
    {
      title: "Redmine チケット検索",
      description:
        "Redmine のチケットを柔軟な条件で検索する。" +
        "プロジェクト、ステータス、担当者、トラッカー、カスタムフィールド（カテゴリなど）、" +
        "作成日・更新日・期日の範囲で絞り込み可能。" +
        "「未完了のチケット一覧」「特定機能のバグ一覧」「先週更新されたもの」「期限切れチケット」などに使用する。" +
        "結果には estimated_hours / spent_hours（見積/実工数）も含まれるので、工数オーバー分析にも使える（sort='spent_hours:desc' 等）。" +
        "結果は要約情報のみ返すので、詳細が必要なチケットは get_issue で取得すること。" +
        "カスタムフィールド名は日本語のまま指定でき、内部で ID に解決される。" +
        "overdue=true で期限切れ抽出、parent_id で親チケット配下の子チケット列挙、count_only=true で件数だけ取得（トークン節約）が可能。" +
        "各チケットの応答に parent_id が含まれる（値があれば子チケット、null なら親チケット）。" +
        "各チケットの url フィールドにブラウザで開けるリンクが含まれているので、リンク提示の際はこれをそのまま使うこと（ベース URL を別途ユーザーに尋ねる必要はない）。",
      inputSchema: inputShape,
    },
    async (args) => {
      const metadata = await ctx.metadata.get();
      const params: Record<string, string | number | undefined> = {};

      // Project（スコープ解決 / 厳格モード）
      const projectSelection = selectProjects(args.project, ctx);
      if (projectSelection.kind === "error") {
        return errorResult(projectSelection.message);
      }

      // Overdue は status="open" を強制し、due_before を今日にする
      let dueBefore = args.due_before;
      if (args.overdue) {
        if (
          args.status &&
          args.status !== "open" &&
          args.status !== undefined
        ) {
          return errorResult(
            "overdue=true は status='open' とのみ併用可能です。status を省略するか 'open' を指定してください。",
          );
        }
        const today = localDateString();
        dueBefore = dueBefore && dueBefore < today ? dueBefore : today;
      }

      // Status
      if (args.status === undefined || args.status === "open" || args.overdue) {
        params.status_id = "open";
      } else if (args.status === "closed") {
        params.status_id = "closed";
      } else if (args.status === "all" || args.status === "*") {
        params.status_id = "*";
      } else {
        const statusId = ctx.metadata.resolveStatusId(args.status);
        if (!statusId) {
          return errorResult(
            `ステータス '${args.status}' が見つかりません。` +
              `利用可能: ${metadata.statuses.map((s) => s.name).join(", ")}`,
          );
        }
        params.status_id = statusId;
      }

      // Assigned to
      if (args.assigned_to) {
        if (args.assigned_to === "me") {
          params.assigned_to_id = "me";
        } else if (args.assigned_to === "none") {
          params.assigned_to_id = "!*";
        } else if (/^\d+$/.test(args.assigned_to)) {
          params.assigned_to_id = args.assigned_to;
        } else {
          // Try resolving by name via users endpoint
          try {
            const users = await ctx.client.listUsers(500);
            const needle = args.assigned_to.trim().toLowerCase();
            const user = users.items.find((u) => {
              const full = `${u.lastname} ${u.firstname}`.toLowerCase();
              const reversed = `${u.firstname} ${u.lastname}`.toLowerCase();
              return (
                u.login?.toLowerCase() === needle ||
                full === needle ||
                reversed === needle ||
                full.includes(needle) ||
                reversed.includes(needle)
              );
            });
            if (!user) {
              return errorResult(
                `担当者 '${args.assigned_to}' が見つかりません。`,
              );
            }
            params.assigned_to_id = user.id;
          } catch (err) {
            // listing users may require admin; fall back to passing the
            // string and letting Redmine try (it may match login).
            params.assigned_to_id = args.assigned_to;
          }
        }
      }

      // Tracker
      if (args.tracker) {
        const id = ctx.metadata.resolveTrackerId(args.tracker);
        if (!id) {
          return errorResult(
            `トラッカー '${args.tracker}' が見つかりません。` +
              `利用可能: ${metadata.trackers.map((t) => t.name).join(", ")}`,
          );
        }
        params.tracker_id = id;
      }

      // Text 部分一致（Redmine は `field=~keyword` で LIKE 検索）
      if (args.subject_contains) {
        params.subject = `~${args.subject_contains}`;
      }
      if (args.description_contains) {
        params.description = `~${args.description_contains}`;
      }
      if (args.notes_contains) {
        params.notes = `~${args.notes_contains}`;
      }

      // Date filters
      if (args.created_after || args.created_before) {
        const after = args.created_after ?? "";
        const before = args.created_before ?? "";
        if (after && before) {
          params.created_on = `><${after}|${before}`;
        } else if (after) {
          params.created_on = `>=${after}`;
        } else if (before) {
          params.created_on = `<=${before}`;
        }
      }
      if (args.updated_after || args.updated_before) {
        const after = args.updated_after ?? "";
        const before = args.updated_before ?? "";
        if (after && before) {
          params.updated_on = `><${after}|${before}`;
        } else if (after) {
          params.updated_on = `>=${after}`;
        } else if (before) {
          params.updated_on = `<=${before}`;
        }
      }
      if (args.due_after || dueBefore) {
        const after = args.due_after ?? "";
        const before = dueBefore ?? "";
        if (after && before) {
          params.due_date = `><${after}|${before}`;
        } else if (after) {
          params.due_date = `>=${after}`;
        } else if (before) {
          params.due_date = `<=${before}`;
        }
      }

      // Parent issue filter
      if (args.parent_id !== undefined) {
        params.parent_id = args.parent_id;
      }

      // Custom fields
      if (args.custom_fields) {
        const partial = args.custom_field_match === "partial";
        const unresolved: string[] = [];
        for (const [name, value] of Object.entries(args.custom_fields)) {
          const id = ctx.metadata.resolveCustomFieldId(name);
          if (!id) {
            unresolved.push(name);
            continue;
          }
          // partial 指定時はリスト型/文字列型に応じて値を解決する
          const cfDef = metadata.customFields.find((c) => c.id === id);
          const resolved = resolveCfFilterValue(cfDef, value, partial);
          if (!resolved.ok) {
            return errorResult(resolved.error);
          }
          params[`cf_${id}`] = resolved.value;
        }
        if (unresolved.length > 0) {
          if (!metadata.customFieldsAvailable) {
            return errorResult(
              `カスタムフィールド情報を取得できていません: ${metadata.customFieldsError ?? "不明"}。` +
                `フィールド名→ID 解決ができないため、custom_fields での絞り込みは使用できません。`,
            );
          }
          return errorResult(
            `カスタムフィールド ${unresolved.map((n) => `'${n}'`).join(", ")} が見つかりません。` +
              `利用可能: ${metadata.customFields.map((cf) => cf.name).join(", ")}`,
          );
        }
      }

      const sortSpec = args.sort ?? "updated_on:desc";
      params.sort = sortSpec;

      // count_only: 件数だけ返す（最小ペイロード）
      if (args.count_only) {
        try {
          const result = await fetchIssuesForSelection(
            ctx,
            projectSelection,
            params,
            1,
          );
          return jsonResult({
            total_count: result.total_count,
            query: params,
            scope:
              projectSelection.kind === "fanOut"
                ? { fan_out: projectSelection.identifiers }
                : undefined,
            hint:
              result.total_count === 0
                ? zeroResultHint(params)
                : undefined,
          });
        } catch (err) {
          if (err instanceof RedmineApiError) {
            return errorResult(err.message, err.body);
          }
          throw err;
        }
      }

      const limit = args.limit ?? 50;

      try {
        const result = await fetchIssuesForSelection(
          ctx,
          projectSelection,
          params,
          limit,
        );
        // fan-out 時は各プロジェクトから limit 件ずつ取得されているのでマージ後に再ソート＆切り詰め
        let items = result.items;
        if (projectSelection.kind === "fanOut") {
          items = sortIssuesBySpec(items, sortSpec).slice(0, limit);
        }
        const baseUrl = ctx.client.baseUrl;
        const trimmed = items.map((i) => trimIssueForList(i, baseUrl));
        return jsonResult({
          total_count: result.total_count,
          returned: trimmed.length,
          query: params,
          scope:
            projectSelection.kind === "fanOut"
              ? { fan_out: projectSelection.identifiers }
              : undefined,
          issues: trimmed,
          hint:
            result.total_count === 0
              ? zeroResultHint(params)
              : result.total_count > trimmed.length
                ? `${result.total_count} 件中 ${trimmed.length} 件を返却。limit を増やすか条件を絞り込んでください。`
                : undefined,
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

/**
 * 0 件ヒット時の、文脈に応じた再検索ガイド。
 * カスタムフィールド絞り込みの有無などでヒント内容を変える。
 */
function zeroResultHint(
  params: Record<string, string | number | undefined>,
): string {
  const usedCustomField = Object.keys(params).some((k) =>
    k.startsWith("cf_"),
  );
  const usedTextFilter =
    params.subject !== undefined ||
    params.description !== undefined ||
    params.notes !== undefined;

  if (usedCustomField) {
    return (
      "0 件ヒットしました。カスタムフィールドの値は既定で完全一致です。" +
      "指定した値が選択肢と完全一致していない可能性があります。" +
      "custom_field_match: 'partial' を指定して再検索するか、" +
      "quick_search でキーワードを全文検索してみてください。"
    );
  }
  if (usedTextFilter) {
    return (
      "0 件ヒットしました。件名・本文・コメントの部分一致で見つからない場合は、" +
      "quick_search（全文検索）でキーワードを単語単位で探すと見つかることがあります。"
    );
  }
  return (
    "0 件ヒットしました。条件が厳しすぎる可能性があります。" +
    "条件を緩めるか、キーワードで探すなら quick_search を試してください。"
  );
}

function trimIssueForList(issue: RedmineIssue, baseUrl: string) {
  return {
    id: issue.id,
    url: `${baseUrl}/issues/${issue.id}`,
    subject: issue.subject,
    project: issue.project?.name,
    tracker: issue.tracker?.name,
    status: issue.status?.name,
    priority: issue.priority?.name,
    parent_id: issue.parent?.id ?? null,
    assigned_to: issue.assigned_to?.name,
    author: issue.author?.name,
    done_ratio: issue.done_ratio,
    estimated_hours: issue.estimated_hours ?? null,
    spent_hours: issue.spent_hours ?? null,
    start_date: issue.start_date,
    due_date: issue.due_date,
    created_on: issue.created_on,
    updated_on: issue.updated_on,
    closed_on: issue.closed_on ?? null,
    custom_fields: issue.custom_fields?.map((cf) => ({
      name: cf.name,
      value: cf.value,
    })),
  };
}
