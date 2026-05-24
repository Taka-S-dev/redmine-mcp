import type {
  RedmineIssue,
  RedmineProject,
  RedmineCustomField,
  RedmineTracker,
  RedmineIssueStatus,
  RedmineUser,
  RedmineActivity,
  RedmineTimeEntry,
  RedmineSearchResult,
  RedmineAttachment,
  PaginatedResponse,
} from "../types.js";

export interface RedmineConfig {
  url: string;
  apiKey: string;
  timeoutMs: number;
  /**
   * 厳格モードのプロジェクトスコープ。設定されていると：
   * - describe_schema / list_projects はこのリストのみ表示
   * - 各ツールの project 引数はこのリストに含まれるものしか受け付けない
   * - project 引数省略時はスコープ内全プロジェクトに fan-out
   */
  projectScope?: string[];
}

export class RedmineApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "RedmineApiError";
  }
}

export class RedmineClient {
  constructor(private readonly config: RedmineConfig) {}

  get baseUrl(): string {
    return this.config.url;
  }

  get projectScope(): string[] | undefined {
    return this.config.projectScope;
  }

  issueUrl(id: number): string {
    return `${this.config.url}/issues/${id}`;
  }

  /** リトライ回数（初回 + リトライ）。一時的なネットワーク障害・5xx 用。 */
  private static readonly MAX_ATTEMPTS = 3;

  private async request<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(path, this.config.url + "/");
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= RedmineClient.MAX_ATTEMPTS;
      attempt++
    ) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs,
      );
      const isLast = attempt === RedmineClient.MAX_ATTEMPTS;

      try {
        const res = await fetch(url, {
          headers: {
            "X-Redmine-API-Key": this.config.apiKey,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (res.ok) {
          return (await res.json()) as T;
        }

        // エラーレスポンス
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = await res.text().catch(() => undefined);
        }
        const apiError = new RedmineApiError(
          `Redmine API error: ${res.status} ${res.statusText} (${url.pathname})`,
          res.status,
          body,
        );
        // 5xx（サーバー側の一時障害）はリトライ。4xx はリトライ無意味なので即時失敗。
        if (res.status >= 500 && !isLast) {
          lastError = apiError;
        } else {
          throw apiError;
        }
      } catch (err) {
        // RedmineApiError（4xx・最終 5xx）はそのまま投げる
        if (err instanceof RedmineApiError) throw err;
        // ネットワークエラー・タイムアウトはリトライ対象
        lastError = err;
        if (isLast) throw err;
        process.stderr.write(
          `[redmine-mcp] リクエスト失敗（${attempt}/${RedmineClient.MAX_ATTEMPTS}）、リトライします: ${url.pathname}\n`,
        );
      } finally {
        clearTimeout(timeoutId);
      }

      // リトライ前の待機（指数的バックオフ: 300ms, 600ms…）
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }

    throw lastError;
  }

  /**
   * Fetch all pages of a paginated endpoint.
   * Redmine's paginated responses have shape { <key>: T[], total_count, offset, limit }.
   */
  private async requestAllPaginated<T>(
    path: string,
    listKey: string,
    params: Record<string, string | number | undefined>,
    maxItems: number,
  ): Promise<PaginatedResponse<T>> {
    const pageSize = Math.min(100, maxItems);
    const items: T[] = [];
    let offset = 0;
    let totalCount = 0;

    while (items.length < maxItems) {
      const res = await this.request<Record<string, unknown>>(path, {
        ...params,
        offset,
        limit: pageSize,
      });
      const pageItems = (res[listKey] as T[]) ?? [];
      totalCount = (res.total_count as number) ?? pageItems.length;
      items.push(...pageItems);
      if (pageItems.length < pageSize) break;
      if (items.length >= totalCount) break;
      offset += pageSize;
    }

    return {
      total_count: totalCount,
      offset: 0,
      limit: items.length,
      items: items.slice(0, maxItems),
    };
  }

  async listIssues(
    params: Record<string, string | number | undefined>,
    maxItems = 100,
  ): Promise<PaginatedResponse<RedmineIssue>> {
    return this.requestAllPaginated<RedmineIssue>(
      "issues.json",
      "issues",
      params,
      maxItems,
    );
  }

  async getIssue(
    id: number,
    include: string[] = [],
  ): Promise<RedmineIssue> {
    const params: Record<string, string> = {};
    if (include.length > 0) params.include = include.join(",");
    const res = await this.request<{ issue: RedmineIssue }>(
      `issues/${id}.json`,
      params,
    );
    return res.issue;
  }

  async listProjects(maxItems = 200): Promise<PaginatedResponse<RedmineProject>> {
    return this.requestAllPaginated<RedmineProject>(
      "projects.json",
      "projects",
      {},
      maxItems,
    );
  }

  async listCustomFields(): Promise<RedmineCustomField[]> {
    // Note: requires admin privileges in Redmine
    const res = await this.request<{ custom_fields: RedmineCustomField[] }>(
      "custom_fields.json",
    );
    return res.custom_fields;
  }

  async listTrackers(): Promise<RedmineTracker[]> {
    const res = await this.request<{ trackers: RedmineTracker[] }>(
      "trackers.json",
    );
    return res.trackers;
  }

  async listIssueStatuses(): Promise<RedmineIssueStatus[]> {
    const res = await this.request<{ issue_statuses: RedmineIssueStatus[] }>(
      "issue_statuses.json",
    );
    return res.issue_statuses;
  }

  async listUsers(maxItems = 200): Promise<PaginatedResponse<RedmineUser>> {
    return this.requestAllPaginated<RedmineUser>(
      "users.json",
      "users",
      {},
      maxItems,
    );
  }

  async getCurrentUser(): Promise<RedmineUser> {
    const res = await this.request<{ user: RedmineUser }>("users/current.json");
    return res.user;
  }

  /**
   * Redmine の全文検索 API。件名・本文・コメントを横断してキーワード検索する。
   * projectIdentifier を渡すとそのプロジェクト配下に限定する。
   */
  async search(
    query: string,
    options: {
      projectIdentifier?: string;
      openIssuesOnly?: boolean;
      maxItems?: number;
    } = {},
  ): Promise<PaginatedResponse<RedmineSearchResult>> {
    const path = options.projectIdentifier
      ? `projects/${options.projectIdentifier}/search.json`
      : "search.json";
    const params: Record<string, string | number | undefined> = {
      q: query,
      issues: 1,
    };
    if (options.openIssuesOnly) params.open_issues = 1;
    return this.requestAllPaginated<RedmineSearchResult>(
      path,
      "results",
      params,
      options.maxItems ?? 50,
    );
  }

  async listActivities(): Promise<RedmineActivity[]> {
    const res = await this.request<{
      time_entry_activities: RedmineActivity[];
    }>("enumerations/time_entry_activities.json");
    return res.time_entry_activities;
  }

  async listTimeEntries(
    params: Record<string, string | number | undefined>,
    maxItems = 200,
  ): Promise<PaginatedResponse<RedmineTimeEntry>> {
    return this.requestAllPaginated<RedmineTimeEntry>(
      "time_entries.json",
      "time_entries",
      params,
      maxItems,
    );
  }

  async getAttachment(id: number): Promise<RedmineAttachment> {
    const res = await this.request<{ attachment: RedmineAttachment }>(
      `attachments/${id}.json`,
    );
    return res.attachment;
  }

  /**
   * 添付ファイルの content_url から実体（バイナリ）を取得する。
   * content_url は Redmine から返される絶対 URL（通常は
   * /attachments/download/<id>/<filename>）。request<T> と同じリトライ・
   * タイムアウトポリシーを使うが、レスポンスは JSON ではなく ArrayBuffer
   * として受け取って Buffer に変換する。
   *
   * パース（PDF / Excel 等）は呼び出し側 or 将来のパーサツールの責務。
   * このメソッドは「認証ヘッダ付きでバイナリを取得する」だけに徹する。
   */
  async downloadAttachment(
    contentUrl: string,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= RedmineClient.MAX_ATTEMPTS;
      attempt++
    ) {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs,
      );
      const isLast = attempt === RedmineClient.MAX_ATTEMPTS;

      try {
        const res = await fetch(contentUrl, {
          headers: { "X-Redmine-API-Key": this.config.apiKey },
          signal: controller.signal,
        });

        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          return {
            bytes: buf,
            contentType:
              res.headers.get("content-type") ?? "application/octet-stream",
          };
        }

        const body = await res.text().catch(() => undefined);
        const apiError = new RedmineApiError(
          `Redmine API error: ${res.status} ${res.statusText} (attachment download)`,
          res.status,
          body,
        );
        if (res.status >= 500 && !isLast) {
          lastError = apiError;
        } else {
          throw apiError;
        }
      } catch (err) {
        if (err instanceof RedmineApiError) throw err;
        lastError = err;
        if (isLast) throw err;
        process.stderr.write(
          `[redmine-mcp] 添付ダウンロード失敗（${attempt}/${RedmineClient.MAX_ATTEMPTS}）、リトライします\n`,
        );
      } finally {
        clearTimeout(timeoutId);
      }

      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }

    throw lastError;
  }
}
