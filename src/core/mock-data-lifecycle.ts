export function isDevelopmentMockResponseId(responseId: string): boolean {
  return /^mock-response-[0-9]+$/.test(responseId);
}

export function isDevelopmentMockSubmissionId(submissionId: string): boolean {
  return /-mock-response-[0-9]+$/.test(submissionId);
}
