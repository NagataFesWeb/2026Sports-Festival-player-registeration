/**
 * `SpreadsheetApp`の最小限の偽物。読み取り回数を数えて、メモ化の効きと無効化を検証する。
 * 実データは一切含めない。テストの中で作った架空の値だけを入れる。
 */
export type FakeCell = string | number | boolean | Date;

export class FakeRange {
  constructor(
    private readonly sheet: FakeSheet,
    private readonly row: number,
    private readonly column: number,
    private readonly rowCount: number,
    private readonly columnCount: number,
  ) {}

  getValues(): FakeCell[][] {
    this.sheet.reads.values += 1;
    return this.slice();
  }

  getDisplayValues(): string[][] {
    this.sheet.reads.display += 1;
    return this.slice().map((row) => row.map((value) => {
      if (value === '') return '';
      if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
      return String(value);
    }));
  }

  getDisplayValue(): string {
    return this.getDisplayValues()[0]?.[0] ?? '';
  }

  setValues(values: FakeCell[][]): FakeRange {
    this.sheet.writes += 1;
    values.forEach((rowValues, rowOffset) => {
      rowValues.forEach((value, columnOffset) => {
        this.sheet.put(this.row + rowOffset, this.column + columnOffset, value);
      });
    });
    return this;
  }

  setValue(value: FakeCell): FakeRange {
    return this.setValues([[value]]);
  }

  clearContent(): FakeRange {
    this.sheet.writes += 1;
    for (let r = 0; r < this.rowCount; r += 1) {
      for (let c = 0; c < this.columnCount; c += 1) {
        this.sheet.put(this.row + r, this.column + c, '');
      }
    }
    return this;
  }

  getValue(): FakeCell {
    return this.getValues()[0]?.[0] ?? '';
  }

  getRow(): number { return this.row; }
  getColumn(): number { return this.column; }

  clear(): FakeRange { return this.clearContent(); }

  // 書式・入力規則・メモは値へ影響しないので、何もせず自身を返す。
  setFontWeight(): FakeRange { return this; }
  setFontSize(): FakeRange { return this; }
  setFontColor(): FakeRange { return this; }
  setBackground(): FakeRange { return this; }
  setBackgrounds(): FakeRange { return this; }
  setWrap(): FakeRange { return this; }
  setHorizontalAlignment(): FakeRange { return this; }
  setVerticalAlignment(): FakeRange { return this; }
  setNumberFormat(): FakeRange { return this; }
  setNote(): FakeRange { return this; }
  setDataValidation(): FakeRange { return this; }
  clearDataValidations(): FakeRange { return this; }
  setBorder(): FakeRange { return this; }
  setFormula(): FakeRange { return this; }
  mergeAcross(): FakeRange { return this; }
  merge(): FakeRange { return this; }
  breakApart(): FakeRange { return this; }

  private slice(): FakeCell[][] {
    const result: FakeCell[][] = [];
    for (let r = 0; r < this.rowCount; r += 1) {
      const row: FakeCell[] = [];
      for (let c = 0; c < this.columnCount; c += 1) {
        row.push(this.sheet.cell(this.row + r, this.column + c));
      }
      result.push(row);
    }
    return result;
  }
}

export class FakeSheet {
  /** 1始まりの行番号 → 1始まりの列番号 → 値。空セルは持たない。 */
  private readonly cells = new Map<string, FakeCell>();
  readonly reads = { values: 0, display: 0 };
  writes = 0;

  constructor(private name: string, rows: FakeCell[][] = []) {
    rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      this.put(rowIndex + 1, columnIndex + 1, value);
    }));
  }

  getName(): string { return this.name; }
  setName(name: string): FakeSheet { this.name = name; return this; }

  cell(row: number, column: number): FakeCell {
    return this.cells.get(`${row}:${column}`) ?? '';
  }

  put(row: number, column: number, value: FakeCell): void {
    if (value === '') this.cells.delete(`${row}:${column}`);
    else this.cells.set(`${row}:${column}`, value);
  }

  getLastRow(): number {
    let last = 0;
    for (const key of this.cells.keys()) last = Math.max(last, Number(key.split(':')[0]));
    return last;
  }

  getLastColumn(): number {
    let last = 0;
    for (const key of this.cells.keys()) last = Math.max(last, Number(key.split(':')[1]));
    return last;
  }

  getMaxRows(): number { return Math.max(this.getLastRow(), 1000); }
  getMaxColumns(): number { return Math.max(this.getLastColumn(), 26); }

  getRange(row: number, column: number, rowCount = 1, columnCount = 1): FakeRange {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }

  deleteRow(row: number): FakeSheet {
    this.writes += 1;
    const moved = new Map<string, FakeCell>();
    for (const [key, value] of this.cells) {
      const [r, c] = key.split(':').map(Number) as [number, number];
      if (r === row) continue;
      moved.set(`${r > row ? r - 1 : r}:${c}`, value);
    }
    this.cells.clear();
    moved.forEach((value, key) => this.cells.set(key, value));
    return this;
  }

  getDataRange(): FakeRange {
    return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }

  insertColumnBefore(column: number): FakeSheet {
    this.writes += 1;
    const moved = new Map<string, FakeCell>();
    for (const [key, value] of this.cells) {
      const [r, c] = key.split(':').map(Number) as [number, number];
      moved.set(`${r}:${c >= column ? c + 1 : c}`, value);
    }
    this.cells.clear();
    moved.forEach((value, key) => this.cells.set(key, value));
    return this;
  }

  setFrozenRows(): FakeSheet { return this; }
  setFrozenColumns(): FakeSheet { return this; }
  setColumnWidth(): FakeSheet { return this; }
  setColumnWidths(): FakeSheet { return this; }
  setRowHeight(): FakeSheet { return this; }
  setRowHeights(): FakeSheet { return this; }
  hideColumns(): FakeSheet { return this; }
  hideSheet(): FakeSheet { return this; }
  activate(): FakeSheet { return this; }

  /** テストの確認用。データ行だけを2次元配列にする。 */
  rows(): FakeCell[][] {
    const lastRow = this.getLastRow();
    const lastColumn = this.getLastColumn();
    const result: FakeCell[][] = [];
    for (let r = 2; r <= lastRow; r += 1) {
      const row: FakeCell[] = [];
      for (let c = 1; c <= lastColumn; c += 1) row.push(this.cell(r, c));
      result.push(row);
    }
    return result;
  }
}

export class FakeSpreadsheet {
  private readonly sheets = new Map<string, FakeSheet>();

  addSheet(name: string, rows: FakeCell[][] = []): FakeSheet {
    const sheet = new FakeSheet(name, rows);
    this.sheets.set(name, sheet);
    return sheet;
  }

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    return this.addSheet(name);
  }

  getSheets(): FakeSheet[] {
    return [...this.sheets.values()];
  }

  deleteSheet(sheet: FakeSheet): void {
    this.sheets.delete(sheet.getName());
  }

  setActiveSheet(): void { /* 画面操作は再現しない */ }
  setSpreadsheetTimeZone(): FakeSpreadsheet { return this; }
  setSpreadsheetLocale(): FakeSpreadsheet { return this; }
}

/** `SpreadsheetApp.newDataValidation()`の偽物。どのメソッドも自身を返し、`build()`は空オブジェクトを返す。 */
function fakeDataValidationBuilder(): Record<string, unknown> {
  const builder: Record<string, unknown> = {};
  ['requireCheckbox', 'requireDate', 'requireValueInList', 'requireNumberBetween',
    'requireFormulaSatisfied', 'setAllowInvalid', 'setHelpText']
    .forEach((name) => { builder[name] = (): Record<string, unknown> => builder; });
  builder.build = (): Record<string, never> => ({});
  return builder;
}

/** `SpreadsheetApp`をこの偽物へ差し替えたときのグローバル値。 */
export function fakeSpreadsheetApp(book: FakeSpreadsheet): Record<string, unknown> {
  return {
    getActiveSpreadsheet: (): FakeSpreadsheet => book,
    flush: (): void => { /* 何もしない */ },
    newDataValidation: (): Record<string, unknown> => fakeDataValidationBuilder(),
  };
}
