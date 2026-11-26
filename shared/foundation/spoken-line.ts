// How long one spoken line may be (the validators of her own-voice lines). The limits are written for Chinese (30 characters and so on);
// an English sentence needs about three times the characters for the same thing, so a line with Latin letters and no CJK character gets
// that room. A fallback guard, not a style rule (docs/claude/2026-11-21-proactive-language.md). Pure.
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/u;
const LATIN = /[A-Za-z]/u;
export function spokenLineMax(text: string, cjkMax: number): number { return !CJK.test(text) && LATIN.test(text) ? cjkMax * 3 : cjkMax; }
