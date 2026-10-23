-- 健身偏好数据库约束接受可选默认热身休息时间，并校验整数范围。
CREATE OR REPLACE FUNCTION public.fitness_payload_valid(kind TEXT, p JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $fitness$
DECLARE
  e JSONB; s JSONB; d JSONB; slot JSONB; segment JSONB; state JSONB; cycle JSONB; keys TEXT[];
  exercises JSONB; previous_end TIMESTAMPTZ; start_time TIMESTAMPTZ; end_time TIMESTAMPTZ;
  segment_count INTEGER; position INTEGER := 0;
BEGIN
  keys := CASE kind
    WHEN 'fitness_template' THEN ARRAY['name','exercises','created_at','updated_at']
    WHEN 'fitness_plan' THEN ARRAY['name','start_date','status','cycle_days','days','generation_state','pending_schedule','created_at','updated_at']
    WHEN 'fitness_workout' THEN ARRAY['name','scheduled_date','source_kind','source_plan_id','source_plan_name','source_template_id','occurrence_key','exercises','status','run_segments','rest_timer','created_at','updated_at']
    WHEN 'fitness_preferences' THEN ARRAY['custom_exercises','default_rest_seconds','sound_enabled','vibration_enabled','pinned_exercise_ids','exercise_weight_modes','created_at','updated_at']
    ELSE NULL END;
  IF keys IS NULL OR NOT p ?& keys THEN RETURN FALSE; END IF;
  -- 官方来源是可选识别信息，完整校验其字段和取值，不建立目录外键。
  IF kind IN ('fitness_template','fitness_plan') THEN
    keys := keys || ARRAY['catalog_origin'];
    IF p ? 'catalog_origin' THEN
      e := p->'catalog_origin';
      IF jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR NOT e ?& ARRAY['source','item_id','revision']
        OR e - ARRAY['source','item_id','revision'] <> '{}'::jsonb
        OR e->>'source' IS DISTINCT FROM 'official'
        OR jsonb_typeof(e->'item_id') IS DISTINCT FROM 'string'
        OR (e->>'item_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(e->'revision') IS DISTINCT FROM 'number'
        OR (e->>'revision') !~ '^[1-9][0-9]*$'
        OR (e->>'revision')::numeric > 2147483647 THEN RETURN FALSE; END IF;
    END IF;
  END IF;
  IF kind = 'fitness_preferences' THEN keys := keys || ARRAY['exercise_rest_settings','default_warmup_rest_seconds']; END IF;
  IF p - keys <> '{}'::jsonb THEN RETURN FALSE; END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'created_at') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p->'updated_at') IS DISTINCT FROM 'string'
    OR (p->>'updated_at')::timestamptz < (p->>'created_at')::timestamptz THEN RETURN FALSE; END IF;
  IF kind IN ('fitness_template','fitness_plan','fitness_workout') AND
    (jsonb_typeof(p->'name') IS DISTINCT FROM 'string' OR length(btrim(p->>'name')) NOT BETWEEN 1 AND 255) THEN RETURN FALSE; END IF;
  IF kind = 'fitness_preferences' THEN
    -- 默认热身休息为可选非负整数，缺省保留客户端默认行为。
    IF p ? 'default_warmup_rest_seconds' AND (
      jsonb_typeof(p->'default_warmup_rest_seconds') IS DISTINCT FROM 'number'
      OR (p->>'default_warmup_rest_seconds') !~ '^[0-9]+$'
      OR (p->>'default_warmup_rest_seconds')::numeric NOT BETWEEN 0 AND 2147483647
    ) THEN RETURN FALSE; END IF;
    IF jsonb_typeof(p->'custom_exercises') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p->'custom_exercises') > 1000 THEN RETURN FALSE; END IF;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'custom_exercises')) <> jsonb_array_length(p->'custom_exercises') THEN RETURN FALSE; END IF;
    FOR e IN SELECT value FROM jsonb_array_elements(p->'custom_exercises') LOOP
      IF NOT e ?& ARRAY['id','name','body_part','equipment','icon','image','deleted']
        OR e - ARRAY['id','name','body_part','equipment','icon','image','deleted'] <> '{}'::jsonb
        OR jsonb_typeof(e->'id') IS DISTINCT FROM 'string'
        OR (e->>'id') !~ '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(e->'name') IS DISTINCT FROM 'string' OR length(btrim(e->>'name')) NOT BETWEEN 1 AND 255
        OR jsonb_typeof(e->'body_part') IS DISTINCT FROM 'string' OR length(btrim(e->>'body_part')) = 0
        OR jsonb_typeof(e->'equipment') IS DISTINCT FROM 'string' OR length(btrim(e->>'equipment')) = 0
        OR jsonb_typeof(e->'icon') IS DISTINCT FROM 'string' OR (e->>'icon') !~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'
        OR jsonb_typeof(e->'deleted') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(e->'image') NOT IN ('null','string') THEN RETURN FALSE; END IF;
      IF jsonb_typeof(e->'image') = 'string' AND (length(e->>'image') NOT BETWEEN 1 AND 65536
        OR (e->>'image') !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') THEN RETURN FALSE; END IF;
    END LOOP;
    IF p ? 'exercise_rest_settings' THEN
      IF jsonb_typeof(p->'exercise_rest_settings') IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
      FOR e IN SELECT value FROM jsonb_each(p->'exercise_rest_settings') LOOP
        IF NOT e ?& ARRAY['rest_seconds','warmup_rest_seconds'] OR e - ARRAY['rest_seconds','warmup_rest_seconds'] <> '{}'::jsonb
          OR jsonb_typeof(e->'rest_seconds') IS DISTINCT FROM 'number' OR jsonb_typeof(e->'warmup_rest_seconds') IS DISTINCT FROM 'number'
          OR (e->>'rest_seconds') !~ '^[0-9]+$' OR (e->>'warmup_rest_seconds') !~ '^[0-9]+$'
          OR (e->>'rest_seconds')::bigint NOT BETWEEN 0 AND 2147483647 OR (e->>'warmup_rest_seconds')::bigint NOT BETWEEN 0 AND 2147483647 THEN RETURN FALSE; END IF;
      END LOOP;
    END IF;
    RETURN jsonb_typeof(p->'default_rest_seconds') = 'number' AND (p->>'default_rest_seconds') ~ '^[0-9]+$' AND (p->>'default_rest_seconds')::numeric BETWEEN 0 AND 2147483647
      AND jsonb_typeof(p->'sound_enabled') = 'boolean' AND jsonb_typeof(p->'vibration_enabled') = 'boolean'
      AND jsonb_typeof(p->'pinned_exercise_ids') = 'array'
      AND jsonb_typeof(p->'exercise_weight_modes') = 'object'
      AND (SELECT count(*) FROM jsonb_object_keys(p->'exercise_weight_modes')) <= 1000
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(p->'exercise_weight_modes') AS mode(key, value)
        WHERE length(btrim(mode.key)) NOT BETWEEN 1 AND 128 OR jsonb_typeof(mode.value) <> 'boolean');
  ELSIF kind = 'fitness_plan' THEN
    IF (p->>'cycle_days')::integer NOT BETWEEN 1 AND 36500 OR jsonb_typeof(p->'status') IS DISTINCT FROM 'string' OR (p->>'status') NOT IN ('in_progress','closed')
      OR jsonb_typeof(p->'days') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'days') <> (p->>'cycle_days')::integer
      OR (SELECT count(DISTINCT value->>'day_index') FROM jsonb_array_elements(p->'days')) <> (p->>'cycle_days')::integer
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p->'days') day WHERE jsonb_typeof(day->'slot') = 'object')
      OR jsonb_typeof(p->'generation_state') IS DISTINCT FROM 'object' THEN RETURN FALSE; END IF;
    FOR d IN SELECT value FROM jsonb_array_elements(p->'days') LOOP
      IF NOT d ?& ARRAY['day_index','slot'] OR d - ARRAY['day_index','slot'] <> '{}'::jsonb
        OR jsonb_typeof(d->'slot') NOT IN ('object','null')
        OR (d->>'day_index')::integer NOT BETWEEN 0 AND (p->>'cycle_days')::integer - 1 THEN RETURN FALSE; END IF;
      slot := d->'slot';
      IF slot <> 'null'::jsonb THEN
        IF NOT slot ?& ARRAY['id','source_template_id','name','exercises'] OR slot - ARRAY['id','source_template_id','name','exercises'] <> '{}'::jsonb
          OR NOT fitness_payload_valid('fitness_template', (slot - ARRAY['id','source_template_id']) || jsonb_build_object('created_at',p->'created_at','updated_at',p->'updated_at')) THEN RETURN FALSE; END IF;
      END IF;
    END LOOP;
    state := p->'generation_state';
    IF NOT state ?& ARRAY['next_cycle_start_date','next_cycle_index','generated_cycles']
      OR state - ARRAY['next_cycle_start_date','next_cycle_index','generated_cycles'] <> '{}'::jsonb
      OR jsonb_typeof(state->'generated_cycles') IS DISTINCT FROM 'array'
      OR (SELECT count(DISTINCT value->>'cycle_index') FROM jsonb_array_elements(state->'generated_cycles')) <> jsonb_array_length(state->'generated_cycles') THEN RETURN FALSE; END IF;
    FOR cycle IN SELECT value FROM jsonb_array_elements(state->'generated_cycles') LOOP
      IF NOT cycle ?& ARRAY['cycle_index','start_date','cycle_days','generated_from_date','rest_dates']
        OR cycle - ARRAY['cycle_index','start_date','cycle_days','generated_from_date','rest_dates'] <> '{}'::jsonb
        OR (cycle->>'cycle_index')::bigint NOT BETWEEN 0 AND (state->>'next_cycle_index')::bigint - 1
        OR (cycle->>'cycle_days')::integer NOT BETWEEN 1 AND 36500
        OR (cycle->>'generated_from_date')::date NOT BETWEEN (cycle->>'start_date')::date AND (cycle->>'start_date')::date + (cycle->>'cycle_days')::integer - 1
        OR jsonb_typeof(cycle->'rest_dates') IS DISTINCT FROM 'array'
        OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(cycle->'rest_dates')) <> jsonb_array_length(cycle->'rest_dates')
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(cycle->'rest_dates') day WHERE day::date NOT BETWEEN (cycle->>'generated_from_date')::date AND (cycle->>'start_date')::date + (cycle->>'cycle_days')::integer - 1) THEN RETURN FALSE; END IF;
    END LOOP;
    IF p->>'pending_schedule' IS NOT NULL AND (jsonb_typeof(p->'pending_schedule') <> 'object'
      OR NOT (p->'pending_schedule') ?& ARRAY['cycle_days','days'] OR (p->'pending_schedule') - ARRAY['cycle_days','days'] <> '{}'::jsonb
      OR NOT fitness_payload_valid('fitness_plan', p || (p->'pending_schedule') || jsonb_build_object('pending_schedule',NULL))) THEN RETURN FALSE; END IF;
    RETURN (jsonb_typeof(p->'start_date') = 'null' AND p->>'status' <> 'in_progress' OR (p->>'start_date')::date IS NOT NULL) AND (p->'generation_state'->>'next_cycle_index')::bigint >= 0
      AND (jsonb_array_length(state->'generated_cycles') = 0 OR state->>'next_cycle_start_date' IS NOT NULL);
  ELSIF kind NOT IN ('fitness_template','fitness_workout') THEN RETURN FALSE;
  END IF;
  exercises := p->'exercises';
  IF jsonb_typeof(exercises) IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  IF kind = 'fitness_template' AND jsonb_array_length(exercises) = 0 THEN RETURN FALSE; END IF;
  IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(exercises)) <> jsonb_array_length(exercises) THEN RETURN FALSE; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(exercises) LOOP
    IF NOT e ?& ARRAY['id','exercise_id','rest_seconds','warmup_rest_seconds','sets']
      OR e - ARRAY['id','exercise_id','rest_seconds','warmup_rest_seconds','sets'] <> '{}'::jsonb
      OR e->>'exercise_id' IS NULL OR length(e->>'exercise_id') NOT BETWEEN 1 AND 128
      OR jsonb_typeof(e->'sets') IS DISTINCT FROM 'array' OR (e->>'rest_seconds')::bigint < 0
      OR (e->>'warmup_rest_seconds')::bigint < 0 THEN RETURN FALSE; END IF;
    IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(e->'sets')) <> jsonb_array_length(e->'sets') THEN RETURN FALSE; END IF;
    FOR s IN SELECT value FROM jsonb_array_elements(e->'sets') LOOP
      keys := ARRAY['id','kind','weight','weight_left','weight_right','reps'];
      IF kind = 'fitness_workout' THEN keys := keys || ARRAY['completed']; END IF;
      IF kind = 'fitness_workout' AND s ? 'rest_durations_seconds' THEN
        keys := keys || ARRAY['rest_durations_seconds'];
        IF jsonb_typeof(s->'rest_durations_seconds') IS DISTINCT FROM 'array'
          OR jsonb_array_length(s->'rest_durations_seconds') > 1000
          OR (jsonb_array_length(s->'rest_durations_seconds') > 0 AND s->>'completed' IS DISTINCT FROM 'true') THEN RETURN FALSE; END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(s->'rest_durations_seconds') AS rest(value)
          WHERE jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$' OR value::numeric > 2147483647) THEN RETURN FALSE; END IF;
      END IF;
      IF NOT s ?& keys OR s - keys <> '{}'::jsonb OR s->>'kind' IS NULL
        OR s->>'kind' NOT IN ('warmup','working')
        OR (s->>'weight') IS NOT NULL AND (jsonb_typeof(s->'weight') <> 'string' OR NOT (s->>'weight') ~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$')
        -- 左右重量各自满足 decimal 契约，出现时必须成对且不能与总重同时存在
        OR (s->>'weight_left') IS NOT NULL AND (jsonb_typeof(s->'weight_left') <> 'string' OR NOT (s->>'weight_left') ~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$')
        OR (s->>'weight_right') IS NOT NULL AND (jsonb_typeof(s->'weight_right') <> 'string' OR NOT (s->>'weight_right') ~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,10})?$')
        -- 一组不能同时保留总重与左右重量；只填单边是编辑中的草稿，允许保存
        OR (s->>'weight' IS NOT NULL AND (s->>'weight_left' IS NOT NULL OR s->>'weight_right' IS NOT NULL))
        OR (s->>'reps' IS NOT NULL AND (jsonb_typeof(s->'reps') <> 'number' OR (s->>'reps') !~ '^[0-9]+$' OR (s->>'reps')::numeric NOT BETWEEN 1 AND 2147483647)) THEN RETURN FALSE; END IF;
      IF kind = 'fitness_template' AND s ? 'completed' THEN RETURN FALSE; END IF;
      IF kind = 'fitness_workout' THEN
        IF jsonb_typeof(s->'completed') IS DISTINCT FROM 'boolean' THEN RETURN FALSE; END IF;
        IF (s->>'completed')::boolean AND (coalesce((s->>'reps')::bigint,0) <= 0 OR p->>'status' = 'scheduled') THEN RETURN FALSE; END IF;
        -- 完成组必须给出完整重量口径：总重、左右成对或完全留空（自重）
        IF (s->>'completed')::boolean AND (s->>'weight_left' IS NULL) <> (s->>'weight_right' IS NULL) THEN RETURN FALSE; END IF;
      END IF;
    END LOOP;
  END LOOP;
  IF kind = 'fitness_template' THEN RETURN TRUE; END IF;
  IF p->>'status' IS NULL OR p->>'status' NOT IN ('scheduled','in_progress','completed') OR jsonb_typeof(p->'run_segments') IS DISTINCT FROM 'array' THEN RETURN FALSE; END IF;
  segment_count := jsonb_array_length(p->'run_segments');
  IF p->>'status' = 'scheduled' THEN
    IF segment_count <> 0 OR p->>'rest_timer' IS NOT NULL THEN RETURN FALSE; END IF;
  ELSIF segment_count = 0
    OR (p->>'status' = 'completed' AND (p->'run_segments'->-1->>'ended_at') IS NULL) THEN RETURN FALSE; END IF;
  FOR segment IN SELECT value FROM jsonb_array_elements(p->'run_segments') LOOP
    IF NOT segment ?& ARRAY['started_at','ended_at'] OR segment - ARRAY['started_at','ended_at'] <> '{}'::jsonb THEN RETURN FALSE; END IF;
    position := position + 1;
    start_time := (segment->>'started_at')::timestamptz; end_time := (segment->>'ended_at')::timestamptz;
    IF start_time IS NULL OR end_time < start_time OR previous_end > start_time OR (end_time IS NULL AND position <> segment_count) THEN RETURN FALSE; END IF;
    previous_end := end_time;
  END LOOP;
  IF p->>'rest_timer' IS NOT NULL AND (p->>'status' <> 'in_progress' OR p->'rest_timer'->>'status' NOT IN ('running','paused')
    OR ((p->'rest_timer'->>'ends_at') IS NOT NULL) <> (p->'rest_timer'->>'status' = 'running')
    OR (p->'rest_timer'->>'remaining_seconds')::bigint < 0 OR (p->'rest_timer'->>'duration_seconds')::bigint < 0) THEN RETURN FALSE; END IF;
  IF p->'rest_timer' ? 'elapsed_seconds' AND (jsonb_typeof(p->'rest_timer'->'elapsed_seconds') IS DISTINCT FROM 'number'
    OR (p->'rest_timer'->>'elapsed_seconds') !~ '^[0-9]+$' OR (p->'rest_timer'->>'elapsed_seconds')::numeric > 2147483647) THEN RETURN FALSE; END IF;
  IF ((p->'rest_timer'->>'exercise_id') IS NULL) <> ((p->'rest_timer'->>'set_id') IS NULL) THEN RETURN FALSE; END IF;
  IF p->'rest_timer'->>'exercise_id' IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(exercises) AS ex(value), jsonb_array_elements(ex.value->'sets') AS st(value)
    WHERE ex.value->>'id' = p->'rest_timer'->>'exercise_id' AND st.value->>'id' = p->'rest_timer'->>'set_id'
      AND st.value->>'completed' = 'true'
  ) THEN RETURN FALSE; END IF;
  RETURN (p->>'scheduled_date')::date IS NOT NULL;
EXCEPTION WHEN OTHERS THEN RETURN FALSE;
END
$fitness$;
