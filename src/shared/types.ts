export type SubmissionType = 'INITIAL' | 'CORRECTION' | 'MANUAL_CHANGE';
export type SubmissionStatus =
  | 'RECEIVED' | 'CHECKED' | 'PENDING_APPROVAL' | 'NEEDS_CORRECTION'
  | 'ON_HOLD' | 'CORRECTION_REQUESTED' | 'REJECTED' | 'APPROVED' | 'APPLIED';
export type Severity = 'WARNING' | 'ERROR';
export type IssueStatus = 'UNCONFIRMED' | 'CONFIRMED' | 'FIXED';
export type RegistrationState = 'REGISTER' | 'PENDING' | 'NOT_PARTICIPATING';

export interface Student {
  studentId: string;
  grade: number;
  classNumber: number;
  attendanceNumber: number;
  name: string;
  gender?: 'M' | 'F' | 'U';
}

export interface Submission {
  submissionId: string;
  submissionType: SubmissionType;
  submittedAt: string;
  submitterStudentId: string;
  submitterNameInput: string;
  submitterEmail: string;
  targetGrade: number;
  targetClass: number;
  isProxy: boolean;
  receptionOpen: boolean;
  status: SubmissionStatus;
  warningCount: number;
  errorCount: number;
}

export interface SubmissionItem {
  submissionItemId: string;
  submissionId: string;
  eventId: string;
  eventName: string;
  slotId: string;
  slotName: string;
  studentIdInput: string;
  studentNameInput: string;
  normalizedStudentId: string;
  normalizedName: string;
  registrationState: RegistrationState;
  required: boolean;
}

export interface Registration {
  registrationId: string;
  sourceSubmissionId: string;
  eventId: string;
  eventName: string;
  slotId: string;
  slotName: string;
  studentId: string;
  studentNameSnapshot: string;
  grade: number;
  classNumber: number;
  version: string;
  updatedAt: string;
  updatedBy: string;
}

export interface MockDataGenerationConfig {
  submissionCount: number;
  targetGrades: number[];
  targetClasses: number[];
  targetFormTypes: Array<'normal' | 'correction'>;
  errorSubmissionCount: number;
  warningSubmissionCount: number;
}

export interface GlobalWarning {
  code: 'STUDENTS_WITHOUT_REGISTRATION';
  title: string;
  message: string;
  fixInstruction: string;
  count: number;
  affectedStudents: Array<{
    studentId: string;
    grade: number;
    classNumber: number;
    name: string;
  }>;
}

export interface ValidationIssue {
  issueId: string;
  submissionId: string;
  submissionItemId: string;
  severity: Severity;
  issueCode: string;
  displayTitle: string;
  locationText: string;
  currentValue: string;
  fixInstruction: string;
  status: IssueStatus;
}

export interface ValidationContext {
  students: Student[];
  sameClassInitialSubmissionCount: number;
  rules?: RuleSetting[];
}

export interface ValidationResult {
  normalizedItems: SubmissionItem[];
  issues: ValidationIssue[];
  warningCount: number;
  errorCount: number;
  nextStatus: SubmissionStatus;
}

export type DashboardFilter = 'ALL' | 'WARNING' | 'ERROR' | 'CLEAR' | 'HOLD' | 'REJECTED' | 'APPROVED';

export interface SubmissionSummary {
  submissionId: string;
  submissionType: SubmissionType;
  submittedAt: string;
  targetGrade: number;
  targetClass: number;
  status: SubmissionStatus;
  warningCount: number;
  errorCount: number;
}

export interface SubmissionDetail {
  submission: Submission;
  items: SubmissionItem[];
  issues: ValidationIssue[];
  approvalHistory: Array<{
    action: string;
    actorEmail: string;
    reason: string;
    actedAt: string;
  }>;
  responseNote: string;
  duplicateCandidates: Array<{
    submission: Submission;
    items: SubmissionItem[];
  }>;
}

export type SettingsSeverity = 'WARNING' | 'ERROR';
export type TargetGrade = '全学年' | '1年' | '2年' | '3年';
export type EventCategory = '男子' | '女子' | '混合' | 'クラス' | 'その他';

export interface EventSetting {
  year: number;
  eventId: string;
  enabled: boolean;
  targetGrade: TargetGrade;
  eventName: string;
  category: EventCategory;
  requiredCount: number;
  hasOrder: boolean;
  vacancyAllowed: boolean;
  assemblyOrder: number;
  displayOrder: number;
  note: string;
  /** 設定シート上の実際の行番号。未使用行を除外して読み込むため、配列の位置とは一致しない。 */
  rowNumber?: number;
}

export interface RuleSetting {
  ruleId: string;
  enabled: boolean;
  ruleName: string;
  target: '全競技' | '個人種目' | 'リレー' | '指定競技';
  targetEventIds: string;
  condition: string;
  limit: number;
  judgment: 'エラー' | '警告';
  displayMessage: string;
  note: string;
  expression?: string;
  /** 設定シート上の実際の行番号。未使用行を除外して読み込むため、配列の位置とは一致しない。 */
  rowNumber?: number;
}

export interface FormDesignSetting {
  year: number;
  normalTitle: string;
  correctionTitle: string;
  deadline: string;
  sendResponseCopy: boolean;
  loginRequired: boolean;
  gradeBranching: boolean;
  normalResubmission: '禁止' | '許可';
  applyBeforeApproval: '禁止';
  formStatus: '未作成' | '下書き' | '公開前確認' | '公開中' | '受付停止' | 'アーカイブ';
  normalFormId: string;
  correctionFormId: string;
  normalEditUrl: string;
  correctionEditUrl: string;
  formsFolderId: string;
  formsFolderUrl: string;
}

export interface SettingsIssue {
  category: '競技設定' | 'ルール設定' | 'フォーム設計';
  severity: SettingsSeverity;
  targetId: string;
  rowNumber: number;
  title: string;
  instruction: string;
}

export interface FormRegistryRow {
  formType: 'normal' | 'correction';
  formId: string;
  itemId: string;
  fieldKey: string;
  eventId: string;
  title: string;
  itemType: string;
  displayOrder: number;
  enabled: boolean;
}
