/** 读取与环境身份无关的 PostgreSQL 结构定义，覆盖 Prisma 模型之外的数据库对象。 */
export async function readCurrentSchemaSnapshot(database) {
  try {
    return await database.$queryRawUnsafe(`
      WITH relations AS (
        SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname <> '_prisma_migrations'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
      ), objects AS (
        SELECT 'relation' AS kind, c.relname::text AS name,
          jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'row_security',c.relrowsecurity,
            'force_row_security',c.relforcerowsecurity,'replica_identity',c.relreplident,'options',c.reloptions)::text AS definition
        FROM relations c WHERE c.relkind IN ('r','p','v','m','S','f')
        UNION ALL
        SELECT 'column', c.relname || '.' || a.attname,
          jsonb_build_object('position',row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),
            'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,
            'default',pg_get_expr(ad.adbin,ad.adrelid),'identity',a.attidentity,'generated',a.attgenerated,
            'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END)::text
        FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid
        LEFT JOIN pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
        WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
        UNION ALL
        SELECT 'constraint', c.relname || '.' || k.conname, pg_get_constraintdef(k.oid,false)
        FROM relations c JOIN pg_constraint k ON k.conrelid=c.oid
        UNION ALL
        SELECT 'index', i.relname::text, jsonb_build_object('definition',pg_get_indexdef(i.oid),'valid',x.indisvalid,'ready',x.indisready)::text
        FROM relations i JOIN pg_index x ON x.indexrelid=i.oid JOIN relations t ON t.oid=x.indrelid
        UNION ALL
        SELECT 'trigger', c.relname || '.' || t.tgname, jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled)::text
        FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid WHERE NOT t.tgisinternal
        UNION ALL
        SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', pg_get_functiondef(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prokind IN ('f','p')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
        UNION ALL
        SELECT 'enum', t.typname, jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)::text
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
        WHERE n.nspname='public' GROUP BY t.typname
        UNION ALL
        SELECT 'sequence', s.sequencename,
          jsonb_build_object('type',s.data_type,'start',s.start_value,'min',s.min_value,'max',s.max_value,
            'increment',s.increment_by,'cycle',s.cycle,'cache',s.cache_size,
            'owned_by',CASE WHEN owned.oid IS NULL THEN NULL ELSE owned_namespace.nspname || '.' || owned.relname || '.' || attribute.attname END)::text
        FROM pg_sequences s JOIN pg_namespace namespace ON namespace.nspname=s.schemaname
        JOIN pg_class sequence ON sequence.relnamespace=namespace.oid AND sequence.relname=s.sequencename
        LEFT JOIN pg_depend dependency ON dependency.classid='pg_class'::regclass AND dependency.objid=sequence.oid
          AND dependency.refclassid='pg_class'::regclass AND dependency.deptype IN ('a','i')
        LEFT JOIN pg_class owned ON owned.oid=dependency.refobjid
        LEFT JOIN pg_namespace owned_namespace ON owned_namespace.oid=owned.relnamespace
        LEFT JOIN pg_attribute attribute ON attribute.attrelid=owned.oid AND attribute.attnum=dependency.refobjsubid
        WHERE s.schemaname='public'
        UNION ALL
        SELECT 'extension', e.extname::text, jsonb_build_object('schema',n.nspname,'version',e.extversion)::text
        FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname <> 'plpgsql'
        UNION ALL
        SELECT 'view', c.relname, pg_get_viewdef(c.oid,false) FROM relations c WHERE c.relkind IN ('v','m')
        UNION ALL
        SELECT 'policy', c.relname || '.' || p.polname,
          jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
            'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))::text
        FROM relations c JOIN pg_policy p ON p.polrelid=c.oid
        UNION ALL
        SELECT 'custom_type', t.typname::text,
          jsonb_build_object('kind',t.typtype,'base',format_type(t.typbasetype,t.typtypmod),'not_null',t.typnotnull,'default',t.typdefault)::text
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        LEFT JOIN pg_class c ON c.oid=t.typrelid
        WHERE n.nspname='public' AND (t.typtype IN ('d','r','m') OR c.relkind='c')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
        UNION ALL
        SELECT 'rule', c.relname || '.' || r.rulename, pg_get_ruledef(r.oid,false)
        FROM relations c JOIN pg_rewrite r ON r.ev_class=c.oid WHERE r.rulename<>'_RETURN'
        UNION ALL
        SELECT 'collation', c.collname::text, jsonb_build_object('provider',c.collprovider,'deterministic',c.collisdeterministic,'locale',c.collcollate,'ctype',c.collctype)::text
        FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_collation'::regclass AND d.objid=c.oid AND d.deptype='e')
        UNION ALL
        SELECT 'aggregate', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.prosrc
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='a'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      ) SELECT kind,name,definition FROM objects ORDER BY kind COLLATE "C",name COLLATE "C"
    `);
  } catch (cause) {
    throw new Error('当前数据库结构快照读取失败', { cause });
  }
}
