import directory from './phone-regions.json' with { type: 'json' };

/** 登录和后台换绑共用国际区号目录，提交值只使用区号。 */
export const phoneRegions: ReadonlyArray<{ code: string; label: string; regions: readonly string[] }> =
  directory.entries;
