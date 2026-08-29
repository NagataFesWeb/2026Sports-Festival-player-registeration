export const SHEETS = {
  dashboard: '操作画面',
  submissions: '承認待ち',
  items: '申請項目',
  issues: '検査結果',
  productionStudents: '生徒マスター',
  students: '疑似生徒マスター',
  registrations: '登録データ',
  rosterHistory: '選手名簿作成履歴',
  mockDataSettings: '疑似データ設定',
  approvals: '承認履歴',
  changeHistory: '変更履歴',
  settingsDashboard: '設定画面',
  eventSettings: '競技設定',
  formDesign: 'フォーム設計',
  formRegistry: 'フォーム項目対応表',
  ruleSettings: 'ルール設定',
  settingsIssues: '設定点検結果',
  rawFormResponses: 'フォーム回答原本'
  ,systemConfig: 'システム設定',
  settingsChangeHistory: '設定変更履歴',
  publicSettingsSnapshot: '公開設定スナップショット',
  liveFormTest: '実機テスト',
} as const;

export const SYSTEM_CONFIG_HEADERS = ['項目', '値'] as const;
export const SYSTEM_CONFIG_KEYS = {
  mode: '運用モード',
  practiceRootFolderId: '練習用保存フォルダID',
} as const;

export const SCRIPT_PROPERTIES = {
  playerRosterJob: 'PLAYER_ROSTER_JOB_V2',
  rosterRebuildRequired: 'ROSTER_REBUILD_REQUIRED',
  authorizedEditorEmails: 'AUTHORIZED_EDITOR_EMAILS',
  systemMode: 'SYSTEM_MODE',
  pendingPreviousFormIds: 'PENDING_PREVIOUS_FORM_IDS',
  publicSettingsLocked: 'PUBLIC_SETTINGS_LOCKED',
  settingsChangeActive: 'SETTINGS_CHANGE_ACTIVE',
  settingsChangeReason: 'SETTINGS_CHANGE_REASON',
  ruleChangeActive: 'RULE_CHANGE_ACTIVE',
  ruleChangeReason: 'RULE_CHANGE_REASON',
} as const;

export const SETTINGS_CHANGE_HISTORY_HEADERS = [
  'changed_at', 'actor_email', 'action', 'reason', 'changed_sheets',
] as const;

export const PUBLIC_SETTINGS_SNAPSHOT_HEADERS = ['sheet_name', 'row_number', 'row_json'] as const;

export const SUBMISSION_HEADERS = [
  'submission_id', 'submission_type', 'submitted_at', 'submitter_student_id',
  'submitter_name_input', 'submitter_email', 'target_grade', 'target_class',
  'is_proxy', 'reception_open', 'status', 'warning_count', 'error_count'
] as const;

export const ITEM_HEADERS = [
  'submission_item_id', 'submission_id', 'submitter_student_id', 'submitter_name_input',
  'event_id', 'event_name', 'slot_id', 'slot_name', 'student_id_input',
  'student_name_input', 'normalized_student_id', 'normalized_name',
  'registration_state', 'required'
] as const;

export const ISSUE_HEADERS = [
  'issue_id', 'submission_id', 'submission_item_id', 'severity', 'issue_code',
  'display_title', 'location_text', 'current_value', 'fix_instruction', 'status'
] as const;

export const STUDENT_HEADERS = [
  'student_id', 'grade', 'class_number', 'attendance_number', 'name', 'gender'
] as const;

export const PRODUCTION_STUDENT_HEADERS = [
  'student_id', 'name', 'grade', 'class_number', 'attendance_number', 'gender_m_or_f'
] as const;

export const APPROVAL_HEADERS = [
  'approval_id', 'submission_id', 'action', 'actor_email', 'reason', 'acted_at'
] as const;

export const REGISTRATION_HEADERS = [
  'registration_id', 'source_submission_id', 'event_id', 'event_name',
  'slot_id', 'slot_name', 'student_id', 'student_name_snapshot', 'grade',
  'class_number', 'version', 'updated_at', 'updated_by', 'gender_snapshot'
] as const;

export const ROSTER_HISTORY_HEADERS = [
  'roster_version_id', 'input_name', 'version_name', 'folder_id', 'folder_url',
  'registration_count', 'source_submission_count', 'created_by', 'created_at'
] as const;

export const MOCK_DATA_SETTING_HEADERS = ['項目', '値', '説明'] as const;
export const MOCK_DATA_SETTING_KEYS = {
  submissionCount: '疑似申請数',
  targetGradePrefix: '対象学年：',
  targetClassPrefix: '対象クラス：',
  normalFormEnabled: '作成するフォーム：通常フォーム',
  correctionFormEnabled: '作成するフォーム：修正フォーム',
  errorSubmissionCount: 'エラーを含む申請数',
  warningSubmissionCount: '警告を含む申請数',
  rosterSource: '疑似申請に使う名簿',
  rosterSourceStamp: '疑似申請を作成した名簿',
} as const;

export const CHANGE_HEADERS = [
  'change_id', 'submission_id', 'submission_item_id', 'before_student_id',
  'after_student_id', 'before_student_name', 'after_student_name',
  'before_registration_state', 'after_registration_state', 'reason',
  'actor_email', 'changed_at'
] as const;

export const EVENT_SETTING_HEADERS = [
  '年度', 'event_id', '有効', '対象学年', '競技名', '区分', '必要人数',
  '走順あり', '欠員許可', '招集順', '表示順', '備考'
] as const;

export const RULE_SETTING_HEADERS = [
  'rule_id', '有効', 'ルール名', '対象', '対象event_id', '旧条件（互換）', '旧上限（互換）',
  '判定', '表示メッセージ', '備考', '論理式（TRUEなら問題なし）'
] as const;

export const RULE_EVENT_TARGET_HEADER_PREFIX = '対象競技:';

export const FORM_DESIGN_HEADERS = ['項目', '値'] as const;

export const FORM_REGISTRY_HEADERS = [
  'form_type', 'form_id', 'item_id', 'field_key', 'event_id', '項目名',
  '種類', '表示順', '有効'
] as const;

export const SETTINGS_ISSUE_HEADERS = [
  '区分', '重要度', '対象ID', '行番号', '問題', '修正方法'
] as const;

export const RAW_FORM_RESPONSE_HEADERS = [
  'form_id', 'response_id', 'form_type', 'submitted_at', 'answer_json',
  'processing_status', 'submission_id', 'processed_at', 'error_code'
] as const;

export const LIVE_FORM_TEST_HEADERS = [
  'case_id', 'form_type', 'テスト内容', '状態', '事前入力URL', 'response_id',
  'submission_id', '取込経路', '判定', '差分', '実行日時', 'answer_json',
] as const;
