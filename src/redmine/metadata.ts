import type { RedmineClient } from "./client.js";
import type {
  RedmineCustomField,
  RedmineTracker,
  RedmineIssueStatus,
  RedmineProject,
  RedmineActivity,
} from "../types.js";

export interface RedmineMetadata {
  customFields: RedmineCustomField[];
  trackers: RedmineTracker[];
  statuses: RedmineIssueStatus[];
  projects: RedmineProject[];
  activities: RedmineActivity[];
  customFieldsAvailable: boolean;
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
    // custom_fields.json requires admin in Redmine. Treat its failure as
    // non-fatal so that non-admin users can still use the other tools.
    let customFields: RedmineCustomField[] = [];
    let customFieldsAvailable = true;
    let customFieldsError: string | undefined;
    try {
      customFields = await this.client.listCustomFields();
    } catch (err) {
      customFieldsAvailable = false;
      customFieldsError =
        err instanceof Error ? err.message : String(err);
    }

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
      customFieldsError,
      activitiesAvailable,
      activitiesError,
      fetchedAt: new Date().toISOString(),
    };
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
