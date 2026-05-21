import type { RedmineClient } from "./client.js";
import type {
  RedmineCustomField,
  RedmineTracker,
  RedmineIssueStatus,
  RedmineProject,
  RedmineActivity,
} from "../types.js";

/**
 * カスタムフィールド定義をどこから取得できたか。
 * - `api`: /custom_fields.json（管理者トークン）。possible_values まで完全。
 * - `issue-scan`: issue データからの推定（非管理者トークン用フォールバック）。
 * - `none`: API・走査とも失敗。CF 名→ID 解決は不可。
 */
export type CustomFieldsSource = "api" | "issue-scan" | "none";

export interface RedmineMetadata {
  customFields: RedmineCustomField[];
  trackers: RedmineTracker[];
  statuses: RedmineIssueStatus[];
  projects: RedmineProject[];
  activities: RedmineActivity[];
  customFieldsAvailable: boolean;
  customFieldsSource: CustomFieldsSource;
  customFieldsError?: string;
  activitiesAvailable: boolean;
  activitiesError?: string;
  fetchedAt: string;
}

export class MetadataCache {
  /**
   * キャッシュの有効期間（ミリ秒）。これを超えて古いと get() で自動再取得する。
   * Redmine 側で CF・トラッカー等を追加したとき、手動 refresh を忘れても
   * 一定時間で自動的に追従させるのが目的。
   */
  private static readonly TTL_MS = 15 * 60 * 1000;

  /**
   * 非管理者トークンで /custom_fields.json が 403 のとき、issue データから
   * CF を推定するために走査する issue 件数。多いほど CF の網羅性が上がるが
   * API 呼び出しも増える（100 件 = 1 リクエスト）。
   */
  private static readonly CF_SCAN_LIMIT = 500;

  /**
   * issue 走査で集めた「観測値」を possible_values（選択肢）として採用する
   * 値の種類数の上限。これを超える CF は日付・数値・自由記述とみなし、
   * 選択肢扱いしない（resolveCfFilterValue が部分一致で `~` 演算子を使う）。
   */
  private static readonly CF_VALUE_CAP = 30;

  private cache: RedmineMetadata | null = null;
  private inflight: Promise<RedmineMetadata> | null = null;

  constructor(private readonly client: RedmineClient) {}

  async get(): Promise<RedmineMetadata> {
    if (this.cache && !this.isStale(this.cache)) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.load();
    try {
      this.cache = await this.inflight;
      return this.cache;
    } finally {
      this.inflight = null;
    }
  }

  /** キャッシュが TTL を超えて古くなっているか。 */
  private isStale(cache: RedmineMetadata): boolean {
    const age = Date.now() - new Date(cache.fetchedAt).getTime();
    return age > MetadataCache.TTL_MS;
  }

  async refresh(): Promise<RedmineMetadata> {
    this.cache = null;
    this.inflight = null;
    return this.get();
  }

  private async load(): Promise<RedmineMetadata> {
    // 常に取得できるメタ情報を先に取る。
    let activities: RedmineActivity[] = [];
    let activitiesAvailable = true;
    let activitiesError: string | undefined;
    const activitiesPromise = this.client
      .listActivities()
      .then((a) => {
        activities = a;
      })
      .catch((err) => {
        activitiesAvailable = false;
        activitiesError = err instanceof Error ? err.message : String(err);
      });

    const [trackers, statuses, allProjects] = await Promise.all([
      this.client.listTrackers(),
      this.client.listIssueStatuses(),
      this.client.listProjects(500).then((r) => r.items),
      activitiesPromise,
    ]);

    // カスタムフィールド定義。/custom_fields.json は Redmine の仕様で管理者専用。
    // 管理者トークンなら API から正確に取得する。403 等で失敗した場合は、
    // 一般トークンでも読める issue データを走査して CF の id↔名前・観測値を
    // 復元する（issue-scan フォールバック）。これにより管理者権限なしでも
    // CF ベースの絞り込み・集計が動く。
    let customFields: RedmineCustomField[] = [];
    let customFieldsAvailable = true;
    let customFieldsSource: CustomFieldsSource = "api";
    let customFieldsError: string | undefined;
    try {
      customFields = await this.client.listCustomFields();
    } catch (apiErr) {
      try {
        customFields = await this.deriveCustomFieldsFromIssues();
        customFieldsSource = "issue-scan";
        if (customFields.length === 0) {
          customFieldsAvailable = false;
          customFieldsSource = "none";
          customFieldsError =
            "issue データからカスタムフィールドを検出できませんでした" +
            "（対象 issue が無いか、CF に値が入っていない）。";
        }
      } catch (scanErr) {
        customFieldsAvailable = false;
        customFieldsSource = "none";
        const apiMsg =
          apiErr instanceof Error ? apiErr.message : String(apiErr);
        const scanMsg =
          scanErr instanceof Error ? scanErr.message : String(scanErr);
        customFieldsError =
          `API での取得に失敗（${apiMsg}）し、issue 走査によるフォールバックも失敗（${scanMsg}）。`;
      }
    }

    // プロジェクトスコープが設定されていれば、ここでフィルタする。
    // 以降の resolveProjectIdentifier 等もスコープ内のみを参照することになり、
    // 自動的に「スコープ外プロジェクトは存在しない」扱いになる（厳格モード）。
    const scope = this.client.projectScope;
    const projects = scope
      ? allProjects.filter((p) => scope.includes(p.identifier))
      : allProjects;

    return {
      customFields,
      trackers,
      statuses,
      projects,
      activities,
      customFieldsAvailable,
      customFieldsSource,
      customFieldsError,
      activitiesAvailable,
      activitiesError,
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * 一般ユーザートークンでも読める issue 一覧 API から、カスタムフィールドの
   * id↔名前と「実際に使われている値」を復元する。/custom_fields.json が
   * 管理者専用であることへのフォールバック。
   *
   * 制約: 走査対象の issue で一度も値が入っていない CF は検出できない。
   * possible_values は観測値であり、未使用の選択肢は含まれない（絞り込み・
   * 集計の用途では実用上十分）。値の種類が CF_VALUE_CAP を超える CF は
   * 日付・数値・自由記述とみなし、選択肢なし（field_format=string）にする。
   */
  private async deriveCustomFieldsFromIssues(): Promise<RedmineCustomField[]> {
    const result = await this.client.listIssues(
      { status_id: "*", sort: "updated_on:desc" },
      MetadataCache.CF_SCAN_LIMIT,
    );

    const acc = new Map<
      number,
      { name: string; values: Set<string>; multiple: boolean }
    >();
    for (const issue of result.items) {
      for (const cf of issue.custom_fields ?? []) {
        let entry = acc.get(cf.id);
        if (!entry) {
          entry = { name: cf.name, values: new Set(), multiple: false };
          acc.set(cf.id, entry);
        }
        const add = (v: unknown) => {
          const s = v == null ? "" : String(v).trim();
          if (s !== "") entry!.values.add(s);
        };
        if (Array.isArray(cf.value)) {
          entry.multiple = true;
          cf.value.forEach(add);
        } else {
          add(cf.value);
        }
      }
    }

    return [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, e]) => {
        const isList =
          e.values.size > 0 && e.values.size <= MetadataCache.CF_VALUE_CAP;
        return {
          id,
          name: e.name,
          customized_type: "issue",
          field_format: isList ? "list" : "string",
          is_required: false,
          is_filter: true,
          searchable: true,
          multiple: e.multiple,
          visible: true,
          possible_values: isList
            ? [...e.values].sort().map((value) => ({ value }))
            : undefined,
        } satisfies RedmineCustomField;
      });
  }

  /**
   * スコープ内のプロジェクト identifier 一覧（設定値そのまま）。スコープ未設定なら undefined。
   */
  get projectScope(): string[] | undefined {
    return this.client.projectScope;
  }

  /**
   * 実効スコープ。設定されたスコープのうち、Redmine 側に実在するもののみを返す。
   * fan-out で 404 を防ぐ目的。スコープ未設定なら undefined、cache 未ロードなら空配列扱い。
   */
  getEffectiveScope(): string[] | undefined {
    if (!this.client.projectScope) return undefined;
    if (!this.cache) return [];
    return this.cache.projects.map((p) => p.identifier);
  }

  /**
   * Resolve an activity name (e.g. "実装", "テスト") to its ID. Returns null if not found.
   */
  resolveActivityId(name: string): number | null {
    if (!this.cache) return null;
    const needle = name.trim().toLowerCase();
    const found = this.cache.activities.find(
      (a) => a.name.toLowerCase() === needle,
    );
    return found?.id ?? null;
  }

  /**
   * Resolve a custom field name (e.g. "カテゴリ") to its Redmine ID.
   * Case-insensitive, trims whitespace. Returns null if not found.
   */
  resolveCustomFieldId(name: string): number | null {
    if (!this.cache) return null;
    const needle = name.trim().toLowerCase();
    const found = this.cache.customFields.find(
      (cf) => cf.name.toLowerCase() === needle,
    );
    return found?.id ?? null;
  }

  /**
   * Resolve a tracker name (e.g. "バグ") to its ID. Returns null if not found.
   */
  resolveTrackerId(name: string): number | null {
    if (!this.cache) return null;
    const needle = name.trim().toLowerCase();
    const found = this.cache.trackers.find(
      (t) => t.name.toLowerCase() === needle,
    );
    return found?.id ?? null;
  }

  /**
   * Resolve a status name (e.g. "新規", "進行中") to its ID. Returns null if not found.
   */
  resolveStatusId(name: string): number | null {
    if (!this.cache) return null;
    const needle = name.trim().toLowerCase();
    const found = this.cache.statuses.find(
      (s) => s.name.toLowerCase() === needle,
    );
    return found?.id ?? null;
  }

  /**
   * Resolve a project name or identifier to its identifier (Redmine API
   * accepts both numeric ID and identifier string; we return identifier
   * for readability in logs).
   */
  resolveProjectIdentifier(nameOrIdentifier: string): string | null {
    if (!this.cache) return null;
    const needle = nameOrIdentifier.trim().toLowerCase();
    const found = this.cache.projects.find(
      (p) =>
        p.identifier.toLowerCase() === needle ||
        p.name.toLowerCase() === needle,
    );
    return found?.identifier ?? null;
  }
}
