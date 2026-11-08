// Where the pet window first appears: the user's own stable
// instance lives at the bottom right of the primary display; test and research windows go elsewhere so the user
// can always tell which one is her. Test launches set SOFT_HEARTS_TEST_PET_CORNER=top-left. The stable channel
// ignores it, so nothing a test exports can move the user's companion.
export interface WorkArea { x: number; y: number; width: number; height: number }
export const PET_SIZE = { width: 400, height: 560 } as const;
const MARGIN = 30;

export function initialPetPosition(area: WorkArea, environment: Record<string, string | undefined>, channel: string | undefined): { x: number; y: number } {
  const testCorner = channel === 'stable' ? undefined : environment.SOFT_HEARTS_TEST_PET_CORNER;
  if (testCorner === 'top-left') return { x: area.x + MARGIN, y: area.y + MARGIN };
  return { x: area.x + area.width - PET_SIZE.width - MARGIN, y: area.y + area.height - PET_SIZE.height - MARGIN };
}
