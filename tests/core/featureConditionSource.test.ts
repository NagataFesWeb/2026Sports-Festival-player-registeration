import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(projectRoot, 'src/gas/feature-service.ts'), 'utf8');

/**
 * メニューの有効・無効を決める判定が、操作を実行したときの判定と食い違わないようにする。
 *
 * 以前、`buildFeatureConditionSnapshot()`が Script Properties から
 * `RULE_CHANGE_ACTIVE`を読み、実際に書き込む`settings-change-service.ts`は
 * Document Properties を使っていた。そのため「ルール設定だけを変更する」は
 * 押せるのに「すでに変更中です」と言われ、「ルール変更を確定して全申請を再検査」は
 * 「変更を始めていません」と言われて、どちらにも進めなくなった。
 * 保存先を知ってよいのは書き込む側のモジュールだけとし、判定は関数で借りる。
 */
describe('機能の利用可否スナップショット', () => {
  it('Properties を自前で読まず、書き込むモジュールの判定関数を呼んでいる', () => {
    const direct = source.split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter((entry) => entry.line.includes('PropertiesService'));
    expect(
      direct.map((entry) => `${entry.number}: ${entry.line}`),
      'src/gas/feature-service.ts が PropertiesService を直接読んでいます。\n'
      + '保存先（Script か Document か）を2か所で決めると、メニューの有効・無効と'
      + '実行時の判定が食い違います。書き込む側のモジュールへ判定関数を作り、'
      + 'それを呼んでください（例: isRuleOnlyChangeActive, isFormBuildJobActive, isPlayerRosterJobActive）。',
    ).toEqual([]);
  });

  it('状態を表す条件が、対応する判定関数から取れている', () => {
    const required = [
      'isPlayerRosterJobActive',
      'isFormBuildJobActive',
      'isRuleOnlyChangeActive',
      'isSettingsChangeActive',
    ];
    const missing = required.filter((name) => !source.includes(`${name}()`));
    expect(
      missing,
      `状態の判定関数が呼ばれていません: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
