// 自然排序（TS 版）
// 与 Rust `algorithm::natural_compare` 语义一致
// 参考 MiraPage Android `NaturalSortComparator.kt`

/** 自然比较：page2.jpg < page10.jpg */
export function naturalCompare(a: string, b: string): number {
  const aSegs = splitToSegments(a);
  const bSegs = splitToSegments(b);
  const len = Math.min(aSegs.length, bSegs.length);

  for (let i = 0; i < len; i++) {
    const aSeg = aSegs[i];
    const bSeg = bSegs[i];
    const aIsNum = /^\d/.test(aSeg);
    const bIsNum = /^\d/.test(bSeg);

    if (aIsNum && bIsNum) {
      const aNorm = aSeg.replace(/^0+/, '') || '0';
      const bNorm = bSeg.replace(/^0+/, '') || '0';
      if (aNorm.length !== bNorm.length) return aNorm.length - bNorm.length;
      if (aNorm !== bNorm) return aNorm < bNorm ? -1 : 1;
    } else {
      const aLower = aSeg.toLowerCase();
      const bLower = bSeg.toLowerCase();
      if (aLower !== bLower) return aLower < bLower ? -1 : 1;
    }
  }

  return aSegs.length - bSegs.length;
}

function splitToSegments(s: string): string[] {
  const segs: string[] = [];
  let i = 0;
  while (i < s.length) {
    const isDigit = /\d/.test(s[i]);
    let j = i;
    while (j < s.length && /\d/.test(s[j]) === isDigit) j++;
    segs.push(s.slice(i, j));
    i = j;
  }
  return segs;
}

/** 对数组按 key 做自然排序（返回新数组） */
export function naturalSort<T>(items: T[], keyFn: (item: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(keyFn(a), keyFn(b)));
}