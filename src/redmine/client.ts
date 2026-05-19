import type {
  RedmineIssue,
  RedmineProject,
  RedmineCustomField,
  RedmineTracker,
  RedmineIssueStatus,
  RedmineUser,
  RedmineActivity,
  RedmineTimeEntry,
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

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const res = await fetch(url, {
        headers: {
          "X-Redmine-API-Key": this.config.apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = await res.text().catch(() => undefined);
        }
        throw new RedmineApiError(
          `Redmine API error: ${res.status} ${res.statusText} (${url.pathname})`,
          res.status,
          body,
        );
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
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
}
