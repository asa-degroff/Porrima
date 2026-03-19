declare module "icodec/node" {
  export const avif: any;
  export const png: any;
  export const jpeg: any;
  export const jxl: {
    loadEncoder: () => Promise<void>;
    encode: (image: { width: number; height: number; data: Uint8ClampedArray; depth?: number }, options?: { quality?: number; effort?: number; lossless?: boolean }) => Uint8Array;
  };
  export const webp: any;
  export const qoi: any;
  export const wp2: any;
  export const heic: any;
}
