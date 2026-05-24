import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RedmineApiError } from "../redmine/client.js";
import {
  jsonResult,
  errorResult,
  detectAttachmentKind,
  type ToolContext,
} from "./context.js";
import { REVIEW_FIELD_ALIASES } from "./field-aliases.js";
import type {
  RedmineIssue,
  RedmineCustomField,
  RedmineAttachment,
} from "../types.js";

/**
 * review_issue — チケットを指定して「記入もれ」と「内部矛盾」を機械判定し、
 * 定性レビュー（内容のおかしさ）のための材料を一括返却するプリミティブ。
 *
 * 設計思想（3層モデル）:
 *   - プリミティブ（このツール）: 機械判定 + データ集約のみ。業務固有の知識は持たない。
 *   - ポリシー: required_fields は呼び出し側（copilot-instructions 経由の AI）が指定。
 *   - 判断: 件名と説明の整合・CF 値の妥当性・コメントの噛み合い等は LLM が行う。
 */

const inputShape = {
  issue_id: z
    .number()
    .int()
    .positive()
    .describe("レビュー対象のチケット ID。"),
  required_fields: z
    .array(z.string())
    .optional()
    .describe(
      "記入必須項目の配列。標準フィールドは英字キーまたは日本語別名で指定可: " +
        "subject(件名/題名/タイトル) / description(説明/本文) / " +
        "assigned_to(担当者/担当) / due_date(期日/締切) / start_date(開始日) / " +
        "estimated_hours(予定工数/見積工数) / category(カテゴリ) / " +
        "fixed_version(対象バージョン/バージョン) / parent(親チケット/親)。" +
        "カスタムフィールドは 'cf:<CF名>'（例: 'cf:カテゴリ'）。" +
        "省略時は記入もれチェックを行わない。トラッカー別の必須項目は " +
        "copilot-instructions.md 等で定義し、AI が呼び出し時に翻訳して渡す想定。",
    ),
  include_children: z
    .boolean()
    .optional()
    .describe(
      "子チケット一覧（id / tracker / subject）を含める。" +
        "親に指摘・子に対応 のような親子セットでの整合レビューに使う。",
    ),
  include_related: z
    .boolean()
    .optional()
    .describe("関連チケット（relations）を含める。"),
  include_journals: z
    .boolean()
    .optional()
    .describe(
      "コメント履歴（journals）を含める。" +
        "コメントと変更内容が噛み合っているかを見たいとき。",
    ),
  include_attachments: z
    .boolean()
    .optional()
    .describe(
      "添付ファイルのメタ情報（filename / size / content_type / kind）を含める。" +
        "中身は含めない。必要に応じて download_attachment で取得する。",
    ),
};

const STANDARD_FIELDS = [
  "subject",
  "description",
  "assigned_to",
  "due_date",
  "start_date",
  "estimated_hours",
  "category",
  "fixed_version",
  "parent",
] as const;

type StandardField = (typeof STANDARD_FIELDS)[number];

function resolveStandardField(key: string): StandardField | null {
  if ((STANDARD_FIELDS as readonly string[]).includes(key)) {
    return key as StandardField;
  }
  return (REVIEW_FIELD_ALIASES as Record<string, StandardField>)[key] ?? null;
}

interface FieldCheck {
  key: string;
  present: boolean;
  preview?: string;
  reason?: string;
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function evaluateStandardField(
  issue: RedmineIssue,
  field: StandardField,
): { present: boolean; preview?: string } {
  switch (field) {
    case "subject":
      return {
        present: !!issue.subject?.trim(),
        preview: issue.subject ? truncate(issue.subject) : undefined,
      };
    case "description": {
      const d = issue.description?.trim();
      return {
        present: !!d,
        preview: d ? truncate(d) : undefined,
      };
    }
    case "assigned_to":
      return {
        present: !!issue.assigned_to,
        preview: issue.assigned_to?.name,
      };
    case "due_date":
      return { present: !!issue.due_date, preview: issue.due_date };
    case "start_date":
      return { present: !!issue.start_date, preview: issue.start_date };
    case "estimated_hours":
      return {
        present: issue.estimated_hours != null,
        preview: issue.estimated_hours?.toString(),
      };
    case "category":
      return {
        present: !!issue.category,
        preview: issue.category?.name,
      };
    case "fixed_version":
      return {
        present: !!issue.fixed_version,
        preview: issue.fixed_version?.name,
      };
    case "parent":
      return {
        present: !!issue.parent,
        preview: issue.parent ? `#${issue.parent.id}` : undefined,
      };
  }
}

function checkCustomField(
  issue: RedmineIssue,
  cfName: string,
  customFields: RedmineCustomField[],
): FieldCheck {
  const key = `cf:${cfName}`;
  const def = customFields.find(
    (c) => c.name.toLowerCase() === cfName.toLowerCase(),
  );
  if (!def) {
    return {
      key,
      present: false,
      reason: `カスタムフィールド '${cfName}' が定義に存在しません`,
    };
  }
  const raw = issue.custom_fields?.find((c) => c.id === def.id)?.value;
  const isEmpty =
    raw == null ||
    (typeof raw === "string" && raw.trim() === "") ||
    (Array.isArray(raw) && raw.length === 0);
  if (isEmpty) {
    return { key, present: false };
  }
  const preview = Array.isArray(raw) ? raw.join(", ") : String(raw);
  return { key, present: true, preview: truncate(preview) };
}

export function register(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "review_issue",
    {
      title: "チケットレビュー（記入もれ・矛盾検出 + 定性レビュー材料）",
      description:
        "指定したチケットの『記入もれ』と『内部矛盾』をサーバー側で機械判定し、" +
        "定性レビューのための完全データを一括で返すプリミティブ。" +
        "required_fields に必須項目を渡すと空欄を completeness.missing に列挙。" +
        "進捗 vs 状態・日付前後・見積 vs 実績などの矛盾は consistency_flags に検出。" +
        "include_children / include_related / include_journals / include_attachments で" +
        "関連データを必要な分だけ同梱可能（トークン節約）。" +
        "件名と説明の整合・CF 値の妥当性・コメントの噛み合い等の『内容のおかしさ』は、" +
        "返却データを読んだ LLM 側で判定する設計（ルール化不可能な定性判断はコードに焼かない）。" +
        "トラッカー別の必須項目は copilot-instructions.md 等で定義し、" +
        "AI が required_fields に翻訳して渡すのが想定運用。" +
        "添付ファイルの中身を見る場合は download_attachment を別途呼ぶ。",
      inputSchema: inputShape,
    },
    async (args) => {
      const metadata = await ctx.metadata.get();

      const includes: string[] = [];
      if (args.include_children) includes.push("children");
      if (args.include_related) includes.push("relations");
      if (args.include_journals) includes.push("journals");
      if (args.include_attachments) includes.push("attachments");

      let issue: RedmineIssue;
      try {
        issue = await ctx.client.getIssue(args.issue_id, includes);
      } catch (err) {
        if (err instanceof RedmineApiError) {
          return errorResult(err.message, err.body);
        }
        throw err;
      }

      // ----- 完全性チェック（required_fields 指定時のみ） -----
      const present: FieldCheck[] = [];
      const missing: FieldCheck[] = [];
      const invalidKeys: string[] = [];

      for (const rawKey of args.required_fields ?? []) {
        const key = rawKey.trim();
        if (key.startsWith("cf:")) {
          const check = checkCustomField(
            issue,
            key.slice(3),
            metadata.customFields,
          );
          (check.present ? present : missing).push(check);
          continue;
        }
        const canonical = resolveStandardField(key);
        if (canonical) {
          const result = evaluateStandardField(issue, canonical);
          // 出力には呼び出し側が書いたキーを返す（題名 と書いたら 題名 が返る）
          const check: FieldCheck = { key, ...result };
          (check.present ? present : missing).push(check);
        } else {
          invalidKeys.push(key);
        }
      }

      if (invalidKeys.length > 0) {
        const aliasesList = Object.keys(REVIEW_FIELD_ALIASES).join(" / ");
        return errorResult(
          `required_fields に未知のキーが含まれています: ${invalidKeys.join(", ")}。` +
            `標準キー（英字）: ${STANDARD_FIELDS.join(" / ")}。` +
            `日本語別名も可: ${aliasesList}。` +
            `CF は 'cf:<CF名>' 形式で指定。`,
        );
      }

      // ----- 内部矛盾チェック（決定論） -----
      const consistency: string[] = [];
      const closedStatusIds = new Set(
        metadata.statuses.filter((s) => s.is_closed).map((s) => s.id),
      );
      const isClosed = closedStatusIds.has(issue.status.id);

      if (issue.done_ratio === 100 && !isClosed) {
        consistency.push(
          `進捗 100% だが状態が '${issue.status.name}'（未完了）。`,
        );
      }
      if (isClosed && issue.done_ratio < 100) {
        consistency.push(
          `状態 '${issue.status.name}'（完了）だが進捗 ${issue.done_ratio}%。`,
        );
      }
      if (
        issue.start_date &&
        issue.due_date &&
        issue.start_date > issue.due_date
      ) {
        consistency.push(
          `開始日 (${issue.start_date}) が期日 (${issue.due_date}) より後。`,
        );
      }
      if (
        issue.estimated_hours != null &&
        issue.spent_hours != null &&
        issue.estimated_hours > 0 &&
        issue.spent_hours > issue.estimated_hours * 1.5
      ) {
        const pct = Math.round((issue.spent_hours / issue.estimated_hours) * 100);
        consistency.push(
          `実績 ${issue.spent_hours}h が見積 ${issue.estimated_hours}h を大幅超過（${pct}%）。`,
        );
      }

      // ----- 添付メタの軽量化 -----
      const attachmentMeta = args.include_attachments
        ? (issue.attachments ?? []).map((a: RedmineAttachment) => ({
            id: a.id,
            filename: a.filename,
            size_bytes: a.filesize,
            content_type: a.content_type,
            kind: detectAttachmentKind(a.content_type),
            created_on: a.created_on,
            author: a.author?.name,
          }))
        : undefined;

      const baseUrl = ctx.client.baseUrl;

      return jsonResult({
        issue: {
          id: issue.id,
          url: `${baseUrl}/issues/${issue.id}`,
          subject: issue.subject,
          description: issue.description,
          project: issue.project?.name,
          tracker: issue.tracker?.name,
          status: issue.status?.name,
          status_is_closed: isClosed,
          priority: issue.priority?.name,
          assigned_to: issue.assigned_to?.name,
          author: issue.author?.name,
          parent_id: issue.parent?.id ?? null,
          category: issue.category?.name,
          fixed_version: issue.fixed_version?.name,
          start_date: issue.start_date,
          due_date: issue.due_date,
          done_ratio: issue.done_ratio,
          estimated_hours: issue.estimated_hours,
          spent_hours: issue.spent_hours,
          created_on: issue.created_on,
          updated_on: issue.updated_on,
          closed_on: issue.closed_on ?? null,
          custom_fields: (issue.custom_fields ?? []).map((c) => ({
            name: c.name,
            value: c.value,
          })),
        },
        children: args.include_children ? (issue.children ?? []) : undefined,
        relations: args.include_related ? (issue.relations ?? []) : undefined,
        journals: args.include_journals
          ? (issue.journals ?? []).map((j) => ({
              user: j.user?.name,
              created_on: j.created_on,
              notes: j.notes,
              details: j.details,
            }))
          : undefined,
        attachments: attachmentMeta,
        completeness:
          (args.required_fields ?? []).length === 0
            ? {
                checked: false,
                hint: "required_fields を指定すると記入もれ検出が有効になる。",
              }
            : { checked: true, missing, present },
        consistency_flags: consistency,
        review_hint:
          "上記データを読み、(1) 件名と説明の整合 (2) カスタムフィールド値の妥当性 " +
          "(3) コメント履歴と変更内容の噛み合い (4) 親子・関連チケットとの整合 " +
          "などの『内容のおかしさ』を定性レビューしてください。" +
          "必須項目・矛盾の決定論検出は completeness / consistency_flags を信頼。" +
          "添付ファイルの内容まで見たい場合は download_attachment で取得し、" +
          "agent 側の Read 機能で開くこと（PDF/Excel パーサは現状未搭載、将来の拡張点）。",
      });
    },
  );
}
