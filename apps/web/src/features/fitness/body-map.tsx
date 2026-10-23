import anatomy from './body-anatomy.json';
import { musclePart } from './statistics-model';
import { bodyPartLabels } from './preferences-model';

/** 复用手机原创人体曲线，颜色仅表示主练肌群对应部位的有效训练量。 */
export function BodyMap({
  volumes,
  trained,
  selected,
  onSelect,
}: {
  volumes: Map<string, string>;
  trained: Set<string>;
  selected: string | null;
  onSelect: (part: string) => void;
}) {
  const maximum = Math.max(0, ...[...volumes.values()].map(Number));
  return (
    <div className="fitness-body-map">
      {[false, true].map((back) => (
        <figure key={String(back)}>
          <svg viewBox="-15 0 130 245" role="group" aria-label={back ? '背面肌群训练量' : '正面肌群训练量'}>
            <path d={anatomy.fitnessBodyOutline} className="fitness-body-outline" />
            <path d={anatomy.fitnessHead} className="fitness-body-outline" />
            <path d={anatomy.fitnessHair} fill="var(--muted)" />
            {anatomy.muscles
              .filter((item) => item.back === back)
              .map((item) => {
                const part = musclePart[item.muscle] ?? item.muscle;
                const amount = trained.has(item.muscle) ? Number(volumes.get(part) ?? '0') : 0;
                const label = bodyPartLabels[part] ?? part;
                const fill =
                  amount > 0
                    ? `color-mix(in srgb, var(--primary) ${35 + (65 * amount) / maximum}%, var(--surface-secondary))`
                    : 'var(--border)';
                return (
                  <g
                    key={item.muscle}
                    tabIndex={0}
                    role="button"
                    aria-label={`${label}，${volumes.get(part) ?? '0'} kg`}
                    aria-pressed={selected === part}
                    onClick={() => onSelect(part)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(part);
                      }
                    }}
                    className={selected === part ? 'is-selected' : ''}
                  >
                    <title>
                      {label} · {volumes.get(part) ?? '0'} kg
                    </title>
                    {item.paths.map((path, index) => (
                      <g key={index} fill={fill} stroke="var(--surface)" strokeWidth="0.6">
                        <path d={path} />
                        <path d={path} transform="translate(100,0) scale(-1,1)" />
                      </g>
                    ))}
                  </g>
                );
              })}
          </svg>
          <figcaption>{back ? '背面' : '正面'}</figcaption>
        </figure>
      ))}
    </div>
  );
}
