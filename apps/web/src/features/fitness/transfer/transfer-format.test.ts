import { describe, expect, it } from 'vitest';
import catalog from '../exercise-catalog.json';
import { preferencesPayload } from '../preferences-model';
import {
  buildTransferPreview,
  detectTransferExercise,
  detectTransferMapping,
  encodeTransferCsv,
  encodeTransferJson,
  parseTransferTable,
  transferExerciseNames,
  transferId,
  type TransferRecord,
} from './transfer-format';

const now = '2026-09-30T10:00:00.000Z';
const templateId = '10000000-0000-4000-8000-000000000001';
const exercise = {
  id: '10000000-0000-4000-8000-000000000002',
  exercise_id: '0025',
  rest_seconds: 90,
  warmup_rest_seconds: 30,
  sets: [
    {
      id: '10000000-0000-4000-8000-000000000003',
      kind: 'working' as const,
      weight: null,
      weight_left: '123456789012345678.1234567891',
      weight_right: '123456789012345678.1234567891',
      reps: 8,
    },
  ],
};
const template: TransferRecord = {
  id: templateId,
  entity_type: 'fitness_template',
  payload: {
    name: '包含,逗号与\n换行的模板',
    catalog_origin: { source: 'official', item_id: 'test', revision: 2 },
    exercises: [exercise],
    created_at: now,
    updated_at: now,
  },
};
const preferences: TransferRecord = {
  id: '10000000-0000-4000-8000-000000000004',
  entity_type: 'fitness_preferences',
  payload: {
    ...preferencesPayload(undefined, now),
    default_warmup_rest_seconds: 30,
    exercise_rest_settings: { '0025': { rest_seconds: 60, warmup_rest_seconds: 20 } },
  },
};

/** 使用实际字段识别路径测试完整文件，避免仅测序列化互为逆运算。 */
async function preview(text: string) {
  const table = parseTransferTable(text);
  return buildTransferPreview(table, detectTransferMapping(table.headers), catalog, {}, now);
}

describe('fitness transfer formats', () => {
  it('动作导入按正式中英文名称或身份匹配，不自动推测未知名称', async () => {
    const entry = catalog.exercises[0]!;
    const known = { exercises: [entry] };
    expect(detectTransferExercise(entry.name_zh, known)).toBe(entry.id);
    expect(detectTransferExercise(entry.name_en.toUpperCase(), known)).toBe(entry.id);
    expect(detectTransferExercise(entry.id, known)).toBe(entry.id);
    expect(detectTransferExercise('没有此动作', known)).toBeUndefined();

    const table = parseTransferTable(`数据类型,名称,动作,组数,重量,次数\n模板,正式名称导入,${entry.name_zh},2,20,8`);
    const result = await buildTransferPreview(table, detectTransferMapping(table.headers), known, {}, now);
    expect(result.records[0]).toMatchObject({ payload: { exercises: [{ exercise_id: entry.id }] } });
  });

  it('keeps mobile native JSON template precision, catalogue origin and optional preferences intact', async () => {
    const result = await preview(encodeTransferJson([template, preferences]));
    expect(result.records).toEqual([template, preferences]);
  });

  it('roundtrips quoted CSV newlines, commas and full nested payloads without losing precision', async () => {
    const result = await preview(encodeTransferCsv([template, preferences]));
    expect(result.records).toEqual([template, preferences]);
  });

  it('preserves running segments, timer, completed sets and rest history', async () => {
    const record: TransferRecord = {
      id: '10000000-0000-4000-8000-000000000005',
      entity_type: 'fitness_workout',
      payload: {
        name: '暂停中的训练',
        scheduled_date: '2026-09-30',
        source_kind: 'template',
        source_plan_id: null,
        source_plan_name: null,
        source_template_id: templateId,
        occurrence_key: null,
        status: 'in_progress',
        exercises: [
          { ...exercise, sets: [{ ...exercise.sets[0]!, completed: true, rest_durations_seconds: [22, 45] }] },
        ],
        run_segments: [{ started_at: now, ended_at: '2026-09-30T10:05:00.000Z' }],
        rest_timer: null,
        created_at: now,
        updated_at: '2026-09-30T10:05:00.000Z',
      },
    };
    expect((await preview(encodeTransferJson([record]))).records).toEqual([record]);
  });

  it.each([encodeTransferJson, encodeTransferCsv])('手动休息计时器导入保留空的动作和组关联', async (encode) => {
    const record: TransferRecord = {
      id: '10000000-0000-4000-8000-000000000009',
      entity_type: 'fitness_workout',
      payload: {
        name: '手动休息',
        scheduled_date: '2026-09-30',
        source_kind: 'blank',
        source_plan_id: null,
        source_plan_name: null,
        source_template_id: null,
        occurrence_key: null,
        status: 'in_progress',
        exercises: [],
        run_segments: [{ started_at: now, ended_at: null }],
        rest_timer: {
          status: 'running',
          ends_at: '2026-09-30T10:01:30.000Z',
          remaining_seconds: 90,
          duration_seconds: 90,
          elapsed_seconds: 0,
          exercise_id: null,
          set_id: null,
        },
        created_at: now,
        updated_at: now,
      },
    };
    expect((await preview(encode([record]))).records).toEqual([record]);
  });

  it.each(['constructor', '__proto__'])('原型同名值 %s 不能代替数据类型或显式动作映射', async (value) => {
    await expect(preview(`数据类型,名称,动作,训练日期\n${value},测试,0025,2026-09-30`)).rejects.toThrow('数据类型');
    await expect(preview(`数据类型,名称,动作\n模板,测试,${value}`)).rejects.toThrow('未匹配');
  });

  it('映射原型同名列时，缺失名称必须交由名称校验拒绝', async () => {
    const rows: Record<string, unknown>[] = [
      { entity_type: 'fitness_template', constructor: '有效名称', exercises: [exercise] },
      { entity_type: 'fitness_template', exercises: [exercise] },
    ];
    const table = parseTransferTable(JSON.stringify(rows));
    const mapping = { ...detectTransferMapping(table.headers), name: 'constructor' };
    await expect(buildTransferPreview(table, mapping, catalog, {}, now)).rejects.toThrow('名称需为');
  });

  it('keeps current/pending schedules and all generation history from mobile exports', async () => {
    const days = [
      {
        day_index: 0,
        slot: {
          id: '10000000-0000-4000-8000-000000000006',
          name: '推日',
          source_template_id: templateId,
          exercises: [exercise],
        },
      },
      { day_index: 1, slot: null },
    ];
    const record: TransferRecord = {
      id: '10000000-0000-4000-8000-000000000007',
      entity_type: 'fitness_plan',
      payload: {
        name: '周期',
        cycle_days: 2,
        days,
        start_date: '2026-09-30',
        status: 'in_progress',
        generation_state: {
          next_cycle_start_date: '2026-10-02',
          next_cycle_index: 1,
          generated_cycles: [
            {
              cycle_index: 0,
              start_date: '2026-09-30',
              cycle_days: 2,
              generated_from_date: '2026-09-30',
              rest_dates: ['2026-10-01'],
            },
          ],
        },
        pending_schedule: { cycle_days: 1, days: days.slice(0, 1) },
        created_at: now,
        updated_at: now,
      },
    };
    expect((await preview(encodeTransferJson([record]))).records).toEqual([record]);
  });

  it('groups flat CSV rows into exercise sets and keeps missing plan days as rest', async () => {
    const text =
      '数据类型,名称,训练日,循环天数,动作,组数,重量,次数\n计划,力量周期,1,3,0025,2,32.5,8\n计划,力量周期,1,3,0025,1,35,6\n计划,力量周期,3,3,0025,1,30,10';
    const result = await preview(text);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.entity_type).toBe('fitness_plan');
    if (record.entity_type !== 'fitness_plan') throw new Error('wrong type');
    expect(record.payload.days[0]?.slot?.exercises).toHaveLength(1);
    expect(record.payload.days[0]?.slot?.exercises[0]?.sets.map((set) => set.reps)).toEqual([8, 8, 6]);
    expect(new Set(record.payload.days[0]?.slot?.exercises[0]?.sets.map((set) => set.id)).size).toBe(3);
    expect(record.payload.days[1]?.slot).toBeNull();
    expect(record.payload.status).toBe('closed');
  });

  it('manual field and exercise mappings are applied before preview and produce stable identities', async () => {
    const table = parseTransferTable('kind,title,movement,kg,count\ntemplate,导入,不认识的动作,31.1234567891,9');
    const mapping = { entity_type: 'kind', name: 'title', exercise: 'movement', weight: 'kg', reps: 'count' };
    expect(transferExerciseNames(table, mapping)).toEqual(['不认识的动作']);
    await expect(buildTransferPreview(table, mapping, catalog, {}, now)).rejects.toThrow('未匹配');
    const a = await buildTransferPreview(table, mapping, catalog, { 不认识的动作: '0025' }, now);
    const b = await buildTransferPreview(table, mapping, catalog, { 不认识的动作: '0025' }, now);
    expect(a).toEqual(b);
    expect(a.exportId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('accepts custom exercise references when the same file contains their definition', async () => {
    const customId = 'custom:10000000-0000-4000-8000-000000000008';
    const custom = {
      ...preferences,
      payload: {
        ...preferences.payload,
        custom_exercises: [
          {
            id: customId,
            name_zh: '自定义',
            name_zh_hant: '自訂義',
            name_en: 'Custom',
            body_part: 'chest',
            target: 'pectorals',
            equipment: 'body weight',
            instructions_zh: [],
            instructions_zh_hant: [],
            instructions_en: [],
            image: null,
            deleted: false,
          },
        ],
      },
    };
    const records = [
      custom,
      { ...template, payload: { ...template.payload, exercises: [{ ...exercise, exercise_id: customId }] } },
    ];
    expect(
      (
        await preview(
          JSON.stringify(
            records.map((record) =>
              record.entity_type === 'fitness_preferences'
                ? { entity_type: record.entity_type, id: record.id, preferences: record.payload }
                : { entity_type: record.entity_type, id: record.id, ...record.payload },
            ),
          ),
        )
      ).records[1],
    ).toMatchObject({ payload: { exercises: [{ exercise_id: customId }] } });
  });

  it('rejects malformed CSV, repeated JSON keys, duplicate IDs and invalid dates instead of partial import', async () => {
    expect(() => parseTransferTable('a,b\n"broken,1')).toThrow('引号');
    expect(() => parseTransferTable('[{"id":"a","id":"b"}]')).toThrow('重复');
    await expect(preview(encodeTransferJson([template, template]))).rejects.toThrow('重复记录身份');
    await expect(preview('数据类型,名称,动作,训练日期\n训练,错误日期,0025,2026-02-30')).rejects.toThrow('有效');
  });

  it('rejects inconsistent grouped plans and completed sets without reps', async () => {
    await expect(preview('数据类型,名称,动作,循环天数\n计划,冲突,0025,2\n计划,冲突,0025,3')).rejects.toThrow('不一致');
    await expect(preview('数据类型,名称,动作,训练日期,完成\n训练,缺少次数,0025,2026-09-30,true')).rejects.toThrow(
      '次数',
    );
  });

  it('stable source hashes do not depend on later record selection', async () => {
    const result = await preview(encodeTransferJson([template, preferences]));
    const selected = result.records.slice(1);
    expect(selected).toEqual([preferences]);
    expect(await transferId([{ a: 1 }])).toBe(await transferId([{ a: 1 }]));
    expect(result.exportId).toBe((await preview(encodeTransferJson([template, preferences]))).exportId);
  });
});
