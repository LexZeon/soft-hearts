import type { CatalogMotion, MotionCategory } from "../../shared/motion-library";

export const motionCategories: readonly MotionCategory[] = [
  "pose", "expression", "reaction", "idle", "gesture", "dance",
];

export const motionCategoryLabels: Record<MotionCategory, string> = {
  pose: "Pose · 姿势",
  expression: "Expression · 表情",
  reaction: "Reaction · 反应",
  idle: "Idle · 待机",
  gesture: "Gesture · 手势",
  dance: "Dance · 短舞",
};

export interface MotionFilterOptions {
  query?: string;
  category?: "all" | MotionCategory;
  selectedTags?: readonly string[];
}

export interface MotionTagCount {
  tag: string;
  count: number;
}

const normalized = (value: string) => value.trim().toLowerCase();
const uniqueTags = (motion: CatalogMotion) => new Set(motion.tags.map(normalized).filter(Boolean));

/** Search text is partial; selected tags and the category are exact filters. */
export function filterMotions(
  motions: readonly CatalogMotion[],
  { query = "", category = "all", selectedTags = [] }: MotionFilterOptions = {},
): CatalogMotion[] {
  const words = normalized(query).split(/\s+/).filter(Boolean);
  const requiredTags = new Set(selectedTags.map(normalized).filter(Boolean));
  return motions.filter(motion => {
    if (category !== "all" && motion.category !== category) return false;
    const tags = uniqueTags(motion);
    if ([...requiredTags].some(tag => !tags.has(tag))) return false;
    const searchable = `${motion.id} ${motion.name} ${motion.category} ${motionCategoryLabels[motion.category]} ${motion.tags.join(" ")}`.toLowerCase();
    return words.every(word => searchable.includes(word));
  });
}

/** Keep every available tag visible while tags are selected, so each can be removed. */
export function listTags(
  motions: readonly CatalogMotion[],
  { query, category }: MotionFilterOptions = {},
): MotionTagCount[] {
  const counts = new Map<string, number>();
  for (const motion of filterMotions(motions, { query, category })) {
    for (const tag of uniqueTags(motion)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b, "en")).map(([tag, count]) => ({ tag, count }));
}
