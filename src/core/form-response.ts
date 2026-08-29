import type {
  EventSetting,
  FormRegistryRow,
  RegistrationState,
  Submission,
  SubmissionItem,
} from '../shared/types';

export interface FormAnswerContext {
  formId: string;
  responseId: string;
  formType: FormRegistryRow['formType'];
  submittedAt: string;
  respondentEmail: string;
  receptionOpen: boolean;
  answersByFieldKey: Record<string, string>;
  registry: FormRegistryRow[];
  events: EventSetting[];
}

export interface FormAnswerConversion {
  submission: Submission;
  items: SubmissionItem[];
}

export function convertFormAnswer(context: FormAnswerContext): FormAnswerConversion {
  const target = parseTargetClass(context.formType, context.answersByFieldKey);
  const submissionId = `FORM-${context.formId}-${context.responseId}`;
  const submission: Submission = {
    submissionId,
    submissionType: context.formType === 'normal' ? 'INITIAL' : 'CORRECTION',
    submittedAt: context.submittedAt,
    submitterStudentId: context.answersByFieldKey.submitter_student_id ?? '',
    submitterNameInput: context.answersByFieldKey.submitter_name_input ?? '',
    submitterEmail: context.respondentEmail,
    targetGrade: target.grade,
    targetClass: target.classNumber,
    isProxy: (context.answersByFieldKey.is_proxy ?? '').includes('代理'),
    receptionOpen: context.receptionOpen,
    status: 'RECEIVED',
    warningCount: 0,
    errorCount: 0,
  };
  return { submission, items: buildItems(submissionId, context) };
}

function parseTargetClass(
  formType: FormRegistryRow['formType'],
  answers: Record<string, string>,
): { grade: number; classNumber: number } {
  if (formType === 'correction') {
    const match = (answers.target_class ?? '').match(/^([1-3])年([1-8])組$/);
    if (!match) throw new Error('修正対象クラスを読み取れません。フォームの回答内容を確認してください。');
    return { grade: Number(match[1]), classNumber: Number(match[2]) };
  }
  const gradeMatch = (answers.target_grade ?? '').match(/^([1-3])年$/);
  const classMatch = (answers.target_class ?? '').match(/^([1-8])組$/);
  if (!gradeMatch || !classMatch) throw new Error('登録対象の学年・組を読み取れません。フォームの回答内容を確認してください。');
  return { grade: Number(gradeMatch[1]), classNumber: Number(classMatch[1]) };
}

function buildItems(submissionId: string, context: FormAnswerContext): SubmissionItem[] {
  const prefix = context.formType === 'correction' ? 'correction_' : '';
  const studentIdMappings = context.registry
    .filter((mapping) => mapping.enabled && mapping.fieldKey.startsWith(prefix) && mapping.fieldKey.endsWith('_student_id') && mapping.eventId)
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .filter((mapping, index, mappings) =>
      mappings.findIndex((candidate) => candidate.fieldKey === mapping.fieldKey) === index,
    );
  const registryKeys = new Set(context.registry.map((mapping) => mapping.fieldKey));
  const eventsById = new Map(context.events.map((event) => [event.eventId, event]));
  return studentIdMappings
    .filter((mapping) => Object.prototype.hasOwnProperty.call(context.answersByFieldKey, mapping.fieldKey))
    .map((mapping, index) => {
      // 現在のフォームは学籍番号だけを聞く。氏名欄があった頃に公開したフォームの回答も
      // そのまま取り込めるよう、氏名の回答があれば読み取る。
      const nameKey = mapping.fieldKey.replace(/_student_id$/, '_name');
      const stateKey = mapping.fieldKey.replace(/_student_id$/, '_state');
      const slotMatch = mapping.fieldKey.match(/_slot(\d+)_student_id$/);
      const slotNumber = Number(slotMatch?.[1] ?? index + 1);
      const event = eventsById.get(mapping.eventId);
      return {
        submissionItemId: `${submissionId}-item-${String(index + 1).padStart(3, '0')}`,
        submissionId,
        eventId: mapping.eventId,
        eventName: event?.eventName ?? eventNameFromTitle(mapping.title),
        slotId: `${mapping.eventId}-slot-${String(slotNumber).padStart(2, '0')}`,
        slotName: event?.hasOrder === false ? `${slotNumber}人目` : `第${slotNumber}走者`,
        studentIdInput: context.answersByFieldKey[mapping.fieldKey] ?? '',
        studentNameInput: context.answersByFieldKey[nameKey] ?? '',
        normalizedStudentId: '',
        normalizedName: '',
        registrationState: registryKeys.has(stateKey)
          ? registrationState(context.answersByFieldKey[stateKey] ?? '')
          : 'REGISTER',
        required: !registryKeys.has(stateKey),
      };
    });
}

function registrationState(value: string): RegistrationState {
  if (value === '現在調整中') return 'PENDING';
  if (value === '出場しない') return 'NOT_PARTICIPATING';
  return 'REGISTER';
}

function eventNameFromTitle(title: string): string {
  return title.replace(/\s+(第\d+走者|\d+人目)\s+学籍番号$/, '').trim() || '競技名未設定';
}
