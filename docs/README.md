# ドキュメント索引

| ファイル | 内容 |
|---|---|
| [spec.md](spec.md) | システム全体仕様、MVP、受け入れ条件、実装タスク |
| [ui.md](ui.md) | 機能の出し分けと説明の規則、管理画面、件数ボタン、詳細表示、承認・却下・修正UI |
| [forms.md](forms.md) | 通常登録フォーム・修正申請フォームの確定フォーマット |
| [settings.md](settings.md) | 競技・ルール設定、設定点検、年度別フォーム生成 |
| [rule-expression-guide.md](rule-expression-guide.md) | 論理式ルールの変数・演算子・全設定例・注意事項 |
| [data-model.md](data-model.md) | データ構造、一意ID、状態遷移、帳票同期 |
| [security.md](security.md) | 個人情報保護、権限、LLM利用制限、監査・復旧 |
| [operation-manual.md](operation-manual.md) | PC初心者向けの図入り操作マニュアル |
| [handover-test.md](handover-test.md) | 第三者が説明なしで操作できるか確認する試験表 |
| [production-verification-checklist.md](production-verification-checklist.md) | Apps Script反映後から本番開始前までの確認チェックリスト |

機能の一覧はドキュメントに置かない。正本は`src/core/feature-catalog.ts`で、スプレッドシートのメニュー「選手登録管理」→「この管理表でできること」から読める。コード側と一覧を二重に持つと必ず片方が古くなるため、docsには規則だけを書く。
