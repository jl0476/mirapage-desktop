/**
 * VirtualRow.vue 测试
 * v0.1.0-module3.0.4-virtuallist: Phase 3 FileList 集成 - 虚拟列表 row 子组件
 *
 * v0.1.0-module3.0.5-masonry (阶段 E2): 仅剩 details view block;
 *  list/grid 已删除. 测试聚焦 details + 基础 row 渲染.
 *
 * 验证:
 * - template 仅渲染 row-view-details block
 * - absoluteTop → transform: translateY (只触发 composite)
 * - aria-rowindex 从 1 开始
 * - iconType WeakMap 缓存 (重复调用命中缓存)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/locales/zh-CN'
import VirtualRow from './VirtualRow.vue'
import type { MediaEntry } from '@/lib/sourceDescriptor'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN },
})

function entry(name: string, opts: Partial<MediaEntry> = {}): MediaEntry {
  return {
    name,
    path: name,
    isDirectory: false,
    isArchive: false,
    size: 0,
    modifiedAt: 0,
    ...opts,
  }
}

describe('VirtualRow.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  const mkProps = (overrides: Record<string, unknown> = {}): any => ({
    entry: entry('foo.txt'),
    rowIndex: 0,
    absoluteTop: 0,
    mark: 'none',
    selected: false,
    viewMode: 'details',
    rowHeight: 29,
    ...overrides,
  })

  it('只渲染 details view block (list/grid block 已删)', () => {
    const w = mount(VirtualRow, {
      props: mkProps(),
      global: { plugins: [createPinia(), i18n] },
    })
    expect(w.find('.row-view-details').exists()).toBe(true)
    expect(w.find('.row-view-list').exists()).toBe(false)
    expect(w.find('.row-view-grid').exists()).toBe(false)
  })

  it('details view host class 存在 (row-host-details)', () => {
    const w = mount(VirtualRow, {
      props: mkProps({ viewMode: 'details' }),
      global: { plugins: [createPinia(), i18n] },
    })
    expect(w.find('.row-host-details').exists()).toBe(true)
  })

  it('absoluteTop → transform: translateY', () => {
    const w = mount(VirtualRow, {
      props: mkProps({ rowIndex: 100, absoluteTop: 2900 }),
      global: { plugins: [createPinia(), i18n] },
    })
    const style = w.find('.row-host').attributes('style') || ''
    expect(style).toContain('translateY(2900px)')
  })

  it('aria-rowindex 从 1 开始', () => {
    const w = mount(VirtualRow, {
      props: mkProps({ rowIndex: 4 }),
      global: { plugins: [createPinia(), i18n] },
    })
    expect(w.find('[role="row"]').attributes('aria-rowindex')).toBe('5')
  })

  it('iconType WeakMap 缓存: 重复调用稳定返回 image', () => {
    const e = entry('foo.jpg')
    const w = mount(VirtualRow, {
      props: mkProps({ entry: e }),
      global: { plugins: [createPinia(), i18n] },
    })
    // vm 上能拿到 script setup 暴露的 iconType 函数
    const vm = w.vm as unknown as { iconType: (entry: MediaEntry) => string }
    expect(vm.iconType(e)).toBe('image')
    expect(vm.iconType(e)).toBe('image')  // 第二次命中缓存
  })
})