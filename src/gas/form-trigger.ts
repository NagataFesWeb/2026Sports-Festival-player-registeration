export function installGeneratedFormTriggers(formIds: string[]): void {
  const existing = new Set(ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'handleGeneratedFormSubmit')
    .map((trigger) => trigger.getTriggerSourceId()));
  formIds.forEach((formId) => {
    if (existing.has(formId)) return;
    ScriptApp.newTrigger('handleGeneratedFormSubmit')
      .forForm(FormApp.openById(formId))
      .onFormSubmit()
      .create();
  });
}

export function retireGeneratedForms(formIds: string[]): void {
  if (formIds.length === 0) return;
  removeGeneratedFormTriggers(formIds);
  formIds.forEach((formId) => {
    const form = FormApp.openById(formId);
    form.setAcceptingResponses(false);
    const publishable = form as typeof form & { setPublished(enabled: boolean): GoogleAppsScript.Forms.Form };
    publishable.setPublished(false);
    DriveApp.getFileById(formId).setTrashed(true);
  });
}

export function removeGeneratedFormTriggers(formIds: string[]): void {
  if (formIds.length === 0) return;
  const retired = new Set(formIds);
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'handleGeneratedFormSubmit')
    .filter((trigger) => retired.has(trigger.getTriggerSourceId()))
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
}
