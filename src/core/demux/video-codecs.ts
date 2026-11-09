/** WebCodecs codec strings from ISO-BMFF / Matroska video decoder configuration records. */

const hex2 = (n: number) => n.toString(16).padStart(2, '0');
const dec2 = (n: number) => String(n).padStart(2, '0');

/** avcC (AVCDecoderConfigurationRecord) → "avc1.PPCCLL". */
export function avcCodecString(avcC: Uint8Array, fourcc = 'avc1'): string | null {
  if (avcC.length < 4 || avcC[0] !== 1) return null;
  return `${fourcc}.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`;
}

/** av1C (AV1CodecConfigurationRecord) → "av01.P.LLT.DD". */
export function av1CodecString(av1C: Uint8Array): string | null {
  if (av1C.length < 4 || (av1C[0] & 0x80) === 0) return null;
  const profile = av1C[1] >> 5;
  const level = av1C[1] & 0x1f;
  const tier = av1C[2] >> 7 ? 'H' : 'M';
  const high = (av1C[2] >> 6) & 1;
  const twelve = (av1C[2] >> 5) & 1;
  const depth = high ? (twelve ? 12 : 10) : 8;
  return `av01.${profile}.${dec2(level)}${tier}.${dec2(depth)}`;
}

/** vpcC (VPCodecConfigurationRecord, full box body incl. version/flags) → "vp09.PP.LL.DD". */
export function vp9CodecString(vpcC: Uint8Array): string | null {
  if (vpcC.length < 7) return null;
  const profile = vpcC[4];
  const level = vpcC[5];
  const depth = vpcC[6] >> 4;
  return `vp09.${dec2(profile)}.${dec2(level)}.${dec2(depth || 8)}`;
}
