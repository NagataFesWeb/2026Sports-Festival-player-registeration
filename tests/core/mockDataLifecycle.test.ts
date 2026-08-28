import { describe, expect, it } from 'vitest';
import {
  isDevelopmentMockResponseId,
  isDevelopmentMockSubmissionId,
} from '../../src/core/mock-data-lifecycle';

describe('開発用疑似データの識別', () => {
  it('疑似フォーム回答と疑似申請だけを識別する', () => {
    expect(isDevelopmentMockResponseId('mock-response-01')).toBe(true);
    expect(isDevelopmentMockSubmissionId('FORM-form-1-mock-response-01')).toBe(true);
    expect(isDevelopmentMockResponseId('real-response-01')).toBe(false);
    expect(isDevelopmentMockSubmissionId('FORM-form-1-real-response-01')).toBe(false);
    expect(isDevelopmentMockSubmissionId('mock-submission-01')).toBe(false);
  });
});
