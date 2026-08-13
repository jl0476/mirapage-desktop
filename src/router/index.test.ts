/**
 * router/index.test.ts — v0.1.0-module3.0.7
 *
 * 验证 /library → /likes 重定向(代码审查 round 3 P1:必须用 push + isReady + fullPath,
 * 不能用 router.resolve() — resolve 不保证执行 redirect 链)
 */
import { describe, it, expect } from 'vitest';
import router from './index';

describe('router — /library 兼容重定向', () => {
  it('push /library 后 currentRoute.fullPath === /likes', async () => {
    await router.push('/library');
    await router.isReady();
    expect(router.currentRoute.value.fullPath).toBe('/likes');
    expect(router.currentRoute.value.name).toBe('likes');
  });

  it('push /likes 直接命中(无重定向)', async () => {
    await router.push('/likes');
    await router.isReady();
    expect(router.currentRoute.value.fullPath).toBe('/likes');
    expect(router.currentRoute.value.name).toBe('likes');
  });
});
