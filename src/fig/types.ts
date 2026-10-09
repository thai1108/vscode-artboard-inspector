// Shapes of the decoded Figma document (the kiwi "Message" root and its NodeChange records).
// Only the fields the viewer reads are declared; Figma omits fields that keep their default value.

export interface FigGuid {
  sessionID: number;
  localID: number;
}

export interface FigVector {
  x: number;
  y: number;
}

/** Affine matrix [m00 m01 m02; m10 m11 m12]. */
export interface FigMatrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export interface FigColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigColorStop {
  color: FigColor;
  position: number;
}

export interface FigPaint {
  type?: string;
  color?: FigColor;
  opacity?: number;
  visible?: boolean;
  stops?: FigColorStop[];
  transform?: FigMatrix;
  image?: { hash?: Uint8Array; dataBlob?: number };
  imageScaleMode?: string;
  originalImageWidth?: number;
  originalImageHeight?: number;
}

export interface FigEffect {
  type?: string;
  visible?: boolean;
  color?: FigColor;
  offset?: FigVector;
  radius?: number;
  spread?: number;
}

export interface FigPath {
  windingRule?: string;
  commandsBlob?: number;
}

export interface FigNumberUnits {
  value: number;
  units?: string;
}

export interface FigFontName {
  family?: string;
  style?: string;
}

/** Text style fields, shared by text nodes and their per-range style overrides. */
export interface FigTextStyle {
  fontName?: FigFontName;
  fontSize?: number;
  fillPaints?: FigPaint[];
  letterSpacing?: FigNumberUnits;
  lineHeight?: FigNumberUnits;
  textDecoration?: string;
  textCase?: string;
}

export interface FigStyleOverride extends FigTextStyle {
  styleID?: number;
}

export interface FigBaseline {
  position?: FigVector;
  firstCharacter?: number;
  endCharacter?: number;
}

export interface FigTextData {
  characters?: string;
  characterStyleIDs?: number[];
  styleOverrideTable?: FigStyleOverride[];
}

export interface FigDerivedTextData {
  baselines?: FigBaseline[];
  /** x offset of every character from the start of its line. */
  logicalIndexToCharacterOffsetMap?: number[];
}

/** A symbol override or derived instance value, addressed by the chain of override keys from the instance. */
export interface FigOverride extends Partial<FigNode> {
  guidPath?: { guids?: FigGuid[] };
}

export interface FigSymbolData {
  symbolID?: FigGuid;
  symbolOverrides?: FigOverride[];
}

export interface FigNode extends FigTextStyle {
  guid: FigGuid;
  type?: string;
  name?: string;
  visible?: boolean;
  opacity?: number;
  parentIndex?: { guid: FigGuid; position: string };
  internalOnly?: boolean;
  size?: FigVector;
  transform?: FigMatrix;
  strokePaints?: FigPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  strokeCap?: string;
  strokeJoin?: string;
  dashPattern?: number[];
  borderStrokeWeightsIndependent?: boolean;
  borderTopWeight?: number;
  borderRightWeight?: number;
  borderBottomWeight?: number;
  borderLeftWeight?: number;
  effects?: FigEffect[];
  cornerRadius?: number;
  rectangleCornerRadiiIndependent?: boolean;
  rectangleTopLeftCornerRadius?: number;
  rectangleTopRightCornerRadius?: number;
  rectangleBottomRightCornerRadius?: number;
  rectangleBottomLeftCornerRadius?: number;
  /** false (or absent on frames) means the frame clips its content. */
  frameMaskDisabled?: boolean;
  /** Set on groups, which Figma stores as frames sized by their children. */
  resizeToFit?: boolean;
  fillGeometry?: FigPath[];
  strokeGeometry?: FigPath[];
  arcData?: { startingAngle?: number; endingAngle?: number; innerRadius?: number };
  mask?: boolean;
  textData?: FigTextData;
  derivedTextData?: FigDerivedTextData;
  textAlignHorizontal?: string;
  overrideKey?: FigGuid;
  symbolData?: FigSymbolData;
  derivedSymbolData?: FigOverride[];
  overriddenSymbolID?: FigGuid;
}

export interface FigMessage {
  nodeChanges?: FigNode[];
  blobs?: { bytes?: Uint8Array }[];
}
