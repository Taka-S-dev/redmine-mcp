/**
 * Redmine の標準フィールド / CSV 出力列の日本語別名マップを集約する。
 *
 * 各ツール（review_issue / export_issues_csv）からは、ここで spread 済みの
 * `REVIEW_FIELD_ALIASES` / `CSV_COLUMN_ALIASES` を import して使う。
 * 新しい別名を追加するときはこのファイル 1 か所だけ編集すれば良い設計。
 *
 * `as const` を付けて値を string literal 型として推論させているので、
 * 消費側の厳格な型（StandardField 等）と互換になる。
 */

/**
 * 共通分: review_issue（記入もれチェック）と export_issues_csv（CSV 列指定）の
 * 両方で同じ意味で使う別名。揺れ防止のため一元化する。
 */
const COMMON = {
  // subject
  件名: "subject",
  題名: "subject",
  タイトル: "subject",
  // description
  説明: "description",
  本文: "description",
  詳細: "description",
  // assigned_to
  担当者: "assigned_to",
  担当: "assigned_to",
  アサイン: "assigned_to",
  // due_date
  期日: "due_date",
  締切: "due_date",
  締切日: "due_date",
  // start_date
  開始日: "start_date",
  着手日: "start_date",
  // estimated_hours
  予定工数: "estimated_hours",
  見積工数: "estimated_hours",
  見積時間: "estimated_hours",
} as const;

/** review_issue 固有のフィールド（standard fields）の別名。 */
const REVIEW_ONLY = {
  // category
  カテゴリ: "category",
  カテゴリー: "category",
  分類: "category",
  // fixed_version
  対象バージョン: "fixed_version",
  バージョン: "fixed_version",
  リリース: "fixed_version",
  // parent
  親チケット: "parent",
  親: "parent",
} as const;

/** CSV エクスポート固有の列（review_issue では使わないもの）の別名。 */
const CSV_ONLY = {
  // id
  番号: "id",
  // url
  リンク: "url",
  アドレス: "url",
  // project
  プロジェクト: "project",
  // tracker
  トラッカー: "tracker",
  種別: "tracker",
  // status
  ステータス: "status",
  状態: "status",
  // priority
  優先度: "priority",
  // parent_id
  親ID: "parent_id",
  親チケットID: "parent_id",
  // author
  起票者: "author",
  作成者: "author",
  報告者: "author",
  // done_ratio
  進捗率: "done_ratio",
  進捗: "done_ratio",
  // spent_hours
  実績工数: "spent_hours",
  実績時間: "spent_hours",
  実績: "spent_hours",
  // created_on
  作成日時: "created_on",
  作成日: "created_on",
  起票日時: "created_on",
  起票日: "created_on",
  // updated_on
  更新日時: "updated_on",
  更新日: "updated_on",
  // closed_on
  完了日時: "closed_on",
  終了日時: "closed_on",
  クローズ日時: "closed_on",
} as const;

/** review_issue の `required_fields` で受け付ける日本語別名（pre-spread）。 */
export const REVIEW_FIELD_ALIASES = { ...COMMON, ...REVIEW_ONLY };

/** export_issues_csv の `fields` で受け付ける日本語別名（pre-spread）。 */
export const CSV_COLUMN_ALIASES = { ...COMMON, ...CSV_ONLY };
