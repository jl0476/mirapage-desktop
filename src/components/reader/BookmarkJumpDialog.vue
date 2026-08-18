<script setup lang="ts">
/**
 * BookmarkJumpDialog.vue — 书签跳转选框（阅读器主菜单 / 右键菜单 / 瀑布流右键共用）
 *
 * 受控组件：父级管 show + 书签列表；选中 emit jump(bm)，遮罩/ESC/取消 emit close。
 * 页码显示与 Bookmarks.vue 一致：image kind 1-based，legacy spread 原样。
 */
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BookmarkItem } from '@/lib/tauri';

interface Props {
  show: boolean;
  bookmarks: BookmarkItem[];
}
const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'jump', bm: BookmarkItem): void;
  (e: 'close'): void;
}>();

const { t } = useI18n();

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

/** 页码列显示：image kind 1-based，legacy spread 原样（当时语义即 spread 序号） */
function displayPage(page: number, positionKind: 'image' | 'spread'): number {
  return positionKind === 'image' ? page + 1 : page;
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.show"
      class="fixed inset-0 z-[1300] bg-black/60 flex items-center justify-center"
      data-test="bookmark-jump-dialog"
      @click.self="emit('close')"
    >
      <div class="w-[320px] bg-surface-1 xp-bd rounded-lg p-6 text-text-primary flex flex-col gap-3 shadow-xl">
        <h3 class="text-base font-semibold m-0">{{ t('reader.jumpToBookmark') }}</h3>
        <p v-if="props.bookmarks.length === 0" class="text-xs text-text-tertiary m-0">
          {{ t('bookmarks.empty') }}
        </p>
        <ul v-else class="list-none p-0 m-0 flex flex-col gap-1 max-h-[320px] overflow-y-auto">
          <li v-for="bm in props.bookmarks" :key="bm.id">
            <button
              class="w-full flex items-center gap-3 px-3 py-2 rounded text-left text-sm text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
              :data-test="`bookmark-jump-item-${bm.id}`"
              @click="emit('jump', bm)"
            >
              <span class="font-mono text-xs shrink-0">{{ displayPage(bm.page, bm.positionKind) }}</span>
              <span class="flex-1 truncate">{{ bm.label ?? t('bookmarks.page') }}</span>
            </button>
          </li>
        </ul>
        <div class="flex justify-end mt-1">
          <button
            type="button"
            class="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-surface-light hover:text-text-primary transition-colors"
            data-test="bookmark-jump-cancel"
            @click="emit('close')"
          >{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
