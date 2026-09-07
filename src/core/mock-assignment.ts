import { ruleExpressionHolds, ruleTargetItems } from './validation';
import type { RuleSetting, Student, Submission, SubmissionItem } from '../shared/types';

/**
 * 疑似データの選手枠。フォーム項目対応表の学籍番号欄1行に対応する。
 * 割り当ての判断に必要な情報だけを持ち、フォームやシートには触れない。
 */
export interface MockSlot {
  eventId: string;
  eventName: string;
  /** 「出場しない」を選べない枠。必ず選手を入れる。 */
  required: boolean;
  /** 競技設定で欠員を許可している枠。生徒が足りなければ空けてよい。 */
  vacancyAllowed: boolean;
}

export interface MockAssignmentInput {
  slots: MockSlot[];
  /** 登録対象クラスの生徒。出席番号順。 */
  classStudents: Student[];
  /** 生徒マスター全体。別クラス・存在しない学籍番号の判定に使う。 */
  students: Student[];
  rules: RuleSetting[];
  grade: number;
  classNumber: number;
  /** 同じクラスで複数回作るときに、選ぶ生徒をずらす開始位置。 */
  studentOffset: number;
}

export interface MockAssignmentResult {
  /** 枠ごとの学籍番号。欠員として空けた枠は空文字。 */
  studentIds: string[];
  /** 満たせなかったルールの説明。空なら全ルールを満たしている。 */
  unsatisfiedRules: string[];
}

/** 意図的にルールを破るための差し替え案。 */
export interface MockViolationCandidate {
  slotIndex: number;
  studentId: string;
  /** 破るルール。`rule_id｜ルール名`。 */
  ruleLabel: string;
  eventName: string;
  /** この差し替えで一緒に成立しなくなる、ほかのルールの数。少ないほうから試す。 */
  sideEffectCount: number;
}

/** 1枠あたり、悪化しない候補が見つかってからさらに探す件数。 */
const EQUAL_SCORE_SCAN = 4;
/** 1枠あたりに試す候補の上限。生徒数が多くても割り当てが終わらなくならないようにする。 */
const CANDIDATE_SCAN_LIMIT = 60;
/** 修復に使える論理式の評価回数。使い切ったら、満たせなかったルールとして報告する。 */
const REPAIR_EVALUATION_BUDGET = 15_000;
/** 修復の繰り返し上限。 */
const REPAIR_PASS_LIMIT = 6;
/** 成立しないルールを組み直すときに、先頭の枠へ入れてみる生徒の数。 */
const RESOLVE_SEED_LIMIT = 8;
/** 意図的にルールを破るとき、1ルールあたりに調べる枠の数。 */
const VIOLATION_SLOT_SCAN = 12;

interface RuleScope {
  rule: RuleSetting;
  label: string;
  slotIndexes: number[];
}

/** まだ決めていない枠は`undefined`、欠員として空けた枠は空文字を返す関数。 */
type SlotStudentIdReader = (slotIndex: number) => string | undefined;

/**
 * この枠を「出場しない」として空けてよいか。
 * 競技設定が欠員を許可していても、フォームに登録状態の質問が無い枠は空けられない。
 * 空けると`REQUIRED_SLOT_MISSING`のエラーになり、避けたい問題より重くなる。
 */
export function canLeaveVacant(slot: MockSlot): boolean {
  return slot.vacancyAllowed && !slot.required;
}

/**
 * ルール設定の論理式を満たすように、疑似データの選手を割り当てる。
 * 論理式の意味は解釈せず、「候補を仮に入れて論理式を評価する」ことだけで判断する。
 * どうしても満たせないルールがあっても止めず、満たせなかったルールを返す。
 */
export function assignMockStudents(input: MockAssignmentInput): MockAssignmentResult {
  const submission = mockSubmission(input.grade, input.classNumber);
  const studentsById = new Map(input.students.map((student) => [student.studentId, student]));
  const scopes = buildRuleScopes(input.slots, input.rules);
  const scopesBySlot: RuleScope[][] = input.slots.map(() => []);
  scopes.forEach((scope) => scope.slotIndexes.forEach((index) => scopesBySlot[index]?.push(scope)));

  const assigned: string[] = input.slots.map(() => '');
  const decided: boolean[] = input.slots.map(() => false);
  const readId: SlotStudentIdReader = (index) => (decided[index] ? assigned[index] : undefined);
  const itemCache = slotItemCache(input.slots);
  const holds = (scope: RuleScope, reader: SlotStudentIdReader): boolean =>
    scopeHolds(scope, reader, itemCache, submission, studentsById);

  const usedByEvent = new Map<string, Set<string>>();
  const usageByStudent = new Map<string, number>();
  const eventUsers = (eventId: string): Set<string> => {
    const used = usedByEvent.get(eventId) ?? new Set<string>();
    usedByEvent.set(eventId, used);
    return used;
  };

  // 空けられない枠から先に、そして関係するルールが多い枠から先に決める。
  const order = input.slots
    .map((slot, index) => ({ slot, index }))
    .sort((left, right) =>
      Number(canLeaveVacant(left.slot)) - Number(canLeaveVacant(right.slot))
      || (scopesBySlot[right.index]?.length ?? 0) - (scopesBySlot[left.index]?.length ?? 0)
      || left.index - right.index);

  order.forEach(({ slot, index }, allocationIndex) => {
    const used = eventUsers(slot.eventId);
    const candidates = orderedCandidates(input, used, usageByStudent, allocationIndex);
    if (candidates.length === 0) {
      decided[index] = true;
      assigned[index] = '';
      return;
    }
    const best = chooseForSlot({
      slotIndex: index, candidates, affected: scopesBySlot[index] ?? [],
      assigned, decided, holds, readId,
    });
    used.add(best);
    usageByStudent.set(best, (usageByStudent.get(best) ?? 0) + 1);
  });

  repairAssignment({
    input, scopes, scopesBySlot, assigned, decided, usedByEvent, usageByStudent, holds, readId,
  });

  return {
    studentIds: assigned,
    unsatisfiedRules: scopes
      .filter((scope) => !holds(scope, readId))
      .map((scope) => `${scope.label} / 論理式：${scope.rule.expression ?? ''}`
        + ` / 対象：${scopeEventNames(scope, input.slots)}`),
  };
}

/**
 * 指定した判定のルールを1つだけ成立しなくする差し替え案を、試す順に返す。
 * 実際にどんな検査結果になるかは呼び出し側が`validateSubmission`で確かめる。
 */
export function findRuleViolationCandidates(
  input: MockAssignmentInput,
  studentIds: readonly string[],
  judgment: RuleSetting['judgment'],
  ruleOffset: number,
  limit: number,
): MockViolationCandidate[] {
  const submission = mockSubmission(input.grade, input.classNumber);
  const studentsById = new Map(input.students.map((student) => [student.studentId, student]));
  const allScopes = buildRuleScopes(input.slots, input.rules);
  const scopes = allScopes.filter((scope) => scope.rule.judgment === judgment);
  if (scopes.length === 0) return [];
  const ordered = scopes.map((_, offset) => scopes[(ruleOffset + offset) % scopes.length]!);
  const itemCache = slotItemCache(input.slots);
  const cleanReader: SlotStudentIdReader = (index) => studentIds[index];
  const heldBefore = new Set(allScopes
    .filter((scope) => scopeHolds(scope, cleanReader, itemCache, submission, studentsById)));
  const found: MockViolationCandidate[] = [];

  for (const target of ordered) {
    let scanned = 0;
    for (const slotIndex of target.slotIndexes) {
      if (!studentIds[slotIndex]) continue;
      if (scanned >= VIOLATION_SLOT_SCAN) break;
      scanned += 1;
      for (const replacement of replacementIds(input, studentIds, target, slotIndex, studentsById)) {
        const reader: SlotStudentIdReader = (index) =>
          (index === slotIndex ? replacement : studentIds[index]);
        if (scopeHolds(target, reader, itemCache, submission, studentsById)) continue;
        const sideEffectCount = allScopes
          .filter((scope) => scope !== target && heldBefore.has(scope)
            && !scopeHolds(scope, reader, itemCache, submission, studentsById))
          .length;
        found.push({
          slotIndex,
          studentId: replacement,
          ruleLabel: target.label,
          eventName: input.slots[slotIndex]?.eventName ?? '',
          sideEffectCount,
        });
        break;
      }
      if (found.length >= limit * 2) break;
    }
    if (found.length >= limit * 2) break;
  }
  return found
    .sort((left, right) => left.sideEffectCount - right.sideEffectCount)
    .slice(0, limit);
}

/** 枠を差し替える候補の学籍番号。ルールを壊しやすいものから順に返す。 */
function replacementIds(
  input: MockAssignmentInput,
  studentIds: readonly string[],
  target: RuleScope,
  slotIndex: number,
  studentsById: Map<string, Student>,
): string[] {
  const eventId = input.slots[slotIndex]?.eventId ?? '';
  const usedInEvent = new Set(input.slots
    .map((slot, index) => (slot.eventId === eventId ? studentIds[index] ?? '' : ''))
    .filter(Boolean));
  usedInEvent.delete(studentIds[slotIndex] ?? '');
  const current = studentsById.get(studentIds[slotIndex] ?? '');

  // 対象ルールの中でいちばん多く出ている生徒。出場回数の上限ルールを超えさせる。
  const usageInScope = new Map<string, number>();
  target.slotIndexes.forEach((index) => {
    const id = studentIds[index];
    if (id) usageInScope.set(id, (usageInScope.get(id) ?? 0) + 1);
  });
  const busiest = [...usageInScope.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id)
    .find((id) => !usedInEvent.has(id) && id !== studentIds[slotIndex]);

  const otherClass = input.students.find((student) =>
    student.grade === input.grade && student.classNumber !== input.classNumber);
  // 書式は正しいが生徒マスターに無い学籍番号。出席番号99番の生徒は作られない。
  const unknownId = `${input.grade}${input.classNumber}99`;
  const opposite = input.classStudents.find((student) =>
    student.gender !== current?.gender && !usedInEvent.has(student.studentId));

  return [
    ...(busiest ? [busiest] : []),
    ...(opposite ? [opposite.studentId] : []),
    ...(studentsById.has(unknownId) ? [] : [unknownId]),
    ...(otherClass ? [otherClass.studentId] : []),
    ...input.classStudents
      .map((student) => student.studentId)
      .filter((id) => !usedInEvent.has(id) && id !== studentIds[slotIndex]),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

interface RepairContext {
  input: MockAssignmentInput;
  scopes: RuleScope[];
  scopesBySlot: RuleScope[][];
  assigned: string[];
  decided: boolean[];
  usedByEvent: Map<string, Set<string>>;
  usageByStudent: Map<string, number>;
  holds: (scope: RuleScope, reader: SlotStudentIdReader) => boolean;
  readId: SlotStudentIdReader;
}

/**
 * 割り当て後に成立していないルールを、枠の生徒を1人ずつ差し替えて直す。
 * ほかのルールを壊さない差し替えだけを受け入れる。評価回数を使い切ったら諦める。
 */
function repairAssignment(context: RepairContext): void {
  let budget = REPAIR_EVALUATION_BUDGET;
  // 1つのルールを直すと別のルールが崩れることがあるので、いちばん良かった状態を覚えておく。
  let best = [...context.assigned];
  let bestFailing = countFailing(context);
  for (let pass = 0; pass < REPAIR_PASS_LIMIT; pass += 1) {
    const failing = context.scopes.filter((scope) => !context.holds(scope, context.readId));
    if (failing.length === 0) return;
    let improved = false;
    for (const target of failing) {
      if (budget <= 0) return;
      const replaced = repairByReplacement(context, target, budget);
      budget -= replaced.evaluations;
      if (replaced.improved) { improved = true; continue; }
      if (budget <= 0) return;
      // 1人だけ入れ替えても直らないことがある（例：4人とも同性にしたいのに1人だけ違う）。
      // その場合は、そのルールの枠をいったん空にして、先頭の生徒を変えながら組み直す。
      const resolved = repairByResolve(context, target, budget);
      budget -= resolved.evaluations;
      if (resolved.improved) { improved = true; continue; }
      if (budget <= 0) return;
      const swapped = repairBySwap(context, target, budget);
      budget -= swapped.evaluations;
      if (swapped.improved) { improved = true; continue; }
      if (budget <= 0) return;
      // 生徒の組み替えでは直らないときの最後の手段として、欠員許可の枠を空ける。
      const vacated = repairByVacancy(context, target, budget);
      budget -= vacated.evaluations;
      if (vacated.improved) improved = true;
    }
    const failingNow = countFailing(context);
    if (failingNow < bestFailing) {
      bestFailing = failingNow;
      best = [...context.assigned];
    }
    if (!improved) break;
  }
  if (countFailing(context) > bestFailing) {
    best.forEach((studentId, index) => { context.assigned[index] = studentId; });
  }
}

function countFailing(context: RepairContext): number {
  return context.scopes.filter((scope) => !context.holds(scope, context.readId)).length;
}

function repairByReplacement(
  context: RepairContext,
  target: RuleScope,
  budget: number,
): { improved: boolean; evaluations: number } {
  const { input, assigned, scopesBySlot, usedByEvent, usageByStudent, holds, readId } = context;
  let evaluations = 0;
  for (const slotIndex of target.slotIndexes) {
    const slot = input.slots[slotIndex];
    if (!slot) continue;
    const affected = scopesBySlot[slotIndex] ?? [];
    const before = affected.filter((scope) => holds(scope, readId)).length;
    evaluations += affected.length;
    const used = usedByEvent.get(slot.eventId) ?? new Set<string>();
    // 空いている枠も対象にする。`N >= 36`のように登録人数を増やさないと直せないルールがある。
    const previous = assigned[slotIndex] ?? '';
    // 生徒を全部試してから、最後に「空ける」案を試す。埋められる枠は空けない。
    const replacements = [
      ...input.classStudents.map((student) => student.studentId),
      ...(canLeaveVacant(slot) ? [''] : []),
    ];
    for (const replacement of replacements) {
      if (evaluations >= budget) return { improved: false, evaluations };
      if (replacement === previous || (replacement !== '' && used.has(replacement))) continue;
      assigned[slotIndex] = replacement;
      const after = affected.filter((scope) => holds(scope, readId)).length;
      evaluations += affected.length;
      if (after > before) {
        if (previous !== '') {
          used.delete(previous);
          usageByStudent.set(previous, Math.max(0, (usageByStudent.get(previous) ?? 1) - 1));
        }
        if (replacement !== '') {
          used.add(replacement);
          usageByStudent.set(replacement, (usageByStudent.get(replacement) ?? 0) + 1);
        }
        return { improved: true, evaluations };
      }
      assigned[slotIndex] = previous;
    }
  }
  return { improved: false, evaluations };
}

/**
 * 生徒の組み替えでは直らないルールを、欠員を許可した枠を空けて直す。
 * 全部の枠が決まったあとに数えるので、途中の集計に引きずられて空けすぎることはない。
 * 1枠空けただけでは直らないルール（39人のクラスで44枠を`MAX_PER_STUDENT <= 1`にする等）が
 * あるため、対象のルールが成立するまで続けて空け、まとめて採用する。
 * ほかのルールを崩す枠は空けず、全体の不成立ルールが減らなければ全部元に戻す。
 */
function repairByVacancy(
  context: RepairContext,
  target: RuleScope,
  budget: number,
): { improved: boolean; evaluations: number } {
  const { input, assigned, usedByEvent, usageByStudent, scopes, holds, readId } = context;
  const remaining = new Set(target.slotIndexes
    .filter((index) => assigned[index] && canLeaveVacant(input.slots[index]!)));
  if (remaining.size === 0) return { improved: false, evaluations: 0 };
  const before = countFailing(context);
  let evaluations = scopes.length;
  const emptied: Array<{ index: number; studentId: string }> = [];

  while (remaining.size > 0 && evaluations < budget) {
    evaluations += 1;
    if (holds(target, readId)) break;
    const index = nextSlotToEmpty(context, target, remaining);
    remaining.delete(index);
    const studentId = assigned[index]!;
    assigned[index] = '';
    evaluations += scopes.length;
    // 空けたことでほかのルールが崩れる枠は空けない。
    if (countFailing(context) > before) { assigned[index] = studentId; continue; }
    emptied.push({ index, studentId });
  }

  evaluations += scopes.length;
  if (emptied.length > 0 && holds(target, readId) && countFailing(context) < before) {
    emptied.forEach(({ index, studentId }) => {
      usedByEvent.get(input.slots[index]!.eventId)?.delete(studentId);
      usageByStudent.set(studentId, Math.max(0, (usageByStudent.get(studentId) ?? 1) - 1));
    });
    return { improved: true, evaluations };
  }
  emptied.forEach(({ index, studentId }) => { assigned[index] = studentId; });
  return { improved: false, evaluations };
}

/**
 * 次に空けてみる枠。同じルールの中で何度も出ている生徒の枠から先に空ける。
 * 論理式の意味は読まず、「重なっている枠から減らす」という数え方だけで決める。
 */
function nextSlotToEmpty(
  context: RepairContext,
  target: RuleScope,
  remaining: Set<number>,
): number {
  const { assigned } = context;
  const usage = new Map<string, number>();
  target.slotIndexes.forEach((index) => {
    const studentId = assigned[index];
    if (studentId) usage.set(studentId, (usage.get(studentId) ?? 0) + 1);
  });
  return [...remaining].sort((left, right) =>
    (usage.get(assigned[right]!) ?? 0) - (usage.get(assigned[left]!) ?? 0)
    || right - left)[0]!;
}

/**
 * 2つの枠の生徒を入れ替えて、成立していないルールを直す。
 * 同じルールに関係する枠どうしだけを試す。同じ競技へ同じ生徒が入る入れ替えはしない。
 */
function repairBySwap(
  context: RepairContext,
  target: RuleScope,
  budget: number,
): { improved: boolean; evaluations: number } {
  const { input, assigned, scopesBySlot, usedByEvent, holds, readId } = context;
  let evaluations = 0;
  for (const leftIndex of target.slotIndexes) {
    const left = input.slots[leftIndex];
    if (!left || !assigned[leftIndex]) continue;
    for (const rightIndex of partnerSlots(scopesBySlot, leftIndex)) {
      if (evaluations >= budget) return { improved: false, evaluations };
      const right = input.slots[rightIndex];
      if (!right || !assigned[rightIndex]) continue;
      const leftStudent: string = assigned[leftIndex]!;
      const rightStudent: string = assigned[rightIndex]!;
      if (leftStudent === rightStudent) continue;
      if (left.eventId !== right.eventId) {
        if (usedByEvent.get(left.eventId)?.has(rightStudent)) continue;
        if (usedByEvent.get(right.eventId)?.has(leftStudent)) continue;
      }
      const affected = [...new Set([
        ...(scopesBySlot[leftIndex] ?? []), ...(scopesBySlot[rightIndex] ?? []),
      ])];
      const before = affected.filter((scope) => holds(scope, readId)).length;
      assigned[leftIndex] = rightStudent;
      assigned[rightIndex] = leftStudent;
      const after = affected.filter((scope) => holds(scope, readId)).length;
      evaluations += affected.length * 2;
      if (after > before) {
        if (left.eventId !== right.eventId) {
          const leftUsers = usedByEvent.get(left.eventId);
          const rightUsers = usedByEvent.get(right.eventId);
          leftUsers?.delete(leftStudent);
          leftUsers?.add(rightStudent);
          rightUsers?.delete(rightStudent);
          rightUsers?.add(leftStudent);
        }
        return { improved: true, evaluations };
      }
      assigned[leftIndex] = leftStudent;
      assigned[rightIndex] = rightStudent;
    }
  }
  return { improved: false, evaluations };
}

/**
 * 成立していないルールの枠をいったん空にして、先頭の枠へ入れる生徒を変えながら組み直す。
 * 「4人とも同性」のように、1枠ずつ直しても抜け出せない組み合わせを解くための手順。
 */
function repairByResolve(
  context: RepairContext,
  target: RuleScope,
  budget: number,
): { improved: boolean; evaluations: number } {
  const { input, assigned, decided, scopesBySlot, usedByEvent, usageByStudent, holds, readId } = context;
  const slotIndexes = target.slotIndexes.filter((index) => assigned[index]);
  if (slotIndexes.length === 0) return { improved: false, evaluations: 0 };
  const snapshot = slotIndexes.map((index) => assigned[index]!);
  let evaluations = 0;

  const eventUsers = (index: number): Set<string> => {
    const eventId = input.slots[index]!.eventId;
    const used = usedByEvent.get(eventId) ?? new Set<string>();
    usedByEvent.set(eventId, used);
    return used;
  };
  const clear = (): void => slotIndexes.forEach((index) => {
    const studentId = assigned[index];
    if (studentId) {
      eventUsers(index).delete(studentId);
      usageByStudent.set(studentId, Math.max(0, (usageByStudent.get(studentId) ?? 1) - 1));
    }
    assigned[index] = '';
    decided[index] = false;
  });
  const place = (index: number, studentId: string): void => {
    eventUsers(index).add(studentId);
    usageByStudent.set(studentId, (usageByStudent.get(studentId) ?? 0) + 1);
    assigned[index] = studentId;
    decided[index] = true;
  };

  clear();
  for (let seed = 0; seed < RESOLVE_SEED_LIMIT; seed += 1) {
    let filledAll = true;
    slotIndexes.forEach((index, position) => {
      const allowVacancy = canLeaveVacant(input.slots[index]!);
      const candidates = orderedCandidates(input, eventUsers(index), usageByStudent, position);
      if (candidates.length === 0) {
        assigned[index] = '';
        decided[index] = true;
        // 空けてよい枠なら、空いたままでも組み直しは成功とみなす。
        if (!allowVacancy) filledAll = false;
        return;
      }
      // 先頭の枠だけ候補の順番をずらして、組全体の顔ぶれを変える。
      const offset = position === 0 ? seed % candidates.length : 0;
      const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
      const chosen = chooseForSlot({
        slotIndex: index, candidates: rotated, affected: scopesBySlot[index] ?? [],
        assigned, decided, holds, readId,
      });
      evaluations += ((scopesBySlot[index] ?? []).length + 1) * 2;
      place(index, chosen);
    });
    evaluations += 1;
    if (filledAll && holds(target, readId)) return { improved: true, evaluations };
    // 次の種を試す前に必ず片付ける。予算切れで抜けるときも、使用中の記録を残さない。
    clear();
    if (evaluations >= budget) break;
  }
  slotIndexes.forEach((index, position) => place(index, snapshot[position]!));
  return { improved: false, evaluations };
}

/** 同じルールに関係する、ほかの枠。入れ替えても意味のない枠は最初から見ない。 */
function partnerSlots(scopesBySlot: RuleScope[][], slotIndex: number): number[] {
  const partners = new Set<number>();
  (scopesBySlot[slotIndex] ?? []).forEach((scope) =>
    scope.slotIndexes.forEach((index) => { if (index !== slotIndex) partners.add(index); }));
  return [...partners];
}

function orderedCandidates(
  input: MockAssignmentInput,
  usedInEvent: Set<string>,
  usageByStudent: Map<string, number>,
  allocationIndex: number,
): string[] {
  const size = input.classStudents.length;
  if (size === 0) return [];
  return input.classStudents
    .map((student, position) => ({
      student,
      rotationRank: (position - input.studentOffset - allocationIndex - 1 + size * 2) % size,
    }))
    .filter(({ student }) => !usedInEvent.has(student.studentId))
    .sort((left, right) =>
      (usageByStudent.get(left.student.studentId) ?? 0) - (usageByStudent.get(right.student.studentId) ?? 0)
      || left.rotationRank - right.rotationRank)
    .map(({ student }) => student.studentId);
}

interface SlotChoiceInput {
  slotIndex: number;
  candidates: string[];
  affected: RuleScope[];
  assigned: string[];
  decided: boolean[];
  holds: (scope: RuleScope, reader: SlotStudentIdReader) => boolean;
  readId: SlotStudentIdReader;
}

/**
 * 1つの枠に入れる生徒を決める。今まで成立しているルールを崩さない候補を優先し、
 * どれも崩してしまう場合は、いちばん多くのルールが成立する候補を選ぶ。
 * ここでは枠を空けない。まだ決めていない枠があるため、
 * 「空ければ成立する」の判断が途中の集計に引きずられるため。空けるのは`repairByVacancy`で行う。
 */
function chooseForSlot(choice: SlotChoiceInput): string {
  const { slotIndex, candidates, affected, assigned, decided, holds, readId } = choice;
  decided[slotIndex] = false;
  const baseline = affected.filter((scope) => holds(scope, readId)).length;
  decided[slotIndex] = true;
  let best = candidates[0]!;
  let bestScore = -1;
  const scanLimit = Math.min(candidates.length, CANDIDATE_SCAN_LIMIT);
  for (let scan = 0; scan < scanLimit; scan += 1) {
    const candidate = candidates[scan]!;
    assigned[slotIndex] = candidate;
    const score = affected.filter((scope) => holds(scope, readId)).length;
    if (score > bestScore) { bestScore = score; best = candidate; }
    if (score > baseline) break;
    if (scan >= EQUAL_SCORE_SCAN - 1 && bestScore >= baseline) break;
  }
  assigned[slotIndex] = best;
  return best;
}

/** ルールごとに、そのルールが見る枠の位置を求める。判定は検査と同じ関数を使う。 */
function buildRuleScopes(slots: MockSlot[], rules: RuleSetting[]): RuleScope[] {
  const skeleton = slots.map((slot, index) => slotItem(slot, index, ''));
  return rules
    .filter((rule) => rule.enabled && (rule.expression ?? '').trim())
    .map((rule) => ({
      rule,
      label: [rule.ruleId, rule.ruleName].map((value) => value.trim()).filter(Boolean).join('｜')
        || 'ルール設定',
      slotIndexes: ruleTargetItems(skeleton, rule).map((item) => Number(item.submissionItemId)),
    }))
    .filter((scope) => scope.slotIndexes.length > 0);
}

/**
 * 枠ごとの申請項目を使い回すための入れ物。
 * 1件の割り当てで論理式を数万回評価するため、評価のたびに項目を作り直すと時間がかかる。
 */
function slotItemCache(slots: MockSlot[]): SubmissionItem[] {
  return slots.map((slot, index) => slotItem(slot, index, ''));
}

function scopeHolds(
  scope: RuleScope,
  readId: SlotStudentIdReader,
  cache: SubmissionItem[],
  submission: Submission,
  studentsById: Map<string, Student>,
): boolean {
  const items: SubmissionItem[] = [];
  for (const index of scope.slotIndexes) {
    const studentId = readId(index);
    if (studentId === undefined) continue;
    const item = cache[index];
    if (!item) continue;
    item.studentIdInput = studentId;
    item.normalizedStudentId = studentId;
    item.registrationState = studentId ? 'REGISTER' : 'NOT_PARTICIPATING';
    items.push(item);
  }
  if (items.length === 0) return true;
  // 論理式が壊れていて判定できないときは、割り当てでは直せないので成立扱いにする。
  // 検査側が`RULE_EXPRESSION_INVALID`として担当者へ知らせる。
  return ruleExpressionHolds(submission, items, studentsById, scope.rule) !== false;
}

function scopeEventNames(scope: RuleScope, slots: MockSlot[]): string {
  const names = [...new Set(scope.slotIndexes.map((index) => slots[index]?.eventName ?? ''))]
    .filter(Boolean);
  return names.length > 0 ? names.join('、') : '対象競技';
}

function slotItem(slot: MockSlot, index: number, studentId: string): SubmissionItem {
  return {
    submissionItemId: String(index),
    submissionId: 'mock-assignment',
    eventId: slot.eventId,
    eventName: slot.eventName,
    slotId: `${slot.eventId}-slot-${String(index).padStart(2, '0')}`,
    slotName: `${index + 1}人目`,
    studentIdInput: studentId,
    studentNameInput: '',
    normalizedStudentId: studentId,
    normalizedName: '',
    registrationState: studentId ? 'REGISTER' : 'NOT_PARTICIPATING',
    required: slot.required,
  };
}

function mockSubmission(grade: number, classNumber: number): Submission {
  return {
    submissionId: 'mock-assignment',
    submissionType: 'INITIAL',
    submittedAt: '',
    submitterStudentId: '',
    submitterNameInput: '',
    submitterEmail: '',
    targetGrade: grade,
    targetClass: classNumber,
    isProxy: false,
    receptionOpen: true,
    status: 'RECEIVED',
    warningCount: 0,
    errorCount: 0,
  };
}
