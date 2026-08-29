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
  /** 学籍番号から生徒マスターを引いた氏名。画面表示用で、シートへは保存しない。 */
  masterName?: string;
  /**
   * 学籍番号から生徒マスターを引いた性別。画面表示用で、シートへは保存しない。
   * 名簿に無い学籍番号と、性別が`m`/`f`以外の生徒は`U`とし、論理式の`UNKNOWN`と一致させる。
   */
  masterGender?: NonNullable<Student['gender']>;
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
  /**
   * 名簿作成時点の生徒マスターの性別。名簿の表示に使う。名簿に無い学籍番号と
   * 性別未設定は`U`とし、論理式の`UNKNOWN`と同じ扱いにする。
   */
  genderSnapshot?: NonNullable<Student['gender']>;
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
  /**
   * 申請確認画面の表示専用データ。同一競技内の重複登録、競技をまたいだ出場、
   * 検査結果と選手枠の対応を持つ。シートへは保存せず、画面表示のたびに作り直す。
   */
  review: SubmissionReview;
}

/** 表示専用の性別。生徒マスターに無い学籍番号は論理式の`UNKNOWN`と同じ`U`にする。 */
export type DisplayGender = 'M' | 'F' | 'U';

export interface ReviewSlot {
  submissionItemId: string;
  eventName: string;
  slotName: string;
}

/**
 * 同じ競技の中で同じ生徒が複数の枠に登録されている組。
 * 論理式`MAX_PER_EVENT`と同じ`競技ID:学籍番号`で数え、ルールカードと表示を一致させる。
 */
export interface SameEventDuplicate {
  duplicateKey: string;
  badgeLabel: string;
  studentId: string;
  name: string;
  gender: DisplayGender;
  eventId: string;
  eventName: string;
  count: number;
  slots: ReviewSlot[];
}

/**
 * 競技をまたいで複数回出場する生徒。重複ではなく通常の登録なので出場数として中立に表示する。
 * 制限したい場合は論理式`MAX_PER_STUDENT`を使う。
 */
export interface MultiEventStudent {
  studentId: string;
  name: string;
  gender: DisplayGender;
  eventCount: number;
  slots: ReviewSlot[];
}

/** 検査結果1件を、画面のどの枠・どの競技へ色を付けるかへ変換した結果。 */
export interface IssueHighlight {
  issueId: string;
  severity: Severity;
  /** 同じ重要度の中での通し番号。カード見出しの`エラー 1`と枠の目印を一致させる。 */
  displayNumber: number;
  submissionItemIds: string[];
  eventIds: string[];
}

export interface SubmissionReview {
  sameEventDuplicates: SameEventDuplicate[];
  multiEventStudents: MultiEventStudent[];
  issueHighlights: IssueHighlight[];
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
  /** 「フォーム設計」シート上の実際の行番号。行が増減しても点検の案内先がずれない。 */
  rowNumbers?: Partial<Record<
    'year' | 'normalTitle' | 'correctionTitle' | 'deadline' | 'loginRequired',
    number | undefined
  >>;
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
