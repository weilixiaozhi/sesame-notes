import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { testFixtureDatabaseUrl } from './existing-test-database.js';

const prisma = new PrismaClient({ datasourceUrl: testFixtureDatabaseUrl() });
const actorKey = createHash('sha256').update(randomUUID()).digest('hex');

/** 每条约束探针使用独立事件身份，清理只匹配本次随机生成的匿名主体。 */
function bannerEvent() {
  return {
    actorKey,
    eventId: randomUUID(),
    kind: 'action',
    occurredAt: new Date(),
    platform: 'app',
    pageId: 'fitness.plans',
    eventName: 'banner_impression',
    bannerSlot: 'fitness-plan-library',
    bannerSource: 'builtin',
    bannerVersion: 0,
    bannerId: 'builtin:fitness-plan-library',
  };
}

afterAll(async () => {
  try {
    await prisma.productAnalyticsEvent.deleteMany({ where: { actorKey } });
  } catch (cause) {
    throw new Error('Banner 数据库约束探针清理失败', { cause });
  } finally {
    await prisma.$disconnect();
  }
});

describe('Banner 事件数据库维度约束', () => {
  it('本地零版本、服务器正版本及无维度历史事件均可存储', async () => {
    try {
      const builtin = await prisma.productAnalyticsEvent.create({ data: bannerEvent() });
      const remote = await prisma.productAnalyticsEvent.create({
        data: {
          ...bannerEvent(),
          eventName: 'banner_click',
          bannerSource: 'remote',
          bannerVersion: 7,
          bannerId: randomUUID(),
        },
      });
      const history = await prisma.productAnalyticsEvent.create({
        data: {
          ...bannerEvent(),
          eventName: 'fitness_plan_save',
          bannerSlot: null,
          bannerSource: null,
          bannerVersion: null,
          bannerId: null,
        },
      });
      expect(builtin.bannerVersion).toBe(0);
      expect(remote.bannerVersion).toBe(7);
      expect(history.bannerSlot).toBeNull();
      const legacy = await prisma.productAnalyticsEvent.create({ data: { ...bannerEvent(), bannerId: null } });
      expect(legacy.bannerId).toBeNull();
    } catch (cause) {
      throw new Error('Banner 合法维度及历史兼容存储验证失败', { cause });
    }
  });

  it.each([
    { name: '缺少位置', patch: { bannerSlot: null } },
    { name: '缺少来源', patch: { bannerSource: null } },
    { name: '缺少版本', patch: { bannerVersion: null } },
    { name: '未知位置', patch: { bannerSlot: 'other-library' } },
    { name: '未知来源', patch: { bannerSource: 'external' } },
    { name: '位置页面不匹配', patch: { pageId: 'fitness.templates' } },
    { name: 'Web 来源', patch: { platform: 'web' } },
    { name: '不是操作事件', patch: { kind: 'active' } },
    { name: '本地正版本', patch: { bannerVersion: 1 } },
    { name: '服务器零版本', patch: { bannerSource: 'remote', bannerVersion: 0 } },
    { name: '负数版本', patch: { bannerSource: 'remote', bannerVersion: -1 } },
    { name: '其他事件携带 Banner 维度', patch: { eventName: 'fitness_plan_save' } },
    { name: '本地图身份与位置不匹配', patch: { bannerId: 'builtin:fitness-template-library' } },
    { name: '远端图片不是 UUID', patch: { bannerSource: 'remote', bannerVersion: 1, bannerId: 'not-a-slide' } },
  ])('数据库拒绝$name', async ({ patch }) => {
    try {
      await expect(prisma.productAnalyticsEvent.create({ data: { ...bannerEvent(), ...patch } })).rejects.toThrow(
        /product_analytics_(banner_dimensions|banner_slide|source)_check/,
      );
    } catch (cause) {
      throw new Error('Banner 数据库存储边界验证失败', { cause });
    }
  });
});
