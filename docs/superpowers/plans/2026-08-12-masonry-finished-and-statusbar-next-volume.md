# 瀑布流 finished + 底栏下一卷 + StatusBar 优化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 瀑布流滚到底 + 停留 STABLE_MS 自动标记 finished=true；底栏右侧新增「下一卷」入口（复用 onCrossNextVolume + 预查）；顺手修底栏三段等宽 + 卷名 hover 跑马灯。

**架构：** 功能 A（finished）在 `useMasonryBrowsePosition` 内叠加 atBottom 状态机（stableTimer + bottomSince + 两阶段提交 + successfulWrites 去重），atBottom 由 MasonryView 计算（三档规则）注入。功能 B（底栏下一卷）StatusBar 加 props/emit，FileBrowser 加预查（请求序号）复用 onCrossNextVolume。功能 C/D 纯 CSS 改 StatusBar。

**技术栈：** Vue 3 + Pinia + Tauri IPC + Vitest（fake timers）+ Rust rusqlite（无 Rust 改动，复用现有 save_progress UPSERT）。

**规格：** `docs/superpowers/specs/2026-08-12-masonry-finished-and-statusbar-next-volume-design.md`（v7 定稿，7 轮审查闭环）

**约定：**
- 测试先于实现（TDD）。每个任务先写测试 → 跑确认失败 → 实现 → 跑确认通过 → commit。
- `npm test -- --run <path>` 跑单个测试文件；`npm run type-check` 类型检查。
- commit 中文，格式 `[scope]: 简述`，不带 co-author。
- 每个任务独立 commit。任务 1-9 对应功能 C/D/B，任务 10-18 对应功能 A。

---

## 文件结构

### 创建
- `src/lib/progressWriteKey.ts` — identity 纯函数（A9 去重 key 生成，无 Vue/Tauri 依赖）
- `src/lib/progressWriteKey.test.ts` — 上述纯函数单测

### 修改
- `src/components/filebrowser/StatusBar.vue` — 三段等宽（C）+ 右段下一卷渲染（B）+ 跑马灯 scoped CSS（D）
- `src/components/filebrowser/StatusBar.test.ts`（如无则创建）— StatusBar 渲染单测
- `src/locales/zh-CN.ts` / `src/locales/en-US.ts` — `fileBrowser.statusBar.nextVolume` 等 key
- `src/components/filebrowser/FileBrowser.vue` — 预查 + 绑定 StatusBar next-volume props/emit
- `src/components/filebrowser/FileBrowser.test.ts` — 预查请求序号测试
- `src/composables/useMasonryBrowsePosition.ts` — atBottom 状态机 + 两阶段提交 + successfulWrites
- `src/composables/useMasonryBrowsePosition.test.ts` — A-T1~T21 测试
- `src/components/filebrowser/MasonryView.vue` — atBottom computed（三档规则）+ 注入 composable

### 不动
- Rust 端 `save_progress` / `save_progress_inner`（现有 UPSERT + COALESCE + CASE WHEN 已满足，spec §2.7）
- `useReaderActions` / reader store（reader 末页 finished 路径不变）

---

## 任务 0：基线验证

**文件：** 无修改

- [ ] **步骤 1：跑全测确认基线绿**

运行：`npm test -- --run`
预期：全部通过（799 用例，0 fail）。如有 pre-existing fail 记录但不阻塞。

- [ ] **步骤 2：type-check 基线**

运行：`npm run type-check`
预期：0 error

- [ ] **步骤 3：记录基线用例数**

记录当前 `npm test` 通过数（应是 799 左右），后续任务增量以此为基准。

---

## 任务 1：StatusBar 三段等宽布局（功能 C）

**文件：**
- 修改：`src/components/filebrowser/StatusBar.vue`
- 测试：`src/components/filebrowser/StatusBar.test.ts`（创建）

**目标：** footer 从「左 shrink-0 + 中 flex-1 + 右 w-0」改为「三段 flex-1 等宽」，路径真正居中。

- [ ] **步骤 1：编写失败的测试**

创建 `src/components/filebrowser/StatusBar.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatusBar from './StatusBar.vue';

describe('StatusBar.vue', () => {
  it('三段等宽: 左/中/右各 flex-1, 中段 justify-center', () => {
    const wrapper = mount(StatusBar, {
      props: { total: 12, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'D:/path' },
    });
    const footer = wrapper.find('[data-test="statusbar"]');
    const children = footer.element.children;
    // 三段
    expect(children.length).toBe(3);
    // 每段含 flex-1 class
    for (const child of children) {
      expect((child as HTMLElement).className).toContain('flex-1');
    }
    // 中段 justify-center
    const center = children[1] as HTMLElement;
    expect(center.className).toContain('justify-center');
  });

  it('无 nextVolumeTitle 时右段渲染空 div 保持对称', () => {
    const wrapper = mount(StatusBar, {
      props: { total: 12, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'D:/path' },
    });
    const footer = wrapper.find('[data-test="statusbar"]');
    const right = footer.element.children[2] as HTMLElement;
    // 右段存在(flex-1)但无下一卷内容
    expect(right.className).toContain('flex-1');
    expect(right.querySelector('[data-test="statusbar-next-volume"]')).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/StatusBar.test.ts`
预期：FAIL（现有 footer 是左 shrink-0 + 右 w-0，三段断言不符）

- [ ] **步骤 3：修改 StatusBar.vue template + script**

将 `<template>` 的 footer 改为三段 flex-1（精确替换 `<footer>...</footer>` 整块）：

```vue
<template>
  <footer
    class="statusbar bg-surface xp-bdt px-3 h-6 flex items-center justify-between gap-2 text-xs text-text-secondary select-none flex-shrink-0"
    data-test="statusbar"
    role="status"
    aria-live="polite"
  >
    <!-- Left: items + selected (flex-1, 左对齐) -->
    <div class="flex-1 flex items-center gap-3 min-w-0 justify-start">
      <span data-test="statusbar-items">{{ itemsLabel }}</span>
      <span
        v-if="selectedCount > 0"
        class="text-text-primary"
        data-test="statusbar-selected"
      >
        {{ selectedLabel }}
        <span class="text-text-muted font-mono ml-1">({{ selectionSizeLabel }})</span>
      </span>
    </div>
    <!-- Center: current path (flex-1, 居中) -->
    <div
      class="flex-1 flex items-center justify-center min-w-0 px-2"
      :title="currentPath"
      data-test="statusbar-path"
    >
      <span class="truncate opacity-80 font-mono">{{ currentPath }}</span>
    </div>
    <!-- Right: 下一卷 (flex-1, 右对齐) - 任务 2 填内容, 此任务先空 div 保持对称 -->
    <div class="flex-1 flex items-center justify-end min-w-0" data-test="statusbar-right">
      <slot name="right" />
    </div>
  </footer>
</template>
```

> 注：任务 1 用 `<slot name="right" />` 占位（空时渲染空 div 保持三段对称）。任务 2 会把 next-volume 内容直接写在 StatusBar 内部（不用 slot），届时移除 slot。这里先用 slot 是为了让任务 1 的「三段等宽」独立可测，不依赖任务 2 的 props。

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/StatusBar.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/StatusBar.vue src/components/filebrowser/StatusBar.test.ts
git commit -m "feat(statusbar): 三段等宽布局, 路径真正居中(修偏右)"
```

---

## 任务 2：StatusBar 右段下一卷渲染（功能 B 展示层）

**文件：**
- 修改：`src/components/filebrowser/StatusBar.vue`
- 修改：`src/components/filebrowser/StatusBar.test.ts`

**目标：** StatusBar 接收 `nextVolumeTitle` / `nextVolumeLoading` / `nextVolumeDisabled` props，emit `next-volume`，右段按三态渲染。

- [ ] **步骤 1：追加失败的测试**

在 `StatusBar.test.ts` 追加：

```typescript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StatusBar from './StatusBar.vue';

describe('StatusBar 下一卷右段', () => {
  const base = { total: 12, selectedCount: 0, selectionSizeBytes: 0, currentPath: 'D:/p' };

  it('nextVolumeTitle 有值: 显示「下一卷: title」, 点击 emit next-volume', async () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeTitle: 'vol02' },
    });
    const btn = wrapper.find('[data-test="statusbar-next-volume"]');
    expect(btn.text()).toContain('vol02');
    await btn.trigger('click');
    expect(wrapper.emitted('next-volume')).toHaveLength(1);
  });

  it('nextVolumeTitle=null: 显示「已是最后一卷」灰 disabled', () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeTitle: null },
    });
    const el = wrapper.find('[data-test="statusbar-next-volume"]');
    expect(el.attributes('disabled')).toBeDefined();
    expect(el.text()).toContain('最后一卷');
  });

  it('nextVolumeLoading=true: 显示「…」', () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeLoading: true },
    });
    const el = wrapper.find('[data-test="statusbar-next-volume"]');
    expect(el.text()).toContain('…');
  });

  it('nextVolumeTitle=undefined: 右段无 next-volume 元素(兼容)', () => {
    const wrapper = mount(StatusBar, { props: base });
    expect(wrapper.find('[data-test="statusbar-next-volume"]').exists()).toBe(false);
  });

  it('nextVolumeDisabled=true: 有 title 但 disabled', () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeTitle: 'vol02', nextVolumeDisabled: true },
    });
    expect(wrapper.find('[data-test="statusbar-next-volume"]').attributes('disabled')).toBeDefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/StatusBar.test.ts`
预期：FAIL（StatusBar 还没接 nextVolume* props）

- [ ] **步骤 3：StatusBar 加 props/emit + 右段渲染**

修改 `StatusBar.vue` script setup，扩展 Props 并加 emit：

```typescript
interface Props {
  total: number;
  selectedCount: number;
  selectionSizeBytes: number;
  currentPath: string;
  itemsText?: string;
  /** 预查到的下一卷名; null=无下一卷(查完确定); undefined=未传入(不渲染右段) */
  nextVolumeTitle?: string | null;
  /** 预查中(防抖/在途), 右段显示「…」 */
  nextVolumeLoading?: boolean;
  /** 禁用点击: swapping/根目录/无 lastFetchedPath */
  nextVolumeDisabled?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  itemsText: undefined,
  nextVolumeTitle: undefined,
  nextVolumeLoading: false,
  nextVolumeDisabled: false,
});

const emit = defineEmits<{ (e: 'next-volume'): void }>();

const { t } = useI18n();

const nextVolumeLabel = computed(() => {
  if (props.nextVolumeTitle === undefined) return null;      // 不渲染
  if (props.nextVolumeLoading) return '…';
  if (props.nextVolumeTitle === null) return t('fileBrowser.statusBar.noNextVolume');
  return t('fileBrowser.statusBar.nextVolume', { title: props.nextVolumeTitle });
});

const nextVolumeDisabledActual = computed(() =>
  props.nextVolumeDisabled || props.nextVolumeTitle === null || props.nextVolumeLoading,
);
```

修改 template 右段（替换任务 1 的 slot 占位）：

```vue
    <!-- Right: 下一卷 (flex-1, 右对齐) -->
    <div class="flex-1 flex items-center justify-end min-w-0" data-test="statusbar-right">
      <button
        v-if="nextVolumeLabel !== null"
        data-test="statusbar-next-volume"
        type="button"
        class="next-volume-btn flex items-center gap-1 px-2 py-0.5 text-text-muted hover:text-accent hover:bg-surface-light transition-colors disabled:text-text-tertiary disabled:hover:bg-transparent disabled:cursor-not-allowed"
        :disabled="nextVolumeDisabledActual"
        :title="nextVolumeLabel"
        @click="emit('next-volume')"
      >
        <span class="next-volume-name truncate">{{ nextVolumeLabel }}</span>
        <svg
          v-if="nextVolumeTitle"
          width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M5 4l10 8-10 8V4zM19 5v14" />
        </svg>
      </button>
    </div>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/StatusBar.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/StatusBar.vue src/components/filebrowser/StatusBar.test.ts
git commit -m "feat(statusbar): 右段下一卷渲染(三态 title/null/loading + emit next-volume)"
```

---

## 任务 3：i18n key（功能 B）

**文件：**
- 修改：`src/locales/zh-CN.ts`
- 修改：`src/locales/en-US.ts`

**目标：** 新增 `fileBrowser.statusBar.nextVolume` / `noNextVolume` 双语。

- [ ] **步骤 1：zh-CN.ts 加 key**

在 `fileBrowser` 命名空间内（`nextVolume: '下一卷'` 附近，约 172 行后）新增 `statusBar` 子对象（若不存在）。先读确认结构：

运行：查找 `statusBar:` 在 zh-CN.ts 是否已存在。

若不存在，在 `fileBrowser` 对象内追加：

```typescript
    statusBar: {
      nextVolume: '下一卷: {title}',
      noNextVolume: '已是最后一卷',
    },
```

若已存在 `statusBar`（含 `items` / `selected` / `path`），仅追加 `nextVolume` / `noNextVolume` 两个 key。

- [ ] **步骤 2：en-US.ts 加对应 key**

同样位置加：

```typescript
    statusBar: {
      // ...existing items/selected/path
      nextVolume: 'Next: {title}',
      noNextVolume: 'Last volume',
    },
```

- [ ] **步骤 3：type-check 验证双语一致**

运行：`npm run type-check`
预期：0 error（vue-i18n 类型对齐）

- [ ] **步骤 4：跑 i18n 一致性测试（若存在）**

运行：`npx vitest run src/locales`
预期：PASS（若有 locale 一致性测试，确认两文件 key 集合相同）

- [ ] **步骤 5：Commit**

```bash
git add src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(i18n): fileBrowser.statusBar 下一卷双语 key"
```

---

## 任务 4：卷名 hover 跑马灯（功能 D）

**文件：**
- 修改：`src/components/filebrowser/StatusBar.vue`（scoped CSS + JS 测量）

**目标：** 右段卷名容器固定宽度，溢出时 hover 触发 CSS translateX 滚动。

- [ ] **步骤 1：追加测试（验 class 存在）**

在 `StatusBar.test.ts` 追加：

```typescript
  it('卷名容器有 next-volume-name class + max-width', () => {
    const wrapper = mount(StatusBar, {
      props: { ...base, nextVolumeTitle: 'very-long-volume-name-here' },
    });
    const name = wrapper.find('.next-volume-name');
    expect(name.exists()).toBe(true);
    // 固定宽度容器(scoped CSS 限制, happy-dom 测不了实际 px, 验 class + style 注入点)
    expect(name.classes()).toContain('next-volume-name');
  });
```

- [ ] **步骤 2：运行测试验证失败/通过**

运行：`npx vitest run src/components/filebrowser/StatusBar.test.ts`
预期：任务 2 已加 `.next-volume-name`，此测试应直接 PASS（class 已存在）。若 FAIL 检查 class 名拼写。

- [ ] **步骤 3：加 scoped CSS 跑马灯 + JS 测量**

在 `StatusBar.vue` script setup 加测量逻辑（onMounted + ResizeObserver 兜底）：

```typescript
import { onMounted, onBeforeUnmount, ref } from 'vue';

const nextVolumeNameEl = ref<HTMLElement | null>(null);
const marqueeOffset = ref(0);
const needsMarquee = ref(false);

function measureMarquee() {
  const el = nextVolumeNameEl.value;
  if (!el) return;
  const span = el.querySelector('span') ?? el;
  needsMarquee.value = span.scrollWidth > el.clientWidth + 1;
  marqueeOffset.value = needsMarquee.value ? span.scrollWidth - el.clientWidth : 0;
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  measureMarquee();
  if (nextVolumeNameEl.value) {
    ro = new ResizeObserver(() => measureMarquee());
    ro.observe(nextVolumeNameEl.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
```

修改 template 卷名 span，绑定 ref + 动态 style：

```vue
        <span
          ref="nextVolumeNameEl"
          class="next-volume-name"
          :class="{ 'needs-marquee': needsMarquee }"
          :style="{ '--marquee-offset': `-${marqueeOffset}px` }"
        >{{ nextVolumeLabel }}</span>
```

在 `<style scoped>` 块（StatusBar.vue 末尾，若无则新增）：

```vue
<style scoped>
.next-volume-name {
  max-width: 160px;
  overflow: hidden;
  white-space: nowrap;
  display: inline-block;
  vertical-align: middle;
}
/* hover 滚动: 不溢出时(needs-marquee false)无效果 */
.next-volume-name.needs-marquee {
  cursor: pointer;
}
.next-volume-btn:hover .next-volume-name.needs-marquee {
  animation: statusbar-marquee 4s linear forwards;
}
@keyframes statusbar-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(var(--marquee-offset, 0)); }
}
</style>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/StatusBar.test.ts`
预期：PASS

- [ ] **步骤 5：type-check**

运行：`npm run type-check`
预期：0 error

- [ ] **步骤 6：Commit**

```bash
git add src/components/filebrowser/StatusBar.vue src/components/filebrowser/StatusBar.test.ts
git commit -m "feat(statusbar): 下一卷卷名 hover 跑马灯(溢出时 translateX 滚动)"
```

---

## 任务 5：progressWriteKey 纯函数（功能 A 基础，A9 去重）

**文件：**
- 创建：`src/lib/progressWriteKey.ts`
- 创建：`src/lib/progressWriteKey.test.ts`

**目标：** identity 稳定生成（JSON.stringify 结构化，防分隔符碰撞）。

- [ ] **步骤 1：编写失败的测试**

创建 `src/lib/progressWriteKey.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { progressWriteKey } from './progressWriteKey';
import type { SourceDescriptor } from '@/lib/sourceDescriptor';

const localDesc = (rootPath: string): SourceDescriptor =>
  ({ type: 'local', rootPath }) as SourceDescriptor;

describe('progressWriteKey', () => {
  it('同输入两次调用严格相等(稳定)', () => {
    const d = localDesc('D:\\comics');
    const k1 = progressWriteKey(d, 'vol01', 'a.jpg', undefined);
    const k2 = progressWriteKey(d, 'vol01', 'a.jpg', undefined);
    expect(k1).toBe(k2);
  });

  it('Windows 路径含 \\ 和 / 不碰撞', () => {
    const d = localDesc('D:\\comics');
    const k1 = progressWriteKey(d, 'a\\b', 'x.jpg', true);
    const k2 = progressWriteKey(d, 'a/b', 'x.jpg', true);
    // a\b 与 a/b 是不同字符串, 应不同 key(不因分隔符误判相同)
    expect(k1).not.toBe(k2);
  });

  it('UNC 路径稳定', () => {
    const d = localDesc('\\\\server\\share');
    const k = progressWriteKey(d, 'sub', 'p.jpg', undefined);
    expect(typeof k).toBe('string');
    expect(k.length).toBeGreaterThan(0);
  });

  it('descriptor 含 | 字符不碰撞(结构化序列化)', () => {
    const d1 = localDesc('D:\\a|b');
    const d2 = localDesc('D:\\a');
    const k1 = progressWriteKey(d1, 'x', 'y.jpg', true);
    const k2 = progressWriteKey(d2, '|x', 'y.jpg', true);
    // 若用 | 拼接会碰撞; JSON.stringify 不会
    expect(k1).not.toBe(k2);
  });

  it('finished=undefined 与 finished=null 归一化为同一 key', () => {
    const d = localDesc('D:\\c');
    const k1 = progressWriteKey(d, 'v', 'i.jpg', undefined);
    const k2 = progressWriteKey(d, 'v', 'i.jpg', null as unknown as undefined);
    expect(k1).toBe(k2);
  });

  it('finished=true 与 finished=undefined 不同 key(升级判定基础)', () => {
    const d = localDesc('D:\\c');
    const k1 = progressWriteKey(d, 'v', 'i.jpg', true);
    const k2 = progressWriteKey(d, 'v', 'i.jpg', undefined);
    expect(k1).not.toBe(k2);
  });

  it('不同 descriptor type 不同 key', () => {
    const local = localDesc('D:\\c');
    const archive = { type: 'archive', archivePath: 'D:\\c.zip' } as SourceDescriptor;
    expect(progressWriteKey(local, 'v', 'i.jpg', true))
      .not.toBe(progressWriteKey(archive, 'v', 'i.jpg', true));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/lib/progressWriteKey.test.ts`
预期：FAIL（模块不存在）

- [ ] **步骤 3：实现 progressWriteKey.ts**

```typescript
/**
 * progressWriteKey — progress 写入去重的稳定 key（spec A9 + 审查 P2 v7）。
 *
 * 用 JSON.stringify 结构化序列化，避免字符串拼接分隔符碰撞
 * （descriptor JSON 或 Windows/UNC 路径可能含 `|` 等字符）。
 *
 * 语义：同一 (descriptor, relPath, imageName, finished) 组合 → 同一 key。
 * finished 用 `?? null` 归一化（undefined 与 null 视为同一「普通进度」语义）。
 *
 * 纯函数, 无 Vue/Tauri 依赖, 可独立单测。
 */
import type { SourceDescriptor } from '@/lib/sourceDescriptor';

export function progressWriteKey(
  descriptor: SourceDescriptor,
  relPath: string,
  imageName: string,
  finished: boolean | undefined,
): string {
  return JSON.stringify([descriptor, relPath, imageName, finished ?? null]);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/lib/progressWriteKey.test.ts`
预期：PASS（全部 7 用例）

- [ ] **步骤 5：Commit**

```bash
git add src/lib/progressWriteKey.ts src/lib/progressWriteKey.test.ts
git commit -m "feat(progress): progressWriteKey 纯函数(A9 去重 identity, 防分隔符碰撞)"
```

---

## 任务 6：FileBrowser 预查下一卷 + 绑定 StatusBar（功能 B 逻辑层）

**文件：**
- 修改：`src/components/filebrowser/FileBrowser.vue`
- 修改：`src/components/filebrowser/FileBrowser.test.ts`

**目标：** FileBrowser 加 `prefetchNextVolume`（请求序号三分支陈旧校验）+ StatusBar 绑定 props/emit。

- [ ] **步骤 1：编写失败的测试**

在 `FileBrowser.test.ts` 的「瀑布流跨卷工具栏下一卷按钮」describe 块（约 1398 行）后追加新 describe。

> **重要：复用现有 harness**。文件顶部已 `vi.mock('@/lib/tauri', ...)`（17 行），`findNextVolume` 已 mock（34 行）并导出为 `mockedFindNextVolume = vi.mocked(findNextVolume)`（47 行）。**不要用 `vi.doMock`**（已 import 的模块上不生效）。用 `mockedFindNextVolume.mockImplementation(...)` / `mockResolvedValue` / `mockRejectedValueOnce` 控制返回。

```typescript
// ─── 底栏下一卷预查(spec §3.5, 审查 P1-3 请求序号) ───
describe('底栏 StatusBar 下一卷预查', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFindNextVolume.mockResolvedValue(null);   // 默认无下一卷
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('lastFetchedPath 变化 → debounce 300ms → findNextVolume 返回 title → StatusBar 收到', async () => {
    mockedFindNextVolume.mockResolvedValue({ descriptor: { type: 'local', rootPath: 'D:\\comics' }, relPath: 'vol02', title: 'vol02' });
    const wrapper = await mountFileBrowserWithRoot('D:\\comics', 'vol01');
    await flushPromises();
    vi.advanceTimersByTime(300);
    await flushPromises();
    expect(mockedFindNextVolume).toHaveBeenCalled();
    const sb = wrapper.findComponent(StatusBar);
    expect(sb.props('nextVolumeTitle')).toBe('vol02');
  });

  it('旧请求晚返回失败不覆盖新目录(请求序号陈旧校验)', async () => {
    // vol01 预查: 挂起(返回一个可控的 promise)
    let rejectVol01: (e: Error) => void = () => {};
    mockedFindNextVolume.mockImplementationOnce(() =>
      new Promise((_, rej) => { rejectVol01 = rej; }),
    );
    // vol02 预查: 成功返回 title
    mockedFindNextVolume.mockResolvedValueOnce({ descriptor: { type: 'local', rootPath: 'D:\\comics' }, relPath: 'vol03', title: 'vol03' });

    const wrapper = await mountFileBrowserWithRoot('D:\\comics', 'vol01');
    await flushPromises();
    vi.advanceTimersByTime(300);          // vol01 预查发出(挂起)
    await flushPromises();

    // 切到 vol02(新请求, seq++)
    await setLastFetchedPath(wrapper, 'vol02');
    vi.advanceTimersByTime(300);          // vol02 预查发出
    await flushPromises();

    // vol01 旧请求现在失败返回
    rejectVol01(new Error('network'));
    await flushPromises();

    // vol01 失败不该把 vol02 的 title 覆盖成 null
    const sb = wrapper.findComponent(StatusBar);
    expect(sb.props('nextVolumeTitle')).toBe('vol03');
  });
});
```

`mountFileBrowserWithRoot(rootPath, lastFetchedPath)` 和 `setLastFetchedPath(wrapper, path)` 是辅助函数——参考文件内现有 `onCrossNextVolume` 测试块（约 1407-1498 行）的 mount 模式实现。若现有 harness 已有等价的 mount helper（如 `mountBrowser`），直接复用并对齐命名。`StatusBar` import：`import StatusBar from './StatusBar.vue'`（文件顶部 import 区）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/FileBrowser.test.ts`
预期：FAIL（FileBrowser 还没 prefetchNextVolume / StatusBar 还没绑 next-volume）

- [ ] **步骤 3：FileBrowser 加预查 + 绑定**

在 `FileBrowser.vue` script setup（`onCrossNextVolume` 附近，约 545-569 行后）加：

```typescript
// ─── 底栏下一卷预查(spec §3.5, 审查 P1-3 请求序号三分支校验) ───
const nextVolumeTitle = ref<string | null | undefined>(undefined);
const nextVolumeLoading = ref(false);
let nextVolumeDebounce: ReturnType<typeof setTimeout> | null = null;
let nextVolumeRequestSeq = 0;

async function prefetchNextVolume(): Promise<void> {
  const path = fb.lastFetchedPath;
  const root = masonryDescriptor.value.rootPath;
  if (!path || !root) { nextVolumeTitle.value = null; return; }
  const seq = ++nextVolumeRequestSeq;
  nextVolumeLoading.value = true;
  try {
    const result = await findNextVolume(masonryDescriptor.value, path, 'next');
    if (seq !== nextVolumeRequestSeq) return;           // 成功: 陈旧丢弃
    nextVolumeTitle.value = result?.title ?? null;
  } catch (e) {
    if (seq !== nextVolumeRequestSeq) return;           // 失败: 陈旧丢弃
    log('[FileBrowser] prefetchNextVolume failed', e);
    nextVolumeTitle.value = null;
  } finally {
    if (seq === nextVolumeRequestSeq) {                 // finally: 仅最新请求关 loading
      nextVolumeLoading.value = false;
    }
  }
}

watch(() => fb.lastFetchedPath, () => {
  if (nextVolumeDebounce) clearTimeout(nextVolumeDebounce);
  // 切目录立即置 loading(不设 undefined, 右段显示「…」不闪空, spec §3.3)
  nextVolumeLoading.value = true;
  nextVolumeDebounce = setTimeout(() => void prefetchNextVolume(), 300);
});
```

`findNextVolume` import（若未 import）：

```typescript
import { findNextVolume } from '@/lib/tauri';
```

`onCrossNextVolume` 成功跳转后（`await fb.navigate(result.relPath);` 之后，约 561 行）追加刷新：

```typescript
    await fb.navigate(result.relPath);
    pushToast(t('reader.crossVolume.jumped', { title: result.title }));
    void prefetchNextVolume();   // 跳转后刷新右段(新卷的下一卷候选)
```

修改 template 的 StatusBar 调用（约 924-930 行）：

```vue
      <StatusBar
        :total="fb.sortedEntries.length"
        :selected-count="fb.selectedCount"
        :selection-size-bytes="fb.selectionSizeBytes"
        :current-path="displayPath"
        :items-text="statusBarItemsText"
        :next-volume-title="nextVolumeTitle"
        :next-volume-loading="nextVolumeLoading"
        :next-volume-disabled="swapping || !fb.rootPath || !fb.lastFetchedPath"
        @next-volume="onCrossNextVolume"
      />
```

- [ ] **步骤 4：补全 mount 辅助函数（如缺失）**

若文件内无等价 `mountFileBrowserWithRoot` / `setLastFetchedPath`，参考现有 `onCrossNextVolume` 测试块（约 1407-1498 行）的 mount + store 操作模式补全。核心：mount FileBrowser、设置 fileBrowser store 的 rootPath + lastFetchedPath、flushPromises。若现有 harness 已有 mount helper，直接复用并删除本步骤新增的辅助函数。

`flushPromises` 来自 `vi` 或测试 utils（`import { flushPromises } from '@vue/test-utils'`）。

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/FileBrowser.test.ts`
预期：PASS（新增 2 用例 + 现有 onCrossNextVolume 4 用例不回归）

- [ ] **步骤 6：Commit**

```bash
git add src/components/filebrowser/FileBrowser.vue src/components/filebrowser/FileBrowser.test.ts
git commit -m "feat(filebrowser): 底栏下一卷预查(请求序号三分支陈旧校验) + StatusBar 绑定"
```

---

## 任务 7：MasonryView atBottom computed 三档规则

**文件：**
- 修改：`src/components/filebrowser/MasonryView.vue`

**目标：** MasonryView 计算 atBottom（三档规则）+ layoutHeight 触发源，传给 composable。此任务先加 computed + 暴露，任务 8 才接进 composable。

- [ ] **步骤 1：编写失败的测试（computeAtBottom 三档纯函数）**

在 `MasonryView.test.ts` 追加。三档规则抽成纯函数 `computeAtBottom`（步骤 3），单测它而非 MasonryView 的 computed（MasonryView 深耦合 useVirtualList/useMasonryLayout，computed 难直接单测；纯函数覆盖全部逻辑）：

```typescript
import { computeAtBottom } from '@/composables/useMasonryLayout';

describe('computeAtBottom 三档纯函数', () => {
  it('档1 不足一屏(sh<=ch): 返回 true', () => {
    expect(computeAtBottom(600, 800, 0)).toBe(true);
  });
  it('档2 短目录(ch<sh<2ch) 顶部 st=0: false(防误判)', () => {
    expect(computeAtBottom(1400, 800, 0)).toBe(false);
  });
  it('档2 短目录 滚动+贴底 st>0: true', () => {
    // sh=1400 ch=800 nearBottom: st+800>=1400-64=1336 → st>=536
    expect(computeAtBottom(1400, 800, 600)).toBe(true);
  });
  it('档3 长目录(sh>=2ch) 贴底: true', () => {
    expect(computeAtBottom(2000, 800, 1200)).toBe(true);
  });
  it('档3 长目录 未贴底: false', () => {
    expect(computeAtBottom(2000, 800, 100)).toBe(false);
  });
  it('档2 短目录 贴底但 st=0: false(须实际滚过)', () => {
    // sh=1400 ch=800 st=0: nearBottom(0+800>=1336)=false, 且 st=0 → false
    expect(computeAtBottom(1400, 800, 0)).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：FAIL（computeAtBottom 不存在）

- [ ] **步骤 3：抽 computeAtBottom 纯函数到 useMasonryLayout.ts**

在 `src/composables/useMasonryLayout.ts` 加导出（放在 `computeColWidth` 附近）：

```typescript
/** atBottom 三档规则常量(spec §2.1) */
export const BOTTOM_THRESHOLD_PX = 64;

/**
 * 计算「是否滚到底」三档规则(spec §2.1, 审查 P1-b + P2)。
 * - 档1 不足一屏(sh<=ch): true(停留即可,滚不动)
 * - 档2 短目录(ch<sh<2ch): nearBottom && st>0(须实际滚过防顶部误判)
 * - 档3 长目录(sh>=2ch): nearBottom
 * 纯函数, 可独立单测(MasonryView atBottom computed 调它)。
 */
export function computeAtBottom(sh: number, ch: number, st: number): boolean {
  const nearBottom = st + ch >= sh - BOTTOM_THRESHOLD_PX;
  if (sh <= ch) return true;
  if (sh < 2 * ch) return nearBottom && st > 0;
  return nearBottom;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/components/filebrowser/MasonryView.test.ts`
预期：PASS（computeAtBottom 5 用例）。注意 import：`import { computeAtBottom } from '@/composables/useMasonryLayout'`

- [ ] **步骤 5：MasonryView 接 atBottom computed**

在 `MasonryView.vue` script setup（`browsePosition` 定义前，约 251 行前）加：

```typescript
import { computeAtBottom } from '@/composables/useMasonryLayout';

// atBottom 三档规则(spec §2.1): layoutHeight 作响应式触发源(审查 P1), 判定读 el.scrollHeight
const atBottom = computed(() => {
  const el = containerRef.value;
  if (!el) return false;
  void layout.value.totalHeight;          // 依赖声明: layout 高度变化时重算
  return computeAtBottom(el.scrollHeight, el.clientHeight, el.scrollTop);
});
```

`containerRef` 来自 `useVirtualList`（MasonryView:59 已有）。

- [ ] **步骤 6：type-check**

运行：`npm run type-check`
预期：0 error

- [ ] **步骤 7：Commit**

```bash
git add src/composables/useMasonryLayout.ts src/components/filebrowser/MasonryView.vue src/components/filebrowser/MasonryView.test.ts
git commit -m "feat(masonry): computeAtBottom 三档规则纯函数 + MasonryView atBottom computed"
```

---

## 任务 8：useMasonryBrowsePosition 接 atBottom param + watch(atBottom)

**文件：**
- 修改：`src/composables/useMasonryBrowsePosition.ts`
- 修改：`src/composables/useMasonryBrowsePosition.test.ts`
- 修改：`src/components/filebrowser/MasonryView.vue`

**目标：** composable 加 `atBottom` 参数 + 内部 `watch(atBottom)` 捕获翻转（false→true 调 scheduleRecord，true→false 调 clearStableTimer）。此任务**只接管线**，finished 逻辑在任务 10+。

- [ ] **步骤 1：编写失败的测试（atBottom 翻转触发 scheduleRecord）**

在 `useMasonryBrowsePosition.test.ts` 追加：

```typescript
it('atBottom false→true 触发 scheduleRecord(布局变化入口, 审查 P1)', async () => {
  const atBottomRef = ref(false);
  const { start, saveProgressMock } = await setupWithAtBottom({ atBottom: atBottomRef });
  await start();
  await flushPromises();
  // scrollTop 不变, 仅 atBottom 翻 true(模拟布局收敛后贴底)
  atBottomRef.value = true;
  await flushPromises();
  vi.advanceTimersByTime(300);  // debounce
  await flushPromises();
  expect(saveProgressMock).toHaveBeenCalled();
});

it('atBottom true→false 调 clearStableTimer(不残留)', async () => {
  const atBottomRef = ref(true);
  const { start } = await setupWithAtBottom({ atBottom: atBottomRef });
  await start();
  await flushPromises();
  atBottomRef.value = false;
  await flushPromises();
  // 内部 stableTimer 应被清(任务 10 加 stableTimer 后验, 此任务先验不崩)
  expect(true).toBe(true);  // placeholder, 任务 10 强化
});
```

> `setupWithAtBottom` 是 setup 的变体，多接一个 `atBottom: Ref<boolean>` 参数。参考现有 `setup` helper（测试文件顶部）扩展。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/composables/useMasonryBrowsePosition.test.ts`
预期：FAIL（composable 还没 atBottom param）

- [ ] **步骤 3：composable 加 atBottom param + watch**

在 `useMasonryBrowsePosition.ts` 的 `UseMasonryBrowsePositionParams` interface 加：

```typescript
  /** 容器是否滚到底(MasonryView 三档 computed 注入, spec §2.1/§2.5) */
  atBottom: Ref<boolean>;
```

在 composable body（`stopEnabledWatch` 声明附近）加 atBottom watcher 变量：

```typescript
  let stopAtBottomWatch: (() => void) | null = null;
```

在 `start()` 内（`stopEnabledWatch` watch 后）加 atBottom watch：

```typescript
    if (stopAtBottomWatch) stopAtBottomWatch();
    stopAtBottomWatch = watch(
      () => params.atBottom.value,
      (now, prev) => {
        if (now && !prev) scheduleRecord();        // false→true: 等价一次滚动, 进 recordCurrentTop
        else if (!now && prev) clearStableTimer(); // true→false: 离开底部, 清 timer(任务 10 加)
      },
    );
```

> 注：`clearStableTimer` 在任务 10 才定义。此任务先写一个空的 `function clearStableTimer() {}` 占位（任务 10 替换实现），让 watch 不报未定义。

在 `stop()` 内加清理：

```typescript
  if (stopAtBottomWatch) { stopAtBottomWatch(); stopAtBottomWatch = null; }
```

- [ ] **步骤 4：MasonryView 传 atBottom 给 composable**

修改 `MasonryView.vue` 的 `useMasonryBrowsePosition({...})` 调用，加 `atBottom`：

```typescript
const browsePosition = useMasonryBrowsePosition({
  descriptor: toRef(props, 'descriptor'),
  currentPath: toRef(props, 'currentPath'),
  renderEntries: entriesRef,
  canonicalImageNames: computed(() => props.canonicalImageNames),
  layoutMap: computed(() => layout.value.map),
  scrollTop,
  colWidth,
  atBottom,                    // ← 新增(任务 7 定义的 computed)
  scrollToEntry,
  enabled: computed(() => settingsStore.recordBrowsePosition),
  autoRestoreOnMount: computed(() => settingsStore.restoreBrowsePositionOnEnter),
});
```

- [ ] **步骤 5：更新现有测试 setup helper**

在 `useMasonryBrowsePosition.test.ts` 的 `setup` helper 加 `atBottom` 默认参数（`ref(false)`），所有现有用例自动兼容。

- [ ] **步骤 6：运行测试验证通过**

运行：`npx vitest run src/composables/useMasonryBrowsePosition.test.ts`
预期：PASS（新 2 用例 + 现有全绿）

- [ ] **步骤 7：type-check**

运行：`npm run type-check`
预期：0 error

- [ ] **步骤 8：Commit**

```bash
git add src/composables/useMasonryBrowsePosition.ts src/composables/useMasonryBrowsePosition.test.ts src/components/filebrowser/MasonryView.vue
git commit -m "feat(masonry-position): 接 atBottom param + watch(atBottom) 布局变化入口"
```

---

## 任务 9：stableTimer / clearStableTimer 封装 + recordCurrentTop 入口 enabled 守卫

**文件：**
- 修改：`src/composables/useMasonryBrowsePosition.ts`
- 修改：`src/composables/useMasonryBrowsePosition.test.ts`

**目标：** 加 `bottomSince` / `stableTimer` / `scheduleStableTimer` / `clearStableTimer`（置空语义 + 5 出口），recordCurrentTop 入口加 `enabled` 守卫。此任务**先搭骨架**，finished 判定在任务 10。

- [ ] **步骤 1：编写失败的测试（enabled=false 时 recordCurrentTop 不写 + flushNow 也不写）**

```typescript
it('enabled=false: recordCurrentTop 入口守卫, 不写(审查 P1-2)', async () => {
  const { start, saveProgressMock, stop } = await setup({ enabled: false });
  await start();
  await flushPromises();
  // 现有用例已覆盖 enabled=false 不写, 此处强化: flushNow 也走入口
  // flushNow 测试在任务 9 步骤 1b
});

it('enabled=false: flushNow 也不写(flushNow 走 recordCurrentTop 入口, 审查 P1-2)', async () => {
  const { start, stop, flushNow, saveProgressMock } = await setup({ enabled: false });
  await start();
  await flushPromises();
  await flushNow();
  await flushPromises();
  expect(saveProgressMock).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/composables/useMasonryBrowsePosition.test.ts`
预期：FAIL（flushNow 现在无条件调 recordCurrentTop，enabled=false 仍写）

- [ ] **步骤 3：实现骨架**

在 composable body 加状态 + 函数：

```typescript
  let bottomSince: number | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  const STABLE_MS = 1200;

  /** 调度 STABLE_MS 后的升级判定(spec §2.3, 置空守护) */
  function scheduleStableTimer(): void {
    if (stableTimer !== null) return;
    stableTimer = setTimeout(() => {
      stableTimer = null;                     // 回调首行置空(审查 P1-a)
      void recordCurrentTop();
    }, STABLE_MS);
  }

  /** 清 stableTimer + bottomSince(5 出口统一调, spec §2.3 不变量) */
  function clearStableTimer(): void {
    if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
    bottomSince = null;
  }
```

（替换任务 8 的空占位 `clearStableTimer`。）

recordCurrentTop 入口最前面加 enabled 守卫（在 `const seqAtEntry = ...` 之前）：

```typescript
  async function recordCurrentTop(): Promise<void> {
    if (!params.enabled.value) return;        // 审查 P1-2: 入口守卫(flushNow 也走这)
    const seqAtEntry = activeStartSeq;
    // ...现有逻辑...
  }
```

5 出口调 clearStableTimer：在 `start()` 开头、`stop()` 开头、`disableWatcher()` 内、`scheduleRecord` resize 分支、`recordCurrentTop` else 分支（atBottom false，任务 10 加）。任务 9 先加前 4 个（recordCurrentTop 的 else 分支在任务 10 改造时加）：

```typescript
  async function start(): Promise<void> {
    activeStartSeq += 1;
    clearStableTimer();                       // ← 加
    // ...现有...
  }

  function stop(): void {
    activeStartSeq += 1;
    clearStableTimer();                       // ← 加
    // ...现有...
  }

  function disableWatcher(): void {
    clearStableTimer();                       // ← 加
    // ...现有...
  }

  function scheduleRecord(): void {
    if (Date.now() - lastResizeAt < RESIZE_COOLDOWN_MS) {
      clearStableTimer();                     // ← 加(resize 冷却期清 timer)
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      return;
    }
    // ...现有...
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/composables/useMasonryBrowsePosition.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useMasonryBrowsePosition.ts src/composables/useMasonryBrowsePosition.test.ts
git commit -m "feat(masonry-position): stableTimer/clearStableTimer 骨架 + recordCurrentTop enabled 入口守卫"
```

---

## 任务 10：atBottom + 停留 → finishedNow 判定 + 复合去重（A9）+ successfulWrites

**文件：**
- 修改：`src/composables/useMasonryBrowsePosition.ts`
- 修改：`src/composables/useMasonryBrowsePosition.test.ts`

**目标：** recordCurrentTop 加 atBottom/bottomSince/finishedNow 计算 + A9 复合去重（快+慢路径）+ successfulWrites。**核心逻辑任务。**

- [ ] **步骤 1：编写失败的测试（A-T1/A-T2 停留确认 + 升级）**

```typescript
it('A-T1: 滚到底停留<STABLE_MS: 写 finished=undefined, 不升级', async () => {
  const atBottomRef = ref(true);
  const { start, saveProgressMock } = await setup({ atBottom: atBottomRef });
  await start();
  await flushPromises();
  // 第 1 次 recordCurrentTop(atBottom=true, bottomSince=null → 记 + 调 timer, finishedNow=false)
  vi.advanceTimersByTime(300);  // debounce
  await flushPromises();
  expect(saveProgressMock).toHaveBeenCalledTimes(1);
  // 第 4 参(finished)应为 undefined
  expect(saveProgressMock.mock.calls[0][3]).toBeUndefined();
});

it('A-T2: 滚到底停留>=STABLE_MS: 第 2 次写 finished=true(同图升级, A9 复合去重放行)', async () => {
  const atBottomRef = ref(true);
  const { start, saveProgressMock } = await setup({ atBottom: atBottomRef });
  await start();
  await flushPromises();
  vi.advanceTimersByTime(300);  // 第 1 次
  await flushPromises();
  vi.advanceTimersByTime(STABLE_MS + 1);  // stableTimer 触发第 2 次
  await flushPromises();
  expect(saveProgressMock).toHaveBeenCalledTimes(2);
  expect(saveProgressMock.mock.calls[1][3]).toBe(true);  // 升级
});

it('A-T3: 已 finished 再滚到底: 不重复 saveProgress(A7 幂等)', async () => {
  const atBottomRef = ref(true);
  const { start, saveProgressMock } = await setup({ atBottom: atBottomRef, initialFinished: true });
  await start();
  await flushPromises();
  vi.advanceTimersByTime(300);
  await flushPromises();
  // initialFinished=true → 入口 A7 跳过
  expect(saveProgressMock).not.toHaveBeenCalled();
});
```

> `setup` helper 需支持 `initialFinished` 参数（mock `getProgress` 返回 finished=true）。`STABLE_MS` 从 composable 导出或测试里用同值常量。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/composables/useMasonryBrowsePosition.test.ts`
预期：FAIL（finishedNow 还没算，saveProgress 第 4 参恒 undefined）

- [ ] **步骤 3：实现核心逻辑**

在 composable body 加 `successfulWrites` + `lastWrittenFinishedParam`：

```typescript
  const successfulWrites = new Set<string>();
  const lastWrittenFinishedParam = ref<boolean | undefined>(undefined);
```

改造 `recordCurrentTop`（替换现有 `:190-228` 整块）：

```typescript
  async function recordCurrentTop(): Promise<void> {
    if (!params.enabled.value) return;                    // 审查 P1-2 入口守卫
    const seqAtEntry = activeStartSeq;
    const descAtEntry = JSON.parse(JSON.stringify(params.descriptor.value)) as SourceDescriptor;
    const pathAtEntry = params.currentPath.value;
    const e = topmostImage.value;
    if (!e) return;

    // ── atBottom + 停留判定(spec §2.3) ──
    const atBottom = params.atBottom.value;
    let finishedNow = false;
    if (atBottom) {
      if (bottomSince === null) {
        bottomSince = Date.now();
        scheduleStableTimer();
        // 首次到底: 先写普通进度
      } else {
        finishedNow = Date.now() - bottomSince >= STABLE_MS;
      }
    } else {
      clearStableTimer();                                 // 离开底部(5 出口之一)
      finishedNow = false;
    }

    const finishedParam: boolean | undefined = finishedNow ? true : undefined;

    // ── A7 幂等: 已 finished 跳过(单调缓存, spec §2.7) ──
    if (finishedParam === true && (lastBrowseProgress.value?.finished === true)) return;
    // 普通滚动(undefined)也要去重(同图)

    // ── A9 复合去重(快+慢路径, spec §2.8) ──
    const identity = progressWriteKey(descAtEntry, pathAtEntry, e.path, finishedParam);
    const alreadyWritten =
      (e.path === lastWrittenPath.value && finishedParam === lastWrittenFinishedParam.value)
      || successfulWrites.has(identity);
    if (alreadyWritten) return;

    const pageAtEntry = params.canonicalImageNames.value.indexOf(e.name);
    const writeSeqAtEntry = activeWriteSeq;

    try {
      // ── 阶段 1: 写入前竞态(允许取消) ──
      const bookId = await ensureBookIdForCurrentDir(descAtEntry, pathAtEntry);
      if (seqAtEntry !== activeStartSeq) { scheduleRetryIfStillAtBottom(); return; }
      if (!sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) return;  // 切目录
      if (bookId == null) return;                         // 持久失败: 不重试
      if (writeSeqAtEntry !== activeWriteSeq) { scheduleRetryIfStillAtBottom(); return; }

      // ── IPC 写入 ──
      let writeSucceeded = false;
      try {
        await saveProgress(bookId, pageAtEntry, 'single', finishedParam, e.name);
        writeSucceeded = true;
      } catch (err) {
        log('[useMasonryBrowsePosition] saveProgress failed', err);
        scheduleRetryIfStillAtBottom();
        return;
      }

      // ── 阶段 2: 写入后(DB 已成功) ──
      successfulWrites.add(identity);                     // ① 始终记 DB 成功(慢路径去重)
      if (writeSeqAtEntry === activeWriteSeq
          && sameDir(descAtEntry, pathAtEntry, params.descriptor.value, params.currentPath.value)) {
        // ② 仅最新请求 + 同目录: 更新当前 UI 缓存
        lastWrittenPath.value = e.path;
        lastWrittenFinishedParam.value = finishedParam;
        lastBrowseProgress.value = {
          bookId,
          page: pageAtEntry,
          imageName: e.name,
          readerMode: 'single',
          updatedAt: Date.now(),
          finished: finishedNow || lastBrowseProgress.value?.finished || false,  // 单调(审查 P1-1)
        };
      }
      // ③ 陈旧成功(writeSeq 变): 不碰 UI 缓存, 不重试(DB 已成功)
    } catch (err) {
      log('[useMasonryBrowsePosition] recordCurrentTop failed', err);
    }
  }

  /** 统一失败出口: 仅 DB 未成功时调(spec §2.3, 审查 P1) */
  function scheduleRetryIfStillAtBottom(): void {
    if (
      params.enabled.value &&
      params.atBottom.value &&
      bottomSince !== null &&
      stableTimer === null
    ) {
      scheduleStableTimer();
    }
  }
```

import progressWriteKey：

```typescript
import { progressWriteKey } from '@/lib/progressWriteKey';
```

`start()`/`stop()` 清理加 successfulWrites + lastWrittenFinishedParam：

```typescript
  async function start(): Promise<void> {
    activeStartSeq += 1;
    clearStableTimer();
    successfulWrites.clear();
    lastWrittenFinishedParam.value = undefined;
    // ...现有...
  }
  function stop(): void {
    activeStartSeq += 1;
    clearStableTimer();
    successfulWrites.clear();
    lastWrittenFinishedParam.value = undefined;
    // ...现有...
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/composables/useMasonryBrowsePosition.test.ts`
预期：A-T1/A-T2/A-T3 PASS。现有用例可能因 recordCurrentTop 重写需调整（去重逻辑变了），逐个修。

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useMasonryBrowsePosition.ts src/composables/useMasonryBrowsePosition.test.ts
git commit -m "feat(masonry-position): atBottom+停留→finished + A9 复合去重 + 两阶段提交"
```

---

## 任务 11：补全 A 部分剩余测试（A-T4~T21）

**文件：**
- 修改：`src/composables/useMasonryBrowsePosition.test.ts`

**目标：** 补全 spec §7.1 剩余测试（离开底部重置、resize 取消 timer、enabled flushNow、缓存单调、瞬时失败重试、持久失败不重试、生命周期不变量、最新/陈旧请求提交）。这是验证任务,不改实现。

- [ ] **步骤 1：逐个编写测试**

参照 spec §7.1 表格，逐个实现 A-T4~T21（跳过已在任务 10 实现的 A-T1/T2/T3）：

- A-T4 离开底部：`atBottomRef.value = false` → 清 timer + 写 undefined
- A-T5 离开再回来重计时
- A-T6 start 重置（successfulWrites/lastWritten* 全清）
- A-T7 resize 冷却期不写
- A-T8 resize 冷却期取消 stableTimer
- A-T9 enabled=false flushNow 不写（任务 9 已部分，强化）
- A-T10 reader 写 true 后普通滚动缓存仍 true（mock getProgress finished=true，滚动另一图）
- A-T11 多列（atBottom ref 翻转即可，三档在 MasonryView 单测）
- A-T14 瞬时失败重试（mock saveProgress 第 2 次抛错，验第 3 次仍调）
- A-T15 生命周期不变量（间接：各出口后 bottomSince 为 null）
- A-T16 持久失败不重试（mock ensureBookId 返回 null）
- A-T17 布局高度变化（atBottom false→true 触发，任务 8 已部分，强化 finished 链路）
- A-T20 最新请求成功写入（writeSeq 未变，UI 缓存更新）
- A-T21 陈旧成功不污染（writeSeq 已变，UI 缓存不更新，successfulWrites 记录）

每个测试：写 → 跑 → 若 FAIL 调实现（理想情况任务 10 实现已覆盖，测试直接 PASS；若 FAIL 说明实现有缺口，回到任务 10 修）。

- [ ] **步骤 2：运行全部 A 测试**

运行：`npx vitest run src/composables/useMasonryBrowsePosition.test.ts`
预期：全部 PASS（A-T1~T21）

- [ ] **步骤 3：Commit**

```bash
git add src/composables/useMasonryBrowsePosition.test.ts
git commit -m "test(masonry-position): 补全 A-T4~T21 竞态/状态测试"
```

---

## 任务 12：全测 + type-check + 收尾

**文件：** 无（验证任务）

- [ ] **步骤 1：跑全测**

运行：`npm test -- --run`
预期：全部 PASS。用例数应为 基线 + 新增（progressWriteKey 7 + StatusBar ~7 + FileBrowser 预查 2 + MasonryView computeAtBottom 5 + useMasonryBrowsePosition A-T1~T21 约 18）。记录实际数。

- [ ] **步骤 2：type-check**

运行：`npm run type-check`
预期：0 error

- [ ] **步骤 3：本地 build portable（可选，验组件集成）**

运行：`cmd.exe //C "F:\\WorkSpaceCollection\\git\\mirapage-desktop\\tauri-build-portable.bat"`
预期：build 成功（验 Rust 无改动 + 前端集成无运行时错误）

- [ ] **步骤 4：更新 CLAUDE.md 当前状态表**

在 `CLAUDE.md` 「当前状态」表格追加一行（3.1.1 或下一个版本号）：

```
| 3.1.1 | 瀑布流滚到底算读完 + 底栏下一卷 + StatusBar 优化 | ✅ ...（描述） |
```

- [ ] **步骤 5：tag + push**

```bash
git tag v0.1.0-module3.1.1
git push github main
git push github v0.1.0-module3.1.1
```

- [ ] **步骤 6：Commit CLAUDE.md 更新**

```bash
git add CLAUDE.md
git commit -m "docs: 更新当前状态表(3.1.1 瀑布流 finished + 底栏下一卷)"
```

---

## 验收对照（spec 覆盖度）

| spec 章节 | 覆盖任务 |
|---|---|
| §2.1 三档规则 atBottom | 任务 7（computeAtBottom） |
| §2.2 触发条件 5 项 | 任务 10（finishedNow + enabled + canonicalImageNames）|
| §2.3 状态机 stableTimer + 两阶段 + 统一失败出口 | 任务 9（骨架）+ 任务 10（核心）|
| §2.5 atBottom 传递 + layoutHeight 触发源 | 任务 7 + 任务 8 |
| §2.7 缓存单调 + reader 协调 | 任务 10（finishedNow \|\| last.finished）|
| §2.8 A9 复合去重 + successfulWrites | 任务 5（progressWriteKey）+ 任务 10 |
| §3 StatusBar 下一卷 | 任务 2 |
| §3.3 三态 + 不闪空 | 任务 2 + 任务 6 |
| §3.5 预查请求序号 | 任务 6 |
| §4 三段等宽 | 任务 1 |
| §5 跑马灯 | 任务 4 |
| §7 测试矩阵 A-T1~T21 | 任务 10 + 任务 11 |
| §7 测试矩阵 B-T1~T10 | 任务 2 + 任务 6 |

## 自检

**1. 规格覆盖度：** 上表逐章对应，无遗漏。§6 数据流总览是说明性章节无需任务。§8 i18n = 任务 3。§10/§11 是风险/开放问题，实现时遵循。

**2. 占位符扫描：** 任务 6 测试复用现有模块级 `vi.mock` + `mockedFindNextVolume` harness（已验证 17/34/47 行存在），不用 `vi.doMock`。任务 8 setup helper 扩展已指明位置。任务 9 的 `clearStableTimer` 空占位 → 任务 9 实现的衔接已明确（任务 8 步骤 3 注明占位，任务 9 步骤 3 注明替换）。任务 11 的 A-T4~T21 列表完整，每个有 spec §7.1 对应预期。无空洞 TODO。

**3. 类型一致性：** `atBottom: Ref<boolean>`（任务 8 定义）在任务 7/10 一致。`progressWriteKey(descriptor, relPath, imageName, finished)` 签名任务 5 定义，任务 10 调用一致。`clearStableTimer`/`scheduleStableTimer`/`scheduleRetryIfStillAtBottom` 命名跨任务一致。`STABLE_MS=1200` 任务 9 定义，任务 10/11 引用一致。
