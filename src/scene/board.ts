// Where each artboard sits on its canvas, in file coordinates. Plain JSON: posted to the webview with the document.

export interface BoardPlacement {
  id: string;
  /** Index into BoardLayout.pages. */
  page: number;
  x: number;
  y: number;
  /** Shown above the artboard on the board (the page name is left out). */
  title: string;
}

/** XD files have one canvas; Figma files have one per page. */
export interface BoardLayout {
  pages: string[];
  placements: BoardPlacement[];
}
