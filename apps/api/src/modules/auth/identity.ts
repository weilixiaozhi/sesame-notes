import { randomInt } from 'node:crypto';

/** 芝麻号与默认昵称生成。 芝麻号 100000000-999999999（9 位、无前导零、全局唯一、不可修改）， 数据库唯一约束兜底碰撞，调用方重试；默认昵称 `芝麻仔` + 6 位随机数字（允许前导零）。 */

/** 生成 9 位无前导零的芝麻号；与数据库唯一约束配合，碰撞时由注册事务重试。 */
export function allocateSesameNumber(): string {
  try {
    return String(randomInt(100_000_000, 1_000_000_000));
  } catch (error) {
    throw new Error('芝麻号生成失败', { cause: error });
  }
}

/** 生成随机默认昵称：`芝麻仔` + 6 位数字（允许前导零，与芝麻号职责分离、不保证唯一）。 */
export function defaultNickname(): string {
  try {
    return `芝麻仔${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
  } catch (error) {
    throw new Error('默认昵称生成失败', { cause: error });
  }
}
