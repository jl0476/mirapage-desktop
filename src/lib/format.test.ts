import { describe, expect, it } from 'vitest';
import { browseHistoryExportFileName, formatExportTimestamp } from './format';

describe('formatExportTimestamp', () => {
  it('各段补零（月/日/时/分/秒 < 10）', () => {
    expect(formatExportTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102_030405');
  });

  it('两位段不补零、跨年正常', () => {
    expect(formatExportTimestamp(new Date(2026, 11, 31, 23, 59, 59))).toBe('20261231_235959');
  });

  it('导出文件名拼接（browse_history_ 前缀 + .json 后缀）', () => {
    expect(browseHistoryExportFileName(new Date(2026, 7, 18, 16, 19, 25))).toBe(
      'browse_history_20260818_161925.json'
    );
  });
});
