export interface RedmineCustomFieldValue {
  id: number;
  name: string;
  value: string | string[] | null;
}

export interface RedmineRef {
  id: number;
  name: string;
}

export interface RedmineUserRef {
  id: number;
  name: string;
}

export interface RedmineIssue {
  id: number;
  project: RedmineRef;
  tracker: RedmineRef;
  status: RedmineRef;
  priority: RedmineRef;
  author: RedmineUserRef;
  assigned_to?: RedmineUserRef;
  category?: RedmineRef;
  fixed_version?: RedmineRef;
  subject: string;
  description?: string;
  start_date?: string;
  due_date?: string;
  done_ratio: number;
  is_private?: boolean;
  estimated_hours?: number | null;
  spent_hours?: number;
  custom_fields?: RedmineCustomFieldValue[];
  created_on: string;
  updated_on: string;
  closed_on?: string | null;
  journals?: RedmineJournal[];
  relations?: RedmineRelation[];
  children?: { id: number; tracker: RedmineRef; subject: string }[];
  attachments?: RedmineAttachment[];
}

export interface RedmineJournal {
  id: number;
  user: RedmineUserRef;
  notes: string;
  created_on: string;
  private_notes?: boolean;
  details: {
    property: string;
    name: string;
    old_value: string | null;
    new_value: string | null;
  }[];
}

export interface RedmineRelation {
  id: number;
  issue_id: number;
  issue_to_id: number;
  relation_type: string;
  delay?: number | null;
}

export interface RedmineAttachment {
  id: number;
  filename: string;
  filesize: number;
  content_type: string;
  description?: string;
  content_url: string;
  author: RedmineUserRef;
  created_on: string;
}

export interface RedmineProject {
  id: number;
  name: string;
  identifier: string;
  description?: string;
  status: number;
  is_public?: boolean;
  parent?: RedmineRef;
  created_on: string;
  updated_on: string;
}

export interface RedmineCustomField {
  id: number;
  name: string;
  customized_type: string;
  field_format: string;
  regexp?: string;
  min_length?: number;
  max_length?: number;
  is_required: boolean;
  is_filter: boolean;
  searchable: boolean;
  multiple: boolean;
  default_value?: string | null;
  visible: boolean;
  possible_values?: { value: string; label?: string }[];
  trackers?: RedmineRef[];
  roles?: RedmineRef[];
}

export interface RedmineTracker {
  id: number;
  name: string;
  default_status?: RedmineRef;
  description?: string;
}

export interface RedmineIssueStatus {
  id: number;
  name: string;
  is_closed: boolean;
}

export interface RedmineUser {
  id: number;
  login?: string;
  firstname: string;
  lastname: string;
  mail?: string;
  created_on?: string;
  last_login_on?: string;
}

export interface RedmineActivity {
  id: number;
  name: string;
  is_default?: boolean;
  active?: boolean;
}

export interface RedmineTimeEntry {
  id: number;
  project: RedmineRef;
  issue?: { id: number };
  user: RedmineUserRef;
  activity: RedmineRef;
  hours: number;
  comments?: string;
  spent_on: string;
  created_on: string;
  updated_on: string;
  custom_fields?: RedmineCustomFieldValue[];
}

export interface PaginatedResponse<T> {
  total_count: number;
  offset: number;
  limit: number;
  items: T[];
}
