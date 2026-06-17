// vendor/qrcodegen.js (Project Nayuki, MIT, v1.7.0) の最小型定義。foundation が使う API のみ宣言する。
export namespace qrcodegen {
  export class QrCode {
    static readonly MIN_VERSION: number;
    static readonly MAX_VERSION: number;
    static encodeText(text: string, ecl: QrCode.Ecc): QrCode;
    readonly version: number;
    readonly size: number;
    readonly mask: number;
    getModule(x: number, y: number): boolean;
  }
  export namespace QrCode {
    export class Ecc {
      static readonly LOW: Ecc;
      static readonly MEDIUM: Ecc;
      static readonly QUARTILE: Ecc;
      static readonly HIGH: Ecc;
      readonly ordinal: number;
      readonly formatBits: number;
    }
  }
}
