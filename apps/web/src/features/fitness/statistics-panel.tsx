import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap, type paths } from '@sesame-notes/api-client';
import { ChevronLeft, ChevronRight, CalendarDays, Clock3, Dumbbell } from 'lucide-react';
import { api } from '../../lib/session';
import { Button, EmptyState, ErrorState, Field, LoadingState } from '../../components/ui';
import { localToday, validDate, type Catalog, type FitnessPreferences, type FitnessSpace } from './fitness-model';
import { BodyMap } from './body-map';
import { taxonomyLabels } from './taxonomy';
import {
  dateKey,
  durationLabel,
  musclePart,
  periodRange,
  shiftPeriod,
  sumVolume,
  type Period,
} from './statistics-model';

type Statistics =
  paths['/api/v1/fitness-spaces/{fitness_space_id}/statistics']['get']['responses'][200]['content']['application/json'];
/** 后端按完整日期范围聚合；列表分页不会影响训练量、时长或身体部位统计。 */
export function StatisticsPanel({
  space,
  userId,
  catalog,
  preferences,
}: {
  space: FitnessSpace;
  userId: string;
  catalog?: Catalog;
  preferences?: FitnessPreferences;
}) {
  const [period, setPeriod] = useState<Period>('month');
  const [anchor, setAnchor] = useState(localToday);
  const [selectedAnatomyPart, setSelectedAnatomyPart] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const range = periodRange(period, anchor);
  const bodyPartLabels = taxonomyLabels(catalog, 'body_parts');
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const statistics = useQuery({
    queryKey: ['account', userId, 'fitness', space.id, 'statistics', range.start, range.end, timeZone],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/v1/fitness-spaces/{fitness_space_id}/statistics', {
          params: {
            path: { fitness_space_id: space.id },
            query: { start_date: range.start, end_date: range.end, time_zone: timeZone },
          },
          signal,
        }),
      ),
  });
  const anatomy = useMemo(() => {
    const definitions = new Map<
      string,
      { name: string; part: string; target: string | null; anatomyPart: string | null }
    >([
      ...(catalog?.exercises.map(
        (exercise) =>
          [
            exercise.id,
            {
              name: exercise.name_zh,
              part: exercise.body_part,
              target: exercise.target,
              anatomyPart: musclePart[exercise.target] ?? null,
            },
          ] as const,
      ) ?? []),
      ...(preferences?.custom_exercises.map(
        (exercise) =>
          // 私有动作只保存分类身份，没有目标肌群；不能把可编辑分类名称或 UUID 当作解剖位置。
          [exercise.id, { name: exercise.name, part: exercise.body_part, target: null, anatomyPart: null }] as const,
      ) ?? []),
    ]);
    const categoryVolumes = new Map<string, string>();
    const anatomyVolumes = new Map<string, string>();
    const trained = new Set<string>();
    const entries =
      statistics.data?.by_exercise.map((entry) => ({ ...entry, definition: definitions.get(entry.exercise_id) })) ?? [];
    for (const entry of entries) {
      const definition = entry.definition;
      if (!definition || !entry.working_sets) continue;
      if (definition.part !== 'cardio' && definition.target !== 'cardiovascular system') {
        categoryVolumes.set(definition.part, sumVolume([categoryVolumes.get(definition.part) ?? '0', entry.volume_kg]));
      }
      // 动态分类统计保留管理员的分类身份，人体图独立按真实目标肌群归到固定解剖部位。
      if (definition.anatomyPart && definition.target) {
        trained.add(definition.target);
        anatomyVolumes.set(
          definition.anatomyPart,
          sumVolume([anatomyVolumes.get(definition.anatomyPart) ?? '0', entry.volume_kg]),
        );
      }
    }
    return { categoryVolumes, anatomyVolumes, trained, entries };
  }, [catalog, preferences, statistics.data]);
  const visibleEntries = anatomy.entries.filter((entry) =>
    selectedAnatomyPart
      ? entry.definition?.anatomyPart === selectedAnatomyPart
      : !selectedCategory || entry.definition?.part === selectedCategory,
  );
  return (
    <section className="fitness-content">
      <div className="fitness-section-heading fitness-analytics-heading">
        <h2>训练统计</h2>
        <div className="fitness-period-tabs" aria-label="统计周期">
          {(['week', 'month', 'year'] as const).map((value) => (
            <Button
              key={value}
              variant={period === value ? 'primary' : 'secondary'}
              onClick={() => setPeriod(value)}
              aria-pressed={period === value}
            >
              {{ week: '周', month: '月', year: '年' }[value]}
            </Button>
          ))}
        </div>
      </div>
      <div className="fitness-date-navigation">
        <Button
          variant="secondary"
          aria-label="上一统计周期"
          disabled={!validDate(shiftPeriod(period, anchor, -1))}
          onClick={() => setAnchor(shiftPeriod(period, anchor, -1))}
        >
          <ChevronLeft size={18} />
        </Button>
        <Field label="统计所在日期">
          <input
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={anchor}
            onChange={(event) => {
              if (validDate(event.target.value)) setAnchor(event.target.value);
            }}
          />
        </Field>
        <Button
          variant="secondary"
          aria-label="下一统计周期"
          disabled={!validDate(shiftPeriod(period, anchor, 1))}
          onClick={() => setAnchor(shiftPeriod(period, anchor, 1))}
        >
          <ChevronRight size={18} />
        </Button>
        <Button variant="ghost" onClick={() => setAnchor(localToday())}>
          本{{ week: '周', month: '月', year: '年' }[period]}
        </Button>
      </div>
      <p className="fitness-muted">
        {range.start} — {range.end} · {timeZone}
      </p>
      <details className="fitness-help">
        <summary>统计口径</summary>
        <p>仅统计已完成训练，按实际开始日期归档。热身组不计训练量；未知动作和有氧仅计总体训练量。</p>
      </details>
      {statistics.isPending ? (
        <LoadingState label="正在统计完整训练范围…" />
      ) : statistics.isError ? (
        <ErrorState error={statistics.error} retry={() => void statistics.refetch()} />
      ) : (
        <>
          <div className="fitness-stat-cards">
            <article>
              <CalendarDays size={20} />
              <span>训练天数</span>
              <strong>
                {statistics.data.training_days}
                <small> 天</small>
              </strong>
            </article>
            <article>
              <Clock3 size={20} />
              <span>训练时长</span>
              <strong>{durationLabel(statistics.data.total_duration_ms)}</strong>
            </article>
            <article>
              <Dumbbell size={20} />
              <span>有效训练量</span>
              <strong>
                {statistics.data.volume_kg}
                <small> kg</small>
              </strong>
            </article>
          </div>
          <div className="fitness-analytics-card">
            <h3>训练时长趋势</h3>
            <DurationChart data={statistics.data} period={period} start={range.start} end={range.end} />
          </div>
          <div className="fitness-analytics-card">
            <h3>主练部位</h3>
            <div className="fitness-anatomy-layout">
              <BodyMap
                volumes={anatomy.anatomyVolumes}
                trained={anatomy.trained}
                selected={selectedAnatomyPart}
                onSelect={(part) => {
                  setSelectedCategory(null);
                  setSelectedAnatomyPart((current) => (current === part ? null : part));
                }}
              />
              <div className="fitness-part-list">
                {Object.entries(bodyPartLabels)
                  .filter(([part]) => part !== 'cardio')
                  .map(([part, label]) => (
                    <button
                      type="button"
                      key={part}
                      aria-pressed={selectedCategory === part}
                      onClick={() => {
                        setSelectedAnatomyPart(null);
                        setSelectedCategory((current) => (current === part ? null : part));
                      }}
                    >
                      <span>{label}</span>
                      <strong>{anatomy.categoryVolumes.get(part) ?? '0'} kg</strong>
                    </button>
                  ))}
              </div>
            </div>
            {visibleEntries.length ? (
              <div className="fitness-stat-exercises">
                {visibleEntries.map((entry) => (
                  <div key={entry.exercise_id}>
                    <span>{entry.definition?.name ?? entry.exercise_id}</span>
                    <span>
                      {entry.completed_sets} 组（{entry.working_sets} 组正式组）
                    </span>
                    <strong>{entry.volume_kg} kg</strong>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title={selectedAnatomyPart || selectedCategory ? '此部位还没有训练记录' : '此周期没有已完成训练'}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** 无记录日期保留折线断点；年度按自然月汇总，表格可读取精确数值。 */
function DurationChart({ data, period, start, end }: { data: Statistics; period: Period; start: string; end: string }) {
  const byDate = new Map<string, number>();
  for (const entry of data.by_date) {
    const key = period === 'year' ? `${entry.date.slice(0, 7)}-01` : entry.date;
    byDate.set(key, (byDate.get(key) ?? 0) + entry.duration_ms);
  }
  const dates: string[] = [];
  const date = new Date(`${start}T12:00:00Z`);
  const endInstant = new Date(`${end}T12:00:00Z`).getTime();
  while (date.getTime() <= endInstant) {
    dates.push(dateKey(date));
    if (period === 'year') date.setUTCMonth(date.getUTCMonth() + 1);
    else date.setUTCDate(date.getUTCDate() + 1);
  }
  const max = Math.max(3600000, ...byDate.values());
  const points = dates.map((key, index) => ({
    key,
    value: byDate.get(key),
    x: 65 + (index * 600) / Math.max(1, dates.length - 1),
    y: 165 - ((byDate.get(key) ?? 0) * 135) / max,
  }));
  let line = '';
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    if (point.value === undefined) continue;
    line += `${index > 0 && points[index - 1]?.value !== undefined ? 'L' : 'M'} ${point.x} ${point.y} `;
  }
  return (
    <div className="fitness-duration-chart">
      <svg viewBox="0 0 700 210" role="img" aria-label="训练时长折线图，详细数值可在下方表格查看">
        {[0, 1, 2].map((tick) => (
          <g key={tick}>
            <line x1="65" x2="665" y1={165 - tick * 67.5} y2={165 - tick * 67.5} stroke="var(--border)" />
            <text x="5" y={170 - tick * 67.5}>
              {((max * tick) / 2 / 3600000).toFixed(1)}h
            </text>
          </g>
        ))}
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth="3" />
        {points
          .filter((point) => point.value !== undefined)
          .map((point) => (
            <circle key={point.key} cx={point.x} cy={point.y} r="4" fill="var(--primary)">
              <title>
                {point.key}: {durationLabel(point.value ?? 0)}
              </title>
            </circle>
          ))}
        {points
          .filter(
            (_, index) => index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 7) === 0,
          )
          .map((point) => (
            <text key={point.key} x={point.x} y="195" textAnchor="middle">
              {period === 'year' ? `${Number(point.key.slice(5, 7))}月` : point.key.slice(5)}
            </text>
          ))}
      </svg>
      {!data.by_date.length ? (
        <p className="fitness-muted">此周期暂无已完成训练时长。</p>
      ) : (
        <details>
          <summary>查看每日详细数据</summary>
          <div className="fitness-stats-table">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>训练</th>
                  <th>完成组</th>
                  <th>时长</th>
                  <th>训练量</th>
                </tr>
              </thead>
              <tbody>
                {data.by_date.map((entry) => (
                  <tr key={entry.date}>
                    <td>{entry.date}</td>
                    <td>{entry.completed_workouts}</td>
                    <td>{entry.completed_sets}</td>
                    <td>{durationLabel(entry.duration_ms)}</td>
                    <td>{entry.volume_kg} kg</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
