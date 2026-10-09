import type { BoardLayout } from './scene/board.ts';
import type { ArtboardScene, ArtboardSummary } from './scene/scene.ts';

export interface DesignImage {
  mime: string;
  data: Uint8Array;
}

/** An opened design file (.xd or .fig): lists artboards and converts one artboard at a time into a scene. */
export interface DesignDocument {
  readonly artboards: readonly ArtboardSummary[];
  /** Artboard positions on their canvas/page, for the board view. */
  readonly board: BoardLayout;
  scene(artboardId: string): ArtboardScene;
  image(uid: string): DesignImage | undefined;
}
