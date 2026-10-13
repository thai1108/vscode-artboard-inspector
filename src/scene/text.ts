const WEIGHT_NAMES: [RegExp, number][] = [
  [/thin|hairline/i, 100],
  [/(extra|ultra)[\s-]?light/i, 200],
  [/light/i, 300],
  [/(semi|demi)[\s-]?bold/i, 600],
  [/(extra|ultra)[\s-]?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/medium/i, 500],
];

export function fontWeight(style: string): number {
  const hiragino = /^W(\d)$/i.exec(style.trim());
  if (hiragino) {
    return Math.max(100, Number(hiragino[1]) * 100);
  }
  return WEIGHT_NAMES.find(([pattern]) => pattern.test(style))?.[1] ?? 400;
}

/** Characters drawn about twice as wide as Latin letters: CJK, kana, hangul, full-width forms, emoji. */
export const WIDE_CHARACTER = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f000}-\u{3ffff}]/u;
