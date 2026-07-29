/**
 * Tags Pinia store
 * 与 Rust commands::tags 对接(DESIGn §5 Phase 4):
 *   - list_tags / create_tag / delete_tag
 *   - add_book_tag / remove_book_tag
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  listTags,
  createTag,
  deleteTag,
  addBookTag,
  removeBookTag,
  type TagItem,
} from '@/lib/tauri';

export const useTagsStore = defineStore('tags', () => {
  const tags = ref<TagItem[]>([]);
  const bookTagsByBookId = ref<Record<number, number[]>>({});

  const tagsById = computed<Record<number, TagItem>>(() => {
    const out: Record<number, TagItem> = {};
    for (const t of tags.value) out[t.id] = t;
    return out;
  });

  async function refresh(): Promise<void> {
    tags.value = await listTags();
  }

  async function create(name: string, color: string | null = null): Promise<TagItem> {
    const t = await createTag(name, color);
    tags.value = [...tags.value, t];
    return t;
  }

  async function remove(id: number): Promise<void> {
    await deleteTag(id);
    tags.value = tags.value.filter((t) => t.id !== id);
    for (const bookId of Object.keys(bookTagsByBookId.value)) {
      bookTagsByBookId.value[Number(bookId)] = bookTagsByBookId.value[Number(bookId)].filter(
        (tid) => tid !== id,
      );
    }
  }

  async function tagBook(bookId: number, tagId: number): Promise<void> {
    await addBookTag(bookId, tagId);
    const list = bookTagsByBookId.value[bookId] ?? [];
    if (!list.includes(tagId)) {
      bookTagsByBookId.value = { ...bookTagsByBookId.value, [bookId]: [...list, tagId] };
    }
  }

  async function untagBook(bookId: number, tagId: number): Promise<void> {
    await removeBookTag(bookId, tagId);
    const list = bookTagsByBookId.value[bookId] ?? [];
    bookTagsByBookId.value = {
      ...bookTagsByBookId.value,
      [bookId]: list.filter((id) => id !== tagId),
    };
  }

  return {
    tags,
    tagsById,
    bookTagsByBookId,
    refresh,
    create,
    remove,
    tagBook,
    untagBook,
  };
});