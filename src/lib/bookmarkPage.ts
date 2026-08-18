/** 当前列表（当前生效排序）中图片的 0-based canonical 索引；不在列表返回 null。 */
export function bookmarkPageForImage(
  imageNames: readonly string[],
  imageName: string,
): number | null {
  const index = imageNames.indexOf(imageName);
  return index < 0 ? null : index;
}

/** 书签存储位置 → canonical 图片索引：legacy spread 索引取该 spread 首图，image 索引原样（负值钳 0）。 */
export function imageIndexForBookmark(
  position: number,
  kind: 'image' | 'spread' | null | undefined,
  spreads: readonly { start: number }[],
): number {
  if (kind !== 'spread') return Math.max(0, position);
  return Math.max(0, spreads[Math.max(0, position)]?.start ?? 0);
}
