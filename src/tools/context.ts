import type { RedmineClient } from "../redmine/client.js";
import type { MetadataCache } from "../redmine/metadata.js";
import type { RedmineIssue } from "../types.js";

export interface ToolContext {
  client: RedmineClient;
  metadata: MetadataCache;
}

/**
 * project 引数のスコープ解決結果。
 *
 * - `single`: 1 つの project_id だけを指定して問い合わせる
 * - `fanOut`: 複数プロジェクトに並列問い合わせし、結果をマージする
 * - `unscoped`: project_id フィルタなし（全プロジェクト対象）
 * - `error`: スコープ外プロジェクトを指定された等
 */
export type ProjectSelection =
  | { kind: "single"; identifier: string }
  | { kind: "fanOut"; identifiers: string[] }
  | { kind: "unscoped" }
  | { kind: "error"; message: string };

/**
 * project 引数とスコープ設定から、どのように問い合わせるかを決定する。
 * 厳格モード（projectScope 設定済み）では、スコープ外プロジェクトはエラー。
 */
export function selectProjects(
  input: string | undefined,
  ctx: ToolContext,
): ProjectSelection {
  const configScope = ctx.client.projectScope;
  const effectiveScope = ctx.metadata.getEffectiveScope();

  if (input) {
    const identifier = ctx.metadata.resolveProjectIdentifier(input);
    if (!identifier) {
      if (configScope) {
        return {
          kind: "error",
          message:
            `プロジェクト '${input}' はスコープ外、または存在しません。` +
            `利用可能（REDMINE_PROJECTS で設定されたもの）: ${configScope.join(", ")}`,
        };
      }
      return {
        kind: "error",
        message: `プロジェクト '${input}' が見つかりません。list_projects で確認してください。`,
      };
    }
    return { kind: "single", identifier };
  }

  // 省略時
  if (!configScope) {
    return { kind: "unscoped" };
  }
  // 設定されたスコープのうち Redmine に実在するものだけを使う
  if (!effectiveScope || effectiveScope.length === 0) {
    return {
      kind: "error",
      message:
        `REDMINE_PROJECTS で設定された [${configScope.join(", ")}] のうち、` +
        `Redmine に実在するプロジェクトがありません。identifier の綴りを確認してください。`,
    };
  }
  if (effectiveScope.length === 1) {
    return { kind: "single", identifier: effectiveScope[0] };
  }
  return { kind: "fanOut", identifiers: effectiveScope };
}

/**
 * スコープ設定を考慮した listIssues 呼び出し。
 * 単一プロジェクト or fan-out 並列取得 or フィルタなし の 3 パターンを吸収する。
 *
 * fan-out 時は、各プロジェクトに同じ params で並列クエリし、items を結合した
 * 単一の結果として返す。total_count は各プロジェクトの合計。
 */
export async function fetchIssuesForSelection(
  ctx: ToolContext,
  selection: Exclude<ProjectSelection, { kind: "error" }>,
  baseParams: Record<string, string | number | undefined>,
  perCallLimit: number,
): Promise<{ total_count: number; items: RedmineIssue[]; fan_out_count?: number }> {
  if (selection.kind === "single") {
    const r = await ctx.client.listIssues(
      { ...baseParams, project_id: selection.identifier },
      perCallLimit,
    );
    return { total_count: r.total_count, items: r.items };
  }
  if (selection.kind === "unscoped") {
    const r = await ctx.client.listIssues(baseParams, perCallLimit);
    return { total_count: r.total_count, items: r.items };
  }
  // fanOut
  const results = await Promise.all(
    selection.identifiers.map((pid) =>
      ctx.client.listIssues({ ...baseParams, project_id: pid }, perCallLimit),
    ),
  );
  return {
    total_count: results.reduce((s, r) => s + r.total_count, 0),
    items: results.flatMap((r) => r.items),
    fan_out_count: selection.identifiers.length,
  };
}

/**
 * fan-out 後のマージ済み issues を sort 仕様に従って再ソートする。
 * sort 仕様は 'field:direction' 形式。デフォルト desc。
 * 複合キー（'a:desc,b:asc'）にも対応。
 */
export function sortIssuesBySpec(
  issues: RedmineIssue[],
  spec: string,
): RedmineIssue[] {
  const keys = spec.split(",").map((s) => {
    const [field, dir] = s.split(":");
    return { field: field.trim(), ascending: (dir ?? "desc").trim() !== "desc" };
  });

  const get = (issue: RedmineIssue, field: string): unknown => {
    const record = issue as unknown as Record<string, unknown>;
    if (
      field === "priority" ||
      field === "status" ||
      field === "tracker" ||
      field === "assigned_to" ||
      field === "author" ||
      field === "project"
    ) {
      const ref = record[field] as { name?: string } | undefined;
      return ref?.name;
    }
    return record[field];
  };

  return [...issues].sort((a, b) => {
    for (const { field, ascending } of keys) {
      const av = get(a, field);
      const bv = get(b, field);
      if (av == null && bv == null) continue;
      if (av == null) return ascending ? -1 : 1;
      if (bv == null) return ascending ? 1 : -1;
      let cmp = 0;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      if (cmp !== 0) return ascending ? cmp : -cmp;
    }
    return 0;
  });
}

export interface ToolResult {
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function jsonResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string, detail?: unknown): ToolResult {
  const body =
    detail !== undefined
      ? `${message}\n\n${JSON.stringify(detail, null, 2)}`
      : message;
  return {
    content: [{ type: "text", text: body }],
    isError: true,
  };
}
