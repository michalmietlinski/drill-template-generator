export type Axis = "x" | "y";
export type RelativeReference = "center" | "edge";
export type RelativeSide = "positive" | "negative";
export type PlateSizeMode = "fixed" | "auto";
export type EarSide = "top" | "left" | "right";
export type CutInEdge = "top" | "left" | "right";
export type EarMode = "custom" | "full";
export type CutInShape = "triangle" | "rectangle";

export interface PlateConfig {
  shape: "rectangle";
  sizeMode: PlateSizeMode;
  width?: number;
  height?: number;
  thickness: number;
  referenceEdges: {
    x: "left";
    y: "top";
  };
  margin?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
}

export interface EarConfigBase {
  id: string;
  enabled: boolean;
  side: EarSide;
  depth: number;
  height: number;
}

export interface EarCustomConfig extends EarConfigBase {
  mode: "custom";
  length: number;
  offset: number;
}

export interface EarFullConfig extends EarConfigBase {
  mode: "full";
}

export type EarConfig = EarCustomConfig | EarFullConfig;

export interface AbsolutePosition {
  mode: "absolute";
  x?: number;
  y?: number;
}

export interface RelativePosition {
  mode: "relative";
  from: string;
  reference: RelativeReference;
  axis: Axis;
  distance: number;
  side: RelativeSide;
}

export type PositionConfig = AbsolutePosition | RelativePosition;

export interface HoleConfig {
  id: string;
  shape: "circle";
  diameter: number;
  position: PositionConfig;
}

export interface CutInConfig {
  id: string;
  shape: CutInShape;
  tabShape?: CutInShape;
  edge: CutInEdge;
  width: number;
  depth: number;
  position: PositionConfig;
}

export interface TemplateConfig {
  plate: PlateConfig;
  tabs: EarConfig[];
  holes: HoleConfig[];
  cutIns: CutInConfig[];
}

export interface ResolvedHole extends HoleConfig {
  x: number;
  y: number;
  radius: number;
}

export interface ResolvedCutIn extends CutInConfig {
  anchorX: number;
  anchorY: number;
}

export interface ResolvedPlate {
  width: number;
  height: number;
  thickness: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Point = [number, number];
export type Ring = Point[];
export type Polygon = Ring[];
export type MultiPolygon = Polygon[];

export interface ResolvedTemplate {
  plate: ResolvedPlate;
  activeTabs: EarConfig[];
  holes: ResolvedHole[];
  cutIns: ResolvedCutIn[];
  baseShape: MultiPolygon;
  bounds: Bounds;
  notes: string[];
}

export const defaultConfig: TemplateConfig = {
  plate: {
    shape: "rectangle",
    sizeMode: "fixed",
    width: 180,
    height: 95,
    thickness: 3,
    referenceEdges: {
      x: "left",
      y: "top"
    },
    margin: {
      left: 10,
      right: 10,
      top: 10,
      bottom: 10
    }
  },
  tabs: [
    {
      id: "tab-top",
      enabled: true,
      mode: "full",
      side: "top",
      depth: 3,
      height: 14
    },
    {
      id: "tab-right",
      enabled: true,
      mode: "custom",
      side: "right",
      depth: 3,
      height: 14,
      length: 32,
      offset: 14
    }
  ],
  holes: [
    {
      id: "h1",
      shape: "circle",
      diameter: 6,
      position: {
        mode: "absolute",
        x: 28,
        y: 22
      }
    },
    {
      id: "h2",
      shape: "circle",
      diameter: 8,
      position: {
        mode: "relative",
        from: "h1",
        reference: "edge",
        axis: "x",
        distance: 18,
        side: "positive"
      }
    },
    {
      id: "h3",
      shape: "circle",
      diameter: 6,
      position: {
        mode: "relative",
        from: "h2",
        reference: "center",
        axis: "y",
        distance: 26,
        side: "positive"
      }
    }
  ],
  cutIns: [
    {
      id: "mark-top-1",
      shape: "triangle",
      tabShape: "rectangle",
      edge: "top",
      width: 8,
      depth: 4,
      position: {
        mode: "absolute",
        x: 74
      }
    }
  ]
};

export const exampleAutoFitConfig: TemplateConfig = {
  ...defaultConfig,
  plate: {
    ...defaultConfig.plate,
    sizeMode: "auto",
    width: 120,
    height: 80
  },
  tabs: [
    {
      id: "tab-top",
      enabled: true,
      mode: "custom",
      side: "top",
      depth: 14,
      height: 12,
      length: 38,
      offset: 12
    },
    {
      id: "tab-left",
      enabled: true,
      mode: "custom",
      side: "left",
      depth: 14,
      height: 12,
      length: 28,
      offset: 18
    }
  ],
  cutIns: [
    {
      id: "mark-top-auto",
      shape: "triangle",
      edge: "top",
      width: 6,
      depth: 3,
      position: {
        mode: "relative",
        from: "h1",
        reference: "center",
        axis: "x",
        distance: 0,
        side: "positive"
      }
    }
  ]
};