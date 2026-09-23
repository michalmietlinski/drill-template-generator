declare module "polygon-clipping" {
  const polygonClipping: {
    union: (...geometries: unknown[]) => unknown;
    difference: (...geometries: unknown[]) => unknown;
  };

  export default polygonClipping;
}

declare module "*.css" {
  const css: string;
  export default css;
}