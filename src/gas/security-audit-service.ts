export interface SharingAuditResult {
  checkedCount: number;
  broadSharingCount: number;
  truncated: boolean;
  issues: string[];
  message: string;
}

const MAX_CHECKED_ITEMS = 500;

function isBroadAccess(access: GoogleAppsScript.Drive.Access): boolean {
  return access === DriveApp.Access.ANYONE
    || access === DriveApp.Access.ANYONE_WITH_LINK
    || access === DriveApp.Access.DOMAIN
    || access === DriveApp.Access.DOMAIN_WITH_LINK;
}

export function auditManagementSharing(): SharingAuditResult {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const managementFile = DriveApp.getFileById(spreadsheet.getId());
  const issues: string[] = [];
  let checkedCount = 0;
  let truncated = false;
  const checkFile = (file: GoogleAppsScript.Drive.File, label: string): void => {
    if (checkedCount >= MAX_CHECKED_ITEMS) {
      truncated = true;
      return;
    }
    checkedCount += 1;
    if (isBroadAccess(file.getSharingAccess())) issues.push(label);
  };
  const checkFolder = (folder: GoogleAppsScript.Drive.Folder, label: string): void => {
    if (checkedCount >= MAX_CHECKED_ITEMS) {
      truncated = true;
      return;
    }
    checkedCount += 1;
    if (isBroadAccess(folder.getSharingAccess())) issues.push(label);
    const files = folder.getFiles();
    while (files.hasNext() && !truncated) checkFile(files.next(), `${label}内のファイル`);
    const folders = folder.getFolders();
    while (folders.hasNext() && !truncated) checkFolder(folders.next(), `${label}内のフォルダ`);
  };

  checkFile(managementFile, '管理スプレッドシート');
  const parents = managementFile.getParents();
  while (parents.hasNext() && !truncated) {
    const rosterFolders = parents.next().getFoldersByName('選手名簿');
    while (rosterFolders.hasNext() && !truncated) checkFolder(rosterFolders.next(), '選手名簿フォルダ');
  }
  return {
    checkedCount,
    broadSharingCount: issues.length,
    truncated,
    issues,
    message: issues.length > 0
      ? `共有範囲が広すぎる場所を${issues.length}件確認しました。Google Driveの共有を「制限付き」にし、必要なGoogleアカウントだけを追加してください。`
      : truncated
        ? `${checkedCount}件まで確認しました。件数が多いため、残りはGoogle Driveで手動確認してください。`
        : `${checkedCount}件を確認し、不特定多数への共有は見つかりませんでした。`,
  };
}
