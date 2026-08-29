import { SCRIPT_PROPERTIES, SHEETS } from '../shared/constants';

export interface ProtectionSetupResult {
  mode: 'STRICT' | 'WARNING';
  protectedSheetCount: number;
  message: string;
}

const DESCRIPTION = '選手登録管理システム：専用画面から操作してください';
const SYSTEM_SHEETS = [
  SHEETS.dashboard,
  SHEETS.submissions,
  SHEETS.items,
  SHEETS.issues,
  SHEETS.registrations,
  SHEETS.rosterHistory,
  SHEETS.approvals,
  SHEETS.changeHistory,
  SHEETS.rawFormResponses,
  SHEETS.systemConfig,
  SHEETS.settingsChangeHistory,
  SHEETS.publicSettingsSnapshot,
  SHEETS.liveFormTest,
] as const;

function configuredEditors(): string[] {
  const raw = PropertiesService.getScriptProperties()
    .getProperty(SCRIPT_PROPERTIES.authorizedEditorEmails) ?? '';
  return [...new Set(raw.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

export function setupSystemSheetProtections(): ProtectionSetupResult {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const editors = configuredEditors();
  const strict = editors.length > 0;
  let protectedSheetCount = 0;
  SYSTEM_SHEETS.forEach((sheetName) => {
    const sheet = book.getSheetByName(sheetName);
    if (!sheet) return;
    const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET)
      .find((protection) => protection.getDescription() === DESCRIPTION);
    const protection = existing ?? sheet.protect().setDescription(DESCRIPTION);
    if (!strict) {
      protection.setWarningOnly(true);
      protectedSheetCount += 1;
      return;
    }
    protection.setWarningOnly(false);
    protection.addEditors(editors);
    const removable = protection.getEditors()
      .filter((user) => !editors.includes(user.getEmail().toLowerCase()));
    if (removable.length > 0) protection.removeEditors(removable);
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    protectedSheetCount += 1;
  });
  return {
    mode: strict ? 'STRICT' : 'WARNING',
    protectedSheetCount,
    message: strict
      ? `${protectedSheetCount}枚のシステムシートを、設定済みの担当者だけが編集できるように保護しました。`
      : `${protectedSheetCount}枚のシステムシートに編集警告を設定しました。本番モードへ切り替えると、登録した体育祭スタッフ共有Gmailアカウントだけの厳格保護になります。`,
  };
}
